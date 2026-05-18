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
    // Fee is WITHHELD (not added to reserves), so the fee-free constant product
    // is preserved up to floor-division dust: k can shrink by sub-(Ra+afterFee)
    // dust, never grow. (See self-review: the design's ">=" was the wrong
    // direction for the fee-withheld model.)
    assert.ok(s.newReserveA * s.newReserveB <= Ra * Rb, "k preserved, shrinks only by dust");
    assert.ok(s.newReserveA * s.newReserveB >= Ra * Rb - s.newReserveA, "dust bounded by one reserve unit");
  });

  it("token B in (netA < 0): symmetric", () => {
    const Ra = 1_000_000_000_000n;
    const Rb = 1_000_000_000_000n;
    const s = simulateNet(Ra, Rb, -10_000_000_000n, SCALE);
    assert.equal(s.feeAmountA, 0n);
    assert.ok(s.feeAmountB > 0n, "fee withheld in token B");
    assert.ok(s.newReserveA < Ra, "reserve A decreased");
    assert.ok(s.newReserveB > Rb, "reserve B increased");
    // Symmetric to the netA > 0 case: fee withheld, so k is preserved up to
    // floor-division dust and can only shrink, never grow.
    assert.ok(s.newReserveA * s.newReserveB <= Ra * Rb, "k preserved, shrinks only by dust");
    assert.ok(s.newReserveA * s.newReserveB >= Ra * Rb - s.newReserveB, "dust bounded by one reserve unit");
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
