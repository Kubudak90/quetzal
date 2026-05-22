/**
 * Clearing daemon. Polls on-chain state; at epoch close, drains the queue,
 * validates reveals, computes clearing, runs bb prove (shelled out), submits
 * to Orderbook.close_epoch_and_clear_verified. Race losers see a clean revert
 * and proceed to the next epoch.
 *
 * The single-cycle entrypoint `runOneClearingCycle` is exported for tests; the
 * long-running loop `runDaemon` invokes it on a polling interval.
 */
import { Fr } from "@aztec/aztec.js/fields";
import type { RevealQueue } from "./queue.js";
import { validateReveals } from "./validate.js";
import { computeClearing, type ClearingOrder } from "./clearing.js";
import { buildClearingWitness, type OrderNotePreimage } from "./witness.js";
import { buildFillsTree } from "./merkle.js";
import { writeSnapshot } from "./snapshot.js";

export interface DaemonContext {
  queue: RevealQueue;
  snapshotsDir: string;
  /** Read the orderbook's current epoch state. */
  getEpoch: () => Promise<{
    epoch_id: number; closes_at_block: number;
    order_acc: Fr; order_count: number;
    cancel_acc: Fr; cancel_count: number;
  }>;
  /** Read the pool's reserves + lp_supply. */
  getPool: () => Promise<{ reserve_a: bigint; reserve_b: bigint; lp_supply: bigint }>;
  /** Read current L2 block height. */
  getBlockNumber: () => Promise<number>;
  /** Shell out: nargo execute on the witness, return path to clearing.gz. */
  runNargoExecute: (proverToml: string) => Promise<void>;
  /** Shell out: bb prove and return the binary proof. */
  runBbProve: () => Promise<Buffer>;
  /** Read the pre-computed vk binary. */
  getVkBytes: () => Promise<Buffer>;
  /** Submit the clearing tx to the orderbook. */
  submitClearing: (args: {
    publicInputs: unknown;
    proof: Fr[];
    vk: Fr[];
  }) => Promise<void>;
}

const HONK_PROOF_FIELDS = 500;
const HONK_VK_FIELDS = 115;
const CONTRACT_PROOF_SIZE = 456;
const CONTRACT_VK_SIZE = 127;

function bridgeProof(buf: Buffer): Fr[] {
  const fields: Fr[] = [];
  for (let i = 0; i < HONK_PROOF_FIELDS; i++) {
    fields.push(Fr.fromBuffer(buf.subarray(i * 32, (i + 1) * 32)));
  }
  return fields.slice(0, CONTRACT_PROOF_SIZE);
}

function bridgeVk(buf: Buffer): Fr[] {
  const fields: Fr[] = [];
  for (let i = 0; i < HONK_VK_FIELDS; i++) {
    fields.push(Fr.fromBuffer(buf.subarray(i * 32, (i + 1) * 32)));
  }
  while (fields.length < CONTRACT_VK_SIZE) fields.push(Fr.ZERO);
  return fields;
}

export async function runOneClearingCycle(ctx: DaemonContext): Promise<void> {
  const epoch = await ctx.getEpoch();
  const blockNow = await ctx.getBlockNumber();

  if (blockNow < epoch.closes_at_block) return;

  const reveals = ctx.queue.drainEpoch(epoch.epoch_id);
  const validated = await validateReveals(reveals, epoch.order_acc);
  if (validated.length === 0 && epoch.order_count > 0) {
    // Don't have all reveals (or tampering detected). Skip - another aggregator
    // who DOES have the complete set can win this round.
    return;
  }

  const clearingOrders: ClearingOrder[] = validated.map((v) => ({
    side: v.side,
    amountIn: v.amount_in,
    limitPrice: v.limit_price,
    submittedAtBlock: v.submitted_at_block,
    orderNonce: v.order_nonce.toBigInt(),
  }));
  const orderPreimages: OrderNotePreimage[] = validated.map((v) => ({
    side: v.side,
    amount_in: v.amount_in,
    limit_price: v.limit_price,
    order_nonce: v.order_nonce.toBigInt(),
    submitted_at_block: v.submitted_at_block,
    owner: v.owner.toBigInt(),
  }));

  const pool = await ctx.getPool();
  const clearing = computeClearing(
    { reserveA: pool.reserve_a, reserveB: pool.reserve_b, lpSupply: pool.lp_supply },
    clearingOrders,
  );
  if (!clearing.cleared && clearingOrders.length > 0) {
    // No convergence - let close_epoch's no-clear path advance the epoch.
    return;
  }

  const witness = await buildClearingWitness({
    epoch: {
      order_acc: epoch.order_acc.toBigInt(),
      cancel_acc: epoch.cancel_acc.toBigInt(),
      order_count: epoch.order_count,
      cancel_count: epoch.cancel_count,
    },
    pool: { reserve_a: pool.reserve_a, reserve_b: pool.reserve_b, current_sqrt_price_before: 0n },
    orders: orderPreimages,
    cancellationIndices: [],  // Sub-3 daemon does not collect cancel reveals yet
    clearing,
    bucketStatesBefore: [],
    bucketStatesAfter: [],
    bucketDeltas: [],
    currentSqrtPriceAfter: 0n,
  });

  await ctx.runNargoExecute(witness.proverToml);
  const proofBuf = await ctx.runBbProve();
  const vkBuf = await ctx.getVkBytes();

  const tree = await buildFillsTree(
    clearing.fills.map((f) => ({ order_nonce: new Fr(f.orderNonce), amount_out: f.amountOut })),
  );
  writeSnapshot(ctx.snapshotsDir, {
    epoch_id: epoch.epoch_id,
    fills: clearing.fills.map((f) => ({ order_nonce: new Fr(f.orderNonce), amount_out: f.amountOut })),
    tree,
  });

  // Build the on-chain ClearingPublic struct shape.
  const deltaA = clearing.newReserveA - pool.reserve_a;
  const deltaB = clearing.newReserveB - pool.reserve_b;
  const publicInputs = {
    order_acc: epoch.order_acc.toBigInt(),
    cancel_acc: epoch.cancel_acc.toBigInt(),
    order_count: epoch.order_count,
    cancel_count: epoch.cancel_count,
    reserve_a: pool.reserve_a,
    reserve_b: pool.reserve_b,
    lp_supply: pool.lp_supply,
    clearing_price: clearing.clearingPrice,
    fills_root: tree.root.toBigInt(),
    swap: {
      a_to_pool: 0n, b_to_pool: 0n, a_from_pool: 0n, b_from_pool: 0n,
      reserve_a_add: deltaA > 0n ? deltaA : 0n,
      reserve_a_sub: deltaA < 0n ? -deltaA : 0n,
      reserve_b_add: deltaB > 0n ? deltaB : 0n,
      reserve_b_sub: deltaB < 0n ? -deltaB : 0n,
      fee_a_per_share_increment: clearing.feeAPerShareIncrement,
      fee_b_per_share_increment: clearing.feeBPerShareIncrement,
    },
  };

  try {
    await ctx.submitClearing({
      publicInputs,
      proof: bridgeProof(proofBuf),
      vk: bridgeVk(vkBuf),
    });
  } catch (e) {
    // Race lost or freshness mismatch. Log + continue.
    console.warn("clearing submit failed (likely race-loss):", (e as Error).message);
  }
}

export async function runDaemon(ctx: DaemonContext, intervalMs = 2000): Promise<void> {
  while (true) {
    try {
      await runOneClearingCycle(ctx);
    } catch (e) {
      console.error("daemon cycle error:", e);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
