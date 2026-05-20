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
    assert.match(proverToml, /amount_out = "498"/);
    // 128 entries in orders, fills, cancelled_indices, fill_to_order_index:
    const ordersBlockMatch = proverToml.match(/orders = \[\n(.*?)\n\]/s);
    assert.ok(ordersBlockMatch, "orders block present");
    const ordersEntries = (ordersBlockMatch![1].match(/{ side = /g) ?? []).length;
    assert.equal(ordersEntries, MAX_ORDERS_PER_EPOCH);
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
