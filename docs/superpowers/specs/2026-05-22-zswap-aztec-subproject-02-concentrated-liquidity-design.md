# Quetzal on Aztec — Sub-project 2 Design: Concentrated Liquidity (Bucket Model)

**Status:** spec
**Date:** 2026-05-22
**Predecessors:** [Sub-project 1 complete through Week 5d-4](./2026-05-21-zswap-aztec-week-05d-4-merkle-settlement-root-design.md), [Sub-project 3 permissionless aggregator](./2026-05-22-zswap-aztec-subproject-03-dar-permissionless-aggregator-design.md)
**Sub-project:** 2 of 6 (concentrated liquidity)
**Estimated duration:** 7 weeks

---

## 1. Goal

Replace Sub-1's flat-liquidity Uniswap-V2-style AMM with a 16-bucket concentrated-liquidity model: each bucket is a discrete price range with its own independent constant-product reserves + liquidity accounting + fee accrual counters. LPs deposit into a chosen bucket (private). Swaps cross from one bucket to the next as the pool's spot price moves through the ranges. Result: 5-10x LP capital efficiency compared to V2 flat liquidity, with full privacy on per-LP amounts (only bucket-level aggregates leak).

## 2. Non-Goals

- **Uniswap V3 tick-grid parity.** Dense (~4000 tick) grid leaks every LP's range to the world. Out of scope.
- **Continuous LP ranges.** Per-position arbitrary [P_lo, P_hi] would force the clearing circuit to iterate every active position. Out of scope; predefined buckets accepted as the privacy/circuit-budget compromise.
- **Bucket count adjustment post-deploy.** Bounds are `PublicImmutable<[BucketBounds; 16]>`; reconfiguring requires a new pool deploy.
- **LP range migration.** Moving a position from bucket A to bucket B requires withdraw + redeposit.
- **MEV resistance for LP positions.** Bucket selection leaks 4 bits (1-of-16) to the aggregator at clearing time. Privacy maximalism within the bucket model; full MEV resistance for LP intent is a future cycle.

## 3. Threat model

Sub-2 inherits Sub-1's + Sub-3's threat model. New surface:
- **Bucket selection leak:** every LP's `PositionNote.bucket_id` (a u32 in 0..15) is private at the note level. The on-chain `Map<u32, PublicMutable<BucketState>>` writes to a specific bucket index ARE observable per Aztec public state semantics — anyone watching the chain sees "bucket 5 deposit traffic" even if they cannot tie a specific LP to that bucket. Anonymity set = `(number of distinct LPs depositing to bucket 5)`. With many LPs and a "bucket-flow" mixer pattern, this approaches near-full privacy for individual LPs.
- **Out-of-range position discovery:** an LP whose bucket is well above or below current spot earns no fees and stays in token-A-only or token-B-only state. The on-chain bucket reserves disclose which buckets have liquidity. This is acceptable: knowing "some LPs think price will rise to bucket 9" is fine since it's an aggregate signal across many makers.

## 4. Data model

### 4.1 Bucket schema (deploy-time immutable)

```rust
struct BucketBounds {
    sqrt_lower: u128,  // sqrt(P_lower), Q-format 1e18-scaled
    sqrt_upper: u128,  // sqrt(P_upper)
}
```

16 buckets, geometric 1.5x spacing from `P_min` (deploy-time constant):
- `bounds[i].sqrt_lower = sqrt(P_min * 1.5^i)`
- `bounds[i].sqrt_upper = sqrt(P_min * 1.5^(i+1))`
- Default `P_min = 0.01x` of initial spot ⇒ total range covered: 0.01x → 656x.

Stored as `PublicImmutable<[BucketBounds; 16]>` (16 × 2 = 32 fields ≈ 2 KB). Computed once at constructor from `P_min` + `growth_num = 1500000000000000000` (1.5e18).

### 4.2 Per-bucket runtime state

```rust
struct BucketState {
    reserve_a: u128,             // token A held by this bucket
    reserve_b: u128,             // token B held by this bucket
    liquidity: u128,             // L = sqrt(reserve_a * reserve_b) when in-range
    cum_fee_a_per_share: u128,   // MasterChef-style, per-bucket (FEE_SCALE = 1e18)
    cum_fee_b_per_share: u128,
}
```

Stored as `buckets: Map<u32, PublicMutable<BucketState>, Context>` keyed by bucket_id ∈ [0,15]. 5 PublicMutable slots per bucket × 16 = 80 slots max; in practice only the 1-3 active buckets per clearing get written.

### 4.3 PositionNote (private)

```rust
struct PositionNote {
    bucket_id: u32,                              // private
    l_share: u128,                               // LP's L in the bucket
    cum_fee_a_per_share_at_deposit: u128,
    cum_fee_b_per_share_at_deposit: u128,
    nonce: Field,
    owner: AztecAddress,
}
```

`bucket_id` field new in Sub-2 vs Sub-1. Existing Sub-1 positions cannot decode with this shape; **fresh deploy required**.

### 4.4 PoolState (global, collapsed)

```rust
struct PoolState {
    reserve_a: u128,           // cached aggregate = sum of buckets[i].reserve_a
    reserve_b: u128,           // cached aggregate
    current_sqrt_price: u128,  // pool's global sqrt_P — drives bucket activation
}
```

Sub-1 fields dropped: `lp_supply`, `cum_fee_a_per_share`, `cum_fee_b_per_share`. The MasterChef counters move into BucketState (per-bucket); `lp_supply` is no longer a single counter (each bucket has its own `liquidity`).

### 4.5 ClearingSwap (clearing circuit ↔ pool interface)

```rust
struct BucketDelta {
    bucket_id: u32,
    reserve_a_add: u128,  reserve_a_sub: u128,
    reserve_b_add: u128,  reserve_b_sub: u128,
    cum_fee_a_per_share_increment: u128,
    cum_fee_b_per_share_increment: u128,
}

struct ClearingSwap {
    // Aggregated cross-bucket flows (token IN/OUT vs orderbook).
    a_to_pool: u128,
    b_to_pool: u128,
    a_from_pool: u128,
    b_from_pool: u128,
    // Sparse per-bucket deltas; MAX_ACTIVE_BUCKETS_PER_EPOCH = 4.
    active_bucket_deltas: [BucketDelta; 4],
    active_bucket_count: u32,
}
```

`MAX_ACTIVE_BUCKETS_PER_EPOCH = 4` is generous — most clearings touch 1-2 buckets given 1.5x bucket spacing.

### 4.6 ClearingPublic (circuit ↔ orderbook public-input vector)

Sub-1: 19 fields. Sub-2: **40 fields** (dropped `lp_supply` since per-bucket `liquidity` replaces it; no single global counter survives).

Slot layout:
- [0-6] order_acc, cancel_acc, order_count, cancel_count, reserve_a, reserve_b, clearing_price (7 fields)
- [7] fills_root (5d-4 Merkle settlement, unchanged)
- [8-11] a_to_pool, b_to_pool, a_from_pool, b_from_pool
- [12] current_sqrt_price_before
- [13] current_sqrt_price_after
- [14] active_bucket_count
- [15-38] active_bucket_deltas[0..4] × 6 fields each = 24 fields
- [39] reserved (zero-padded; future-proofing for fee carve-out)

`flatten_clearing_public` rewritten as `[Field; 40]`.

## 5. Deposit flow

### 5.1 V3 liquidity formulas

For bucket `[sqrt_lower, sqrt_upper]` at current pool `sqrt_P`:

**In-range** (`sqrt_lower < sqrt_P < sqrt_upper`) — both sides used, with refund:
```
L_a = X_a * (sqrt_P * sqrt_upper / SCALE) / (sqrt_upper - sqrt_P)
L_b = X_b * SCALE / (sqrt_P - sqrt_lower)
L_used = min(L_a, L_b)
used_a = L_used * (sqrt_upper - sqrt_P) / (sqrt_P * sqrt_upper / SCALE)
used_b = L_used * (sqrt_P - sqrt_lower) / SCALE
refund_a = X_a - used_a
refund_b = X_b - used_b
```

**Below range** (`sqrt_P <= sqrt_lower`) — bucket holds only token A:
```
L_used = X_a * (sqrt_upper * sqrt_lower / SCALE) / (sqrt_upper - sqrt_lower)
used_a = X_a
used_b = 0
refund_a = 0
refund_b = X_b   // entirely refunded
```

**Above range** (`sqrt_P >= sqrt_upper`) — bucket holds only token B:
```
L_used = X_b / (sqrt_upper - sqrt_lower)
used_a = 0
used_b = X_b
refund_a = X_a   // entirely refunded
refund_b = 0
```

### 5.2 `deposit` end-to-end

```rust
fn deposit(
    bucket_id: u32,
    amount_a: u128, amount_b: u128,
    hint: PoolHintForBucket,
    nonce_a: Field, nonce_b: Field, position_nonce: Field,
)
```

Hint-validate pattern carried over from Sub-1:
1. Validate `bucket_id ∈ [0, 15]`.
2. Escrow `amount_a` + `amount_b` into pool's PUBLIC balance (`Token.transfer_private_to_public`).
3. Compute `(l_used, used_a, used_b)` from `compute_deposit_in_range` / `_below_range` / `_above_range` based on hint values.
4. Refund the surplus side privately: `Token.transfer_public_to_private(pool → maker, refund_*)` if non-zero.
5. Insert new PositionNote with `l_share = l_used`, `cum_fee_*_at_deposit` from hint.
6. Enqueue `_apply_deposit_to_bucket(bucket_id, used_a, used_b, l_used, hint)` which:
   - Re-reads bucket state, asserts `actual == hint` (optimistic concurrency from Sub-1).
   - Asserts `current_sqrt_price` is consistent with bucket bounds in the hint's regime (in-range / below / above).
   - Updates bucket: `reserve_a += used_a`, `reserve_b += used_b`, `liquidity += l_used`.
   - Updates global `PoolState.reserve_a/b` aggregate cache.

### 5.3 CLI ergonomics

`quetzal deposit --bucket <id> --amount-a <X> [--auto-b]`:
- `--auto-b`: CLI reads bucket state via `get_bucket(id)` simulate-call, computes exact required `amount_b` for `amount_a` at the bucket's current ratio. Submits with that exact pair to maximize L_used.
- Without `--auto-b`: maker provides both amounts; refund pattern handles surplus.

## 6. Withdraw flow

```rust
fn withdraw(
    position_nonce: Field,
    hint: BucketStateHint,
    nonce_a: Field, nonce_b: Field,
)
```

1. Pop the PositionNote (nullifier-based one-shot, owner check).
2. Compute `fee_*_per_share_delta = hint.cum_fee_*_per_share - note.cum_fee_*_at_deposit`.
3. `earned_a = mul_div(l_share, fee_a_per_share_delta, FEE_SCALE)`; `earned_b` analogous.
4. `principal_a = mul_div(l_share, hint.reserve_a, hint.liquidity)`; `principal_b` analogous.
5. `payout_a = principal_a + earned_a`; `payout_b = principal_b + earned_b`.
6. `Token.transfer_public_to_private(pool → lp, payout_*)` for both tokens.
7. Enqueue `_apply_withdraw_to_bucket(bucket_id, l_share, principal_*, earned_*, hint)` which:
   - Asserts hint matches live bucket state (all 5 fields).
   - Asserts underflow safety (`bucket.reserve_a >= principal_a + earned_a`, similar for B and liquidity).
   - Decrements bucket state.
   - Updates global PoolState aggregate cache.

**Out-of-range withdraw:** if the bucket is below or above current price, one of `reserve_a` / `reserve_b` is 0, so the corresponding principal is 0 and payout is single-token. Math works without special-case branching.

**Fee accrual contract:** `cum_fee_*_per_share` increments ONLY in clearing's `BucketDelta` (Bölüm 3), and only for buckets that flow absorbed actual swap flow during that epoch. Buckets that sit dormant accumulate no fees. The MasterChef invariant `cum_fee_at_deposit <= cum_fee_now` is preserved by construction (monotonic non-decreasing).

## 7. Clearing circuit changes

### 7.1 Aggregator-side bucket-tracing swap

In `aggregator/src/clearing.ts`:

```
Inputs: bucket_states[16], current_sqrt_price, orders[].

Algorithm:
1. Standard order-matching at uniform clearing price P*  (Sub-1 logic).
2. Compute net order imbalance: netA, netB.
3. Bucket-tracing swap from current_sqrt_price toward sqrt(P*):
   - active_bucket_id = bucket whose range contains current_sqrt_price
   - direction = (sqrt(P*) > current_sqrt_price) ? "up" : "down"
   - while flow remains AND sqrt_price != sqrt(P*):
     - max_flow_in_bucket = liquidity of active_bucket * (sqrt_boundary - sqrt_price) / SCALE
       (where sqrt_boundary = bucket's sqrt_upper if going up, sqrt_lower if down)
     - if remaining_flow <= max_flow:
         absorb remaining_flow; current_sqrt_price → sqrt(P*); done
     - else:
         active_bucket consumes max_flow; current_sqrt_price → sqrt_boundary;
         advance to next bucket; continue
   - Record per-bucket deltas (reserve_a/b deltas, fee_a/b_increment derived from 0.3% LP fee on that bucket's swap segment).
4. Per-order fills computed at uniform P* (Sub-1 logic, unchanged).

Output: ClearingResult with bucket-level deltas + per-order fills.
```

### 7.2 Circuit-side asserts

Public inputs (40 fields per §4.6). Private witnesses:
- `bucket_bounds: [BucketBounds; 16]`
- `bucket_states_before: [BucketState; 16]`
- `bucket_states_after: [BucketState; 16]`
- existing 5d-2 inputs (`orders`, `cancelled_indices`, `fills`, `fills_len`, `fill_to_order_index`)

The circuit asserts:
1. For each `active_bucket_deltas[i] for i < active_bucket_count`: `bucket_states_after[id] == bucket_states_before[id] + delta`.
2. For non-active buckets (id not in active_bucket_deltas): `bucket_states_after[id] == bucket_states_before[id]`.
3. `Σ_active reserve_a deltas == swap.a_to_pool - swap.a_from_pool` (and similarly for B).
4. For each active bucket: constant-product preservation (V3 swap invariant) of `(reserve_a + delta_a) * (reserve_b + delta_b)` matches the bucket's `liquidity^2 / FEE_SCALE` accounting after fee withholding.
5. `current_sqrt_price_after` is the bucket-tracing endpoint sqrt-price (derived from final active bucket's post-state).
6. Each bucket's `cum_fee_a/b_per_share_increment` = `fee_a/b_collected / bucket.liquidity_before` (MasterChef formula, per-bucket).
7. Existing 5d-2 asserts: order_acc replay, fill payouts canonical, fills_root Merkle (Sub-1 5d-4) unchanged.

### 7.3 RAM budget

- Sub-1 baseline: ~57K gates @ N=32, ~5 GB peak bb prove.
- New per-bucket arithmetic: ~16K gates (16 buckets × ~1K gates V3 math).
- Per-active-bucket assertion overhead: ~3K gates × 4 = 12K gates.
- **Total: ~85K gates, ~7 GB peak bb prove projected.** Empirical verification at plan Task 3 (parallels Sub-1 5d-3 task 3).

If RAM exceeds budget: drop MAX_ACTIVE_BUCKETS_PER_EPOCH from 4 to 3 (reduces by ~3K gates), or skip per-bucket k-monotonicity assert (deferred to off-chain verifier).

### 7.4 bb artifact bridging

Hypothesis (carries forward from 5d-3 / 5d-4): bb proof size stays at 500 fields (file) → 456 fields (contract), bb vk stays at 115 → 127. Public-input count change (19 → 40) is Honk IVC-channel routed, not embedded in proof bytes. Empirical recheck at plan Task 4 with explicit "if bridging numbers drifted, update `HONK_PROOF_FIELDS` / `HONK_VK_FIELDS`" step.

## 8. Migration

- **Fresh deploy required.** PositionNote shape changed (added `bucket_id`); PoolState shape changed (dropped 3 fields, added `current_sqrt_price` + buckets Map). No on-chain migration; existing positions from any Sub-1 deployment must be withdrawn before deploying Sub-2.
- **Deploy script:** `scripts/deploy-tokens.ts` gains `P_MIN_SQRT` + `BUCKET_GROWTH_NUM` (= 1.5e18) constants; pool constructor computes 16 bounds.
- **Pool constructor signature** grows: `constructor(token_a, token_b, p_min_sqrt, bucket_growth_num)` (was just `token_a, token_b`).
- **CLI breaking changes:** `quetzal deposit` adds required `--bucket` flag; `quetzal positions` output includes bucket info.
- **Orderbook side migration:** `clearing_vk_hash` refreshes (new circuit ⇒ new VK). Orderbook constructor itself doesn't change, just gets a fresh deploy with the new hash + new ClearingPublic struct shape.

## 9. Test plan

| ID | Test | Konum | Tip |
|---|---|---|---|
| B1 | `compute_deposit_inrange` matches JS reference for known inputs | `contracts/pool/src/test.nr` + `aggregator/test/buckets.test.ts` | Noir + JS parity |
| B2 | `compute_deposit_inrange` refund path: surplus A returned when L_b binding | Noir TXE | Unit |
| B3 | Single bucket V3 swap: pool sqrt_price moves within bucket bounds, constant product preserved | Noir TXE | Unit |
| B4 | Cross-bucket swap: 2-bucket trace, sqrt_price crosses boundary, both bucket states update | JS unit | Aggregator |
| B5 | Out-of-range bucket deposit (sqrt_p ≥ sqrt_upper): only token B consumed, A refunded | Noir TXE | Unit |
| W1 | Withdraw single-position: principal + earned fees credited to LP, bucket state decremented | Noir TXE | Unit |
| W2 | Withdraw at out-of-range bucket: payout entirely in one token | Noir TXE | Unit |
| W3 | Withdraw underflow guards: stale hint reverts cleanly | Noir TXE | Unit |
| C1 | Clearing circuit: 40-field public-input flatten matches expected slot order | Noir TXE | Unit |
| C2 | Clearing circuit: single-bucket swap proof valid + invalid (tampered delta) rejected | Cross-layer | E2E-deferred |
| P1 | Per-bucket parity: 100 random (L, sqrt_p, sqrt_lower, sqrt_upper) tuples produce identical fills in JS and Noir | `aggregator/test/buckets.parity.test.ts` | Parity |
| E1 | Full e2e (dormant): LP1 deposits bucket 5, LP2 deposits bucket 7, alice submits buy, clearing crosses 5→6→7, both LPs see fees + principal at withdraw | `tests/integration/concentrated-lp.test.ts` | E2E |

### Test deferrals (same TXE-cross-package limitation pattern as Sub-3)

- B1/B5/W1/W2 happy-paths requiring real Token deployment may need to defer the Token-interaction tails to E1. The TXE-friendly unit tests cover the math primitives + the hint-validate logic; the Token escrow + refund flows land in E1.
- C2 (tampered delta rejection) requires the real recursive verify path on L1 rollup kernel, which TXE no-ops (per `memory/reference_aztec_txe_recursive_verify.md`). Deferred to E1.

## 10. Out-of-scope

- Sub-tick precision (denser bucket grid) — Sub-2.5 candidate
- LP range migration without withdraw/redeposit
- Single-sided deposits with implicit auto-swap to ratio
- Bucket count adjustment post-deploy
- Range orders (UI-style limit orders via narrow ranges)
- MEV resistance for LP intent — Sub-3.5 candidate; bucket selection still leaks 4 bits

## 11. Success criteria

- 16 buckets deploy with geometric bounds matching `P_min * 1.5^i` formula.
- Deposit refund pattern returns surplus side to LP's private balance (Sub-1 V2 pattern preserved).
- Single-bucket V3 swap behaves identically to V2 when LP capital is concentrated in a single bucket containing the spot price.
- Cross-bucket clearing executes correctly through 2-3 buckets in one epoch.
- Withdraw returns principal + accrued fees per Bölüm 4 math.
- bb prove on the new 40-field circuit runs in <8 GB RAM at N=32 orders + 4 active buckets.
- Existing Sub-1 + Sub-3 test suites (orderbook + token + aggregator-registry + treasury + aggregator JS) still green after the rewrite.

## 12. Estimated phasing (7 weeks)

| Week | Focus | Outputs |
|---|---|---|
| 1 | V3 math primitives in pool + JS parity scaffold | `contracts/pool/src/buckets.nr` + `aggregator/src/buckets.ts` + B1/P1 tests |
| 2 | Pool deposit/withdraw rewrite | `deposit` + `withdraw` + `_apply_*` callbacks + W1-W3 + B2 TXE tests |
| 3 | Aggregator clearing.ts bucket tracing | `computeClearing` bucket-walk + B4 JS unit + 16-bucket parity |
| 4 | Clearing circuit rewrite + bb artifact rebuild | `circuits/clearing/src/buckets.nr` + main.nr 40-field shape + Task 3 empirical bridge recheck |
| 5 | Orderbook ClearingPublic shape update + integration test E1 stub | flatten_clearing_public `[Field; 40]`, ClearingSwap struct grows, integration test scaffold |
| 6 | CLI updates + deploy script bucket-bounds generation | `quetzal deposit --bucket`, `quetzal positions` enriched, deploy script geometric-bounds computation |
| 7 | E1 e2e + dormant-test housekeeping + README docs | Full LP1+LP2 deposit→clearing→withdraw e2e, op runbook update, sub-2 memory note |

---

**Cross-refs:**
- [Sub-project 1 MVP design](./2026-05-14-zswap-aztec-mvp-design.md)
- [Sub-project roadmap](./2026-05-14-zswap-aztec-roadmap.md)
- [Week 5d-4 Merkle settlement root](./2026-05-21-zswap-aztec-week-05d-4-merkle-settlement-root-design.md)
- [Sub-project 3 permissionless aggregator](./2026-05-22-zswap-aztec-subproject-03-dar-permissionless-aggregator-design.md)
- Memory: [[project-zswap-aztec]], [[subproject1-complete]], [[subproject3-complete]], [[privacy-maximalism-design-default]]
