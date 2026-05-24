// sdk/src/orders.test.ts
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { validatePlaceOrderInput, validateBulkInput, MAX_ORDERS_PER_BULK, MAX_DECOYS } from "./orders.js";
import { OrderError } from "./errors.js";

describe("validatePlaceOrderInput", () => {
  test("rejects amount <= 0", () => {
    assert.throws(
      () => validatePlaceOrderInput({ side: "sell", amount: 0n, limitPrice: 5000n, path: ["tUSDC", "tETH"] }),
      OrderError,
    );
  });
  test("rejects limitPrice <= 0", () => {
    assert.throws(
      () => validatePlaceOrderInput({ side: "sell", amount: 1n, limitPrice: 0n, path: ["tUSDC", "tETH"] }),
      OrderError,
    );
  });
  test("rejects path length < 2", () => {
    assert.throws(
      () => validatePlaceOrderInput({ side: "sell", amount: 1n, limitPrice: 5000n, path: ["tUSDC"] }),
      OrderError,
    );
  });
  test("rejects path length > 3", () => {
    assert.throws(
      () => validatePlaceOrderInput({ side: "sell", amount: 1n, limitPrice: 5000n, path: ["a", "b", "c", "d"] }),
      OrderError,
    );
  });
  test("accepts valid 2-hop", () => {
    assert.doesNotThrow(
      () => validatePlaceOrderInput({ side: "sell", amount: 1n, limitPrice: 5000n, path: ["tUSDC", "tETH"] }),
    );
  });
});

describe("validateBulkInput", () => {
  test("rejects decoyCount > 4 (Sub-6a A5 cap)", () => {
    assert.throws(
      () => validateBulkInput({ side: "sell", amount: 1n, limitPrice: 5000n, path: ["tUSDC", "tETH"], decoyCount: 5 }),
      OrderError,
    );
  });
  test("rejects decoyCount < 0", () => {
    assert.throws(
      () => validateBulkInput({ side: "sell", amount: 1n, limitPrice: 5000n, path: ["tUSDC", "tETH"], decoyCount: -1 }),
      OrderError,
    );
  });
  test("accepts decoyCount=0 (no decoys = single-order semantics)", () => {
    assert.doesNotThrow(
      () => validateBulkInput({ side: "sell", amount: 1n, limitPrice: 5000n, path: ["tUSDC", "tETH"], decoyCount: 0 }),
    );
  });
  test("accepts decoyCount=4 (max anonymity set)", () => {
    assert.doesNotThrow(
      () => validateBulkInput({ side: "sell", amount: 1n, limitPrice: 5000n, path: ["tUSDC", "tETH"], decoyCount: 4 }),
    );
  });
});

describe("constants", () => {
  test("MAX_ORDERS_PER_BULK = 5 (Sub-6a A5 downsize)", () => {
    assert.equal(MAX_ORDERS_PER_BULK, 5);
  });
  test("MAX_DECOYS = 4 (MAX_ORDERS_PER_BULK - 1)", () => {
    assert.equal(MAX_DECOYS, 4);
  });
});
