/**
 * Sub-8.1 aggregator main entrypoint.
 *
 * Mode (MVP, reveal-server-only):
 *   - Boots Fastify on PORT (default 3000) with POST /reveal + GET /health.
 *   - Spawns a background "epoch watcher" loop that polls the orderbook via a
 *     read-only client and LOGS the current epoch, queue size, and whether a
 *     clearing would have been triggered. It does NOT submit the clearing tx
 *     yet — that step requires nargo + bb proof gen + a funded L2 wallet,
 *     which is deferred to Sub-8.1.next (see ops/RUNBOOK-aggregator.md).
 *
 * Future (full clearing daemon):
 *   - Wire `runDaemon(ctx)` from ./daemon.ts. The DaemonContext needs:
 *     * getEpoch  → orderbook.get_epoch()
 *     * getPool   → pool.get_reserves() + current_sqrt_price
 *     * runNargoExecute / runBbProve → shell out to nargo + bb binaries
 *     * submitClearing → orderbook.close_epoch_and_clear_verified(...)
 *
 * Env contract:
 *   - PORT                            HTTP port (default 3000)
 *   - AZTEC_NODE_URL                  Aztec L2 RPC (e.g. https://rpc.testnet.aztec-labs.com)
 *   - ORDERBOOK_ADDRESS               L2 Orderbook contract address (0x…)
 *   - POOL_ADDRESS                    L2 Pool contract address (optional)
 *   - AGGREGATOR_L2_SECRET            ephemeral wallet secret for read-only PXE
 *                                     calls (any 32-byte hex; reads only).
 *                                     Optional — if missing, the watcher logs a
 *                                     warning and skips on-chain polling.
 *   - WATCHER_INTERVAL_MS             poll interval (default 15000)
 *   - LOG_LEVEL                       info|debug (default info)
 *   - RELAYER_MODE=1                  enables bridge-claim relayer side-loop
 *                                     (Sub-5c; requires L1_RPC_URL + L1_PRIVATE_KEY)
 */

import { setTimeout as sleep } from "node:timers/promises";
import Fastify from "fastify";
import { z } from "zod";
import { RevealQueue, type RevealPayload } from "./queue.js";

// ── Logging ────────────────────────────────────────────────────────────────
const LOG_LEVEL = (process.env.LOG_LEVEL ?? "info").toLowerCase();
function log(level: "info" | "warn" | "error" | "debug", msg: string, extra?: Record<string, unknown>): void {
  if (level === "debug" && LOG_LEVEL !== "debug") return;
  const line = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...(extra ?? {}),
  };
  // Use console so Docker captures it on stdout/stderr.
  if (level === "error") console.error(JSON.stringify(line));
  else console.log(JSON.stringify(line));
}

// ── Fastify reveal server ──────────────────────────────────────────────────
// Mirrors src/server.ts shape but inlines so we can extend /health with the
// extra fields (lastEpochSeen, watcherStatus) without coupling test helpers.
const RevealSchema = z.object({
  epoch_id: z.number().int().nonnegative(),
  order_nonce: z.string().regex(/^0x[0-9a-fA-F]+$/),
  side: z.boolean(),
  amount_in: z.string().regex(/^\d+$/),
  limit_price: z.string().regex(/^\d+$/),
  submitted_at_block: z.number().int().nonnegative(),
  owner: z.string().regex(/^0x[0-9a-fA-F]+$/),
  submission_tx_hash: z.string().optional(),
});

interface WatcherState {
  status: "idle" | "polling" | "disabled" | "error";
  lastEpochSeen: number | null;
  lastBlockSeen: number | null;
  lastError: string | null;
  lastPollAt: string | null;
}

const watcher: WatcherState = {
  status: "idle",
  lastEpochSeen: null,
  lastBlockSeen: null,
  lastError: null,
  lastPollAt: null,
};

async function buildHttp(queue: RevealQueue): Promise<ReturnType<typeof Fastify>> {
  const app = Fastify({ logger: false });

  app.post("/reveal", async (req, reply) => {
    const parse = RevealSchema.safeParse(req.body);
    if (!parse.success) {
      return reply.code(400).send({ error: "invalid payload", issues: parse.error.issues });
    }
    const payload: RevealPayload = parse.data;
    queue.enqueue(payload);
    log("debug", "reveal enqueued", {
      epoch_id: payload.epoch_id,
      order_nonce: payload.order_nonce,
      queueSize: queue.size(),
    });
    return { ok: true };
  });

  app.get("/health", async () => ({
    ok: true,
    service: "quetzal-aggregator",
    queueSize: queue.size(),
    watcher: { ...watcher },
  }));

  // Root for human eyeballs — keeps unknown probes from 404'ing in the logs.
  app.get("/", async () => ({
    ok: true,
    service: "quetzal-aggregator",
    endpoints: ["POST /reveal", "GET /health"],
  }));

  await app.ready();
  return app;
}

// ── Background epoch watcher (MVP: logs only) ──────────────────────────────
//
// Imports the SDK + opens a read-only QuetzalClient. If config loading or
// PXE bootstrap fails (missing env, network unreachable, etc.) we degrade
// gracefully: server keeps running, watcher.status becomes "disabled" or
// "error", and /health reflects that. This is intentional — accepting
// reveals into the queue is independently useful even without on-chain
// reads.
async function startEpochWatcher(queue: RevealQueue): Promise<void> {
  const intervalMs = Number(process.env.WATCHER_INTERVAL_MS ?? "15000");
  const nodeUrl = process.env.AZTEC_NODE_URL;
  const orderbookAddr = process.env.ORDERBOOK_ADDRESS;
  const secret = process.env.AGGREGATOR_L2_SECRET;

  if (!nodeUrl || !orderbookAddr || !secret) {
    log("warn", "epoch watcher disabled — missing env", {
      have_nodeUrl: Boolean(nodeUrl),
      have_orderbook: Boolean(orderbookAddr),
      have_secret: Boolean(secret),
    });
    watcher.status = "disabled";
    return;
  }

  // Lazy-import SDK so a misconfigured-but-running container still serves
  // /reveal + /health while we fix the L2 wiring.
  let client: unknown;
  try {
    const sdkMod = await import("@quetzal/sdk");
    const QuetzalClient = (sdkMod as { QuetzalClient: { connect: (opts: unknown) => Promise<unknown> } })
      .QuetzalClient;
    // Use "schnorr" account spec — ephemeral embedded PXE, no funding needed
    // for read-only simulate() calls. The DaemonContext.submitClearing path
    // (which DOES need a funded wallet) is not wired in the MVP.
    log("info", "epoch watcher: connecting to Aztec node", { nodeUrl });
    client = await QuetzalClient.connect({
      network: nodeUrl.includes("testnet") ? "alpha-testnet" : "sandbox",
      nodeUrl,
      account: { type: "schnorr", secret },
      contracts: {
        orderbook: orderbookAddr,
        // Token + pool addrs aren't strictly required for get_epoch() but the
        // SDK's contract-registration pass will skip undefined entries.
        tUSDC: process.env.TUSDC_ADDRESS ?? "0x" + "0".repeat(64),
        tETH: process.env.TETH_ADDRESS ?? "0x" + "0".repeat(64),
        admin: process.env.ADMIN_ADDRESS ?? "0x" + "0".repeat(64),
        pools: process.env.POOL_ADDRESS
          ? [
              {
                pool_id: 0,
                token_a: process.env.TUSDC_ADDRESS ?? "0x" + "0".repeat(64),
                token_b: process.env.TETH_ADDRESS ?? "0x" + "0".repeat(64),
                address: process.env.POOL_ADDRESS,
              },
            ]
          : [],
        aggregatorRegistry: process.env.AGGREGATOR_REGISTRY_ADDRESS,
        treasury: process.env.TREASURY_ADDRESS,
      },
    });
    log("info", "epoch watcher: PXE bootstrap complete");
  } catch (e) {
    watcher.status = "error";
    watcher.lastError = `bootstrap: ${e instanceof Error ? e.message : String(e)}`;
    log("error", "epoch watcher: bootstrap failed", { error: watcher.lastError });
    return;
  }

  // Polling loop. Runs forever; per-iteration errors are logged + swallowed.
  log("info", "epoch watcher: started", { intervalMs });
  while (true) {
    try {
      watcher.status = "polling";
      const c = client as { reads: { getCurrentEpoch: () => Promise<{ epoch_id: number; closes_at_block: number }> } };
      const epoch = await c.reads.getCurrentEpoch();
      watcher.lastEpochSeen = epoch.epoch_id;
      watcher.lastBlockSeen = epoch.closes_at_block;
      watcher.lastPollAt = new Date().toISOString();
      watcher.lastError = null;
      log("info", "epoch poll", {
        epoch_id: epoch.epoch_id,
        closes_at_block: epoch.closes_at_block,
        queueSize: queue.size(),
        // TODO (Sub-8.1.next): when block >= closes_at_block AND queue has
        // matching reveals, call runOneClearingCycle(daemonCtx). For now,
        // we only log so operators see the loop is alive.
        wouldClear: queue.size() > 0,
      });
    } catch (e) {
      watcher.status = "error";
      watcher.lastError = e instanceof Error ? e.message : String(e);
      log("error", "epoch poll failed", { error: watcher.lastError });
    }
    await sleep(intervalMs);
  }
}

// ── Optional relayer side-loop (Sub-5c) ────────────────────────────────────
async function maybeStartRelayer(): Promise<void> {
  if (process.env.RELAYER_MODE !== "1") return;
  if (!process.env.L1_RPC_URL || !process.env.L1_PRIVATE_KEY) {
    log("warn", "RELAYER_MODE=1 set but L1_RPC_URL/L1_PRIVATE_KEY missing — skipping");
    return;
  }
  try {
    log("info", "relayer-mode: starting side-loop");
    const { runRelayerLoop } = await import("./relayer-mode.js");
    const { loadConfig } = await import("../../cli/src/config.js");
    const config = loadConfig();
    if (!config.treasury) {
      log("warn", "relayer-mode: config.treasury missing — skipping");
      return;
    }
    const bridgesByAddress: Record<string, "USDC" | "WETH" | "wBTC"> = {};
    if (config.l1?.usdcBridge) bridgesByAddress[config.l1.usdcBridge.toLowerCase()] = "USDC";
    if (config.l1?.wethBridge) bridgesByAddress[config.l1.wethBridge.toLowerCase()] = "WETH";
    if (config.l1?.wbtcBridge) bridgesByAddress[config.l1.wbtcBridge.toLowerCase()] = "wBTC";
    runRelayerLoop({
      aztecNodeUrl: config.nodeUrl,
      l1RpcUrl: process.env.L1_RPC_URL,
      l1PrivateKey: process.env.L1_PRIVATE_KEY as `0x${string}`,
      treasuryAddr: config.treasury,
      bridgesByAddress,
    }).catch((e: unknown) => {
      log("error", "relayer-mode crashed", { error: e instanceof Error ? e.message : String(e) });
    });
  } catch (e) {
    log("error", "relayer-mode init failed", { error: e instanceof Error ? e.message : String(e) });
  }
}

// ── Entrypoint ─────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? "3000");
  const queue = new RevealQueue();

  log("info", "starting quetzal-aggregator", {
    port,
    relayerMode: process.env.RELAYER_MODE === "1",
    logLevel: LOG_LEVEL,
  });

  const app = await buildHttp(queue);
  await app.listen({ port, host: "0.0.0.0" });
  log("info", "http server listening", { port });

  // Fire off the watcher + relayer loops without awaiting — they run forever.
  startEpochWatcher(queue).catch((e: unknown) => {
    log("error", "epoch watcher crashed", { error: e instanceof Error ? e.message : String(e) });
  });
  maybeStartRelayer().catch(() => {});

  // Graceful shutdown — close fastify cleanly so docker stop's SIGTERM
  // doesn't leak the port.
  const shutdown = async (sig: string): Promise<void> => {
    log("info", "shutting down", { signal: sig });
    try {
      await app.close();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((e: unknown) => {
  console.error(JSON.stringify({
    ts: new Date().toISOString(),
    level: "error",
    msg: "fatal",
    error: e instanceof Error ? e.message : String(e),
  }));
  process.exit(1);
});
