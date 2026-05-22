import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { buildClearingWitness, type BucketStateForCircuit } from "../src/witness.js";
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
