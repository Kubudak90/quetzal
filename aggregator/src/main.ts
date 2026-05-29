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
import { Fr } from "@aztec/aztec.js/fields";
import { RevealQueue, type RevealPayload } from "./queue.js";
import {
  runOneClearingCycleMP,
  buildU128PoolRegistry,
  type DaemonContextMP,
  type ClearingPublicStruct,
} from "./clearing-cycle.js";
import type { PoolStateForRouting } from "./clearing.js";

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
  // Sub-9.3: optional pool address triplet (USDC/ETH, USDC/BTC, ETH/BTC).
  // If present, the watcher wires the FULL multi-pair clearing loop.
  const poolUsdcEth = process.env.POOL_USDC_ETH_ADDRESS ?? process.env.POOL_ADDRESS;
  const poolUsdcBtc = process.env.POOL_USDC_BTC_ADDRESS;
  const poolEthBtc = process.env.POOL_ETH_BTC_ADDRESS;
  const tUSDC = process.env.TUSDC_ADDRESS;
  const tETH = process.env.TETH_ADDRESS;
  const tBTC = process.env.TBTC_ADDRESS;
  const snapshotsDir = process.env.SNAPSHOTS_DIR ?? "/repo/aggregator/data/snapshots";
  // Sub-9.3: clearing-cycle gate. Set CLEARING_ENABLED=1 to enable the
  // multi-pair clearing submit path. Default is "log-only" (Sub-8.1 MVP).
  const clearingEnabled = process.env.CLEARING_ENABLED === "1";

  if (!nodeUrl || !orderbookAddr || !secret) {
    log("warn", "epoch watcher disabled — missing env", {
      have_nodeUrl: Boolean(nodeUrl),
      have_orderbook: Boolean(orderbookAddr),
      have_secret: Boolean(secret),
    });
    watcher.status = "disabled";
    return;
  }

  // Lazy-import SDK + aztec-node so a misconfigured-but-running container still
  // serves /reveal + /health while we fix the L2 wiring.
  let client: unknown;
  let node: { getBlockNumber: () => Promise<number> } | null = null;
  try {
    const sdkMod = await import("@quetzal/sdk");
    const QuetzalClient = (sdkMod as { QuetzalClient: { connect: (opts: unknown) => Promise<unknown> } })
      .QuetzalClient;
    // Aztec node client for block-number reads (cheaper than SDK roundtrips).
    const nodeMod = await import("@aztec/aztec.js/node");
    const createAztecNodeClient = (nodeMod as { createAztecNodeClient: (url: string) => unknown }).createAztecNodeClient;
    node = createAztecNodeClient(nodeUrl) as { getBlockNumber: () => Promise<number> };
    log("info", "epoch watcher: connecting to Aztec node", { nodeUrl, clearingEnabled });

    // Construct pool list (Sub-9.3): all 3 pools if envs are present.
    const pools = [];
    if (poolUsdcEth && tUSDC && tETH) pools.push({ pool_id: 0, token_a: tETH, token_b: tUSDC, address: poolUsdcEth });
    if (poolUsdcBtc && tUSDC && tBTC) pools.push({ pool_id: 1, token_a: tBTC, token_b: tUSDC, address: poolUsdcBtc });
    if (poolEthBtc && tETH && tBTC) pools.push({ pool_id: 2, token_a: tETH, token_b: tBTC, address: poolEthBtc });

    client = await QuetzalClient.connect({
      network: nodeUrl.includes("testnet") ? "alpha-testnet" : "sandbox",
      nodeUrl,
      account: {
        type: "schnorr",
        secret,
        // Sub-9.3: optional salt + signingKey to reach a pre-deployed wallet
        // (e.g. admin's). Without these, the SDK derives address from secret
        // + Fr.ZERO salt + derived signingKey -> a NEW unfunded account.
        salt: process.env.AGGREGATOR_L2_SALT,
        signingKey: process.env.AGGREGATOR_L2_SIGNING_KEY,
        // Sub-9.3: enable client IVC prover when clearing path is enabled —
        // tx submission requires real proofs (close_epoch / close_epoch_and_clear_verified).
        proverEnabled: clearingEnabled,
        // Optional persistent PXE for warm-restart speed.
        dataDirectory: process.env.PXE_DATA_DIRECTORY,
      },
      contracts: {
        orderbook: orderbookAddr,
        tUSDC: tUSDC ?? "0x" + "0".repeat(64),
        tETH: tETH ?? "0x" + "0".repeat(64),
        tBTC,
        admin: process.env.ADMIN_ADDRESS ?? "0x" + "0".repeat(64),
        pools,
        aggregatorRegistry: process.env.AGGREGATOR_REGISTRY_ADDRESS,
        treasury: process.env.TREASURY_ADDRESS,
      },
    });
    log("info", "epoch watcher: PXE bootstrap complete", { pools: pools.length });
  } catch (e) {
    watcher.status = "error";
    watcher.lastError = `bootstrap: ${e instanceof Error ? e.message : String(e)}`;
    log("error", "epoch watcher: bootstrap failed", { error: watcher.lastError });
    return;
  }

  // Sub-9.3: build the DaemonContextMP if clearing is enabled.
  let daemonCtx: DaemonContextMP | null = null;
  if (clearingEnabled) {
    try {
      daemonCtx = await buildDaemonContextMP({
        queue,
        snapshotsDir,
        client,
        node: node!,
        poolUsdcEth,
        poolUsdcBtc,
        poolEthBtc,
        tUSDC,
        tETH,
        tBTC,
      });
      log("info", "DaemonContextMP built — clearing loop wired", {
        registry_size: daemonCtx.registry.length,
        snapshots_dir: snapshotsDir,
      });
    } catch (e) {
      // Don't kill the watcher — fallback to log-only mode if context build fails.
      log("error", "DaemonContextMP build failed; falling back to log-only", {
        error: e instanceof Error ? e.message : String(e),
      });
      daemonCtx = null;
    }
  }

  // Polling loop. Runs forever; per-iteration errors are logged + swallowed.
  log("info", "epoch watcher: started", { intervalMs, clearingEnabled: Boolean(daemonCtx) });
  while (true) {
    try {
      watcher.status = "polling";
      const c = client as { reads: { getCurrentEpoch: () => Promise<{ epoch_id: number; closes_at_block: number }> } };
      const epoch = await c.reads.getCurrentEpoch();
      const blockNow = node ? await node.getBlockNumber() : null;
      watcher.lastEpochSeen = epoch.epoch_id;
      watcher.lastBlockSeen = blockNow ?? epoch.closes_at_block;
      watcher.lastPollAt = new Date().toISOString();
      watcher.lastError = null;
      const wouldClear =
        queue.size() > 0 &&
        blockNow !== null &&
        blockNow >= epoch.closes_at_block;
      log("info", "epoch poll", {
        epoch_id: epoch.epoch_id,
        closes_at_block: epoch.closes_at_block,
        block_now: blockNow,
        queueSize: queue.size(),
        wouldClear,
      });

      // Sub-9.3: fire clearing cycle when gate is hit.
      if (wouldClear && daemonCtx) {
        log("info", "epoch close window hit — running clearing cycle");
        // Run in background (don't block the next poll). Mutex inside
        // runOneClearingCycleMP prevents concurrent cycles.
        runOneClearingCycleMP(daemonCtx, log).then(
          (status) => log("info", "clearing cycle complete", { status }),
          (err) => log("error", "clearing cycle failed", {
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      }
    } catch (e) {
      watcher.status = "error";
      watcher.lastError = e instanceof Error ? e.message : String(e);
      log("error", "epoch poll failed", { error: watcher.lastError });
    }
    await sleep(intervalMs);
  }
}

/**
 * Sub-9.3: build the DaemonContextMP that bridges from SDK → daemon orchestrator.
 * Heavy: opens a long-lived QuetzalClient + aztec node client.
 */
async function buildDaemonContextMP(args: {
  queue: RevealQueue;
  snapshotsDir: string;
  client: unknown;
  node: { getBlockNumber: () => Promise<number> };
  poolUsdcEth?: string;
  poolUsdcBtc?: string;
  poolEthBtc?: string;
  tUSDC?: string;
  tETH?: string;
  tBTC?: string;
}): Promise<DaemonContextMP> {
  // Build u128-canonical registry from env pools.
  const configPools = [];
  if (args.poolUsdcEth && args.tUSDC && args.tETH)
    configPools.push({ pool_id: 0, address: args.poolUsdcEth, token_a: args.tETH, token_b: args.tUSDC });
  if (args.poolUsdcBtc && args.tUSDC && args.tBTC)
    configPools.push({ pool_id: 1, address: args.poolUsdcBtc, token_a: args.tBTC, token_b: args.tUSDC });
  if (args.poolEthBtc && args.tETH && args.tBTC)
    configPools.push({ pool_id: 2, address: args.poolEthBtc, token_a: args.tETH, token_b: args.tBTC });
  if (configPools.length === 0) throw new Error("no pools configured for clearing loop");
  const registry = buildU128PoolRegistry(configPools);

  // SDK types
  type SdkClient = {
    reads: { getCurrentEpochFull: () => Promise<{
      epoch_id: number; closes_at_block: number;
      order_acc: string; order_count: number;
      cancel_acc: string; cancel_count: number;
    }> };
    pools: {
      getPoolState: (poolId: number) => Promise<{ reserveA: bigint; reserveB: bigint; currentSqrtPrice: bigint }>;
      getBucket: (bucketId: number, poolId: number) => Promise<{
        reserveA: bigint; reserveB: bigint; liquidity: bigint;
        cumFeeAPerShare: bigint; cumFeeBPerShare: bigint;
      }>;
    };
    orders: {
      closeEpochVerified: (opts: { proofFields: Fr[]; vkFields: Fr[]; publicInputs: unknown }) =>
        Promise<{ epoch_id: number; closes_at_block: number }>;
      closeEpoch: (opts?: { epoch?: number }) => Promise<{ epoch_id: number; closes_at_block: number }>;
    };
  };
  const c = args.client as SdkClient;

  return {
    queue: args.queue,
    snapshotsDir: args.snapshotsDir,
    registry,
    circuitDir: process.env.CIRCUIT_DIR ?? "/repo/circuits/clearing",
    nargoBin: process.env.NARGO_BIN ?? "nargo",
    bbBin: process.env.BB_BIN ?? "bb",
    proveDeadlineMs: Number(process.env.PROVE_DEADLINE_MS ?? "300000"),
    verbose: process.env.PROVE_VERBOSE !== "0",
    getEpoch: async () => {
      const e = await c.reads.getCurrentEpochFull();
      return {
        epoch_id: e.epoch_id,
        closes_at_block: e.closes_at_block,
        order_acc: Fr.fromString(e.order_acc),
        order_count: e.order_count,
        cancel_acc: Fr.fromString(e.cancel_acc),
        cancel_count: e.cancel_count,
      };
    },
    getBlockNumber: () => args.node.getBlockNumber(),
    getPoolState: async (poolId: number) => {
      // Sub-9.3: read pool aggregate + 16 buckets. We read ALL buckets since
      // clearing needs the full state for proper sqrt-price tracing. Slow on
      // testnet (~30s for 16 reads) but correct. Optimisation deferred.
      const aggregate = await c.pools.getPoolState(poolId);
      const buckets = [];
      for (let i = 0; i < 16; i++) {
        const b = await c.pools.getBucket(i, poolId);
        buckets.push({
          reserve_a: b.reserveA,
          reserve_b: b.reserveB,
          liquidity: b.liquidity,
          cum_fee_a_per_share: b.cumFeeAPerShare,
          cum_fee_b_per_share: b.cumFeeBPerShare,
        });
      }
      const result: PoolStateForRouting = {
        reserveA: aggregate.reserveA,
        reserveB: aggregate.reserveB,
        lpSupply: 0n,  // unused by computeClearingV2 in the Sub-2.5+ V3 path
        currentSqrtPrice: aggregate.currentSqrtPrice,
        bucketBounds: [],   // computeClearingV2 falls back to per-bucket math via bucketStates
        bucketStates: buckets,
      };
      return result;
    },
    submitClearing: async ({ publicInputs, proof, vk }: {
      publicInputs: ClearingPublicStruct;
      proof: Fr[];
      vk: Fr[];
    }) => {
      const res = await c.orders.closeEpochVerified({
        proofFields: proof,
        vkFields: vk,
        publicInputs,
      });
      void res;
      return { txHash: "submitted" };
    },
    submitCloseEpochOnly: async () => {
      const res = await c.orders.closeEpoch();
      void res;
      return { txHash: "submitted" };
    },
  };
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
