# Sub-project 2.5: Circuit Integration (Concentrated Liquidity End-to-End)

**Status:** Design
**Date:** 2026-05-22
**Parent project:** [Quetzal](../specs/2026-05-14-zswap-aztec-mvp-design.md) — sub-project 2 follow-up
**Predecessor specs:**
- [Sub-2 (Concentrated Liquidity LP-side)](2026-05-22-zswap-aztec-subproject-02-concentrated-liquidity-design.md)
- [Sub-1 (5d-4 Merkle Settlement Root)](2026-05-21-zswap-aztec-week-05d-4-merkle-settlement-root-design.md)
- [Sub-3 (Permissionless Aggregator)](2026-05-22-zswap-aztec-subproject-03-dar-permissionless-aggregator-design.md)

## Goal

Land end-to-end clearing for the 16-bucket concentrated AMM that Sub-2 left dormant: V3 swap-step math, multi-bucket aggregator trace, 42-field witness builder, circuit `fn main` rewrite with per-bucket assertions, bb prove against the new circuit, and a full e2e exercising LP1+LP2+maker clearing across 2-3 buckets — culminating in a joint Sub-2.5+Sub-3 testnet validation that also resolves Sub-1 5d-3's testnet dormancy.

## Non-Goals

- LP fee distribution per-LP (Sub-2 already pools per-bucket; LPs claim share at withdraw)
- Just-in-time liquidity (V3 mainnet feature; not needed for MVP)
- Mainnet-precision Q128.128 math upgrade (Sub-2's 1e18 Q-format retained for MVP)
- Dynamic bucket count or runtime bucket-bounds adjustment (16 buckets pinned at deploy time)
- Concentrated liquidity range-order specials (V3 limit-order via single-side deposit) — already supported by Sub-2's `compute_deposit_below_range` / `_above_range` math
- Aztec deterministic-address pre-computation to collapse Sub-3's 4-deploy circular-dep dance (Sub-5 follow-up)

## Section 1 — V3 swap-step math (sqrt_p update formula)

Three formulas in 1e18-scaled Q-format added to the existing `circuits/clearing/src/buckets.nr`, `contracts/pool/src/buckets.nr`, and `aggregator/src/buckets.ts` triplet (parity-tested, same pattern as Sub-2's deposit math).

**Going UP (token B flows in, sqrt_p increases) — within a single bucket:**

Given `liquidity L`, current `sqrt_p`, and input `Δb` of token B:
```
sqrt_p_new = sqrt_p + Δb * SCALE / L
```
- Bucket exits to next when `sqrt_p_new >= sqrt_upper`. Then the swap consumed `max_b = L * (sqrt_upper - sqrt_p) / SCALE` and the residual `Δb - max_b` continues to the next bucket starting at `sqrt_p_new = sqrt_lower_of_next = sqrt_upper_of_current`.

**Going DOWN (token A flows in, sqrt_p decreases):**

Given `Δa` of token A:
```
sqrt_p_new = (sqrt_p * L * SCALE) / (L * SCALE + Δa * sqrt_p)
```
- Bucket exits to previous when `sqrt_p_new <= sqrt_lower`. Consumed `max_a = L * (sqrt_p - sqrt_lower) / (sqrt_p * sqrt_lower / SCALE)`; residual continues.

**Token-output formulas (the "other side" payout):**

Going up, the bucket gives out token A:
```
Δa_out = L * (sqrt_p_new - sqrt_p) / (sqrt_p * sqrt_p_new / SCALE)
```
Going down, the bucket gives out token B:
```
Δb_out = L * (sqrt_p - sqrt_p_new) / SCALE
```

**Q-format precision:** 1e18 (60-bit fractional), same as Sub-1/Sub-2. Test-scale token amounts (1e6 – 1e18) never overflow u128 intermediate products with `mul_div` long-multiply (proven in Sub-1's `pricing.nr`). For mainnet scale (>1e24 cumulative volume), Q-format may need upgrade to Q128.128 — out-of-scope, documented as Sub-5 follow-up.

**Rounding convention:** Always round-down (floor) in intermediate products. Pool keeps any dust; swapper gets slightly less than ideal. Matches V3 mainnet convention. Aggregator computes outputs identically to the circuit so no proof mismatch.

**LP fee withholding:** 0.3% fee withheld from the swap INPUT before sqrt_p update, just like Sub-1's V2 — but per-bucket. Fee accrues to that bucket's `cum_fee_*_per_share` counter via the `BucketDelta` increments.

## Section 2 — Multi-bucket trace + circuit per-bucket assertions

### Aggregator: `traceBucketSwap` multi-bucket state machine

Replaces the current Sub-2 single-bucket-only `traceBucketSwap`:

```
traceBucketSwap(pool, swap):
  let { buckets, currentSqrtPrice, activeBucketId } = pool
  let remaining_in = swap.input_amount  // already fee-adjusted at caller
  let total_out = 0
  let active_deltas: Map<bucket_id, BucketDelta> = {}
  let direction = swap.side == BUY ? UP : DOWN
  let sqrt_p = currentSqrtPrice
  let bucket_id = activeBucketId

  while remaining_in > 0:
    let bucket = buckets[bucket_id]
    let bounds = computeBoundsFor(bucket_id, p_min_sqrt, growth_num)

    if bucket.liquidity == 0:
      // Empty bucket: cross instantly to next non-empty (sqrt_p jumps to bound)
      sqrt_p = direction == UP ? bounds.sqrt_upper : bounds.sqrt_lower
      bucket_id = direction == UP ? bucket_id + 1 : bucket_id - 1
      assert(bucket_id < NUM_BUCKETS && bucket_id >= 0, "swap exceeded all buckets")
      continue

    // Compute max input that stays within this bucket
    let max_in = direction == UP
      ? max_b_in_to_upper(bucket.liquidity, sqrt_p, bounds.sqrt_upper)
      : max_a_in_to_lower(bucket.liquidity, sqrt_p, bounds.sqrt_lower)

    if remaining_in <= max_in:
      // Swap concludes inside this bucket
      let sqrt_p_new = direction == UP
        ? sqrt_p + (remaining_in * SCALE) / bucket.liquidity
        : (sqrt_p * bucket.liquidity * SCALE) / (bucket.liquidity * SCALE + remaining_in * sqrt_p)
      let out = direction == UP
        ? bucket.liquidity * (sqrt_p_new - sqrt_p) / mul_div(sqrt_p, sqrt_p_new, SCALE)
        : bucket.liquidity * (sqrt_p - sqrt_p_new) / SCALE
      total_out += out
      recordDelta(active_deltas, bucket_id, remaining_in, out, direction)
      sqrt_p = sqrt_p_new
      remaining_in = 0
    else:
      // Crosses out of this bucket
      let bound = direction == UP ? bounds.sqrt_upper : bounds.sqrt_lower
      let out = direction == UP
        ? bucket.liquidity * (bound - sqrt_p) / mul_div(sqrt_p, bound, SCALE)
        : bucket.liquidity * (sqrt_p - bound) / SCALE
      total_out += out
      recordDelta(active_deltas, bucket_id, max_in, out, direction)
      sqrt_p = bound
      remaining_in -= max_in
      bucket_id = direction == UP ? bucket_id + 1 : bucket_id - 1
      assert(bucket_id < NUM_BUCKETS && bucket_id >= 0, "swap exceeded all buckets")

  assert(active_deltas.size <= MAX_ACTIVE_BUCKETS_PER_EPOCH, "too many buckets crossed")
  return { total_out, active_deltas, new_sqrt_price: sqrt_p, new_active_bucket_id: bucket_id }
```

**Empty-bucket handling:** `sqrt_p` jumps instantly to the boundary; no input consumed, no fee accrued. Empty buckets have no LPs to compensate. If ALL buckets in the swap direction are empty, the trace fails with "swap exceeded all buckets" and the caller (`clearing.ts`) rejects the swap.

**Multi-bucket cap = 4:** `MAX_ACTIVE_BUCKETS_PER_EPOCH=4` already set in Sub-2. Aggregator enforces; circuit enforces (sparse delta array length).

### Circuit `fn main` per-bucket assertions (in `circuits/clearing/src/main.nr`)

For each `BucketDelta[i]` in the public input where `bucket_id != INVALID_BUCKET_ID`:

1. **Pre-state ↔ private witness binding:** Assert `bucket_state_before[bucket_id].hash() == private_witness.bucket_states_before_hashes[i]` (binds public delta to private state)
2. **Constant-product invariant (V3 form):**
   - Reconstructed `sqrt_p_new` from delta and pre-state must produce post-state reserves matching delta:
     - `post_reserve_a == pre_reserve_a - delta.reserve_a_out + delta.reserve_a_in`
     - `post_reserve_b == pre_reserve_b - delta.reserve_b_out + delta.reserve_b_in`
   - Liquidity preserved: `bucket_state_after.liquidity == bucket_state_before.liquidity` (swap doesn't change L; only deposit/withdraw does)
3. **Per-bucket sqrt_p trajectory:** Bucket touched implies `sqrt_p` traverses through it. Last bucket's `sqrt_p_after` equals `clearing.current_sqrt_price_after` in `ClearingPublic`.

**Cross-bucket sum equality (single assertion, outside the per-bucket loop):**

```rust
let total_a_consumed = sum(deltas[i].reserve_a_in for i in 0..4)
let total_a_paid_out = sum(deltas[i].reserve_a_out for i in 0..4)
let total_b_consumed = sum(deltas[i].reserve_b_in for i in 0..4)
let total_b_paid_out = sum(deltas[i].reserve_b_out for i in 0..4)

// Match orderbook's net flow (already in ClearingPublic)
assert(total_b_consumed - total_b_paid_out == clearing.pool_b_in - clearing.pool_b_out)
assert(total_a_consumed - total_a_paid_out == clearing.pool_a_in - clearing.pool_a_out)
```

**Why this assertion shape:** Per-bucket assertions catch any per-bucket math fudging; cross-bucket sum catches aggregator-side tampering with delta distribution. Combined: aggregator cannot produce a valid proof unless it ran traceBucketSwap correctly with the same math the circuit reconstructs.

**Fee assertion:** Each delta carries `cum_fee_a_delta` and `cum_fee_b_delta`. Circuit asserts:
```rust
fee_a = direction == DOWN ? delta.reserve_a_in * FEE_BPS / 10000 : 0
fee_b = direction == UP ? delta.reserve_b_in * FEE_BPS / 10000 : 0
delta.cum_fee_a_delta == fee_a * SCALE / bucket.liquidity
delta.cum_fee_b_delta == fee_b * SCALE / bucket.liquidity
```

**Witness shape:**
- **Public inputs (42 fields):** unchanged from Sub-2 (already laid out in `flatten_clearing_public`).
- **Private witness additions:** `bucket_states_before: [BucketState; 4]` and `bucket_states_after: [BucketState; 4]`. The bucket_id slot in the corresponding `BucketDelta` names which bucket the slot represents. Padding entries are zero-state + asserted-skipped if `delta.bucket_id == INVALID_BUCKET_ID`.

## Section 3 — Witness builder + bb prove rebuild + bridge recheck

### `aggregator/src/witness.ts` — 42-field public input emission

Current builder emits 19-field Sub-1 shape. Rewrite to match `flatten_clearing_public` slot layout:

```
slot[0]    = epoch_id
slot[1]    = clearing_price_num
slot[2]    = clearing_price_denom
slot[3]    = total_a_in_pool
slot[4]    = total_b_in_pool
slot[5]    = total_a_out_pool
slot[6]    = total_b_out_pool
slot[7]    = fills_root                    (Sub-1 5d-4 Merkle)
slot[8]    = pool_a_in
slot[9]    = pool_b_in
slot[10]   = pool_a_out
slot[11]   = pool_b_out
slot[12]   = current_sqrt_price_after
slot[13]   = active_bucket_count           (1..4)
slot[14+k*7 .. 14+k*7+6] for k in 0..4:
  [0] bucket_id (INVALID_BUCKET_ID = 0xFFFF if padding)
  [1] reserve_a_in
  [2] reserve_a_out
  [3] reserve_b_in
  [4] reserve_b_out
  [5] cum_fee_a_delta
  [6] cum_fee_b_delta
```

**Private witness layout:**
- Per-active-bucket: `BucketState` pre-image (5 fields × 4 = 20)
- Per-active-bucket: `BucketState` post-image (5 fields × 4 = 20)
- Order list: same Sub-1 structure (no changes)
- Pool pre/post `sqrt_p` snapshots: 2 fields

Total witness growth from Sub-1's 19-field clearing: +23 public + ~50 private. Projected gate count: ~85K. Empirical confirmation in the bb prove step.

### `circuits/clearing/src/main.nr` rewrite

Replace current `fn main(...) -> pub [Field; 19]` signature with `-> pub [Field; 42]`. Body structure:

```rust
fn main(
    clearing_public_inputs: ...,           // 42 fields decoded
    orders: [PrivateOrder; MAX_ORDERS],    // existing
    bucket_states_before: [BucketState; 4],
    bucket_states_after: [BucketState; 4],
    pool_sqrt_p_before: u128,
    pool_sqrt_p_after: u128,
) -> pub [Field; 42] {
    // 1. Sub-1 carryover: orderbook fills + crossing price (unchanged)
    let _ = verify_sub1_clearing(clearing_public_inputs, orders);

    // 2. Sub-2.5 NEW: per-bucket state machine assertions
    let mut total_a_in: u128 = 0;
    let mut total_a_out: u128 = 0;
    let mut total_b_in: u128 = 0;
    let mut total_b_out: u128 = 0;
    let mut active_count: u32 = 0;

    // Chain sqrt_p across the per-bucket loop. First active bucket's
    // sqrt_p_in_chain == pool_sqrt_p_before; subsequent buckets receive the
    // previous bucket's sqrt_p_out. After the loop, the last active bucket's
    // sqrt_p_out must equal pool_sqrt_p_after (asserted at step 4 below).
    let mut sqrt_p_in_chain: u128 = pool_sqrt_p_before;

    for k in 0..MAX_ACTIVE_BUCKETS_PER_EPOCH {
        let delta = decode_bucket_delta(clearing_public_inputs, k);
        if delta.bucket_id != INVALID_BUCKET_ID {
            let sqrt_p_out_chain = assert_bucket_step(
                bucket_states_before[k],
                bucket_states_after[k],
                delta,
                sqrt_p_in_chain,
            );
            sqrt_p_in_chain = sqrt_p_out_chain;
            total_a_in += delta.reserve_a_in;
            total_a_out += delta.reserve_a_out;
            total_b_in += delta.reserve_b_in;
            total_b_out += delta.reserve_b_out;
            active_count += 1;
        }
    }

    // 3. Cross-bucket sum equality
    assert(total_a_in - total_a_out == clearing.pool_a_in - clearing.pool_a_out);
    assert(total_b_in - total_b_out == clearing.pool_b_in - clearing.pool_b_out);
    assert(active_count == clearing.active_bucket_count);

    // 4. Pool sqrt_p chain: last active delta's out -> pool_sqrt_p_after -> clearing public
    assert(sqrt_p_in_chain == pool_sqrt_p_after);
    assert(pool_sqrt_p_after == clearing.current_sqrt_price_after);

    pack_public_inputs(...)
}
```

**`assert_bucket_step` helper** (in `circuits/clearing/src/buckets.nr`) carries the V3 math from §1. Takes pre + post `BucketState` + `BucketDelta`, recomputes `sqrt_p_new` via the §1 formulas, and asserts post reserves match.

### bb prove + bridge recheck

```bash
cd circuits/clearing
nargo compile
bb write_vk -b target/clearing.json -o target/vk.bin
bb prove -b target/clearing.json -w target/clearing.gz -o target/proof.bin
```

**Bridge hypothesis empirical confirmation:**
- Read `target/proof.bin` length: expected 500 fields (32 bytes each = 16000 bytes). Truncate to 456 in `aggregator/src/proof-bytes.ts` (unchanged from Sub-1).
- Read `target/vk.bin` length: expected 115 fields. Pad with `Fr.ZERO` to 127 (unchanged).
- `EMPTY_ROOT` constant (Sub-1 5d-4) unchanged.
- New `vk_hash` read by `scripts/deploy-tokens.ts` via `readVkHash()` (already exists).

**Risk:** Gate-count growth could push proving time/RAM past dev-box budget. Mitigation: if bb prove OOMs, profile gate counts (`bb gates --bytecode-path target/clearing.json`) to identify hot paths. The per-bucket loop is the suspect — `assert_bucket_step` math can be simplified by precomputing intermediate products in witness rather than in-circuit. Document if needed.

**vk_hash refresh consequence:**
- Orderbook stores new `vk_hash`. The deploy script's existing `readVkHash()` reads from `circuits/clearing/target/vk.bin/vk_hash` — picks up the new value automatically.
- Existing testnet/devnet deployments using Sub-1 vk_hash become incompatible (cannot verify Sub-2.5 proofs). Documented as expected breaking change; testnet must redeploy.

## Section 4 — E2E test + joint Sub-2.5+Sub-3 testnet validation + phasing

### Local dev-stack e2e (`tests/integration/concentrated-lp.test.ts`)

Promote the dormant Sub-2 scaffold to a live test:

```typescript
describe("Sub-2 e2e — concentrated liquidity multi-bucket clearing", () => {
  it("E1: LP1 + LP2 + alice clearing across 3 buckets", async () => {
    // Setup: deploy stack via scripts/deploy-tokens.ts
    //   p_min_sqrt = 0.1e18, growth_num = 1.5e18 (so bucket bounds geometric)
    //   pool starts at sqrt_p = ~bucket 5 center

    // LP1 deposits into bucket 5 (in-range), 1000 tUSDC + auto-derived tETH
    // LP2 deposits into bucket 7 (above spot), tETH-only side per V3 above-range math

    // alice submits a large buy that requires crossing buckets 5 -> 6 -> 7:
    //   compute alice's order size such that max_b_in_to_upper(bucket 5)
    //   is less than alice's input, forcing exit to bucket 6 (empty -> skip)
    //   then bucket 7 absorbs remainder

    // aggregator runs:
    //   - close_epoch (waits for epoch_length blocks)
    //   - traceBucketSwap produces 3-bucket BucketDelta[] (bucket 5 + 7 active; 6 skipped due to empty)
    //   - witness builder emits 42-field public input
    //   - bb prove against the new circuit
    //   - submit verify_clearing on orderbook

    // Assertions:
    //   - LP1 withdraw returns principal + fee_a > 0 (bucket 5 was in-range, took token A)
    //   - LP2 withdraw returns principal + fee_b > 0 (bucket 7 absorbed input B)
    //   - alice's claim_fill produces correct token A output
    //   - orderbook's settlement_root matches the Merkle of fills
    //   - pool's current_sqrt_price moved from bucket 5 -> bucket 7
  });
});
```

**Empty-bucket skip (bucket 6) is the most important test path:** it exercises the trace-machine's empty-bucket jump.

### Joint Sub-2.5 + Sub-3 testnet validation

Single testnet runner script `scripts/testnet-sub2-5.ts`:

1. Deploy full stack to testnet (`AZTEC_NODE_URL=https://aztec-testnet.../`) using the 4-deploy circular-dep dance from `deploy-tokens.ts`
2. Register aggregator via `aggregator register --bond 1000000000 --url <testnet-aggregator-url>` (Sub-3 path)
3. Submit alice's order via CLI (Sub-1 path, carries through)
4. LP1 + LP2 deposit (Sub-2 path)
5. After `EPOCH_LENGTH` testnet blocks: `close-epoch` + clearing daemon runs `traceBucketSwap` + bb prove against testnet ClientIVC + submit `verify_clearing`
6. Verify `claim_fill` works for alice (Sub-1 5d-4 Merkle path) + LP1/LP2 withdraw works (Sub-2 path)
7. Verify aggregator received fee via Treasury (Sub-3 path)

**Idempotency:** Runner persists testnet state in `testnet-state.json` (deployed contract addresses, position nonces, order nonces) so partial-run resume is possible. Same pattern as Sub-1 5d-3's testnet attempt (which never completed `close_epoch` due to epoch_length tuning).

**Resolves carry-over from Sub-1 5d-3:** That memory note explicitly flags `close_epoch_and_clear_verified` as never reached on testnet. This run completes it (now Sub-2.5-shape, but proves the path end-to-end).

**Testnet success criteria:**
- `tx_hash` URLs for: 4 deploys + register + 1 order + 2 deposits + close_epoch + verify_clearing + claim_fill + 2 withdraws
- All txs reach `mined` status (not `pending` or `dropped`)
- Final balances reconcile vs starting balances + expected swap output + fees

### Phasing (mapping to task plan)

- **Phase A** (1 task): V3 swap-step math in `buckets.nr` + `buckets.ts` 3-way parity (extends existing primitives)
- **Phase B** (3 tasks): aggregator `traceBucketSwap` multi-bucket + tests
- **Phase C** (3 tasks): witness builder 42-field + per-active-bucket private witness wiring + tests
- **Phase D** (4 tasks): circuit `fn main` rewrite + per-bucket assertions + cross-bucket sum + bb prove
- **Phase E** (2 tasks): bridge recheck + local e2e (`concentrated-lp.test.ts`)
- **Phase F** (2 tasks): joint Sub-2.5+Sub-3 testnet runner + execution + memory note

Estimated 15 tasks total; ~3-4 weeks.

## Success criteria

Sub-2.5 lands when:
1. `concentrated-lp.test.ts E1` passes on local dev stack with the V3 swap-step math crossing 2-3 buckets (one of which is empty).
2. Testnet runner produces all expected `tx_hash`es + reconciled balances; `close_epoch_and_clear_verified` path is exercised end-to-end (Sub-1 5d-3 dormancy resolved).
3. Sub-1 + Sub-3 + Sub-2 LP-side carryover tests still green (no regressions).
4. Bridge hypothesis (500-field proof, 115-field VK, `EMPTY_ROOT` constant) still holds empirically against the new circuit.
