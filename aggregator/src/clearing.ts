/**
 * Frequent-batch-auction clearing for ZSwap. Pure computation - given a pool
 * snapshot and a set of orders, `computeClearing` produces the uniform clearing
 * price, the per-order fills, the post-clearing reserves, and the LP fee accrual.
 *
 * See docs/superpowers/specs/2026-05-19-zswap-aztec-week-05b-clearing-aggregator-design.md
 */
import { mulDiv, SCALE, FEE_NUM, FEE_DEN } from "./fixed-point.js";

/** Maximum orders cleared in one epoch; the rest carry over. */
export const MAX_ORDERS_PER_EPOCH = 32;
/** Clearing-price search band: [spot / PRICE_BAND, spot * PRICE_BAND]. */
export const PRICE_BAND = 100n;
/** Bisection stops when |realizedP - P| <= TOLERANCE (1e-9 of a price unit). */
export const TOLERANCE = 1_000_000_000n;
/** Bisection iteration cap. */
export const MAX_ITERS = 128;

/** One submitted order, as the aggregator sees it. */
export interface ClearingOrder {
  /** false = buy (pays token A, wants token B); true = sell (pays token B, wants token A). */
  side: boolean;
  /** Input amount in base units (token A for a buy, token B for a sell). */
  amountIn: bigint;
  /** Limit price, quote-per-base, 1e18-scaled. Buy: max it will pay. Sell: min it accepts. */
  limitPrice: bigint;
  /** L2 block of submission - the FIFO ordering key. */
  submittedAtBlock: number;
  /** The OrderNote identity nonce. */
  orderNonce: bigint;
}

/** Pool reserves + LP supply at clearing time. */
export interface PoolSnapshot {
  reserveA: bigint;
  reserveB: bigint;
  lpSupply: bigint;
}

/** One filled order. */
export interface OrderFill {
  orderNonce: bigint;
  /** Amount of `amountIn` consumed - always == amountIn in this slice (full fills). */
  filledIn: bigint;
  /** Output token received (token B for a buy, token A for a sell). */
  amountOut: bigint;
}

/** The result of clearing one epoch. */
export interface ClearingResult {
  /** false => epoch skipped (no eligible orders / no convergence / degenerate pool). */
  cleared: boolean;
  /** Uniform clearing price P*, 1e18-scaled (0n when cleared == false). */
  clearingPrice: bigint;
  /** One entry per filled order; empty when cleared == false. */
  fills: OrderFill[];
  newReserveA: bigint;
  newReserveB: bigint;
  /** cum_fee_a_per_share delta, 1e18-scaled. */
  feeAPerShareIncrement: bigint;
  /** cum_fee_b_per_share delta, 1e18-scaled. */
  feeBPerShareIncrement: bigint;
}

/**
 * Step 1: the epoch's batch - the <= MAX_ORDERS_PER_EPOCH oldest orders by
 * `submittedAtBlock`, ties broken by `orderNonce` ascending (total order, for
 * determinism). The input array is not mutated.
 */
export function selectBatch(orders: ClearingOrder[]): ClearingOrder[] {
  return [...orders]
    .sort((x, y) => {
      if (x.submittedAtBlock !== y.submittedAtBlock) {
        return x.submittedAtBlock - y.submittedAtBlock;
      }
      if (x.orderNonce < y.orderNonce) return -1;
      if (x.orderNonce > y.orderNonce) return 1;
      return 0;
    })
    .slice(0, MAX_ORDERS_PER_EPOCH);
}

/** The constant-product swap of the net imbalance. */
export interface NetSwap {
  newReserveA: bigint;
  newReserveB: bigint;
  /** Price the net swap executed at, quote-per-base 1e18-scaled. Equals `p` when netA == 0. */
  realizedP: bigint;
  /** LP fee withheld, in token A (non-zero only when token A flows in). */
  feeAmountA: bigint;
  /** LP fee withheld, in token B (non-zero only when token B flows in). */
  feeAmountB: bigint;
  /** Gross token A into the AMM (netA > 0 only). */
  ammAIn: bigint;
  /** Gross token A out of the AMM (netA < 0 only). */
  ammAOut: bigint;
  /** Gross token B into the AMM (netA < 0 only). */
  ammBIn: bigint;
  /** Gross token B out of the AMM (netA > 0 only). */
  ammBOut: bigint;
}

/**
 * Swap the signed net imbalance through the constant-product pool.
 * `netA > 0`: token A flows in. `netA < 0`: token B flows in (sized via `p`).
 * `netA == 0`: no swap. The 0.3% fee is WITHHELD from the swap input and reported
 * in `feeAmount*` - it is NOT added to the reserves (ZSwap tracks fees in a
 * separate per-share counter; see the spec, Step 4).
 */
export function simulateNet(
  reserveA: bigint,
  reserveB: bigint,
  netA: bigint,
  p: bigint,
): NetSwap {
  if (netA === 0n) {
    return {
      newReserveA: reserveA,
      newReserveB: reserveB,
      realizedP: p,
      feeAmountA: 0n,
      feeAmountB: 0n,
      ammAIn: 0n,
      ammAOut: 0n,
      ammBIn: 0n,
      ammBOut: 0n,
    };
  }
  if (netA > 0n) {
    const afterFee = (netA * FEE_NUM) / FEE_DEN;
    const feeAmountA = netA - afterFee;
    const outB = reserveB - mulDiv(reserveA, reserveB, reserveA + afterFee);
    return {
      newReserveA: reserveA + afterFee,
      newReserveB: reserveB - outB,
      realizedP: outB === 0n ? 0n : mulDiv(netA, SCALE, outB),
      feeAmountA,
      feeAmountB: 0n,
      ammAIn: netA,
      ammAOut: 0n,
      ammBIn: 0n,
      ammBOut: outB,
    };
  }
  // netA < 0: token B flows in. Its size is the token-A deficit valued at p.
  const inB = mulDiv(-netA, SCALE, p);
  const afterFee = (inB * FEE_NUM) / FEE_DEN;
  const feeAmountB = inB - afterFee;
  const outA = reserveA - mulDiv(reserveA, reserveB, reserveB + afterFee);
  return {
    newReserveA: reserveA - outA,
    newReserveB: reserveB + afterFee,
    realizedP: inB === 0n ? 0n : mulDiv(outA, SCALE, inB),
    feeAmountA: 0n,
    feeAmountB,
    ammAIn: 0n,
    ammAOut: outA,
    ammBIn: inB,
    ammBOut: 0n,
  };
}

/** The batch evaluated at one candidate clearing price. */
export interface PriceEval {
  netA: bigint;
  swap: NetSwap;
  eligibleBuys: ClearingOrder[];
  eligibleSells: ClearingOrder[];
}

/**
 * Evaluate `batch` at candidate price `p`: who is eligible, the net imbalance,
 * and the resulting AMM swap. A buy is eligible when `limitPrice >= p`; a sell
 * when `limitPrice <= p`.
 */
export function clearingAt(pool: PoolSnapshot, batch: ClearingOrder[], p: bigint): PriceEval {
  const eligibleBuys = batch.filter((o) => !o.side && o.limitPrice >= p);
  const eligibleSells = batch.filter((o) => o.side && o.limitPrice <= p);
  let sumAIn = 0n;
  for (const o of eligibleBuys) sumAIn += o.amountIn;
  let sumBIn = 0n;
  for (const o of eligibleSells) sumBIn += o.amountIn;
  const netA = sumAIn - mulDiv(sumBIn, p, SCALE);
  const swap = simulateNet(pool.reserveA, pool.reserveB, netA, p);
  return { netA, swap, eligibleBuys, eligibleSells };
}

/**
 * Step 3: binary-search the uniform clearing price P* where the net flow's AMM
 * execution price equals P* itself. Returns null when the pool is degenerate,
 * when the search band does not bracket a root, when the book cannot cross, or
 * on non-convergence - the caller treats null as "epoch skipped".
 *
 * On the region where orders are eligible the residual `realizedP(P) - P` is
 * monotonically decreasing. Outside it (every order gated out) the residual
 * would be a spurious 0; `probe` instead reports a direction so the search is
 * steered back onto the eligible region.
 */
export function findClearingPrice(pool: PoolSnapshot, batch: ClearingOrder[]): bigint | null {
  if (pool.reserveA === 0n || pool.reserveB === 0n || pool.lpSupply === 0n) return null;
  const spot = mulDiv(pool.reserveA, SCALE, pool.reserveB);
  let lo = spot / PRICE_BAND;
  if (lo < 1n) lo = 1n;
  let hi = spot * PRICE_BAND;

  const hasBuys = batch.some((o) => !o.side);
  const hasSells = batch.some((o) => o.side);

  // Probe a price: a residual when orders are eligible, else a direction
  // ("tooHigh" / "tooLow") or "gap" (a mixed book whose sides never overlap).
  type Probe = { residual: bigint } | { dir: "tooHigh" | "tooLow" | "gap" };
  const probe = (p: bigint): Probe => {
    const ev = clearingAt(pool, batch, p);
    if (ev.eligibleBuys.length === 0 && ev.eligibleSells.length === 0) {
      if (hasBuys && hasSells) return { dir: "gap" };
      if (hasBuys) return { dir: "tooHigh" }; // buys-only: every buy limit < p
      return { dir: "tooLow" }; // sells-only: every sell limit > p
    }
    return { residual: ev.swap.realizedP - p };
  };

  const loP = probe(lo);
  const hiP = probe(hi);
  if (("dir" in loP && loP.dir === "gap") || ("dir" in hiP && hiP.dir === "gap")) return null;
  // lo must sit at-or-below the root; hi at-or-above.
  const loOk = "dir" in loP ? loP.dir === "tooLow" : loP.residual >= 0n;
  const hiOk = "dir" in hiP ? hiP.dir === "tooHigh" : hiP.residual <= 0n;
  if (!loOk || !hiOk) return null;

  for (let i = 0; i < MAX_ITERS; i++) {
    const mid = (lo + hi) / 2n;
    const m = probe(mid);
    if ("dir" in m) {
      if (m.dir === "gap") return null;
      if (m.dir === "tooLow") lo = mid;
      else hi = mid;
    } else {
      if (m.residual >= -TOLERANCE && m.residual <= TOLERANCE) return mid;
      if (m.residual > 0n) lo = mid;
      else hi = mid;
    }
    if (hi - lo <= 1n) {
      // Settle on an endpoint that actually has eligible orders.
      if ("residual" in probe(lo)) return lo;
      if ("residual" in probe(hi)) return hi;
      return null;
    }
  }
  return null; // did not converge within MAX_ITERS
}

/** The "epoch skipped" result - reserves unchanged, nothing cleared. */
function skipped(pool: PoolSnapshot): ClearingResult {
  return {
    cleared: false,
    clearingPrice: 0n,
    fills: [],
    newReserveA: pool.reserveA,
    newReserveB: pool.reserveB,
    feeAPerShareIncrement: 0n,
    feeBPerShareIncrement: 0n,
  };
}

/**
 * Clear one epoch: select the FIFO batch, discover the uniform clearing price,
 * cross every eligible order fully at that price, route the net imbalance through
 * the AMM, and accrue the 0.3% fee to LPs.
 *
 * Returns `{ cleared: false, ... }` (a safe no-op) when the batch is empty, the
 * price search does not converge, or no order is eligible at P*.
 */
export function computeClearing(pool: PoolSnapshot, orders: ClearingOrder[]): ClearingResult {
  const batch = selectBatch(orders);
  if (batch.length === 0) return skipped(pool);

  const pStar = findClearingPrice(pool, batch);
  if (pStar === null) return skipped(pool);

  const ev = clearingAt(pool, batch, pStar);
  if (ev.eligibleBuys.length === 0 && ev.eligibleSells.length === 0) return skipped(pool);

  // Sum the eligible amounts on each side.
  let sumAIn = 0n;
  for (const o of ev.eligibleBuys) sumAIn += o.amountIn;
  let sumBIn = 0n;
  for (const o of ev.eligibleSells) sumBIn += o.amountIn;

  // Exact aggregate token totals the crossing + AMM swap actually move:
  //   xTotal = total token A paid to sellers, yTotal = total token B paid to buyers.
  const xTotal = sumAIn - ev.swap.ammAIn + ev.swap.ammAOut;
  const yTotal = sumBIn - ev.swap.ammBIn + ev.swap.ammBOut;

  const fills: OrderFill[] = [];
  // Buyers receive token B: distribute yTotal pro-rata by amountIn / sumAIn,
  // the LAST buy absorbs the rounding remainder so the sum is exact.
  let buyAcc = 0n;
  ev.eligibleBuys.forEach((o, i) => {
    const isLast = i === ev.eligibleBuys.length - 1;
    const amountOut = isLast ? yTotal - buyAcc : mulDiv(yTotal, o.amountIn, sumAIn);
    buyAcc += amountOut;
    fills.push({ orderNonce: o.orderNonce, filledIn: o.amountIn, amountOut });
  });
  // Sellers receive token A: distribute xTotal pro-rata by amountIn / sumBIn.
  let sellAcc = 0n;
  ev.eligibleSells.forEach((o, i) => {
    const isLast = i === ev.eligibleSells.length - 1;
    const amountOut = isLast ? xTotal - sellAcc : mulDiv(xTotal, o.amountIn, sumBIn);
    sellAcc += amountOut;
    fills.push({ orderNonce: o.orderNonce, filledIn: o.amountIn, amountOut });
  });

  const feeAPerShareIncrement =
    pool.lpSupply === 0n ? 0n : mulDiv(ev.swap.feeAmountA, SCALE, pool.lpSupply);
  const feeBPerShareIncrement =
    pool.lpSupply === 0n ? 0n : mulDiv(ev.swap.feeAmountB, SCALE, pool.lpSupply);

  return {
    cleared: true,
    clearingPrice: pStar,
    fills,
    newReserveA: ev.swap.newReserveA,
    newReserveB: ev.swap.newReserveB,
    feeAPerShareIncrement,
    feeBPerShareIncrement,
  };
}

// ============================================================================
// Sub-2: bucket-tracing swap (V3-style concentrated liquidity).
// ============================================================================
import type { BucketBounds, BucketState } from "./buckets.js";
import {
  SCALE as BUCKET_SCALE,
  nextSqrtPUp,
  nextSqrtPDown,
  swapStepOutA,
  swapStepOutB,
} from "./buckets.js";

export interface PoolWithBuckets {
  reserveA: bigint;
  reserveB: bigint;
  lpSupply: bigint;
  currentSqrtPrice: bigint;
  bucketBounds: BucketBounds[];
  bucketStates: BucketState[];
}

export interface BucketDeltaResult {
  bucket_id: number;
  reserve_a_add: bigint;
  reserve_a_sub: bigint;
  reserve_b_add: bigint;
  reserve_b_sub: bigint;
  cum_fee_a_per_share_increment: bigint;
  cum_fee_b_per_share_increment: bigint;
}

export interface BucketTraceOutput {
  newSqrtPrice: bigint;
  bucketDeltas: BucketDeltaResult[];
  newReserveA: bigint;
  newReserveB: bigint;
}

/**
 * Sub-2: full V3 multi-bucket state machine. Traces a swap through one or
 * more concentrated-liquidity buckets starting from currentSqrtPrice.
 *
 * - Withholds 0.3% LP fee from the gross input before routing.
 * - Crosses bucket boundaries: when the remaining after-fee input exhausts
 *   the current bucket it steps to the next bucket (UP or DOWN) and
 *   continues, accumulating per-bucket reserve deltas and fee shares.
 * - Empty buckets (liquidity == 0) are skipped.
 * - Pro-rated fee shares are distributed across touched buckets; the final
 *   touched bucket absorbs any truncation residual so sum(stepFee) ==
 *   feeWithheld exactly.
 * - Throws if the input exceeds all available buckets in the chosen
 *   direction, or if more than MAX_BUCKET_HOPS distinct buckets are touched.
 *
 * Inputs:
 *   netA > 0: token A flows in (pool moves DOWN as A becomes plentiful)
 *   netB > 0: token B flows in (pool moves UP)
 *
 * Returns: per-bucket reserve deltas, fee increments, and the new sqrt_p.
 */
export function traceBucketSwap(
  pool: PoolWithBuckets,
  netA: bigint,
  netB: bigint,
): BucketTraceOutput {
  if (netA === 0n && netB === 0n) {
    return {
      newSqrtPrice: pool.currentSqrtPrice,
      bucketDeltas: [],
      newReserveA: pool.reserveA,
      newReserveB: pool.reserveB,
    };
  }

  const BUCKET_FEE_BPS = 30n;
  const BUCKET_FEE_SCALE = 10_000n;
  const MAX_BUCKET_HOPS = 4;

  let bucketId = pool.bucketBounds.findIndex(
    (b) => pool.currentSqrtPrice >= b.sqrt_lower && pool.currentSqrtPrice < b.sqrt_upper,
  );
  if (bucketId < 0) bucketId = pool.bucketBounds.length - 1;

  const direction = netB > 0n;
  let remaining = direction ? netB : netA;
  const inAfterFeeTotal = (remaining * (BUCKET_FEE_SCALE - BUCKET_FEE_BPS)) / BUCKET_FEE_SCALE;
  let inAfterFee = inAfterFeeTotal;
  let feeWithheld = remaining - inAfterFeeTotal;

  const deltas = new Map<number, BucketDeltaResult>();
  let sqrtP = pool.currentSqrtPrice;
  let feeDistributed = 0n;

  while (inAfterFee > 0n && bucketId >= 0 && bucketId < pool.bucketBounds.length) {
    const bucket = pool.bucketStates[bucketId]!;
    const bounds = pool.bucketBounds[bucketId]!;

    if (bucket.liquidity === 0n) {
      sqrtP = direction ? bounds.sqrt_upper : bounds.sqrt_lower;
      bucketId = direction ? bucketId + 1 : bucketId - 1;
      continue;
    }

    let stepInMax: bigint;
    if (direction) {
      stepInMax = (bucket.liquidity * (bounds.sqrt_upper - sqrtP)) / BUCKET_SCALE;
    } else {
      const denom = (sqrtP * bounds.sqrt_lower) / BUCKET_SCALE;
      stepInMax = (bucket.liquidity * (sqrtP - bounds.sqrt_lower)) / denom;
    }

    let stepIn: bigint;
    let stepOut: bigint;
    let sqrtPNew: bigint;

    if (inAfterFee <= stepInMax) {
      stepIn = inAfterFee;
      if (direction) {
        sqrtPNew = nextSqrtPUp(bucket.liquidity, sqrtP, stepIn);
        stepOut = swapStepOutA(bucket.liquidity, sqrtP, sqrtPNew);
      } else {
        sqrtPNew = nextSqrtPDown(bucket.liquidity, sqrtP, stepIn);
        stepOut = swapStepOutB(bucket.liquidity, sqrtP, sqrtPNew);
      }
      inAfterFee = 0n;
    } else {
      stepIn = stepInMax;
      sqrtPNew = direction ? bounds.sqrt_upper : bounds.sqrt_lower;
      if (direction) {
        stepOut = swapStepOutA(bucket.liquidity, sqrtP, sqrtPNew);
      } else {
        stepOut = swapStepOutB(bucket.liquidity, sqrtP, sqrtPNew);
      }
      inAfterFee -= stepIn;
    }

    // I1: last-bucket residual pattern — guarantees sum(stepFee) == feeWithheld.
    let stepFee: bigint;
    if (inAfterFee === 0n) {
      // This is the final touched bucket; assign the remainder to avoid truncation loss.
      stepFee = feeWithheld - feeDistributed;
    } else {
      stepFee = (feeWithheld * stepIn) / inAfterFeeTotal;
    }
    feeDistributed += stepFee;
    const cumFeeAInc = direction ? 0n : (stepFee * BUCKET_SCALE) / bucket.liquidity;
    const cumFeeBInc = direction ? (stepFee * BUCKET_SCALE) / bucket.liquidity : 0n;

    const prev = deltas.get(bucketId);
    const delta: BucketDeltaResult = {
      bucket_id: bucketId,
      reserve_a_add: (prev?.reserve_a_add ?? 0n) + (direction ? 0n : stepIn),
      reserve_a_sub: (prev?.reserve_a_sub ?? 0n) + (direction ? stepOut : 0n),
      reserve_b_add: (prev?.reserve_b_add ?? 0n) + (direction ? stepIn : 0n),
      reserve_b_sub: (prev?.reserve_b_sub ?? 0n) + (direction ? 0n : stepOut),
      cum_fee_a_per_share_increment:
        (prev?.cum_fee_a_per_share_increment ?? 0n) + cumFeeAInc,
      cum_fee_b_per_share_increment:
        (prev?.cum_fee_b_per_share_increment ?? 0n) + cumFeeBInc,
    };
    deltas.set(bucketId, delta);

    sqrtP = sqrtPNew;
    if (inAfterFee > 0n) {
      bucketId = direction ? bucketId + 1 : bucketId - 1;
    }
  }

  if (inAfterFee > 0n) {
    throw new Error("swap exceeded all buckets in the chosen direction");
  }
  if (deltas.size > MAX_BUCKET_HOPS) {
    throw new Error(`traceBucketSwap touched ${deltas.size} buckets (cap ${MAX_BUCKET_HOPS})`);
  }

  let aggA = 0n;
  let aggB = 0n;
  for (const d of deltas.values()) {
    aggA += d.reserve_a_add - d.reserve_a_sub;
    aggB += d.reserve_b_add - d.reserve_b_sub;
  }

  return {
    newSqrtPrice: sqrtP,
    bucketDeltas: Array.from(deltas.values()).sort((a, b) => a.bucket_id - b.bucket_id),
    newReserveA: pool.reserveA + aggA,
    newReserveB: pool.reserveB + aggB,
  };
}

// ============================================================================
// Sub-2.5: bucket-aware clearing (computeClearingV2).
// ============================================================================

export interface ClearingResultV2 extends ClearingResult {
  bucketDeltas?: BucketDeltaResult[];
  currentSqrtPriceAfter?: bigint;
  bucketStatesBefore?: BucketState[];
  bucketStatesAfter?: BucketState[];
}

/**
 * Sub-2.5: bucket-aware clearing. Calls computeClearing for fills + P*,
 * then routes the net imbalance through traceBucketSwap to produce
 * per-bucket deltas + the new sqrt_p_after + bucket states before/after.
 *
 * Output shape feeds buildClearingWitness directly.
 */
export function computeClearingV2(
  pool: PoolWithBuckets,
  orders: ClearingOrder[],
): ClearingResultV2 {
  const base: ClearingResult = computeClearing(
    { reserveA: pool.reserveA, reserveB: pool.reserveB, lpSupply: pool.lpSupply },
    orders,
  );
  if (!base.cleared) {
    return {
      ...base,
      bucketDeltas: [],
      currentSqrtPriceAfter: pool.currentSqrtPrice,
      bucketStatesBefore: [],
      bucketStatesAfter: [],
    };
  }
  // Net flows from base.newReserve* vs pool's pre-clearing reserves.
  const netA = base.newReserveA - pool.reserveA;
  const netB = base.newReserveB - pool.reserveB;
  // traceBucketSwap takes positive netA / positive netB; figure out direction.
  const netAPositive = netA > 0n ? netA : 0n;
  const netBPositive = netB > 0n ? netB : 0n;
  const trace = traceBucketSwap(pool, netAPositive, netBPositive);

  // Snapshot bucket states before + after for the witness.
  const touchedIds = trace.bucketDeltas.map((d) => d.bucket_id);
  const before: BucketState[] = touchedIds.map((id) => ({ ...pool.bucketStates[id]! }));
  const after: BucketState[] = touchedIds.map((id) => {
    const d = trace.bucketDeltas.find((x) => x.bucket_id === id)!;
    const s = pool.bucketStates[id]!;
    return {
      reserve_a: s.reserve_a + d.reserve_a_add - d.reserve_a_sub,
      reserve_b: s.reserve_b + d.reserve_b_add - d.reserve_b_sub,
      liquidity: s.liquidity,
      cum_fee_a_per_share: s.cum_fee_a_per_share + d.cum_fee_a_per_share_increment,
      cum_fee_b_per_share: s.cum_fee_b_per_share + d.cum_fee_b_per_share_increment,
    };
  });

  return {
    ...base,
    newReserveA: trace.newReserveA,
    newReserveB: trace.newReserveB,
    bucketDeltas: trace.bucketDeltas,
    currentSqrtPriceAfter: trace.newSqrtPrice,
    bucketStatesBefore: before,
    bucketStatesAfter: after,
  };
}
