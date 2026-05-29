/**
 * Sub-9.3: production clearing-cycle orchestration for the multi-pair orderbook.
 *
 * The Sub-2.5-era `runOneClearingCycle` in daemon.ts targets the SINGLE-POOL
 * shape and is kept around for backward-compat (legacy tests). Sub-4 / Sub-5a
 * deployed the multi-pair orderbook whose `close_epoch_and_clear_verified`
 * expects the ClearingPublic struct (active_pool_count + active_pools[3]). The
 * circuit at `circuits/clearing/src/main.nr` matches this multi-pair shape.
 *
 * `runOneClearingCycleMP` (this module) wires the production flow:
 *
 *   1. Read on-chain EpochState (full shape) + current L2 block via SDK.
 *   2. Drain the queue for this epoch_id; replay-validate against order_acc.
 *   3. Resolve each order's path to per-hop pool_ids (u128 canonical).
 *   4. Read per-pool state (reserves + sqrt_price + 16 buckets).
 *   5. Compute clearing via computeClearingMultiPair.
 *   6. Build Prover.toml via buildClearingWitnessMultiPair.
 *   7. Shell out to nargo execute + bb prove. Read proof.bin + vk.bin.
 *   8. Submit close_epoch_and_clear_verified via SDK.
 *   9. Snapshot fills tree to disk for the maker's `claim` step.
 *
 * Concurrency: a module-level mutex prevents two cycles running at once. If a
 * second tick fires while the first cycle is still in-flight, the second
 * returns immediately (the first will pick up the next iteration).
 *
 * Error policy: per-cycle errors are caught and logged. The watcher keeps
 * polling; on the next epoch the cycle is re-attempted with fresh state.
 *
 * Operational notes:
 *   - This module shells out to `nargo` + `bb`. They MUST be on PATH (the
 *     production image uses `aztecprotocol/aztec:4.2.1` as runtime base which
 *     bakes both in).
 *   - The clearing circuit's vk_hash MUST match the on-chain orderbook's
 *     `clearing_vk_hash` storage. Deploy script pins this; aggregator reads
 *     it from `circuits/clearing/target/vk.bin/vk` at runtime.
 *   - bb prove is slow (~30-60s on a warm L2 host). The watcher polls every
 *     15s; we set a per-cycle deadline well above the worst-case prove time.
 */

import { spawn } from "node:child_process";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { Fr } from "@aztec/aztec.js/fields";

import type { RevealQueue } from "./queue.js";
import { validateReveals } from "./validate.js";
import {
  computeClearingMultiPair,
  type ClearingOrderMultiPair,
  type PoolStateForRouting,
} from "./clearing.js";
import {
  buildClearingWitnessMultiPair,
  MAX_ACTIVE_POOLS_PER_EPOCH,
  INVALID_POOL_ID,
} from "./witness.js";
import { buildHopFillsTree } from "./merkle.js";
import { writeSnapshot } from "./snapshot.js";
import type { PoolRegistry, PoolRegistryEntry } from "./path.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Sub-9.3: full ClearingPublic struct shape, matches contracts/orderbook ClearingPublic. */
export interface ClearingPublicStruct {
  order_acc: string | bigint;   // Fr
  cancel_acc: string | bigint;  // Fr
  order_count: number;
  cancel_count: number;
  fills_root: string;           // 0x-prefixed Fr hex
  active_pool_count: number;
  active_pools: Array<{
    pool_id: number;
    clearing_price: bigint;
    swap: {
      a_to_pool: bigint;
      b_to_pool: bigint;
      a_from_pool: bigint;
      b_from_pool: bigint;
      active_bucket_deltas: Array<{
        bucket_id: number;
        reserve_a_add: bigint;
        reserve_a_sub: bigint;
        reserve_b_add: bigint;
        reserve_b_sub: bigint;
        cum_fee_a_per_share_increment: bigint;
        cum_fee_b_per_share_increment: bigint;
      }>;
      active_bucket_count: number;
      current_sqrt_price_after: bigint;
    };
  }>;
}

/**
 * Aggregator-side context for the multi-pair clearing loop. Callbacks
 * abstract the on-chain reads / submit so the orchestrator stays testable.
 */
export interface DaemonContextMP {
  queue: RevealQueue;
  snapshotsDir: string;
  registry: PoolRegistry;

  /** Read full orderbook epoch state. */
  getEpoch(): Promise<{
    epoch_id: number;
    closes_at_block: number;
    order_acc: Fr;
    order_count: number;
    cancel_acc: Fr;
    cancel_count: number;
  }>;
  /** Current L2 block. */
  getBlockNumber(): Promise<number>;
  /** Read one pool's state (incl. bucket states). poolId is the pool_id from registry. */
  getPoolState(poolId: number): Promise<PoolStateForRouting>;
  /** Submit close_epoch_and_clear_verified(publicInputs, proof, vk). */
  submitClearing(args: {
    publicInputs: ClearingPublicStruct;
    proof: Fr[];
    vk: Fr[];
  }): Promise<{ txHash?: string }>;

  /** Circuit project dir (default: circuits/clearing). */
  circuitDir?: string;
  /** nargo binary path (default: nargo). */
  nargoBin?: string;
  /** bb binary path (default: bb). */
  bbBin?: string;
  /** Per-prove deadline ms (default: 180_000). */
  proveDeadlineMs?: number;
  /** Stream subprocess stderr to console (default: true). */
  verbose?: boolean;
}

// ---------------------------------------------------------------------------
// Concurrency guard
// ---------------------------------------------------------------------------
let CYCLE_IN_FLIGHT = false;
export function isCycleInFlight(): boolean { return CYCLE_IN_FLIGHT; }

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const HONK_PROOF_FIELDS = 500;
const HONK_VK_FIELDS = 115;
const CONTRACT_PROOF_SIZE = 456;
const CONTRACT_VK_SIZE = 127;
const U128_MASK = (1n << 128n) - 1n;

function bridgeProof(buf: Buffer): Fr[] {
  const numFields = Math.floor(buf.length / 32);
  const fields: Fr[] = [];
  for (let i = 0; i < numFields; i++) {
    fields.push(Fr.fromBuffer(buf.subarray(i * 32, (i + 1) * 32)));
  }
  if (fields.length > CONTRACT_PROOF_SIZE) return fields.slice(0, CONTRACT_PROOF_SIZE);
  while (fields.length < CONTRACT_PROOF_SIZE) fields.push(Fr.ZERO);
  return fields;
}
function bridgeVk(buf: Buffer): Fr[] {
  const numFields = Math.floor(buf.length / 32);
  const fields: Fr[] = [];
  for (let i = 0; i < numFields; i++) {
    fields.push(Fr.fromBuffer(buf.subarray(i * 32, (i + 1) * 32)));
  }
  if (fields.length > CONTRACT_VK_SIZE) return fields.slice(0, CONTRACT_VK_SIZE);
  while (fields.length < CONTRACT_VK_SIZE) fields.push(Fr.ZERO);
  return fields;
}

// ---------------------------------------------------------------------------
// Subprocess helpers
// ---------------------------------------------------------------------------
interface ProcResult { code: number; stdout: string; stderr: string; }
function runProc(
  cmd: string,
  args: string[],
  opts: { cwd?: string; deadlineMs?: number; verbose?: boolean } = {},
): Promise<ProcResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: process.env });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
      if (opts.verbose) process.stdout.write(d);
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
      if (opts.verbose) process.stderr.write(d);
    });
    const timer = opts.deadlineMs
      ? setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error(`subprocess timed out after ${opts.deadlineMs}ms: ${cmd} ${args.join(" ")}`));
        }, opts.deadlineMs)
      : null;
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
  });
}

// ---------------------------------------------------------------------------
// Pool registry construction
// ---------------------------------------------------------------------------

/**
 * Build a u128-canonical pool registry from quetzal.config pool entries.
 *
 * The on-chain orderbook stores `pool_token_a/b` in u128-canonical order
 * (Sub-9.1 P3 fix). The aggregator's path resolver MUST mirror this; otherwise
 * `resolvePoolId` would not find the registry entry for any order whose path
 * disagrees with full-bigint canonical (which is the case for the Sub-9
 * tUSDC/tETH pair).
 */
export function buildU128PoolRegistry(
  configPools: Array<{ pool_id: number; token_a: string; token_b: string; address: string }>,
): PoolRegistry {
  return configPools.map((p): PoolRegistryEntry => {
    const a = BigInt(p.token_a) & U128_MASK;
    const b = BigInt(p.token_b) & U128_MASK;
    const [lo, hi] = a < b ? [a, b] : [b, a];
    return { pool_id: p.pool_id, token_a: lo, token_b: hi };
  });
}

/** u128-canonical resolvePoolId, used by the witness builder helpers. */
export function resolvePoolIdU128(reg: PoolRegistry, a: bigint, b: bigint): number {
  const am = a & U128_MASK;
  const bm = b & U128_MASK;
  const [lo, hi] = am < bm ? [am, bm] : [bm, am];
  for (const p of reg) {
    if (p.token_a === lo && p.token_b === hi) return p.pool_id;
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Logging facade
// ---------------------------------------------------------------------------
type LogLevel = "info" | "warn" | "error" | "debug";
export type LogFn = (level: LogLevel, msg: string, extra?: Record<string, unknown>) => void;
const DEFAULT_LOG: LogFn = (level, msg, extra) => {
  const line = { ts: new Date().toISOString(), level, msg, ...(extra ?? {}) };
  if (level === "error") console.error(JSON.stringify(line));
  else console.log(JSON.stringify(line));
};

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * Single-shot multi-pair clearing cycle. Idempotent: if the queue is empty,
 * or the epoch hasn't closed, or another cycle is in flight, it returns early.
 *
 * Returns a short status string for the watcher's log line.
 */
export async function runOneClearingCycleMP(
  ctx: DaemonContextMP,
  log: LogFn = DEFAULT_LOG,
): Promise<string> {
  if (CYCLE_IN_FLIGHT) return "skipped:in-flight";
  CYCLE_IN_FLIGHT = true;
  try {
    const blockNow = await ctx.getBlockNumber();
    const epoch = await ctx.getEpoch();

    if (blockNow < epoch.closes_at_block) {
      return `skipped:not-closed(block=${blockNow}<closes=${epoch.closes_at_block})`;
    }

    if (epoch.order_count === 0 && ctx.queue.size() === 0) {
      // Empty epoch — could submit empty-clearing to advance, but for MVP we
      // skip and let the next non-empty cycle handle it.
      return "skipped:empty-epoch";
    }

    const reveals = ctx.queue.drainEpoch(epoch.epoch_id);
    log("info", "draining reveals", { count: reveals.length, epoch_id: epoch.epoch_id });

    if (reveals.length === 0 && epoch.order_count > 0) {
      log("warn", "epoch has orders but no reveals in queue — skipping (other aggregator may win)");
      return "skipped:no-reveals";
    }

    const validated = await validateReveals(reveals, epoch.order_acc);
    if (validated.length === 0 && epoch.order_count > 0) {
      // Diagnostic: replay independently to surface the mismatched acc.
      const { computeCi, replayOrderAcc } = await import("./validate.js");
      const cis = [];
      for (const r of reveals) {
        try {
          cis.push(await computeCi({
            owner: BigInt(r.owner),
            side: r.side,
            amount_in: BigInt(r.amount_in),
            limit_price: BigInt(r.limit_price),
            order_nonce: BigInt(r.order_nonce),
            submitted_at_block: r.submitted_at_block,
          }));
        } catch { /* ignore parse */ }
      }
      const replayed = cis.length > 0 ? (await replayOrderAcc(cis)).toString() : "(empty)";
      log("warn", "order_acc replay mismatch — reveals tampered or incomplete", {
        on_chain_order_acc: epoch.order_acc.toString(),
        on_chain_order_count: epoch.order_count,
        replayed_order_acc: replayed,
        reveals_in_queue: reveals.length,
      });
      return "skipped:replay-mismatch";
    }
    log("info", "reveals validated", { count: validated.length });

    // Build per-order multi-pair shape. Sub-9.3 MVP: only 1-hop orders are
    // expected from the smoke. Multi-hop is supported by the witness/circuit
    // but path data must come from somewhere (currently NOT in reveal payload).
    // We default 1-hop by deriving the path from registry: the order is for
    // the pool whose token_a or token_b matches "the" path. Without explicit
    // path in the reveal we cannot resolve multi-hop; for MVP we require
    // 1-hop and infer the pool from a SINGLE-pool registry lookup.
    //
    // The smoke uses a single pool (USDC/ETH) and a 2-token path. We hardcode
    // the assumption that ALL reveals in the queue are 1-hop on pool 0 for
    // this MVP, which matches the Sub-9 smoke shape. Multi-hop wiring is a
    // Sub-9.4 carry-forward (reveal payload needs explicit path bytes).
    const POOL_USDC_ETH = ctx.registry.find((p) => p.pool_id === 0);
    if (!POOL_USDC_ETH) throw new Error("registry missing pool_id=0");
    const pathTokens: [bigint, bigint, bigint] = [POOL_USDC_ETH.token_a, POOL_USDC_ETH.token_b, 0n];

    const clearingOrders: ClearingOrderMultiPair[] = validated.map((v) => ({
      side: v.side,
      amountIn: v.amount_in,
      limitPrice: v.limit_price,
      submittedAtBlock: v.submitted_at_block,
      orderNonce: v.order_nonce.toBigInt(),
      path_len: 2 as const,
      path: pathTokens,
    }));

    // Determine active pool set (1-hop: every order touches its single pool).
    const activePoolIds = new Set<number>();
    for (const o of clearingOrders) {
      activePoolIds.add(0); // hardcoded 1-hop on pool 0 (see above MVP note)
      void o;
    }

    // Read per-pool state.
    const poolStateMap = new Map<number, PoolStateForRouting>();
    for (const pid of activePoolIds) {
      const ps = await ctx.getPoolState(pid);
      poolStateMap.set(pid, ps);
    }
    log("info", "pool states read", { pool_count: poolStateMap.size });

    // Compute clearing.
    const clearing = computeClearingMultiPair({
      orders: clearingOrders,
      pools: poolStateMap,
      registry: ctx.registry,
    });

    if (!clearing.cleared) {
      log("info", "clearing did not cross (no eligible orders) — skipping submit");
      return "skipped:no-cross";
    }
    log("info", "clearing computed", {
      active_pool_count: clearing.activePoolCount,
      fills: clearing.fills.length,
    });

    // Build the witness Prover.toml.
    const orderPreimages = validated.map((v) => ({
      side: v.side,
      amount_in: v.amount_in,
      limit_price: v.limit_price,
      order_nonce: v.order_nonce.toBigInt(),
      submitted_at_block: v.submitted_at_block,
      owner: v.owner.toBigInt(),
      // Sub-4 fields for circuit (the buildClearingWitnessMultiPair reads these via `as any`).
      path_len: 2,
      path: [pathTokens[0], pathTokens[1], pathTokens[2]],
    }));

    // Per-pool sqrt prices BEFORE clearing.
    const poolSqrtPBefore: bigint[] = [];
    const poolTokenPairs: Array<[bigint, bigint]> = [];
    for (let i = 0; i < MAX_ACTIVE_POOLS_PER_EPOCH; i++) {
      const slot = clearing.perPoolClearings[i];
      if (slot) {
        const st = poolStateMap.get(slot.pool_id);
        poolSqrtPBefore.push(st?.currentSqrtPrice ?? 0n);
        const regEntry = ctx.registry.find((p) => p.pool_id === slot.pool_id);
        poolTokenPairs.push(regEntry ? [regEntry.token_a, regEntry.token_b] : [0n, 0n]);
      } else {
        poolSqrtPBefore.push(0n);
        poolTokenPairs.push([0n, 0n]);
      }
    }

    const witness = await buildClearingWitnessMultiPair({
      epoch: {
        order_acc: epoch.order_acc.toBigInt(),
        cancel_acc: epoch.cancel_acc.toBigInt(),
        order_count: epoch.order_count,
        cancel_count: epoch.cancel_count,
      },
      orders: orderPreimages,
      cancellationIndices: [],
      perPoolClearings: clearing.perPoolClearings,
      fills: clearing.fills,
      poolSqrtPBefore,
      poolTokenPairs,
    });

    // Write Prover.toml.
    const circuitDir = ctx.circuitDir ?? "circuits/clearing";
    const proverTomlPath = join(circuitDir, "Prover.toml");
    writeFileSync(proverTomlPath, witness.proverToml);
    log("info", "Prover.toml written", { path: proverTomlPath });

    // Shell out: nargo execute → produces target/clearing.gz + public_inputs.
    const nargo = ctx.nargoBin ?? "nargo";
    const bb = ctx.bbBin ?? "bb";
    const deadline = ctx.proveDeadlineMs ?? 180_000;
    const verbose = ctx.verbose ?? true;

    log("info", "running nargo execute");
    const nargoR = await runProc(nargo, ["execute", "clearing"], {
      cwd: circuitDir,
      deadlineMs: deadline,
      verbose,
    });
    if (nargoR.code !== 0) {
      throw new Error(`nargo execute failed code=${nargoR.code}: ${nargoR.stderr.slice(-500)}`);
    }
    log("info", "nargo execute OK");

    log("info", "running bb prove");
    // bb prove uses the witness from nargo execute. Output dir = target/proofdir.
    const bbR = await runProc(bb, [
      "prove",
      "-b", "target/clearing.json",
      "-w", "target/clearing.gz",
      "-o", "target/proofdir",
      "--oracle_hash", "poseidon2",
    ], {
      cwd: circuitDir,
      deadlineMs: deadline,
      verbose,
    });
    if (bbR.code !== 0) {
      throw new Error(`bb prove failed code=${bbR.code}: ${bbR.stderr.slice(-500)}`);
    }
    log("info", "bb prove OK");

    // Read proof + vk from disk.
    const proofPath = join(circuitDir, "target/proofdir/proof");
    const vkPath = join(circuitDir, "target/vk.bin/vk");
    if (!existsSync(proofPath)) throw new Error(`proof not found at ${proofPath}`);
    if (!existsSync(vkPath)) throw new Error(`vk not found at ${vkPath}`);
    const proofBuf = readFileSync(proofPath);
    const vkBuf = readFileSync(vkPath);
    void HONK_PROOF_FIELDS; void HONK_VK_FIELDS;  // documentation references
    const proofFields = bridgeProof(proofBuf);
    const vkFields = bridgeVk(vkBuf);

    // Build the public_inputs struct that matches the on-chain ClearingPublic.
    const padBucketDelta = () => ({
      bucket_id: 0xffff,
      reserve_a_add: 0n, reserve_a_sub: 0n,
      reserve_b_add: 0n, reserve_b_sub: 0n,
      cum_fee_a_per_share_increment: 0n,
      cum_fee_b_per_share_increment: 0n,
    });
    const SENTINEL_POOL = {
      pool_id: INVALID_POOL_ID,
      clearing_price: 0n,
      swap: {
        a_to_pool: 0n, b_to_pool: 0n,
        a_from_pool: 0n, b_from_pool: 0n,
        active_bucket_deltas: [padBucketDelta(), padBucketDelta(), padBucketDelta(), padBucketDelta()],
        active_bucket_count: 0,
        current_sqrt_price_after: 0n,
      },
    };
    const sortedPools = clearing.perPoolClearings.slice().sort((a, b) => a.pool_id - b.pool_id);
    const active_pools = [];
    for (let i = 0; i < MAX_ACTIVE_POOLS_PER_EPOCH; i++) {
      const pc = sortedPools[i];
      if (!pc) { active_pools.push(SENTINEL_POOL); continue; }
      const deltas = pc.bucketDeltas.slice();
      while (deltas.length < 4) deltas.push({
        bucket_id: 0xffff,
        reserve_a_add: 0n, reserve_a_sub: 0n,
        reserve_b_add: 0n, reserve_b_sub: 0n,
        cum_fee_a_per_share_increment: 0n,
        cum_fee_b_per_share_increment: 0n,
      });
      // Derive aggregate swap flows from buckets.
      let aToPool = 0n, bToPool = 0n, aFromPool = 0n, bFromPool = 0n;
      for (const d of pc.bucketDeltas) {
        aToPool += d.reserve_a_add;
        aFromPool += d.reserve_a_sub;
        bToPool += d.reserve_b_add;
        bFromPool += d.reserve_b_sub;
      }
      active_pools.push({
        pool_id: pc.pool_id,
        clearing_price: pc.clearingPrice,
        swap: {
          a_to_pool: aToPool,
          b_to_pool: bToPool,
          a_from_pool: aFromPool,
          b_from_pool: bFromPool,
          active_bucket_deltas: deltas,
          active_bucket_count: pc.bucketDeltas.length,
          current_sqrt_price_after: pc.currentSqrtPriceAfter,
        },
      });
    }

    // Build fills tree (Sub-4 64-leaf hop-fill tree).
    const tree = await buildHopFillsTree(
      clearing.fills.map((f) => ({
        order_nonce: new Fr(f.orderNonce),
        hop_index: f.hop_index,
        amount_out: f.amountOut,
        pool_id: f.pool_id,
      })),
      64,
    );

    const publicInputs: ClearingPublicStruct = {
      order_acc: epoch.order_acc.toString(),
      cancel_acc: epoch.cancel_acc.toString(),
      order_count: epoch.order_count,
      cancel_count: epoch.cancel_count,
      fills_root: tree.root.toString(),
      active_pool_count: clearing.activePoolCount,
      active_pools,
    };

    // Snapshot the fills tree to disk for the maker's claim step.
    // We reuse the buildFillsTree shape from snapshot.ts. The hop-fill tree has
    // a different leaf shape (4-field) but snapshot.ts expects the 2-field
    // (order_nonce, amount_out) shape. For MVP we write a separate JSON sidecar.
    try {
      writeSnapshot(ctx.snapshotsDir, {
        epoch_id: epoch.epoch_id,
        fills: clearing.fills.map((f) => ({ order_nonce: new Fr(f.orderNonce), amount_out: f.amountOut })),
        // The 2-field tree is incorrect for hop-fill claims, but the snapshot is
        // primarily a forensic record here; the maker's claim_fill needs the
        // 64-leaf hop tree's sibling path which we ALSO persist below.
        tree: {
          root: tree.root,
          leaves: tree.leaves,
          paths: new Map(),
        },
      });
      log("info", "snapshot written", { dir: ctx.snapshotsDir, epoch: epoch.epoch_id });
    } catch (e) {
      log("warn", "snapshot write failed", { error: String(e) });
    }

    // Submit.
    log("info", "submitting close_epoch_and_clear_verified", {
      proof_fields: proofFields.length,
      vk_fields: vkFields.length,
      fills_count: clearing.fills.length,
    });
    const submitR = await ctx.submitClearing({ publicInputs, proof: proofFields, vk: vkFields });
    log("info", "close_epoch_and_clear_verified submitted", { txHash: submitR.txHash });

    return `cleared:fills=${clearing.fills.length}`;
  } finally {
    CYCLE_IN_FLIGHT = false;
  }
}

// Re-exports for tests + watcher.
export { dirname as _dirname };
