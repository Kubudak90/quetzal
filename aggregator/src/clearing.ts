/**
 * Frequent-batch-auction clearing for ZSwap. Pure computation - given a pool
 * snapshot and a set of orders, `computeClearing` produces the uniform clearing
 * price, the per-order fills, the post-clearing reserves, and the LP fee accrual.
 *
 * See docs/superpowers/specs/2026-05-19-zswap-aztec-week-05b-clearing-aggregator-design.md
 */
import { mulDiv, SCALE, FEE_NUM, FEE_DEN } from "./fixed-point.js";

/** Maximum orders cleared in one epoch; the rest carry over. */
export const MAX_ORDERS_PER_EPOCH = 128;
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
    return { newReserveA: reserveA, newReserveB: reserveB, realizedP: p, feeAmountA: 0n, feeAmountB: 0n };
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
 * when the search band does not bracket a root, or on non-convergence - the
 * caller treats null as "epoch skipped".
 *
 * The residual `realizedP(P) - P` is treated as monotonically decreasing in P
 * over the band: at a low P many buys / few sells are eligible (large positive
 * netA, high realized price, positive residual); at a high P the reverse.
 */
export function findClearingPrice(pool: PoolSnapshot, batch: ClearingOrder[]): bigint | null {
  if (pool.reserveA === 0n || pool.reserveB === 0n) return null;
  const spot = mulDiv(pool.reserveA, SCALE, pool.reserveB);
  let lo = spot / PRICE_BAND;
  if (lo < 1n) lo = 1n;
  let hi = spot * PRICE_BAND;
  const residual = (p: bigint): bigint => clearingAt(pool, batch, p).swap.realizedP - p;

  // The band must bracket a root: residual(lo) >= 0 >= residual(hi).
  if (residual(lo) < 0n || residual(hi) > 0n) return null;

  for (let i = 0; i < MAX_ITERS; i++) {
    const mid = (lo + hi) / 2n;
    const r = residual(mid);
    if (r >= -TOLERANCE && r <= TOLERANCE) return mid;
    if (r > 0n) lo = mid;
    else hi = mid;
    if (hi - lo <= 1n) return mid;
  }
  return null; // did not converge within MAX_ITERS
}
