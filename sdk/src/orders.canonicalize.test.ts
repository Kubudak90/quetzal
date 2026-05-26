// sdk/src/orders.canonicalize.test.ts
// Sub-6c A4: unit tests for canonical path normalization.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { canonicalizePath } from "./orders.js";
import { OrderError } from "./errors.js";

describe("canonicalizePath", () => {
  test("already-canonical 2-hop unchanged", () => {
    const r = canonicalizePath("sell", ["0x10", "0x20"]);
    assert.equal(r.side, "sell");
    assert.deepEqual(r.path, ["0x10", "0x20"]);
  });

  test("reversed 2-hop flips side + reverses path", () => {
    const r = canonicalizePath("sell", ["0x20", "0x10"]);
    assert.equal(r.side, "buy");
    assert.deepEqual(r.path, ["0x10", "0x20"]);
  });

  test("3-hop endpoints canonical, middle preserved", () => {
    const r = canonicalizePath("buy", ["0x10", "0x99", "0x20"]);
    assert.equal(r.side, "buy");
    assert.deepEqual(r.path, ["0x10", "0x99", "0x20"]);
  });

  test("3-hop reversed endpoints flips + reverses (middle moves with)", () => {
    const r = canonicalizePath("buy", ["0x20", "0x99", "0x10"]);
    assert.equal(r.side, "sell");
    assert.deepEqual(r.path, ["0x10", "0x99", "0x20"]);
  });

  test("equal endpoints throws OrderError", () => {
    assert.throws(
      () => canonicalizePath("buy", ["0x10", "0x10"]),
      OrderError,
    );
  });

  test("round-trip: canonicalize twice = idempotent", () => {
    const once = canonicalizePath("sell", ["0x30", "0x10"]);
    const twice = canonicalizePath(once.side, once.path);
    assert.deepEqual(twice, once);
  });
});
