import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildClearingWitness, MAX_ORDERS_PER_EPOCH } from "../src/witness.js";
import { type ClearingResult } from "../src/clearing.js";

describe("buildClearingWitness", () => {
  it("emits the full fixed-size order/index/fill arrays", () => {
    const epoch = { order_acc: 0n, cancel_acc: 0n, order_count: 1, cancel_count: 0 };
    const pool = { reserve_a: 1_000_000n, reserve_b: 2_000_000n, lp_supply: 1_000_000n };
    const orders = [{
      side: false,
      amount_in: 1000n,
      limit_price: 2_000_000_000_000_000_000n,
      order_nonce: 0x1n,
      submitted_at_block: 5,
      owner: 0xaaaan,
    }];
    const clearing: ClearingResult = {
      cleared: true,
      clearingPrice: 2_000_000_000_000_000_000n,
      // NOTE: clearing.fills.amountOut is ignored by buildClearingWitness —
      // it recomputes canonical payouts from the circuit's payout formula.
      fills: [{ orderNonce: 0x1n, filledIn: 1000n, amountOut: 498n }],
      newReserveA: 1_000_500n,
      newReserveB: 1_999_751n,
      feeAPerShareIncrement: 0n,
      feeBPerShareIncrement: 1n,
    } as ClearingResult;

    const { proverToml } = buildClearingWitness({
      epoch, pool, orders, cancellationIndices: [], clearing,
    });

    assert.match(proverToml, /order_count = 1/);
    assert.match(proverToml, /cancel_count = 0/);
    assert.match(proverToml, /fills_len = 1/);
    // Circuit-canonical payout: floor(floor(1000 * 1e18 / 2e18) * 9970/10000)
    //   = floor(500 * 9970/10000) = floor(498.5) = 498
    assert.match(proverToml, /amount_out = "498"/);
    // 128 entries in orders, fills, cancelled_indices, fill_to_order_index:
    const ordersBlockMatch = proverToml.match(/orders = \[\n(.*?)\n\]/s);
    assert.ok(ordersBlockMatch, "orders block present");
    const ordersEntries = (ordersBlockMatch![1].match(/{ side = /g) ?? []).length;
    assert.equal(ordersEntries, MAX_ORDERS_PER_EPOCH);
  });

  it("swap fields come from gross order flows (canonical circuit formulas)", () => {
    // only-buys scenario: 1 buy order, 0 sells.
    //
    // Circuit-canonical payout for buy 1000 @ 2e18:
    //   gross_b = floor(1000 * 1e18 / 2e18) = 500
    //   payout  = floor(500 * 9970/10000) = 498
    //
    // From canonical fills: grossBuyInA = 1000, buyerPayoutsB = 498
    //   grossBuyOutB = floor(1000 * 1e18 / 2e18) = 500
    //   feePoolB = 500 - 498 = 2
    //   a_to_pool   = sat(1000, 0)  = 1000
    //   a_from_pool = sat(0, 1000)  = 0
    //   b_to_pool   = sat(0, 498)   = 0
    //   b_from_pool = sat(498, 0)   = 498
    //   netFlowA = 1000 - 0 - 0 = 1000  → reserve_a_add = 1000
    //   netFlowB = 0 - 498 - 2 = -500   → reserve_b_sub = 500
    const epoch = { order_acc: 0n, cancel_acc: 0n, order_count: 1, cancel_count: 0 };
    const pool = { reserve_a: 1_000_000n, reserve_b: 2_000_000n, lp_supply: 1_000_000n };
    const orders = [{
      side: false,
      amount_in: 1000n,
      limit_price: 2_000_000_000_000_000_000n,
      order_nonce: 0x1n,
      submitted_at_block: 5,
      owner: 0xaaaan,
    }];
    const clearing: ClearingResult = {
      cleared: true,
      clearingPrice: 2_000_000_000_000_000_000n,
      fills: [{ orderNonce: 0x1n, filledIn: 1000n, amountOut: 498n }],
      newReserveA: 1_000_500n,
      newReserveB: 1_999_751n,
      feeAPerShareIncrement: 0n,
      feeBPerShareIncrement: 1n,
    } as ClearingResult;

    const { proverToml } = buildClearingWitness({
      epoch, pool, orders, cancellationIndices: [], clearing,
    });

    // a_to_pool = gross buy input (1000)
    assert.match(proverToml, /a_to_pool = "1000"/);
    assert.match(proverToml, /a_from_pool = "0"/);
    assert.match(proverToml, /b_to_pool = "0"/);
    assert.match(proverToml, /b_from_pool = "498"/);
    // reserve_a_add = netFlowA = 1000 (full gross input; no A fee for only-buys)
    assert.match(proverToml, /reserve_a_add = "1000"/);
    assert.match(proverToml, /reserve_a_sub = "0"/);
    // reserve_b_sub = 500 (gross_buy_out_b; the fee stays in pool as per-share increment)
    assert.match(proverToml, /reserve_b_sub = "500"/);
    assert.match(proverToml, /reserve_b_add = "0"/);
  });

  it("rejects when fills reference a nonce not in orders", () => {
    const epoch = { order_acc: 0n, cancel_acc: 0n, order_count: 1, cancel_count: 0 };
    const pool = { reserve_a: 1n, reserve_b: 1n, lp_supply: 1n };
    const orders = [{
      side: false, amount_in: 1n, limit_price: 1n,
      order_nonce: 0x1n, submitted_at_block: 0, owner: 0n,
    }];
    const clearing: ClearingResult = {
      cleared: true, clearingPrice: 1n,
      fills: [{ orderNonce: 0xDEADn, filledIn: 1n, amountOut: 1n }],
      newReserveA: 1n, newReserveB: 1n,
      feeAPerShareIncrement: 0n, feeBPerShareIncrement: 0n,
    } as ClearingResult;

    assert.throws(
      () => buildClearingWitness({ epoch, pool, orders, cancellationIndices: [], clearing }),
      /not in orders/,
    );
  });

  it("rejects when args.orders.length != epoch.order_count", () => {
    const epoch = { order_acc: 0n, cancel_acc: 0n, order_count: 2, cancel_count: 0 };
    const pool = { reserve_a: 1n, reserve_b: 1n, lp_supply: 1n };
    const orders = [{
      side: false, amount_in: 1n, limit_price: 1n,
      order_nonce: 0x1n, submitted_at_block: 0, owner: 0n,
    }]; // length 1, but epoch says 2
    const clearing: ClearingResult = {
      cleared: true, clearingPrice: 1n, fills: [], newReserveA: 1n, newReserveB: 1n,
      feeAPerShareIncrement: 0n, feeBPerShareIncrement: 0n,
    } as ClearingResult;

    assert.throws(
      () => buildClearingWitness({ epoch, pool, orders, cancellationIndices: [], clearing }),
      /orders.length .* != epoch.order_count/,
    );
  });
});
