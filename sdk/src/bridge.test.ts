// sdk/src/bridge.test.ts
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { validateBridgeExitInput, BridgeApi, _internals } from "./bridge.js";
import { BridgeError } from "./errors.js";

// ─── Minimal mock client shape for BridgeApi tests ───────────────────────────

function makeMockClient(nodeUrl = "https://node.mock") {
  return {
    config: { nodeUrl, contracts: undefined },
    wallet: {},
    address: {},
  } as unknown as Parameters<typeof BridgeApi.prototype.claim>[0] extends never
    ? never
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    : any;
}

describe("BridgeApi.getMessageReady", () => {
  // Must be a valid BN254 Fr value (< field modulus ~0x30644e...)
  const VALID_HASH = ("0x" + "00".repeat(31) + "01") as `0x${string}`;

  test("returns true when L1→L2 message is in the tree", async () => {
    const origGetNode = _internals.getNode;
    _internals.getNode = async (_url: string) => ({
      getL1ToL2MessageMembershipWitness: async (_block: unknown, _hash: unknown) => ({
        index: 42n,
        siblingPath: [],
      }),
    });
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const api = new BridgeApi(makeMockClient() as any);
      const result = await api.getMessageReady(VALID_HASH);
      assert.strictEqual(result, true);
    } finally {
      _internals.getNode = origGetNode;
    }
  });

  test("returns false when no membership witness yet", async () => {
    const origGetNode = _internals.getNode;
    _internals.getNode = async (_url: string) => ({
      getL1ToL2MessageMembershipWitness: async (_block: unknown, _hash: unknown) => undefined,
    });
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const api = new BridgeApi(makeMockClient() as any);
      const result = await api.getMessageReady(VALID_HASH);
      assert.strictEqual(result, false);
    } finally {
      _internals.getNode = origGetNode;
    }
  });

  test("rejects malformed message hash", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const api = new BridgeApi(makeMockClient() as any);
    await assert.rejects(
      () => api.getMessageReady("not-hex" as `0x${string}`),
      (err: Error) => {
        assert.ok(err instanceof BridgeError);
        assert.match(err.message, /messageHash/);
        return true;
      },
    );
  });

  test("rejects message hash with invalid hex characters", async () => {
    // "0x" + "ZZ".repeat(32) = 66 chars, correct prefix and length, invalid hex
    const badHash = ("0x" + "ZZ".repeat(32)) as `0x${string}`;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const api = new BridgeApi(makeMockClient() as any);
    await assert.rejects(
      () => api.getMessageReady(badHash),
      (err: Error) => {
        assert.ok(err instanceof BridgeError);
        assert.match(err.message, /messageHash/);
        return true;
      },
    );
  });
});

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
