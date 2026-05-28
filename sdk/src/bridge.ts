// sdk/src/bridge.ts
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { Fr } from "@aztec/aztec.js/fields";
import type { QuetzalClient } from "./client.js";
import type { ScheduledExit, QuetzalContracts } from "./types.js";
import { BridgeError, ConfigError } from "./errors.js";
import { buildSplitSchedule, loadBridgeState, saveBridgeState } from "./privacy/bridge-schedule.js";
import { queryRecentDeposits, isRoundTripRisk } from "./privacy/bridge-history.js";
import { classifyAmount, formatAdvisory, resolveTokenDecimals } from "./privacy/amount-heuristic.js";
import { computeWithdrawContent } from "./util/sha256-content.js";

export interface BridgeDepositInput {
  token: string;
  amount: bigint;
  isPrivate: boolean;
}

export interface BridgeDepositResult {
  l1TxHash: string;
  messageIndex: bigint;
  secret?: string;
  secretHash?: string;
}

export interface BridgeClaimInput {
  token: string;
  amount: bigint;
  isPrivate: boolean;
  secret?: Fr | string;
  messageIndex: Fr | string;
}

export interface BridgeExitInput {
  token: string;
  amount: bigint;
  l1Recipient: string;
  isPrivate?: boolean;
  splitInto?: number;
  intervalDays?: number;
  ackRound?: boolean;
  ackDelay?: boolean;
  relayerFee?: bigint;
}

export interface BridgeTickInput {
  autoClaim?: boolean;
}

// ─── Validators / helpers ────────────────────────────────────────────────────

export function validateBridgeExitInput(input: BridgeExitInput): void {
  if (input.amount <= 0n) {
    throw new BridgeError("UNKNOWN", "amount must be > 0");
  }
  if (!input.l1Recipient) {
    throw new BridgeError("UNKNOWN", "l1Recipient required");
  }
}

function requireContracts(client: QuetzalClient): QuetzalContracts {
  const c = client.config.contracts;
  if (!c) {
    throw new ConfigError(
      "MISSING_ENV",
      "QuetzalClient.config.contracts not set; pass `contracts` to QuetzalClient.connect()",
    );
  }
  return c;
}

function resolveTokenAddress(contracts: QuetzalContracts, alias: string): string {
  // Accept legacy (tUSDC/tETH/tBTC) and bridged (aUSDC/aWETH/aWBTC) names.
  const map: Record<string, string | undefined> = {
    tUSDC: contracts.tUSDC,
    aUSDC: contracts.tUSDC,
    tETH: contracts.tETH,
    aWETH: contracts.tETH,
    tBTC: contracts.tBTC,
    aWBTC: contracts.tBTC,
  };
  const addr = map[alias];
  if (!addr) {
    throw new BridgeError(
      "UNKNOWN",
      `unknown token alias '${alias}'. Known: tUSDC/aUSDC, tETH/aWETH, tBTC/aWBTC.`,
    );
  }
  return addr;
}

function validateL1Address(addr: string): void {
  if (!addr.startsWith("0x") || addr.length !== 42) {
    throw new BridgeError(
      "UNKNOWN",
      `l1Recipient must be a 0x-prefixed 20-byte L1 address, got: ${addr}`,
    );
  }
}

function toFr(v: Fr | string): Fr {
  if (typeof v !== "string") return v;
  if (v.startsWith("0x")) return Fr.fromString(v);
  return new Fr(BigInt(v));
}

// ─── Module-level helpers (exported for test mockability) ────────────────────

export const _internals = {
  async getNode(nodeUrl: string) {
    const { createAztecNodeClient } = await import("@aztec/aztec.js/node");
    return createAztecNodeClient(nodeUrl);
  },
};

// ─── Public API ───────────────────────────────────────────────────────────────

export class BridgeApi {
  constructor(private client: QuetzalClient) {}

  /**
   * L1->L2 deposit.  Not yet wired in the SDK body: the canonical reference
   * implementation is the operator runbook for Sub-5b (scripts/deploy-bridge.ts);
   * the SDK API surface is reserved for a future operator-facing wiring task.
   */
  async deposit(input: BridgeDepositInput): Promise<BridgeDepositResult> {
    void input;
    throw new BridgeError(
      "UNKNOWN",
      "BridgeApi.deposit is not implemented yet; use the Sub-5b deploy-bridge script for L1 deposits.",
    );
  }

  /**
   * Returns `true` when the given L1→L2 deposit message hash has membership in
   * the Aztec inbox tree — i.e. the sequencer has finalised it and a claim can
   * now succeed.  Browser UI polls this every 30 s to flip a pending claim from
   * 'Waiting' to 'Ready to claim'.
   *
   * @param messageHash  0x-prefixed 32-byte hex string (64 hex chars + "0x" = 66 chars total)
   * @throws {BridgeError} if messageHash is malformed
   */
  async getMessageReady(messageHash: `0x${string}`): Promise<boolean> {
    if (!messageHash.startsWith("0x") || messageHash.length !== 66) {
      throw new BridgeError(
        "UNKNOWN",
        `messageHash must be a 0x-prefixed 32-byte hex string (66 chars), got: ${messageHash}`,
      );
    }
    const node = await _internals.getNode(this.client.config.nodeUrl);
    const witness = await node.getL1ToL2MessageMembershipWitness("latest", Fr.fromHexString(messageHash));
    return witness !== undefined;
  }

  async claim(input: BridgeClaimInput): Promise<{ l2TxHash: string }> {
    const contracts = requireContracts(this.client);
    const tokenAddress = resolveTokenAddress(contracts, input.token);
    if (input.isPrivate && input.secret === undefined) {
      throw new BridgeError("UNKNOWN", "claim_private requires a secret preimage");
    }
    const secret = input.secret !== undefined ? toFr(input.secret) : new Fr(0n);
    const messageIndex = toFr(input.messageIndex);

    const { loadTokenContract } = await import("./internal/contracts.js");
    const TokenContract = await loadTokenContract();
    const token = await TokenContract.at(AztecAddress.fromString(tokenAddress), this.client.wallet);
    const tokenDyn = token as unknown as {
      methods: {
        claim_public: (
          to: AztecAddress,
          amount: bigint,
          secret: Fr,
          messageLeafIndex: Fr,
        ) => { send: (args: { from: AztecAddress }) => { wait?: () => Promise<unknown> } };
        claim_private: (
          to: AztecAddress,
          amount: bigint,
          secret: Fr,
          messageLeafIndex: Fr,
        ) => { send: (args: { from: AztecAddress }) => { wait?: () => Promise<unknown> } };
      };
    };
    const fn = input.isPrivate ? "claim_private" : "claim_public";
    const tx = tokenDyn.methods[fn](this.client.address, input.amount, secret, messageIndex).send({
      from: this.client.address,
    });
    const receipt = (await (tx as { wait?: () => Promise<unknown> }).wait?.()) as
      | { txHash?: { toString: () => string } }
      | undefined;
    return { l2TxHash: receipt?.txHash?.toString() ?? "" };
  }

  async exit(
    input: BridgeExitInput,
  ): Promise<{ l2TxHash: string } | { scheduledExits: ScheduledExit[] }> {
    validateBridgeExitInput(input);
    validateL1Address(input.l1Recipient);
    const contracts = requireContracts(this.client);
    const tokenAddress = resolveTokenAddress(contracts, input.token);
    const usePrivate = input.isPrivate !== false;

    // D2: amount-pattern fingerprint advisory (re-thrown so CLI can surface it)
    const decimals = resolveTokenDecimals(input.token);
    const heuristic = classifyAmount(input.amount, decimals);
    if (heuristic.classification !== "natural" && input.ackRound !== true) {
      const advisory = formatAdvisory(heuristic, decimals, input.token.toUpperCase());
      throw new BridgeError(
        "UNKNOWN",
        `${advisory} Pass ackRound=true to acknowledge + proceed.`,
      );
    }

    // C2: round-trip pre-check via L1 logs (best-effort; skipped if l1 config missing)
    const l1 = this.client.config.l1;
    const bridgeAddrs = [l1?.usdcBridge, l1?.wethBridge, l1?.wbtcBridge]
      .filter((x): x is string => !!x)
      .map((s) => s as `0x${string}`);
    const l1MakerAddr = (l1?.makerAddr ?? process.env.L1_MAKER_ADDR ?? "") as `0x${string}`;
    if (l1?.rpcUrl && bridgeAddrs.length > 0 && l1MakerAddr) {
      let records: Awaited<ReturnType<typeof queryRecentDeposits>>;
      try {
        records = await queryRecentDeposits(l1.rpcUrl, bridgeAddrs, l1MakerAddr, 7);
      } catch {
        records = [];
      }
      const { risk, matched } = isRoundTripRisk(input.amount, records, 5);
      if (risk && matched && input.ackDelay !== true) {
        throw new BridgeError(
          "UNKNOWN",
          `Round-trip detection risk: matching deposit ${matched.amount} ${input.token} ${Math.floor((Date.now() / 1000 - matched.timestamp) / 86400)}d ago. Pass ackDelay=true to acknowledge.`,
        );
      }
    }

    // C3: split path
    const splitInto = input.splitInto ?? 1;
    const intervalDays = input.intervalDays ?? 3;
    if (splitInto > 1) {
      const newExits = buildSplitSchedule(
        input.token,
        input.amount,
        input.l1Recipient,
        splitInto,
        intervalDays,
      );
      const state = loadBridgeState();
      state.scheduledExits.push(...newExits);
      saveBridgeState(state);
      return { scheduledExits: newExits };
    }

    // Single-exit submit path
    const { loadTokenContract } = await import("./internal/contracts.js");
    const TokenContract = await loadTokenContract();
    const token = await TokenContract.at(AztecAddress.fromString(tokenAddress), this.client.wallet);
    const tokenDyn = token as unknown as {
      methods: {
        exit_to_l1_public: (
          amount: bigint,
          l1Recipient: Fr,
        ) => {
          send: (args: { from: AztecAddress }) => {
            wait: () => Promise<{ txHash: { toString: () => string } }>;
          };
        };
        exit_to_l1_private: (
          amount: bigint,
          l1Recipient: Fr,
        ) => {
          send: (args: { from: AztecAddress }) => {
            wait: () => Promise<{ txHash: { toString: () => string } }>;
          };
        };
      };
    };
    const l1RecipientFr = new Fr(BigInt(input.l1Recipient));
    const fn = usePrivate ? "exit_to_l1_private" : "exit_to_l1_public";
    const tx = tokenDyn.methods[fn](input.amount, l1RecipientFr).send({
      from: this.client.address,
    });
    const receipt = await tx.wait();
    const l2TxHash = receipt.txHash.toString();

    // Optional relayer-fee queue on Treasury (Sub-5c D3).
    const relayerFee = input.relayerFee ?? 0n;
    if (relayerFee > 0n) {
      if (!contracts.treasury) {
        throw new BridgeError(
          "UNKNOWN",
          "relayerFee > 0 but config.contracts.treasury is not set",
        );
      }
      const expectedContent = computeWithdrawContent(input.l1Recipient, input.amount, usePrivate);
      const { loadTreasuryContract } = await import("./internal/contracts.js");
      const TreasuryContract = await loadTreasuryContract();
      const treasury = await TreasuryContract.at(
        AztecAddress.fromString(contracts.treasury),
        this.client.wallet,
      );
      const treasuryDyn = treasury as unknown as {
        methods: {
          queue_relayer_claim: (
            l2TxHash: Fr,
            expectedContent: Fr,
            l1Recipient: Fr,
            amount: bigint,
            fee: bigint,
          ) => { send: (args: { from: AztecAddress }) => Promise<unknown> };
        };
      };
      await treasuryDyn.methods
        .queue_relayer_claim(
          Fr.fromString(l2TxHash),
          Fr.fromString(expectedContent),
          l1RecipientFr,
          input.amount,
          relayerFee,
        )
        .send({ from: this.client.address });
    }

    return { l2TxHash };
  }

  async tick(input: BridgeTickInput = {}): Promise<{ processedCount: number }> {
    const contracts = requireContracts(this.client);
    const state = loadBridgeState();
    const now = Math.floor(Date.now() / 1000);
    let processed = 0;
    let changed = false;

    for (const exit of state.scheduledExits) {
      if (exit.status === "pending" && exit.submitAfterUnix <= now) {
        try {
          const tokenL2Addr = resolveTokenAddress(contracts, exit.token);
          const { loadTokenContract } = await import("./internal/contracts.js");
          const TokenContract = await loadTokenContract();
          const token = await TokenContract.at(
            AztecAddress.fromString(tokenL2Addr),
            this.client.wallet,
          );
          const tokenDyn = token as unknown as {
            methods: {
              exit_to_l1_public: (
                amount: bigint,
                l1Recipient: Fr,
              ) => {
                send: (args: { from: AztecAddress }) => {
                  wait: () => Promise<{
                    txHash: { toString: () => string };
                    blockNumber?: number;
                  }>;
                };
              };
            };
          };
          const l1RecipientFr = new Fr(BigInt(exit.l1Recipient));
          const amountBig = BigInt(exit.amount);
          const tx = tokenDyn.methods
            .exit_to_l1_public(amountBig, l1RecipientFr)
            .send({ from: this.client.address });
          const receipt = await tx.wait();
          exit.status = "submitted";
          exit.l2TxHash = receipt.txHash.toString();
          exit.l2EpochAtSubmit = receipt.blockNumber ?? null;
          processed++;
          changed = true;
        } catch {
          /* leave status pending so a later tick retries */
        }
      } else if (exit.status === "submitted" && input.autoClaim === true) {
        // L1 auto-claim path (Sub-5c C4) is wired in the CLI today; the SDK
        // tick body delegates the L1 step to the CLI for now (operator path).
        // Surface a no-op so the SDK call stays side-effect-free for L1 here.
      }
    }
    if (changed) saveBridgeState(state);
    return { processedCount: processed };
  }
}
