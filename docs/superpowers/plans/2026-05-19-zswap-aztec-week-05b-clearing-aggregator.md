# ZSwap-on-Aztec — Week 5b: Off-chain clearing aggregator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `@zswap/aggregator` — a pure TypeScript module whose `computeClearing(pool, orders)` implements the frequent-batch-auction clearing algorithm (FIFO selection, binary-search uniform clearing price, peer-to-peer crossing, net imbalance through the constant-product AMM with the 0.3% fee, full fills, LP fee accrual).

**Architecture:** A new `aggregator/` pnpm-workspace package with no Aztec dependency — pure `bigint` computation. Built as four composable, independently-tested units: `mulDiv` fixed-point helpers → `selectBatch` (FIFO) → `simulateNet`/`clearingAt`/`findClearingPrice` (price discovery) → `computeClearing` (the assembled result).

**Tech Stack:** TypeScript (Node 22), `node:test` + `tsx`, pnpm workspaces. No `@aztec/*`.

**Spec:** `docs/superpowers/specs/2026-05-19-zswap-aztec-week-05b-clearing-aggregator-design.md`

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `aggregator/package.json` | `@zswap/aggregator` manifest (`test`, `typecheck` scripts) | Create |
| `aggregator/tsconfig.json` | TS config (NodeNext, strict, noEmit) | Create |
| `aggregator/src/fixed-point.ts` | `mulDiv` + scale/fee constants | Create |
| `aggregator/src/clearing.ts` | types, `selectBatch`, `simulateNet`, `clearingAt`, `findClearingPrice`, `computeClearing` | Create (grown across Tasks 2-4) |
| `aggregator/test/fixed-point.test.ts` | `mulDiv` unit tests | Create |
| `aggregator/test/clearing.test.ts` | clearing unit tests | Create (grown across Tasks 2-4) |
| `package.json` (root) | `test` script also runs the aggregator unit tests | Modify |
| `README.md` | status line + docs links | Modify |

`pnpm-workspace.yaml` already lists `aggregator` — no change needed. The aggregator's tests are pure (no dev stack), so they run as part of `pnpm test` unconditionally and fast.

## Pre-flight

- [ ] Confirm `git status` is clean and `git tag -l | grep week-05` shows `week-05-liquidity-pool`.
- [ ] Read `cli/package.json` and `cli/tsconfig.json` — the aggregator package mirrors their shape (pnpm workspace member, `type: module`, NodeNext/strict tsconfig).

---

## Task 1: Package scaffold + fixed-point helpers

**Dispatch with model: sonnet.**

**Files:**
- Create: `aggregator/package.json`, `aggregator/tsconfig.json`, `aggregator/src/fixed-point.ts`, `aggregator/test/fixed-point.test.ts`
- Modify: `package.json` (root)

- [ ] **Step 1: `aggregator/package.json`**

```json
{
  "name": "@zswap/aggregator",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --import tsx --test 'test/**/*.test.ts'",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "@types/node": "^22.7.0",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0"
  }
}
```

- [ ] **Step 2: `aggregator/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

- [ ] **Step 3: `aggregator/src/fixed-point.ts`**

```ts
/**
 * Fixed-point helpers for the clearing aggregator. All amounts are `bigint`;
 * prices are quote-per-base, scaled by `SCALE` (1e18) — matching the Noir
 * `OrderNote.limit_price` field.
 */

/** Price fixed-point scale: a price of 1.0 is `SCALE`. */
export const SCALE = 1_000_000_000_000_000_000n;

/**
 * The 0.3% swap fee, applied to the swap input:
 * `input_after_fee = input * FEE_NUM / FEE_DEN`. The withheld `0.3%` is the LP fee.
 */
export const FEE_NUM = 9970n;
export const FEE_DEN = 10_000n;

/**
 * `floor(a * b / denom)`. `bigint` is arbitrary-precision, so the `a * b`
 * intermediate is exact and never overflows; this helper centralises the
 * divide-by-zero guard and documents the floor-rounding intent.
 */
export function mulDiv(a: bigint, b: bigint, denom: bigint): bigint {
  if (denom === 0n) throw new Error("mulDiv: division by zero");
  return (a * b) / denom;
}
```

- [ ] **Step 4: `aggregator/test/fixed-point.test.ts`**

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mulDiv, SCALE, FEE_NUM, FEE_DEN } from "../src/fixed-point.js";

describe("fixed-point", () => {
  it("mulDiv computes a*b/denom with floor division", () => {
    assert.equal(mulDiv(6n, 7n, 2n), 21n);
    assert.equal(mulDiv(7n, 1n, 2n), 3n, "floors 3.5 -> 3");
    assert.equal(mulDiv(0n, 999n, 7n), 0n);
  });

  it("mulDiv handles operands far beyond 2^64 without overflow", () => {
    const big = 10n ** 40n;
    assert.equal(mulDiv(big, big, big), big);
  });

  it("mulDiv throws on a zero denominator", () => {
    assert.throws(() => mulDiv(1n, 1n, 0n), /division by zero/);
  });

  it("constants have the documented values", () => {
    assert.equal(SCALE, 10n ** 18n);
    assert.equal(FEE_NUM, 9970n);
    assert.equal(FEE_DEN, 10_000n);
    // 0.3% fee: input * 9970/10000 keeps 99.7%.
    assert.equal((1_000_000n * FEE_NUM) / FEE_DEN, 997_000n);
  });
});
```

- [ ] **Step 5: Wire the root `test` script**

In the root `package.json`, the `test` script currently reads:

```json
    "test": "pnpm -r --filter './tests/**' test",
```

Change it to also run the aggregator's package `test` script:

```json
    "test": "pnpm -r --filter './tests/**' --filter './aggregator' test",
```

- [ ] **Step 6: Install, typecheck, test**

```bash
pnpm install
pnpm --filter @zswap/aggregator typecheck
pnpm --filter @zswap/aggregator test
```

Expected: install succeeds (picks up the new `aggregator` workspace member); `tsc --noEmit` reports no errors; `node:test` reports `4` passing tests under the `fixed-point` suite.

- [ ] **Step 7: Commit**

```bash
git add aggregator/ package.json pnpm-lock.yaml
git commit -m "feat(aggregator): @zswap/aggregator scaffold + fixed-point helpers"
```

---

## Task 2: Clearing types + FIFO batch selection

**Dispatch with model: sonnet.**

**Files:**
- Create: `aggregator/src/clearing.ts`, `aggregator/test/clearing.test.ts`

- [ ] **Step 1: `aggregator/src/clearing.ts` — types, constants, `selectBatch`**

```ts
/**
 * Frequent-batch-auction clearing for ZSwap. Pure computation — given a pool
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
  /** L2 block of submission — the FIFO ordering key. */
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
  /** Amount of `amountIn` consumed — always == amountIn in this slice (full fills). */
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
 * Step 1: the epoch's batch — the <= MAX_ORDERS_PER_EPOCH oldest orders by
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
```

- [ ] **Step 2: `aggregator/test/clearing.test.ts` — `selectBatch` tests**

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { selectBatch, MAX_ORDERS_PER_EPOCH, type ClearingOrder } from "../src/clearing.js";

function order(p: Partial<ClearingOrder> & { orderNonce: bigint; submittedAtBlock: number }): ClearingOrder {
  return {
    side: false,
    amountIn: 1_000n,
    limitPrice: 1_000_000_000_000_000_000n,
    ...p,
  };
}

describe("selectBatch", () => {
  it("sorts ascending by submittedAtBlock", () => {
    const batch = selectBatch([
      order({ orderNonce: 1n, submittedAtBlock: 30 }),
      order({ orderNonce: 2n, submittedAtBlock: 10 }),
      order({ orderNonce: 3n, submittedAtBlock: 20 }),
    ]);
    assert.deepEqual(batch.map((o) => o.orderNonce), [2n, 3n, 1n]);
  });

  it("breaks ties on submittedAtBlock by orderNonce ascending", () => {
    const batch = selectBatch([
      order({ orderNonce: 9n, submittedAtBlock: 5 }),
      order({ orderNonce: 4n, submittedAtBlock: 5 }),
      order({ orderNonce: 7n, submittedAtBlock: 5 }),
    ]);
    assert.deepEqual(batch.map((o) => o.orderNonce), [4n, 7n, 9n]);
  });

  it("caps the batch at MAX_ORDERS_PER_EPOCH, keeping the oldest", () => {
    const orders: ClearingOrder[] = [];
    for (let i = 0; i < 130; i++) {
      orders.push(order({ orderNonce: BigInt(i), submittedAtBlock: i }));
    }
    const batch = selectBatch(orders);
    assert.equal(batch.length, MAX_ORDERS_PER_EPOCH);
    // The 128 oldest (blocks 0..127) are kept; 128 and 129 are dropped.
    assert.equal(batch[batch.length - 1]!.submittedAtBlock, 127);
  });

  it("does not mutate the input array", () => {
    const orders = [
      order({ orderNonce: 1n, submittedAtBlock: 30 }),
      order({ orderNonce: 2n, submittedAtBlock: 10 }),
    ];
    selectBatch(orders);
    assert.equal(orders[0]!.orderNonce, 1n, "input order preserved");
  });

  it("returns an empty batch for no orders", () => {
    assert.deepEqual(selectBatch([]), []);
  });
});
```

- [ ] **Step 3: Typecheck + test**

```bash
pnpm --filter @zswap/aggregator typecheck
pnpm --filter @zswap/aggregator test
```

Expected: typecheck clean; `node:test` reports `4` fixed-point + `5` `selectBatch` tests passing.

- [ ] **Step 4: Commit**

```bash
git add aggregator/src/clearing.ts aggregator/test/clearing.test.ts
git commit -m "feat(aggregator): clearing types + FIFO batch selection"
```

---

## Task 3: AMM net swap + clearing-price binary search

**Dispatch with model: opus** — the AMM math and the bisection are the subtle core.

**Files:**
- Modify: `aggregator/src/clearing.ts`, `aggregator/test/clearing.test.ts`

- [ ] **Step 1: `clearing.ts` — append `simulateNet`, `clearingAt`, `findClearingPrice`**

Append to `aggregator/src/clearing.ts` (after `selectBatch`):

```ts
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
 * in `feeAmount*` — it is NOT added to the reserves (ZSwap tracks fees in a
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
 * when the search band does not bracket a root, or on non-convergence — the
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
```

- [ ] **Step 2: `clearing.test.ts` — append `simulateNet` / `findClearingPrice` tests**

Append to `aggregator/test/clearing.test.ts`:

```ts
import {
  simulateNet,
  clearingAt,
  findClearingPrice,
  type PoolSnapshot,
} from "../src/clearing.js";

const SCALE = 1_000_000_000_000_000_000n;

describe("simulateNet", () => {
  it("no swap when netA is zero", () => {
    const s = simulateNet(1_000n, 1_000n, 0n, SCALE);
    assert.equal(s.newReserveA, 1_000n);
    assert.equal(s.newReserveB, 1_000n);
    assert.equal(s.realizedP, SCALE);
    assert.equal(s.feeAmountA, 0n);
    assert.equal(s.feeAmountB, 0n);
  });

  it("token A in: reserves move, fee withheld, constant product preserved", () => {
    const Ra = 1_000_000_000_000n;
    const Rb = 1_000_000_000_000n;
    const netA = 10_000_000_000n;
    const s = simulateNet(Ra, Rb, netA, SCALE);
    // Fee is 0.3% of netA, withheld from the input (not added to reserveA).
    assert.equal(s.feeAmountA, netA - (netA * 9970n) / 10000n);
    assert.equal(s.feeAmountB, 0n);
    // Reserve A grows only by the after-fee input; reserve B falls.
    assert.equal(s.newReserveA, Ra + (netA * 9970n) / 10000n);
    assert.ok(s.newReserveB < Rb, "reserve B decreased");
    // Constant product preserved up to floor dust (never shrinks).
    assert.ok(s.newReserveA * s.newReserveB >= Ra * Rb, "k preserved/grown by dust");
  });

  it("token B in (netA < 0): symmetric", () => {
    const Ra = 1_000_000_000_000n;
    const Rb = 1_000_000_000_000n;
    const s = simulateNet(Ra, Rb, -10_000_000_000n, SCALE);
    assert.equal(s.feeAmountA, 0n);
    assert.ok(s.feeAmountB > 0n, "fee withheld in token B");
    assert.ok(s.newReserveA < Ra, "reserve A decreased");
    assert.ok(s.newReserveB > Rb, "reserve B increased");
    assert.ok(s.newReserveA * s.newReserveB >= Ra * Rb, "k preserved/grown by dust");
  });
});

describe("findClearingPrice", () => {
  const balancedPool: PoolSnapshot = {
    reserveA: 1_000_000_000_000n,
    reserveB: 1_000_000_000_000n,
    lpSupply: 1_000_000_000_000n,
  };

  it("returns null for a degenerate (empty) pool", () => {
    assert.equal(findClearingPrice({ reserveA: 0n, reserveB: 0n, lpSupply: 0n }, []), null);
  });

  it("a near-exact cross clears at roughly the spot price", () => {
    // One buy and one sell of matching value at spot (1.0). Net flow ~ 0.
    const batch: ClearingOrder[] = [
      { side: false, amountIn: 1_000_000n, limitPrice: 2n * SCALE, submittedAtBlock: 1, orderNonce: 1n },
      { side: true, amountIn: 1_000_000n, limitPrice: SCALE / 2n, submittedAtBlock: 2, orderNonce: 2n },
    ];
    const p = findClearingPrice(balancedPool, batch);
    assert.ok(p !== null, "should converge");
    // spot is 1.0 (SCALE); a balanced cross clears within ~1% of it.
    assert.ok(p! > (SCALE * 99n) / 100n && p! < (SCALE * 101n) / 100n, `P* near spot, got ${p}`);
  });

  it("the residual at the returned P* is within tolerance", () => {
    const batch: ClearingOrder[] = [
      { side: false, amountIn: 5_000_000n, limitPrice: 3n * SCALE, submittedAtBlock: 1, orderNonce: 1n },
      { side: true, amountIn: 2_000_000n, limitPrice: SCALE / 4n, submittedAtBlock: 2, orderNonce: 2n },
    ];
    const p = findClearingPrice(balancedPool, batch);
    assert.ok(p !== null, "should converge");
    const ev = clearingAt(balancedPool, batch, p!);
    const residual = ev.swap.realizedP - p!;
    const abs = residual < 0n ? -residual : residual;
    // Bisection converges to a unit-wide bracket; the residual is small relative to P*.
    assert.ok(abs <= p! / 1_000n, `residual ${abs} small vs P* ${p}`);
  });
});
```

- [ ] **Step 3: Typecheck + test**

```bash
pnpm --filter @zswap/aggregator typecheck
pnpm --filter @zswap/aggregator test
```

Expected: typecheck clean; `node:test` reports `4` fixed-point + `5` selectBatch + `3` simulateNet + `3` findClearingPrice tests passing (`15` total).

- [ ] **Step 4: Commit**

```bash
git add aggregator/src/clearing.ts aggregator/test/clearing.test.ts
git commit -m "feat(aggregator): AMM net swap + clearing-price binary search"
```

---

## Task 4: `computeClearing` — the assembled result

**Dispatch with model: opus** — assembling fills + fee accrual + the conservation properties.

**Files:**
- Modify: `aggregator/src/clearing.ts`, `aggregator/test/clearing.test.ts`

- [ ] **Step 1: `clearing.ts` — append `computeClearing`**

Append to `aggregator/src/clearing.ts`:

```ts
/** The "epoch skipped" result — reserves unchanged, nothing cleared. */
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

  const fills: OrderFill[] = [];
  for (const o of ev.eligibleBuys) {
    // A buy pays `amountIn` token A, receives token A / P* of token B.
    fills.push({ orderNonce: o.orderNonce, filledIn: o.amountIn, amountOut: mulDiv(o.amountIn, SCALE, pStar) });
  }
  for (const o of ev.eligibleSells) {
    // A sell pays `amountIn` token B, receives token B * P* of token A.
    fills.push({ orderNonce: o.orderNonce, filledIn: o.amountIn, amountOut: mulDiv(o.amountIn, pStar, SCALE) });
  }

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
```

- [ ] **Step 2: `clearing.test.ts` — append `computeClearing` tests**

Append to `aggregator/test/clearing.test.ts`:

```ts
import { computeClearing } from "../src/clearing.js";

describe("computeClearing", () => {
  const pool: PoolSnapshot = {
    reserveA: 1_000_000_000_000n,
    reserveB: 1_000_000_000_000n,
    lpSupply: 1_000_000_000_000n,
  };

  it("empty order list -> epoch skipped, reserves unchanged", () => {
    const r = computeClearing(pool, []);
    assert.equal(r.cleared, false);
    assert.equal(r.clearingPrice, 0n);
    assert.deepEqual(r.fills, []);
    assert.equal(r.newReserveA, pool.reserveA);
    assert.equal(r.newReserveB, pool.reserveB);
    assert.equal(r.feeAPerShareIncrement, 0n);
    assert.equal(r.feeBPerShareIncrement, 0n);
  });

  it("a degenerate (empty) pool -> epoch skipped", () => {
    const batch: ClearingOrder[] = [
      { side: false, amountIn: 1_000n, limitPrice: SCALE, submittedAtBlock: 1, orderNonce: 1n },
    ];
    const r = computeClearing({ reserveA: 0n, reserveB: 0n, lpSupply: 0n }, batch);
    assert.equal(r.cleared, false);
  });

  it("one-sided book (buys only): net token A swaps through the AMM, all buys filled", () => {
    const batch: ClearingOrder[] = [
      { side: false, amountIn: 5_000_000n, limitPrice: 5n * SCALE, submittedAtBlock: 1, orderNonce: 1n },
      { side: false, amountIn: 3_000_000n, limitPrice: 5n * SCALE, submittedAtBlock: 2, orderNonce: 2n },
    ];
    const r = computeClearing(pool, batch);
    assert.equal(r.cleared, true);
    assert.equal(r.fills.length, 2, "both buys filled");
    assert.ok(r.newReserveA > pool.reserveA, "reserve A grew (token A flowed in)");
    assert.ok(r.newReserveB < pool.reserveB, "reserve B fell");
    assert.ok(r.feeAPerShareIncrement > 0n, "LP fee accrued in token A");
    assert.equal(r.feeBPerShareIncrement, 0n);
    // The fee is withheld from reserves, so k cannot grow; it shrinks only by dust.
    assert.ok(r.newReserveA * r.newReserveB <= pool.reserveA * pool.reserveB, "k does not grow");
  });

  it("a buy below P* is gated out and carries over", () => {
    // A generous buy and a sell clear well above 1.0; a second buy with a low
    // limit (0.5) is ineligible at that P* and must be absent from fills.
    const batch: ClearingOrder[] = [
      { side: false, amountIn: 8_000_000n, limitPrice: 10n * SCALE, submittedAtBlock: 1, orderNonce: 1n },
      { side: true, amountIn: 1_000_000n, limitPrice: SCALE / 10n, submittedAtBlock: 2, orderNonce: 2n },
      { side: false, amountIn: 1_000_000n, limitPrice: SCALE / 2n, submittedAtBlock: 3, orderNonce: 3n },
    ];
    const r = computeClearing(pool, batch);
    assert.equal(r.cleared, true);
    assert.ok(r.clearingPrice > SCALE / 2n, "P* is above the gated buy's limit");
    const nonces = r.fills.map((f) => f.orderNonce);
    assert.ok(!nonces.includes(3n), "the low-limit buy is gated out");
  });

  it("the 128-cap keeps the oldest, drops the newest", () => {
    const batch: ClearingOrder[] = [];
    for (let i = 0; i < 130; i++) {
      // Mix buys and sells so a clearing price exists.
      batch.push({
        side: i % 2 === 0,
        amountIn: 1_000_000n,
        limitPrice: i % 2 === 0 ? 10n * SCALE : SCALE / 10n,
        submittedAtBlock: i,
        orderNonce: BigInt(i),
      });
    }
    const r = computeClearing(pool, batch);
    assert.equal(r.cleared, true);
    assert.ok(r.fills.length <= 128, "no more than 128 orders cleared");
    const nonces = r.fills.map((f) => f.orderNonce);
    assert.ok(!nonces.includes(128n) && !nonces.includes(129n), "the two newest are not cleared");
  });

  it("fee-per-share increment equals fee / lpSupply", () => {
    const batch: ClearingOrder[] = [
      { side: false, amountIn: 9_000_000n, limitPrice: 5n * SCALE, submittedAtBlock: 1, orderNonce: 1n },
      { side: true, amountIn: 1_000_000n, limitPrice: SCALE / 5n, submittedAtBlock: 2, orderNonce: 2n },
    ];
    const r = computeClearing(pool, batch);
    assert.equal(r.cleared, true);
    // Re-derive the net swap at P* and check the fee maths.
    const ev = clearingAt(pool, batch, r.clearingPrice);
    const expected = (ev.swap.feeAmountA * SCALE) / pool.lpSupply;
    assert.equal(r.feeAPerShareIncrement, expected);
  });

  it("is deterministic — identical inputs yield deep-equal output", () => {
    const batch: ClearingOrder[] = [
      { side: false, amountIn: 4_000_000n, limitPrice: 3n * SCALE, submittedAtBlock: 1, orderNonce: 1n },
      { side: true, amountIn: 2_000_000n, limitPrice: SCALE / 3n, submittedAtBlock: 2, orderNonce: 2n },
    ];
    assert.deepEqual(computeClearing(pool, batch), computeClearing(pool, batch));
  });

  it("value conservation: every filled buy gets B, every sell gets A; k preserved", () => {
    const batch: ClearingOrder[] = [
      { side: false, amountIn: 6_000_000n, limitPrice: 4n * SCALE, submittedAtBlock: 1, orderNonce: 1n },
      { side: true, amountIn: 3_000_000n, limitPrice: SCALE / 4n, submittedAtBlock: 2, orderNonce: 2n },
    ];
    const r = computeClearing(pool, batch);
    assert.equal(r.cleared, true);
    for (const f of r.fills) {
      assert.ok(f.amountOut > 0n, `fill ${f.orderNonce} received output`);
      assert.ok(f.filledIn > 0n, "full fill");
    }
    assert.ok(
      r.newReserveA * r.newReserveB <= pool.reserveA * pool.reserveB,
      "constant product does not grow (fee withheld from reserves; shrinks only by dust)",
    );
  });
});
```

- [ ] **Step 3: Typecheck + test**

```bash
pnpm --filter @zswap/aggregator typecheck
pnpm --filter @zswap/aggregator test
```

Expected: typecheck clean; `node:test` reports all suites passing — `4` fixed-point + `5` selectBatch + `3` simulateNet + `3` findClearingPrice + `8` computeClearing = `23` tests.

- [ ] **Step 4: Commit**

```bash
git add aggregator/src/clearing.ts aggregator/test/clearing.test.ts
git commit -m "feat(aggregator): computeClearing — fills, reserves, LP fee accrual"
```

---

## Task 5: Final check + Week 5b milestone

**Dispatch with model: sonnet.**

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Clean install + full aggregator check**

```bash
rm -rf node_modules aggregator/node_modules tests/node_modules cli/node_modules
pnpm install
pnpm --filter @zswap/aggregator typecheck
pnpm --filter @zswap/aggregator test
```

Expected: install succeeds; typecheck clean; `23` aggregator tests pass.

- [ ] **Step 2: Confirm the root `test` script includes the aggregator**

```bash
cat package.json | grep '"test"'
```

Expected: the `test` line contains both `--filter './tests/**'` and `--filter './aggregator'`.

Then start the dev stack in another terminal (`bash scripts/dev.sh`, wait until ready) and run the full suite:

```bash
pnpm test
```

Expected: the aggregator's `23` unit tests pass **and** the `23` integration tests pass (`pnpm test` runs both packages). `fail 0` overall.

Stop the dev stack: `bash scripts/dev.sh --down`.

- [ ] **Step 3: Update README**

In `README.md`, replace the `**Status:**` line with:

```
**Status:** Week 5b complete. The off-chain clearing aggregator (`@zswap/aggregator`) computes the frequent-batch-auction clearing — FIFO selection, uniform clearing price, the net imbalance through the AMM with the 0.3% LP fee. 23 aggregator unit tests + 23 integration tests + 21 TXE tests green. Week 5c wires an on-chain ClearingContract.
```

In the `## Documentation` section, add:

```
- [Week 5b Clearing Aggregator Design](docs/superpowers/specs/2026-05-19-zswap-aztec-week-05b-clearing-aggregator-design.md)
- [Week 5b Implementation Plan](docs/superpowers/plans/2026-05-19-zswap-aztec-week-05b-clearing-aggregator.md)
```

- [ ] **Step 4: Milestone commit and tag**

```bash
git add README.md
git commit -m "docs: mark Week 5b (clearing aggregator) complete"
git tag week-05b-clearing-aggregator
git tag -l | grep week-05b
```

Expected: `week-05b-clearing-aggregator`.

---

## Definition of Done for Week 5b

- `@zswap/aggregator` typechecks; `computeClearing` and its helpers are pure (no `@aztec/*`, no I/O).
- All `23` aggregator unit tests pass; `pnpm test` runs them green alongside the unaffected `23` integration tests.
- `computeClearing` implements MVP design 8.1: FIFO selection, binary-search uniform clearing price, peer-to-peer crossing, the net AMM swap with the 0.3% counter-tracked fee, full fills, and the fee-per-share increments — verified by the fixtures.
- Empty / degenerate / non-convergent inputs return `cleared: false` safely.
- `git tag` shows `week-05b-clearing-aggregator`.

## Hand-off to Week 5c

`computeClearing`'s output is exactly what an on-chain `ClearingContract` will be handed. Week 5c brainstorms that contract — its hard problem is that `OrderNote`s are private notes only their owner can nullify, so applying a clearing on-chain needs a user-driven `claim_fill` model (each filled maker nullifies their own order and claims their output, the contract validating the claim against the recorded epoch result).

## Risk Notes

- **Bisection monotonicity (Task 3).** `findClearingPrice` assumes the residual is monotone with a single sign change in the band. It guards by requiring the band endpoints to bracket a root (`residual(lo) >= 0 >= residual(hi)`) and returns `null` otherwise; non-convergence within `MAX_ITERS` also returns `null`. The `findClearingPrice` tests must include a case that exercises the `null` path (e.g. a degenerate pool) so the safe exit is covered.
- **Floor-rounding dust (Tasks 3-4).** Every `mulDiv` floors. Tests assert the constant product is preserved-or-grown (`>=`) and that outputs are positive — never exact-equality on amounts derived through divisions.
- **`computeClearing` shape vs. the future circuit.** The Week-5d circuit will re-verify a submitted `P*`/fills. The AMM formulas in `simulateNet` are the reference the circuit must match — keep them as the single source of truth.
