// sdk/src/bridge.test.ts
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { validateBridgeExitInput } from "./bridge.js";
import { BridgeError } from "./errors.js";

describe("validateBridgeExitInput", () => {
  test("rejects amount <= 0", () => {
    assert.throws(
      () => validateBridgeExitInput({ token: "tUSDC", amount: 0n, l1Recipient: "0xabc" }),
      BridgeError,
    );
  });
  test("rejects empty l1Recipient", () => {
    assert.throws(
      () => validateBridgeExitInput({ token: "tUSDC", amount: 1n, l1Recipient: "" }),
      BridgeError,
    );
  });
  test("accepts valid", () => {
    assert.doesNotThrow(
      () => validateBridgeExitInput({ token: "tUSDC", amount: 1n, l1Recipient: "0xabc" }),
    );
  });
});
