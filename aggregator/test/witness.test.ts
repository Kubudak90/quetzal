import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { buildClearingWitness, type BucketStateForCircuit, type BucketDeltaForCircuit } from "../src/witness.js";
import { SCALE } from "../src/buckets.js";

describe("buildClearingWitness 42-field Sub-2.5 shape", () => {
  it("C1: emits Prover.toml with 42-field public layout headers", async () => {
    const witness = await buildClearingWitness({
      epoch: { order_acc: 1n, cancel_acc: 0n, order_count: 1, cancel_count: 0 },
      pool: {
        reserve_a: 1000n * SCALE,
        reserve_b: 1000n * SCALE,
        current_sqrt_price_before: SCALE / 5n,
      },
      orders: [{
        side: false, amount_in: SCALE / 100n, limit_price: SCALE,
        order_nonce: 42n, submitted_at_block: 1, owner: 1n,
      }],
      cancellationIndices: [],
      clearing: {
        cleared: true,
        clearingPrice: SCALE,
        fills: [{ orderNonce: 42n, filledIn: SCALE / 100n, amountOut: 0n }],
        newReserveA: 1000n * SCALE,
        newReserveB: 999n * SCALE,
        feeAPerShareIncrement: 0n,
        feeBPerShareIncrement: 0n,
      },
      bucketStatesBefore: [{
        bucket_id: 4,
        reserve_a: 1000n * SCALE, reserve_b: 1000n * SCALE,
        liquidity: SCALE,
        cum_fee_a_per_share: 0n, cum_fee_b_per_share: 0n,
      }],
      bucketStatesAfter: [{
        bucket_id: 4,
        reserve_a: 1000n * SCALE, reserve_b: 999n * SCALE,
        liquidity: SCALE,
        cum_fee_a_per_share: 0n, cum_fee_b_per_share: 0n,
      }],
      bucketDeltas: [{
        bucket_id: 4,
        reserve_a_add: 0n, reserve_a_sub: 0n,
        reserve_b_add: SCALE / 100n, reserve_b_sub: 0n,
        cum_fee_a_per_share_increment: 0n,
        cum_fee_b_per_share_increment: 0n,
      }],
      currentSqrtPriceAfter: SCALE / 5n + SCALE / 1000n,
    });
    assert.match(witness.proverToml, /order_acc\s*=/);
    assert.match(witness.proverToml, /current_sqrt_price_after\s*=/);
    assert.match(witness.proverToml, /active_bucket_count\s*=/);
    assert.match(witness.proverToml, /active_bucket_deltas\s*=/);
    assert.doesNotMatch(witness.proverToml, /lp_supply\s*=/);
    assert.match(witness.proverToml, /bucket_states_before\s*=/);
    assert.match(witness.proverToml, /bucket_states_after\s*=/);
    assert.match(witness.proverToml, /pool_sqrt_p_before\s*=/);
  });
});

describe("buildClearingWitness padding (Sub-2.5)", () => {
  it("C2: pads bucket_states_before/after + active_bucket_deltas to 4 entries", async () => {
    const w = await buildClearingWitness({
      epoch: { order_acc: 0n, cancel_acc: 0n, order_count: 0, cancel_count: 0 },
      pool: { reserve_a: 1000n * SCALE, reserve_b: 1000n * SCALE, current_sqrt_price_before: SCALE },
      orders: [],
      cancellationIndices: [],
      clearing: {
        cleared: false, clearingPrice: 0n, fills: [],
        newReserveA: 1000n * SCALE, newReserveB: 1000n * SCALE,
        feeAPerShareIncrement: 0n, feeBPerShareIncrement: 0n,
      },
      bucketStatesBefore: [],
      bucketStatesAfter: [],
      bucketDeltas: [],
      currentSqrtPriceAfter: SCALE,
    });
    const deltaEntries = (w.proverToml.match(/bucket_id = /g) ?? []).length;
    assert.equal(deltaEntries, 4, "exactly 4 bucket_delta entries (with sentinels)");
    const beforeSection = w.proverToml.split("bucket_states_before = [")[1]?.split("]")[0] ?? "";
    const beforeEntries = (beforeSection.match(/\{ reserve_a/g) ?? []).length;
    assert.equal(beforeEntries, 4, "4 bucket_states_before entries");
    assert.match(w.proverToml, /bucket_id = 65535/);
  });

  it("C3: emits active_bucket_count = bucketDeltas.length", async () => {
    const w = await buildClearingWitness({
      epoch: { order_acc: 0n, cancel_acc: 0n, order_count: 0, cancel_count: 0 },
      pool: { reserve_a: 0n, reserve_b: 0n, current_sqrt_price_before: SCALE },
      orders: [],
      cancellationIndices: [],
      clearing: {
        cleared: false, clearingPrice: 0n, fills: [],
        newReserveA: 0n, newReserveB: 0n,
        feeAPerShareIncrement: 0n, feeBPerShareIncrement: 0n,
      },
      bucketStatesBefore: [
        { bucket_id: 4, reserve_a: 1n, reserve_b: 1n, liquidity: 1n, cum_fee_a_per_share: 0n, cum_fee_b_per_share: 0n },
        { bucket_id: 5, reserve_a: 2n, reserve_b: 2n, liquidity: 2n, cum_fee_a_per_share: 0n, cum_fee_b_per_share: 0n },
      ],
      bucketStatesAfter: [
        { bucket_id: 4, reserve_a: 1n, reserve_b: 1n, liquidity: 1n, cum_fee_a_per_share: 0n, cum_fee_b_per_share: 0n },
        { bucket_id: 5, reserve_a: 2n, reserve_b: 2n, liquidity: 2n, cum_fee_a_per_share: 0n, cum_fee_b_per_share: 0n },
      ],
      bucketDeltas: [
        { bucket_id: 4, reserve_a_add: 0n, reserve_a_sub: 0n, reserve_b_add: 1n, reserve_b_sub: 0n, cum_fee_a_per_share_increment: 0n, cum_fee_b_per_share_increment: 0n },
        { bucket_id: 5, reserve_a_add: 0n, reserve_a_sub: 0n, reserve_b_add: 1n, reserve_b_sub: 0n, cum_fee_a_per_share_increment: 0n, cum_fee_b_per_share_increment: 0n },
      ],
      currentSqrtPriceAfter: SCALE,
    });
    assert.match(w.proverToml, /active_bucket_count = 2/);
  });

  it("C4: throws if bucketDeltas.length > 4", async () => {
    await assert.rejects(
      buildClearingWitness({
        epoch: { order_acc: 0n, cancel_acc: 0n, order_count: 0, cancel_count: 0 },
        pool: { reserve_a: 0n, reserve_b: 0n, current_sqrt_price_before: SCALE },
        orders: [], cancellationIndices: [],
        clearing: {
          cleared: false, clearingPrice: 0n, fills: [],
          newReserveA: 0n, newReserveB: 0n,
          feeAPerShareIncrement: 0n, feeBPerShareIncrement: 0n,
        },
        bucketStatesBefore: Array.from({ length: 5 }, (_, i) => ({
          bucket_id: i, reserve_a: 0n, reserve_b: 0n, liquidity: 0n,
          cum_fee_a_per_share: 0n, cum_fee_b_per_share: 0n,
        })),
        bucketStatesAfter: Array.from({ length: 5 }, (_, i) => ({
          bucket_id: i, reserve_a: 0n, reserve_b: 0n, liquidity: 0n,
          cum_fee_a_per_share: 0n, cum_fee_b_per_share: 0n,
        })),
        bucketDeltas: Array.from({ length: 5 }, (_, i) => ({
          bucket_id: i, reserve_a_add: 0n, reserve_a_sub: 0n, reserve_b_add: 0n, reserve_b_sub: 0n,
          cum_fee_a_per_share_increment: 0n, cum_fee_b_per_share_increment: 0n,
        })),
        currentSqrtPriceAfter: SCALE,
      }),
      /> cap 4/,
    );
  });
});

import { buildClearingWitnessMultiPair } from "../src/witness.js";
import type { HopFill, PoolClearingResult } from "../src/clearing.js";

describe("Sub-4 buildClearingWitnessMultiPair", () => {
  it("W1: empty multi-pair clearing emits 114-field shape headers", async () => {
    const w = await buildClearingWitnessMultiPair({
      epoch: { order_acc: 0n, cancel_acc: 0n, order_count: 0, cancel_count: 0 },
      orders: [],
      cancellationIndices: [],
      perPoolClearings: [],
      fills: [],
    });
    assert.match(w.proverToml, /order_acc\s*=/);
    assert.match(w.proverToml, /fills_root\s*=/);
    assert.match(w.proverToml, /active_pool_count\s*=\s*0/);
    assert.match(w.proverToml, /active_pool_clearings\s*=/);
    assert.match(w.proverToml, /fill_to_order_index\s*=/);
    assert.match(w.proverToml, /pool_bucket_states_before\s*=/);
    assert.match(w.proverToml, /pool_bucket_states_after\s*=/);
    assert.match(w.proverToml, /pool_sqrt_p_before\s*=/);
    assert.match(w.proverToml, /pool_token_pairs\s*=/);
    assert.doesNotMatch(w.proverToml, /active_pools\s*=/);
  });

  it("W2: pads active_pools to 3 with INVALID_POOL_ID sentinels", async () => {
    const w = await buildClearingWitnessMultiPair({
      epoch: { order_acc: 0n, cancel_acc: 0n, order_count: 0, cancel_count: 0 },
      orders: [],
      cancellationIndices: [],
      perPoolClearings: [],
      fills: [],
    });
    // 3 sentinel slots (pool_id = 0xFFFFFFFF = 4294967295)
    const sentinelCount = (w.proverToml.match(/pool_id\s*=\s*4294967295/g) ?? []).length;
    assert.equal(sentinelCount, 3);
  });

  it("W3: 2-hop fills produce hop_index 0 and 1 entries", async () => {
    const perPool: PoolClearingResult[] = [
      {
        pool_id: 0, clearingPrice: 2_000_000_000_000_000_000n,
        bucketDeltas: [],
        currentSqrtPriceAfter: 1_000_000_000_000_000_000n,
        bucketStatesBefore: [], bucketStatesAfter: [],
      },
      {
        pool_id: 2, clearingPrice: 1_000_000_000_000_000_000n,
        bucketDeltas: [],
        currentSqrtPriceAfter: 1_000_000_000_000_000_000n,
        bucketStatesBefore: [], bucketStatesAfter: [],
      },
    ];
    const fills: HopFill[] = [
      { orderNonce: 42n, hop_index: 0, amountOut: 50n, pool_id: 0 },
      { orderNonce: 42n, hop_index: 1, amountOut: 25n, pool_id: 2 },
    ];
    const w = await buildClearingWitnessMultiPair({
      epoch: { order_acc: 0n, cancel_acc: 0n, order_count: 1, cancel_count: 0 },
      orders: [{ side: false, amount_in: 100n, limit_price: 1n, order_nonce: 42n, submitted_at_block: 1, owner: 1n }],
      cancellationIndices: [],
      perPoolClearings: perPool,
      fills,
    });
    // fills array entries include hop_index = 0 and 1
    assert.match(w.proverToml, /hop_index\s*=\s*0/);
    assert.match(w.proverToml, /hop_index\s*=\s*1/);
  });
});
