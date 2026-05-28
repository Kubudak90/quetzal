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

// ─── BridgeApi.deposit ───────────────────────────────────────────────────────

describe("BridgeApi.deposit", () => {
  // DepositInitiated topic hash (matches contracts-l1/src/TokenBridge.sol)
  const DEPOSIT_INITIATED_TOPIC =
    "0x6d427fdb35b9c2ae11c4374e424fdc75bd8ae80001f74d846ea70bf7233af909";

  // Build a 32-byte hex chunk from a bigint, no 0x.
  const u256Hex = (v: bigint): string => v.toString(16).padStart(64, "0");

  function makeMockClientWithL1(
    l1: {
      usdcBridge?: string;
      wethBridge?: string;
      wbtcBridge?: string;
      rpcUrl?: string;
    } | undefined,
  ) {
    return {
      config: {
        nodeUrl: "https://node.mock",
        l1,
        contracts: {
          orderbook: "0x0000000000000000000000000000000000000000000000000000000000000abc",
          tUSDC: "0x0000000000000000000000000000000000000000000000000000000000000001",
          tETH: "0x0000000000000000000000000000000000000000000000000000000000000002",
          tBTC: "0x0000000000000000000000000000000000000000000000000000000000000003",
          pools: [],
        },
      },
      wallet: {},
      address: {
        toString: () =>
          "0x1111111111111111111111111111111111111111111111111111111111111111",
      },
    } as unknown as Parameters<typeof BridgeApi.prototype.claim>[0] extends never
      ? never
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      : any;
  }

  test("happy path: approves + bridges + returns secret + messageIndex", async () => {
    const writeCalls: Array<{ functionName: string; args: readonly unknown[] }> = [];
    const APPROVE_HASH =
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const DEPOSIT_HASH =
      "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const MESSAGE_INDEX = 42n;
    const L1_TOKEN_ADDR = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";

    // event data layout (non-indexed, in order):
    //   amount (uint256) | secretHash (bytes32) | messageIndex (uint256) | isPrivate (bool)
    const eventData =
      "0x" +
      u256Hex(1_000_000n) +
      u256Hex(0n) + // secretHash placeholder (filled in below would shift to dynamic — kept 0n here)
      u256Hex(MESSAGE_INDEX) +
      u256Hex(0n);

    const mockWallet = {
      account: { address: "0xfaceb00cfaceb00cfaceb00cfaceb00cfaceb00c" as const },
      writeContract: async (args: { functionName: string; args: readonly unknown[] }) => {
        writeCalls.push({ functionName: args.functionName, args: args.args });
        if (args.functionName === "approve") return APPROVE_HASH;
        return DEPOSIT_HASH;
      },
    };

    const origGetViem = _internals.getViem;
    _internals.getViem = async () => ({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      createPublicClient: (() => ({
        readContract: async () => L1_TOKEN_ADDR,
        waitForTransactionReceipt: async ({ hash }: { hash: string }) => {
          if (hash === APPROVE_HASH) return { logs: [] };
          return {
            logs: [
              {
                topics: [DEPOSIT_INITIATED_TOPIC],
                data: eventData,
              },
            ],
          };
        },
      })) as unknown as typeof import("viem").createPublicClient,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      http: ((_url?: string) => undefined) as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sepolia: { id: 11155111 } as any,
    });

    try {
      const api = new BridgeApi(
        makeMockClientWithL1({
          usdcBridge: "0x000000000000000000000000000000000000a55c",
          rpcUrl: "https://sepolia.mock",
        }),
      );
      const result = await api.deposit(
        { token: "tUSDC", amount: 1_000_000n, isPrivate: false },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        mockWallet as any,
      );
      assert.strictEqual(result.l1TxHash, DEPOSIT_HASH);
      assert.strictEqual(result.messageIndex, MESSAGE_INDEX);
      assert.ok(result.secret, "expected secret");
      assert.match(result.secret!, /^0x[0-9a-f]{1,64}$/);
      assert.ok(result.secretHash, "expected secretHash");
      assert.match(result.secretHash!, /^0x[0-9a-f]{1,64}$/);
      assert.strictEqual(writeCalls.length, 2);
      assert.strictEqual(writeCalls[0].functionName, "approve");
      assert.strictEqual(writeCalls[1].functionName, "depositToL2Public");
    } finally {
      _internals.getViem = origGetViem;
    }
  });

  test("rejects when L1 config missing", async () => {
    const api = new BridgeApi(makeMockClientWithL1(undefined));
    await assert.rejects(
      () =>
        api.deposit(
          { token: "tUSDC", amount: 1n, isPrivate: false },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          { account: { address: "0xabc" } } as any,
        ),
      (err: Error) => {
        assert.ok(err instanceof BridgeError);
        assert.match(err.message, /config\.l1/);
        return true;
      },
    );
  });

  test("rejects unknown token alias", async () => {
    const api = new BridgeApi(
      makeMockClientWithL1({
        usdcBridge: "0x000000000000000000000000000000000000a55c",
      }),
    );
    await assert.rejects(
      () =>
        api.deposit(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          { token: "junk", amount: 1n, isPrivate: false } as any,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          { account: { address: "0xabc" } } as any,
        ),
      (err: Error) => {
        assert.ok(err instanceof BridgeError);
        assert.match(err.message, /unknown token/);
        return true;
      },
    );
  });
});
