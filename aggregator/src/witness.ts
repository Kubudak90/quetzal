/**
 * Build a Prover.toml witness from the aggregator's ClearingResult + on-chain
 * EpochState. The output feeds `nargo execute --prover-name <stem>` for the
 * clearing circuit at circuits/clearing/. The TOML field names + ordering must
 * match circuits/clearing/src/main.nr's fn main parameter list.
 */
import { type ClearingResult } from "./clearing.js";

export const MAX_ORDERS_PER_EPOCH = 128;

/** Mirror of contracts/orderbook/src/main.nr's EpochState (subset the circuit binds to). */
export interface EpochState {
  order_acc: bigint;       // Field
  cancel_acc: bigint;      // Field
  order_count: number;
  cancel_count: number;
}

/** Mirror of contracts/orderbook/src/main.nr's OrderNote. */
export interface OrderNotePreimage {
  side: boolean;
  amount_in: bigint;
  limit_price: bigint;
  order_nonce: bigint;
  submitted_at_block: number;
  owner: bigint;           // AztecAddress.toField().toBigInt()
}

/** Pre-clearing pool snapshot. */
export interface PoolSnapshotForCircuit {
  reserve_a: bigint;
  reserve_b: bigint;
  lp_supply: bigint;
}

export interface ClearingWitness {
  /** TOML-encoded text to write to circuits/clearing/Prover.toml. */
  proverToml: string;
}

/**
 * Build the Prover.toml witness for the clearing circuit.
 *
 * @param args.epoch    On-chain EpochState (binding inputs).
 * @param args.pool     Pre-clearing pool snapshot.
 * @param args.orders   Submission-order array of OrderNote preimages. Length must equal
 *                      args.epoch.order_count. The builder pads to MAX_ORDERS_PER_EPOCH.
 * @param args.cancellationIndices  In cancellation order, each entry is the submission
 *                      index of the cancelled order. Length must equal args.epoch.cancel_count.
 * @param args.clearing The aggregator's ClearingResult (P*, fills, swap).
 */
export function buildClearingWitness(args: {
  epoch: EpochState;
  pool: PoolSnapshotForCircuit;
  orders: OrderNotePreimage[];
  cancellationIndices: number[];
  clearing: ClearingResult;
}): ClearingWitness {
  const { epoch, pool, orders, cancellationIndices, clearing } = args;
  if (orders.length !== epoch.order_count) {
    throw new Error(`orders.length (${orders.length}) != epoch.order_count (${epoch.order_count})`);
  }
  if (cancellationIndices.length !== epoch.cancel_count) {
    throw new Error(`cancellationIndices.length (${cancellationIndices.length}) != epoch.cancel_count (${epoch.cancel_count})`);
  }

  // Pad orders to MAX with zero sentinels.
  const ordersPadded: OrderNotePreimage[] = orders.slice();
  while (ordersPadded.length < MAX_ORDERS_PER_EPOCH) {
    ordersPadded.push({
      side: false, amount_in: 0n, limit_price: 0n,
      order_nonce: 0n, submitted_at_block: 0, owner: 0n,
    });
  }

  const cancelledPadded: number[] = cancellationIndices.slice();
  while (cancelledPadded.length < MAX_ORDERS_PER_EPOCH) {
    cancelledPadded.push(0);
  }

  // fill_to_order_index[i] = submission index of orders matching fills[i].orderNonce.
  const fillToOrderIndex: number[] = clearing.fills.map((fill) => {
    const idx = orders.findIndex((o) => o.order_nonce === fill.orderNonce);
    if (idx < 0) {
      throw new Error(`fill order_nonce ${fill.orderNonce} not in orders[]`);
    }
    return idx;
  });
  while (fillToOrderIndex.length < MAX_ORDERS_PER_EPOCH) {
    fillToOrderIndex.push(0);
  }

  // Derive ClearingSwap fields from the aggregator's ClearingResult.
  //
  // NOTE: ClearingResult does NOT expose a netSwap field — the NetSwap struct is
  // internal to computeClearing(). We synthesise the circuit's swap witness from
  // the reserve-delta identity:
  //
  //   reserve_*_add = max(newReserve* - oldReserve*, 0)
  //   reserve_*_sub = max(oldReserve* - newReserve*, 0)
  //
  // The gross user-side flows (a_to_pool, b_from_pool, etc.) equal the same
  // reserve deltas because the 0.3% LP fee is tracked in the separate
  // feeAPerShareIncrement / feeBPerShareIncrement counters and is NOT added to
  // reserves by the clearing circuit.
  const reserveADelta = clearing.newReserveA - pool.reserve_a;
  const reserveBDelta = clearing.newReserveB - pool.reserve_b;
  const reserveAAdd = reserveADelta > 0n ? reserveADelta : 0n;
  const reserveASub = reserveADelta < 0n ? -reserveADelta : 0n;
  const reserveBAdd = reserveBDelta > 0n ? reserveBDelta : 0n;
  const reserveBSub = reserveBDelta < 0n ? -reserveBDelta : 0n;

  // Net swap aggregates: when token A flows into the pool (reserveADelta > 0)
  // that is aToPool; when it flows out that is aFromPool. Symmetrically for B.
  const aToPool = reserveAAdd;
  const aFromPool = reserveASub;
  const bToPool = reserveBAdd;
  const bFromPool = reserveBSub;

  // Build the TOML.
  const lines: string[] = [];
  lines.push(`order_acc = "0x${epoch.order_acc.toString(16)}"`);
  lines.push(`cancel_acc = "0x${epoch.cancel_acc.toString(16)}"`);
  lines.push(`order_count = ${epoch.order_count}`);
  lines.push(`cancel_count = ${epoch.cancel_count}`);
  lines.push(`reserve_a = "${pool.reserve_a}"`);
  lines.push(`reserve_b = "${pool.reserve_b}"`);
  lines.push(`lp_supply = "${pool.lp_supply}"`);
  lines.push(`clearing_price = "${clearing.clearingPrice}"`);
  lines.push(`fills_len = ${clearing.fills.length}`);

  // fills: array of 128 FillEntry structs. Pad with zeros past fills_len.
  lines.push(`fills = [`);
  for (let i = 0; i < MAX_ORDERS_PER_EPOCH; i++) {
    const f = i < clearing.fills.length ? clearing.fills[i] : null;
    const nonce = f ? `"0x${f.orderNonce.toString(16)}"` : `"0x0"`;
    const out = f ? `"${f.amountOut}"` : `"0"`;
    lines.push(`  { order_nonce = ${nonce}, amount_out = ${out} },`);
  }
  lines.push(`]`);

  // swap struct (TOML inline-table).
  lines.push(`swap = { ` +
    `a_to_pool = "${aToPool}", ` +
    `b_to_pool = "${bToPool}", ` +
    `a_from_pool = "${aFromPool}", ` +
    `b_from_pool = "${bFromPool}", ` +
    `reserve_a_add = "${reserveAAdd}", ` +
    `reserve_a_sub = "${reserveASub}", ` +
    `reserve_b_add = "${reserveBAdd}", ` +
    `reserve_b_sub = "${reserveBSub}", ` +
    `fee_a_per_share_increment = "${clearing.feeAPerShareIncrement}", ` +
    `fee_b_per_share_increment = "${clearing.feeBPerShareIncrement}" ` +
    `}`);

  // orders: array of 128 OrderPreimage.
  lines.push(`orders = [`);
  for (const o of ordersPadded) {
    lines.push(`  { ` +
      `side = ${o.side}, ` +
      `amount_in = "${o.amount_in}", ` +
      `limit_price = "${o.limit_price}", ` +
      `order_nonce = "0x${o.order_nonce.toString(16)}", ` +
      `submitted_at_block = ${o.submitted_at_block}, ` +
      `owner = "0x${o.owner.toString(16)}" ` +
      `},`);
  }
  lines.push(`]`);

  // cancelled_indices + fill_to_order_index: flat arrays of u32.
  lines.push(`cancelled_indices = [${cancelledPadded.join(", ")}]`);
  lines.push(`fill_to_order_index = [${fillToOrderIndex.join(", ")}]`);

  return { proverToml: lines.join("\n") + "\n" };
}
