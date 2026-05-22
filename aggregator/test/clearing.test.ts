import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { computeClearingV2 } from "../src/clearing.js";
import { SCALE } from "../src/buckets.js";

describe("computeClearingV2 (Sub-2.5 bucket-aware)", () => {
  it("V1: BUY-only batch routes through traceBucketSwap and emits deltas", () => {
    const pMinSqrt = SCALE / 10n;
    const growth = (SCALE * 15n) / 10n;
    const bounds = [];
    let lo = pMinSqrt;
    for (let i = 0; i < 16; i++) {
      const hi = (lo * growth) / SCALE;
      bounds.push({ sqrt_lower: lo, sqrt_upper: hi });
      lo = hi;
    }
    const states = bounds.map(() => ({
      reserve_a: 0n, reserve_b: 0n, liquidity: 0n,
      cum_fee_a_per_share: 0n, cum_fee_b_per_share: 0n,
    }));
    // Seed bucket 4 with substantial liquidity
    states[4] = {
      reserve_a: 1000n * SCALE, reserve_b: 1000n * SCALE,
      liquidity: SCALE, cum_fee_a_per_share: 0n, cum_fee_b_per_share: 0n,
    };

    // Set currentSqrtPrice INSIDE bucket 4 (3/4 through its width)
    const b4 = bounds[4]!;
    const sqrtP = b4.sqrt_lower + ((b4.sqrt_upper - b4.sqrt_lower) * 3n) / 4n;

    const result = computeClearingV2(
      {
        reserveA: 1000n * SCALE, reserveB: 1000n * SCALE,
        lpSupply: SCALE, currentSqrtPrice: sqrtP,
        bucketBounds: bounds, bucketStates: states,
      },
      [{
        side: false, amountIn: SCALE / 100n, limitPrice: SCALE * 1000n,
        submittedAtBlock: 1, orderNonce: 42n,
      }, {
        // matching sell so the clearing has both sides
        side: true, amountIn: SCALE / 100n, limitPrice: SCALE / 1000n,
        submittedAtBlock: 1, orderNonce: 43n,
      }],
    );
    assert.equal(result.cleared, true, "clearing succeeded");
    assert.ok(result.bucketDeltas !== undefined, "result has bucketDeltas");
    assert.ok(Array.isArray(result.bucketStatesBefore), "result has bucketStatesBefore");
    assert.ok(Array.isArray(result.bucketStatesAfter), "result has bucketStatesAfter");
    assert.ok(result.currentSqrtPriceAfter !== undefined, "result has currentSqrtPriceAfter");
  });
});
