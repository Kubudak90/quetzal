/**
 * Build a Prover.toml witness from the aggregator's ClearingResult + on-chain
 * EpochState. The output feeds `nargo execute --prover-name <stem>` for the
 * clearing circuit at circuits/clearing/. The TOML field names + ordering must
 * match circuits/clearing/src/main.nr's fn main parameter list.
 *
 * IMPORTANT: The TS aggregator's ClearingResult.fills use a different fee model than
 * the Noir circuit's `payout()` function. The circuit checks each fill's amount_out
 * against `payout(order, clearing_price)` = amount_in * SCALE/P* * (FEE_DEN-FEE_NUM)/FEE_DEN.
 * The witness builder MUST recompute fills using the circuit's canonical formula.
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
  /** Override the circuit's MAX_ORDERS_PER_EPOCH for smaller test circuits (default: 128). */
  maxOrders?: number;
}): ClearingWitness {
  const { epoch, pool, orders, cancellationIndices, clearing } = args;
  const maxPerEpoch = args.maxOrders ?? MAX_ORDERS_PER_EPOCH;
  if (orders.length !== epoch.order_count) {
    throw new Error(`orders.length (${orders.length}) != epoch.order_count (${epoch.order_count})`);
  }
  if (cancellationIndices.length !== epoch.cancel_count) {
    throw new Error(`cancellationIndices.length (${cancellationIndices.length}) != epoch.cancel_count (${epoch.cancel_count})`);
  }

  // Pad orders to maxPerEpoch with zero sentinels.
  const ordersPadded: OrderNotePreimage[] = orders.slice();
  while (ordersPadded.length < maxPerEpoch) {
    ordersPadded.push({
      side: false, amount_in: 0n, limit_price: 0n,
      order_nonce: 0n, submitted_at_block: 0, owner: 0n,
    });
  }

  const cancelledPadded: number[] = cancellationIndices.slice();
  while (cancelledPadded.length < maxPerEpoch) {
    cancelledPadded.push(0);
  }

  // =========================================================================
  // Build CIRCUIT-CANONICAL fills.
  //
  // The TS aggregator's ClearingResult.fills use a pro-rata distribution model
  // that does NOT match the circuit's per-order payout formula.  The circuit
  // asserts each fill's amount_out == payout(order, clearing_price) where:
  //
  //   buy payout  = floor( floor(amount_in * SCALE / P*) * (FEE_DEN - FEE_NUM) / FEE_DEN )
  //   sell payout = floor( floor(amount_in * P* / SCALE) * (FEE_DEN - FEE_NUM) / FEE_DEN )
  //
  // We re-derive canonical fills from the ELIGIBLE orders (those in clearing.fills)
  // using the circuit's exact formula, keyed on order_nonce.
  // =========================================================================
  const SCALE = 1_000_000_000_000_000_000n;
  const FEE_NUM_CIRCUIT = 30n;
  const FEE_DEN_CIRCUIT = 10_000n;

  /** Replicate circuits/clearing/src/pricing.nr::payout(). */
  function circuitPayout(order: OrderNotePreimage, clearingPrice: bigint): bigint {
    const gross = order.side
      ? (order.amount_in * clearingPrice) / SCALE            // sell: in_B * P* / SCALE → A
      : (order.amount_in * SCALE) / clearingPrice;           // buy:  in_A * SCALE / P* → B
    return (gross * (FEE_DEN_CIRCUIT - FEE_NUM_CIRCUIT)) / FEE_DEN_CIRCUIT;
  }

  // Collect the set of filled order nonces (from the aggregator's result) and
  // map them to orders[].  The aggregator decides WHICH orders are filled;
  // the circuit decides HOW MUCH each filled order receives.
  //
  // Validate: every nonce in clearing.fills must appear in orders[].
  const orderNonceSet = new Set(orders.map((o) => o.order_nonce));
  for (const fill of clearing.fills) {
    if (!orderNonceSet.has(fill.orderNonce)) {
      throw new Error(`fill order_nonce ${fill.orderNonce} not in orders[]`);
    }
  }

  const filledNonces = new Set(clearing.fills.map((f) => f.orderNonce));
  const canonicalFills: { orderNonce: bigint; amountOut: bigint }[] = [];
  const fillToOrderIndex: number[] = [];

  for (let i = 0; i < orders.length; i++) {
    const o = orders[i]!;
    if (filledNonces.has(o.order_nonce)) {
      canonicalFills.push({
        orderNonce: o.order_nonce,
        amountOut: circuitPayout(o, clearing.clearingPrice),
      });
      fillToOrderIndex.push(i);
    }
  }
  while (fillToOrderIndex.length < maxPerEpoch) {
    fillToOrderIndex.push(0);
  }

  // =========================================================================
  // Derive ClearingSwap fields using the CANONICAL fills (not clearing.fills).
  // =========================================================================

  // Step 1: accumulate gross flows and canonical payouts from canonical fills.
  let grossBuyInA = 0n;
  let grossSellInB = 0n;
  let buyerPayoutsB = 0n;
  let sellerPayoutsA = 0n;
  for (const cf of canonicalFills) {
    const order = orders.find((o) => o.order_nonce === cf.orderNonce);
    if (!order) continue;                            // can't happen — just satisfies TS
    if (order.side) {
      grossSellInB  += order.amount_in;
      sellerPayoutsA += cf.amountOut;
    } else {
      grossBuyInA   += order.amount_in;
      buyerPayoutsB  += cf.amountOut;
    }
  }

  // Step 2: pool-side gross flows (sec 6.5 circuit formulas).
  const sat = (x: bigint, y: bigint) => (x > y ? x - y : 0n);
  const aToPool   = sat(grossBuyInA,  sellerPayoutsA);
  const aFromPool = sat(sellerPayoutsA, grossBuyInA);
  const bToPool   = sat(grossSellInB, buyerPayoutsB);
  const bFromPool = sat(buyerPayoutsB, grossSellInB);

  // Step 3: LP fee withheld from output (sec 6.5 circuit formulas).
  //   gross_buy_out_b  = floor(gross_buy_in_a  * SCALE / clearing_price)
  //   gross_sell_out_a = floor(gross_sell_in_b * clearing_price / SCALE)
  //   fee_pool_b = gross_buy_out_b  - buyer_payouts_b
  //   fee_pool_a = gross_sell_out_a - seller_payouts_a
  const grossBuyOutB  = clearing.clearingPrice > 0n
    ? (grossBuyInA  * SCALE) / clearing.clearingPrice : 0n;
  const grossSellOutA = clearing.clearingPrice > 0n
    ? (grossSellInB * clearing.clearingPrice) / SCALE : 0n;
  const feePoolA = grossSellOutA >= sellerPayoutsA ? grossSellOutA - sellerPayoutsA : 0n;
  const feePoolB = grossBuyOutB  >= buyerPayoutsB  ? grossBuyOutB  - buyerPayoutsB  : 0n;

  const feeAPerShareIncrement = pool.lp_supply > 0n
    ? (feePoolA * SCALE) / pool.lp_supply : 0n;
  const feeBPerShareIncrement = pool.lp_supply > 0n
    ? (feePoolB * SCALE) / pool.lp_supply : 0n;

  // Step 4: reserve deltas from the accounting identity (sec 6.5.23/24):
  //   reserve_a_add - reserve_a_sub = a_to_pool - a_from_pool - fee_pool_a
  //   reserve_b_add - reserve_b_sub = b_to_pool - b_from_pool - fee_pool_b
  const netFlowA = aToPool - aFromPool - feePoolA;
  const netFlowB = bToPool - bFromPool - feePoolB;
  const reserveAAdd = netFlowA > 0n ? netFlowA : 0n;
  const reserveASub = netFlowA < 0n ? -netFlowA : 0n;
  const reserveBAdd = netFlowB > 0n ? netFlowB : 0n;
  const reserveBSub = netFlowB < 0n ? -netFlowB : 0n;

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
  lines.push(`fills_len = ${canonicalFills.length}`);

  // fills: array of maxPerEpoch FillEntry structs (circuit-canonical payouts). Pad past fills_len.
  lines.push(`fills = [`);
  for (let i = 0; i < maxPerEpoch; i++) {
    const f = i < canonicalFills.length ? canonicalFills[i] : null;
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
    `fee_a_per_share_increment = "${feeAPerShareIncrement}", ` +
    `fee_b_per_share_increment = "${feeBPerShareIncrement}" ` +
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
