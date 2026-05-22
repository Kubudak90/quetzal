import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { traceBucketSwap, type PoolWithBuckets } from "../src/clearing.js";
import { SCALE } from "../src/buckets.js";

function makePool(): PoolWithBuckets {
  // 16 buckets, geometric 1.5x spacing from sqrt_p=1.0 ... bounds[5] contains
  // sqrt_p=1.0e18 (we'll set currentSqrtPrice there).
  const bounds = Array.from({ length: 16 }, (_, i) => ({
    sqrt_lower: SCALE * (i === 0 ? 1n : (15n ** BigInt(i)) / (10n ** BigInt(i)) ),
    sqrt_upper: SCALE * (15n ** BigInt(i + 1)) / (10n ** BigInt(i + 1)),
  }));
  // Active bucket has reserves + liquidity; others are empty.
  const states = Array.from({ length: 16 }, () => ({
    reserve_a: 0n, reserve_b: 0n, liquidity: 0n,
    cum_fee_a_per_share: 0n, cum_fee_b_per_share: 0n,
  }));
  states[0] = {
    reserve_a: 1_000_000n, reserve_b: 1_000_000n, liquidity: 1_000_000n,
    cum_fee_a_per_share: 0n, cum_fee_b_per_share: 0n,
  };
  return {
    reserveA: 1_000_000n, reserveB: 1_000_000n, lpSupply: 0n,
    currentSqrtPrice: SCALE,  // sqrt(1.0)
    bucketBounds: bounds,
    bucketStates: states,
  };
}

describe("traceBucketSwap (Sub-2 single-bucket case)", () => {
  it("zero flow returns identity", () => {
    const pool = makePool();
    const out = traceBucketSwap(pool, 0n, 0n);
    assert.equal(out.bucketDeltas.length, 0);
    assert.equal(out.newSqrtPrice, pool.currentSqrtPrice);
    assert.equal(out.newReserveA, pool.reserveA);
    assert.equal(out.newReserveB, pool.reserveB);
  });

  it("netA > 0 (A flows in) produces single BucketDelta with reserve_a_add", () => {
    const pool = makePool();
    const out = traceBucketSwap(pool, 1_000n, 0n);
    assert.equal(out.bucketDeltas.length, 1);
    assert.equal(out.bucketDeltas[0]!.reserve_a_add, 1_000n);
    assert.equal(out.bucketDeltas[0]!.reserve_b_add, 0n);
    assert.ok(out.bucketDeltas[0]!.reserve_b_sub > 0n);
    assert.ok(out.bucketDeltas[0]!.cum_fee_a_per_share_increment > 0n);
  });

  it("netB > 0 (B flows in) produces single BucketDelta with reserve_b_add", () => {
    const pool = makePool();
    const out = traceBucketSwap(pool, 0n, 1_000n);
    assert.equal(out.bucketDeltas.length, 1);
    assert.equal(out.bucketDeltas[0]!.reserve_b_add, 1_000n);
    assert.equal(out.bucketDeltas[0]!.reserve_a_add, 0n);
    assert.ok(out.bucketDeltas[0]!.reserve_a_sub > 0n);
    assert.ok(out.bucketDeltas[0]!.cum_fee_b_per_share_increment > 0n);
  });

  it("empty bucket returns identity (no flow can be absorbed)", () => {
    const pool = makePool();
    // Clear out bucket 0
    pool.bucketStates[0] = {
      reserve_a: 0n, reserve_b: 0n, liquidity: 0n,
      cum_fee_a_per_share: 0n, cum_fee_b_per_share: 0n,
    };
    const out = traceBucketSwap(pool, 1_000n, 0n);
    assert.equal(out.bucketDeltas.length, 0);
  });
});
