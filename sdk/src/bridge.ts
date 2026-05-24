// sdk/src/bridge.ts
import type { QuetzalClient } from "./client.js";
import type { ScheduledExit } from "./types.js";
import { BridgeError } from "./errors.js";

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
  secret?: string;
  messageIndex: bigint;
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
}

export interface BridgeTickInput {
  autoClaim?: boolean;
}

export function validateBridgeExitInput(input: BridgeExitInput): void {
  if (input.amount <= 0n) {
    throw new BridgeError("UNKNOWN", "amount must be > 0");
  }
  if (!input.l1Recipient) {
    throw new BridgeError("UNKNOWN", "l1Recipient required");
  }
}

export class BridgeApi {
  constructor(private client: QuetzalClient) {}

  async deposit(input: BridgeDepositInput): Promise<BridgeDepositResult> {
    void input;
    throw new BridgeError("UNKNOWN", "deposit not yet implemented (Task 2.8 lifts CLI body)");
  }

  async claim(input: BridgeClaimInput): Promise<{ l2TxHash: string }> {
    void input;
    throw new BridgeError("UNKNOWN", "claim not yet implemented (Task 2.8 lifts CLI body)");
  }

  async exit(
    input: BridgeExitInput,
  ): Promise<{ l2TxHash: string } | { scheduledExits: ScheduledExit[] }> {
    validateBridgeExitInput(input);
    throw new BridgeError("UNKNOWN", "exit not yet implemented (Task 2.8 lifts CLI body)");
  }

  async tick(input: BridgeTickInput = {}): Promise<{ processedCount: number }> {
    void input;
    throw new BridgeError("UNKNOWN", "tick not yet implemented (Task 2.8 lifts CLI body)");
  }
}
