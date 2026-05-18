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
