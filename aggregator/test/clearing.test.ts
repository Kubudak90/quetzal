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
      // Even i = buy @ 10.0, odd i = sell @ 0.1 -> they cross for any p in [0.1, 10].
      const isBuy = i % 2 === 0;
      batch.push({
        side: !isBuy,
        amountIn: 1_000_000n,
        limitPrice: isBuy ? 10n * SCALE : SCALE / 10n,
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

  it("is deterministic - identical inputs yield deep-equal output", () => {
    const batch: ClearingOrder[] = [
      { side: false, amountIn: 4_000_000n, limitPrice: 3n * SCALE, submittedAtBlock: 1, orderNonce: 1n },
      { side: true, amountIn: 2_000_000n, limitPrice: SCALE / 3n, submittedAtBlock: 2, orderNonce: 2n },
    ];
    assert.deepEqual(computeClearing(pool, batch), computeClearing(pool, batch));
  });

  it("value conservation: every filled buy gets B, every sell gets A; k does not grow", () => {
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
