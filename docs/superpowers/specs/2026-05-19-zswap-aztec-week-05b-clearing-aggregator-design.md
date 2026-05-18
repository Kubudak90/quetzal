# ZSwap-on-Aztec Week 5b — Off-chain clearing aggregator

**Status:** design
**Date:** 2026-05-19
**Parent spec:** `2026-05-14-zswap-aztec-mvp-design.md` (sub-project 1, MVP vertical slice)
**Predecessor:** `2026-05-18-zswap-aztec-week-05-liquidity-pool-design.md`

## 0. Where this sits

The remaining MVP clearing system was decomposed in the Week 5 spec into four
slices. This spec is the first of them:

- **5b (this spec) - off-chain clearing aggregator:** a pure TypeScript module
  implementing the frequent-batch-auction clearing algorithm (MVP design 8.1).
  No Aztec, no chain I/O - pure computation.
- **5c - on-chain `ClearingContract`:** applies a clearing result on-chain. Needs
  its own brainstorm: `OrderNote`s are private notes that only their owner can
  nullify, so on-chain clearing requires a user-driven claim model.
- **5d - Noir clearing circuit:** replaces trust in the aggregator with a ZK proof.
- **5e - settlement claim flow:** encrypted settlement logs, `claim_fill`.

Week 5b is deliberately just the algorithm. Getting the clearing economics correct
and exhaustively tested in isolation - before any on-chain machinery - is the
highest-value first step. The pure function this slice produces is exactly what
the future `ClearingContract` will be handed and what the Week-5c circuit will
verify.

---

## 1. Goals (in scope)

- A new `aggregator/` pnpm-workspace package (`@zswap/aggregator`) containing the
  pure clearing module.
- **`computeClearing(pool, orders)`** - a pure function implementing the MVP
  frequent-batch-auction clearing: FIFO order selection, binary-search discovery
  of a single uniform clearing price `P*`, peer-to-peer crossing at `P*`, the net
  imbalance routed through the constant-product AMM with the 0.3% fee, and the
  resulting per-order fills + LP fee accrual.
- Fixed-point `bigint` arithmetic helpers.
- Exhaustive `node:test` unit tests, runnable without the dev stack.

## 2. Non-goals (deferred)

| Deferred | Target |
|---|---|
| On-chain `ClearingContract` | Week 5c |
| Order-reveal channel (users publishing order plaintexts to the aggregator) | sub-project 3 |
| ZK clearing circuit / proof generation | Week 5d |
| Settlement notes / `claim_fill` | Week 5e |
| Chain-watching, tx submission, the aggregator daemon | later slices |
| Intra-batch partial fills / remnant notes | see 4.3 - not planned for the MVP aggregator |

Week 5b ships a pure library function. It has no `main`, no CLI, no network or
chain dependency. The caller supplies the pool snapshot and the order list; the
function returns the clearing result.

---

## 3. Package structure

`aggregator/` is a new pnpm-workspace member (the `aggregator` entry already
exists in `pnpm-workspace.yaml`, reserved since Week 1).

```
aggregator/
  package.json          # name "@zswap/aggregator", type "module", private
  tsconfig.json         # mirrors cli/tsconfig.json (NodeNext, strict, noEmit)
  src/
    fixed-point.ts      # bigint fixed-point helpers
    clearing.ts         # types + computeClearing()
  test/
    clearing.test.ts    # node:test unit tests
```

`package.json` has a `test` script (`node --import tsx --test test/**/*.test.ts`)
and a `typecheck` script (`tsc --noEmit`). The only dependency is `tsx` +
`typescript` + `@types/node` as devDependencies; **no `@aztec/*`** - the module is
pure. The root `package.json` `test` script is extended so `pnpm test` also runs
the aggregator's unit tests (they need no dev stack, so they run fast and
unconditionally).

---

## 4. The clearing algorithm

### 4.1 Conventions

- **Tokens:** token A is the quote asset (tUSDC), token B is the base asset
  (tETH). This matches the orderbook: `side = false` (bid) deposits token A,
  `side = true` (ask) deposits token B.
- **Price:** `P` is quote-per-base - token A per one unit of token B - scaled by
  `1e18`. `OrderNote.limit_price` uses the same scale.
- **A buy** (`side = false`) pays `amountIn` of token A, wants token B; its
  `limitPrice` is the maximum quote-per-base it will pay.
- **A sell** (`side = true`) pays `amountIn` of token B, wants token A; its
  `limitPrice` is the minimum quote-per-base it will accept.
- All quantities are `bigint`. Token amounts are base units. The 0.3% fee is
  `30 / 10_000`.
- `MAX_ORDERS_PER_EPOCH = 128`.

### 4.2 Types

```ts
export interface ClearingOrder {
  side: boolean;            // false = buy (pays token A), true = sell (pays token B)
  amountIn: bigint;         // token base units (token A for a buy, token B for a sell)
  limitPrice: bigint;       // quote-per-base, 1e18-scaled
  submittedAtBlock: number; // FIFO ordering key
  orderNonce: bigint;       // identity (the OrderNote nonce)
}

export interface PoolSnapshot {
  reserveA: bigint;
  reserveB: bigint;
  lpSupply: bigint;
}

export interface OrderFill {
  orderNonce: bigint;
  filledIn: bigint;   // amount of `amountIn` consumed (== amountIn in this slice; see 4.3)
  amountOut: bigint;  // output token received (token B for a buy, token A for a sell)
}

export interface ClearingResult {
  cleared: boolean;               // false => epoch skipped (no eligible orders / no convergence)
  clearingPrice: bigint;          // P*, 1e18-scaled (0 when cleared == false)
  fills: OrderFill[];             // one per filled order; empty when cleared == false
  newReserveA: bigint;            // pool reserve A after the net AMM swap
  newReserveB: bigint;            // pool reserve B after the net AMM swap
  feeAPerShareIncrement: bigint;  // cum_fee_a_per_share delta, 1e18-scaled
  feeBPerShareIncrement: bigint;  // cum_fee_b_per_share delta, 1e18-scaled
}

export function computeClearing(pool: PoolSnapshot, orders: ClearingOrder[]): ClearingResult;
```

When `cleared == false`, the reserves are returned unchanged and both fee
increments are 0.

### 4.3 Fill model - full-fill

At the self-consistent clearing price `P*`, **every order in the eligible set
fills 100%** (`filledIn == amountIn`). Rationale: the matched buy/sell volume
crosses peer-to-peer at `P*`, and the constant-product AMM backs the net
imbalance - so there is always enough liquidity at `P*` for every eligible order.
Orders excluded from the result (by the 128-cap or by limit price) are simply
absent from `fills`; they carry over **whole** to the next epoch. There are **no
intra-batch partial fills** in this slice - the MVP's remnant-note machinery is
not implemented. `filledIn` is kept in `OrderFill` for forward-compatibility but
always equals the order's `amountIn`.

### 4.4 Steps

**Step 1 - FIFO batch selection.** Sort `orders` ascending by `submittedAtBlock`
(ties broken by `orderNonce` ascending, for determinism). Take the first
`min(128, n)`. This is the epoch's batch; the rest carry over untouched.

**Step 2 - empty check.** If the batch is empty, return
`{ cleared: false, clearingPrice: 0n, fills: [], newReserveA: pool.reserveA,
newReserveB: pool.reserveB, feeAPerShareIncrement: 0n, feeBPerShareIncrement: 0n }`.

**Step 3 - binary search for `P*`.** The search band is
`[spot / 100, spot * 100]` where `spot = reserveA * 1e18 / reserveB`. For a
candidate price `P`:

- `eligibleBuys` = batch orders with `side == false` and `limitPrice >= P`.
- `eligibleSells` = batch orders with `side == true` and `limitPrice <= P`.
- `sumAIn` = sum of `eligibleBuys[].amountIn` (token A).
- `sumBIn` = sum of `eligibleSells[].amountIn` (token B).
- `netA = sumAIn - mulDiv(sumBIn, P, 1e18)` - the buy-side token-A value minus the
  sell-side token-B value priced at `P`.
- If `netA > 0`: the net flow is token A into the AMM. Swap `netA` of token A in
  (constant-product, 0.3% fee on the input): `amountInAfterFee = netA * 9970 / 10000`,
  `outB = reserveB - mulDiv(reserveA, reserveB, reserveA + amountInAfterFee)`.
  `realizedP = mulDiv(netA, 1e18, outB)` (token A per token B for the net swap).
- If `netA < 0`: the net flow is token B into the AMM. `inB = mulDiv(-netA, 1e18, P)`,
  `amountInAfterFee = inB * 9970 / 10000`,
  `outA = reserveA - mulDiv(reserveA, reserveB, reserveB + amountInAfterFee)`,
  `realizedP = mulDiv(outA, 1e18, inB)`.
- If `netA == 0`: `realizedP = P` exactly (perfect cross, no AMM flow).

Bisect on the residual `realizedP - P`: maintain `[lo, hi]`, evaluate `mid`,
narrow toward the sign change. Stop when `abs(realizedP - mid) <= TOLERANCE`
(`TOLERANCE = 1e9`, i.e. 1e-9 of a price unit) or after `MAX_ITERS = 128`
iterations. If no acceptable `P*` is found within `MAX_ITERS`, return
`{ cleared: false, ... }` (the epoch is skipped - a safe no-op).

The residual is treated as monotonically decreasing in `P` over the search band
(higher `P` shrinks `netA` and raises the AMM execution price asymmetrically).
The bisection assumes one sign change; if the band endpoints do not bracket a
root, the search returns `cleared: false`. See 7 (Risks).

**Step 4 - fills and reserves at `P*`.** With `P*` fixed, recompute `eligibleBuys`
/ `eligibleSells`, `sumAIn`, `sumBIn`, `netA`.

- Apply the net AMM swap as in Step 3. **The fee is extracted, not retained in
  reserves** (ZSwap uses a separate MasterChef counter, so the fee must NOT be
  added to `reserve_*` or the Week-5 `withdraw` - which pays `principal` from
  reserves and `fees` from the counter - would double-count it). Concretely, for
  `netA > 0`: `feeAmountA = netA - amountInAfterFee`, `newReserveA = reserveA +
  amountInAfterFee` (the fee portion is held by the pool but tracked in the
  counter, not in `reserve_a`), `newReserveB = reserveB - outB`. Symmetric for
  `netA < 0`. The constant product is therefore preserved across the net swap
  (equal up to floor-division dust), and the fee lives entirely in the counter.
- Each eligible **buy** receives token B: `amountOut = mulDiv(amountIn, 1e18, P*)`.
- Each eligible **sell** receives token A: `amountOut = mulDiv(amountIn, P*, 1e18)`.
- `fills` = one `OrderFill` per eligible buy and sell, `filledIn == amountIn`.

**Step 5 - fee accrual.** The fee amount from Step 4 is in token A if `netA > 0`,
token B if `netA < 0`, zero if `netA == 0`. Convert to a per-share increment:
`feeAPerShareIncrement = mulDiv(feeAmountA, 1e18, lpSupply)` (and `feeB` similarly;
the other is 0). If `lpSupply == 0` the increments are 0 (an empty pool cannot
accrue per-share fees - but note clearing against an empty pool is itself
degenerate; see 7).

### 4.5 Fixed-point helpers (`fixed-point.ts`)

- `mulDiv(a: bigint, b: bigint, denom: bigint): bigint` - computes `a * b / denom`
  with floor division. `bigint` is arbitrary-precision, so the intermediate
  `a * b` never overflows; the helper exists for readability and a single
  divide-by-zero guard.
- `SCALE = 1_000_000_000_000_000_000n` (1e18).
- `FEE_NUM = 9970n`, `FEE_DEN = 10000n` (the 0.3% fee multiplier on swap input).

All rounding is floor (truncating `bigint` division). Conservation checks in the
tests account for floor-rounding dust.

---

## 5. Determinism and conservation

`computeClearing` is a pure function: identical inputs yield byte-identical
output, with no reliance on `Date`, randomness, or iteration order of unsorted
collections (Step 1's sort is total, ties broken by `orderNonce`).

Value conservation, verified by tests: no token is created or destroyed. The
matched volume crosses 1:1 in value at `P*`. The fee is extracted from the swap
input and booked to `cum_fee_*_per_share` (not retained in reserves - see Step 4),
so the constant product is **preserved** across the net swap:
`newReserveA * newReserveB >= reserveA * reserveB`, equal up to floor-division
dust. The sum of `fills[].amountOut` reconciles with the crossed volume plus the
AMM output, up to floor-division dust.

---

## 6. Test strategy

`aggregator/test/clearing.test.ts` - pure `node:test` unit tests, no dev stack.
Hand-computed fixtures:

| Test | Verifies |
|---|---|
| `empty order list -> epoch skipped` | `cleared == false`, reserves unchanged, fees 0. |
| `no eligible orders -> epoch skipped` | Orders whose limit prices admit no `P*` in band -> `cleared == false`. |
| `one-sided book (buys only)` | All net flow swaps token A through the AMM; `newReserveA` up, `newReserveB` down; every buy filled. |
| `one-sided book (sells only)` | Symmetric: token B swaps in. |
| `exact cross` | Buys and sells net to ~0 -> `P*` ~ spot, near-zero AMM flow, near-zero fee, all orders filled. |
| `net imbalance + fee` | Verify the AMM swap output, the 0.3% fee amount, and `newReserveA*newReserveB >= reserveA*reserveB`. |
| `limit price gates a buy out` | A buy with `limitPrice < P*` is absent from `fills`; it carries over. |
| `limit price gates a sell out` | A sell with `limitPrice > P*` is absent from `fills`. |
| `128-cap` | With 130 orders, only the 128 oldest (by `submittedAtBlock`) are in `fills`; the 2 newest are absent. |
| `FIFO tie-break` | Orders with equal `submittedAtBlock` are ordered by `orderNonce` deterministically. |
| `fee-per-share increment` | `feeAPerShareIncrement == mulDiv(feeAmount, 1e18, lpSupply)`; the other increment is 0. |
| `value conservation` | For a representative clearing: `Sum(fills.amountOut)` reconciles with crossed volume + AMM output within dust; constant-product preserved-or-grown. |
| `determinism` | Same inputs called twice -> deep-equal results. |
| `mulDiv` unit tests | Floor behaviour, divide-by-zero throws, large operands (no overflow). |

---

## 7. Risks specific to Week 5b

- **Bisection monotonicity.** The residual `realizedP(P) - P` is assumed to be
  monotonic with a single sign change in the search band. Across an order's limit
  price the eligible set changes discretely, so the residual is piecewise-smooth,
  not globally smooth. If the band endpoints do not bracket a root, or the sign
  changes more than once, the bisection may miss `P*`. Week 5b's mitigation:
  bounded iterations and `cleared: false` on non-convergence (a safe no-op - the
  epoch simply does not clear, orders carry over). A more robust per-interval
  analytic solve was considered and deferred (the spec-faithful binary search was
  chosen). Tests must include a non-convergence fixture to confirm the safe exit.
- **Degenerate pool.** Clearing against `reserveA == 0` or `reserveB == 0`
  (no liquidity) has no well-defined `spot`. `computeClearing` returns
  `cleared: false` when either reserve is 0.
- **Floor-rounding dust.** Every division floors; `amountOut` sums will be a few
  base units short of the ideal. Tests assert reconciliation within an explicit
  dust bound, never exact equality.
- **`P*` vs. the future circuit.** The Week-5d circuit will verify a submitted
  `P*`/fills, re-checking the AMM math and limit constraints - it does not care
  how `P*` was found. Keeping `computeClearing`'s AMM formulas identical to what
  the circuit will check is important; the formulas in 4.4 are the reference.

---

## 8. Repository delta after Week 5b

```
aggregator/package.json        + new pnpm-workspace package
aggregator/tsconfig.json       + new
aggregator/src/fixed-point.ts  + new
aggregator/src/clearing.ts     + new
aggregator/test/clearing.test.ts + new
package.json                   ~ root `test` script also runs the aggregator unit tests
pnpm-lock.yaml                 ~ new package's devDependencies
README.md                      ~ status line + docs links
```

## 9. Implementation phases (preview of the plan)

1. `aggregator/` package scaffold (`package.json`, `tsconfig.json`) + `fixed-point.ts`
   helpers + their unit tests; wire the root `test` script.
2. `clearing.ts` types + Steps 1-2 (FIFO batch, empty check) + those tests.
3. Step 3 - the binary search for `P*` + the AMM swap math + convergence tests.
4. Steps 4-5 - fills, reserve update, fee accrual + the remaining tests.
5. Final check: `pnpm test` runs the aggregator unit tests green alongside the
   existing suites; README; milestone commit + tag `week-05b-clearing-aggregator`.

## 10. Acceptance criteria

- `@zswap/aggregator` typechecks; `computeClearing` and the fixed-point helpers
  are pure (no `@aztec/*`, no I/O).
- All aggregator unit tests pass; `pnpm test` runs them and they are green; the
  prior 21 TXE + 23 integration tests are unaffected.
- `computeClearing` correctly implements MVP design 8.1: FIFO selection, binary
  search `P*`, peer-to-peer crossing, the net AMM swap with the 0.3% fee, full
  fills, and the fee-per-share increments - all verified by hand-computed fixtures.
- Non-convergence and degenerate inputs return `cleared: false` safely.
- `git tag` shows `week-05b-clearing-aggregator`.

## 11. Open questions deferred to implementation

- The exact `TOLERANCE` and `MAX_ITERS` constants - 4.4 proposes `1e9` and `128`;
  the plan may tune them against the test fixtures.
- Whether `fixed-point.ts` needs more than `mulDiv` + the constants - kept minimal
  by YAGNI; add only what `clearing.ts` actually uses.
