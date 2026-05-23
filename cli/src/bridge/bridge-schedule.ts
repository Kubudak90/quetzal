// cli/src/bridge/bridge-schedule.ts
// Sub-6a C3: bridge exit schedule writer/reader.
//
// State file: ~/.quetzal/bridge-state.json
// Tracks scheduled multi-hop exits with status (pending -> submitted -> l1_claimable -> done).
//
// Used by bridge exit --split-into N --interval-days D (C3) + bridge tick + status (C4).

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type ExitStatus = "pending" | "submitted" | "l1_claimable" | "done";

export interface ScheduledExit {
  id: string;
  token: string;
  amount: string;            // bigint as decimal string
  l1Recipient: string;
  submitAfterUnix: number;
  status: ExitStatus;
  l2TxHash: string | null;
  l2EpochAtSubmit: number | null;
  createdAtUnix: number;
}

export interface BridgeState {
  scheduledExits: ScheduledExit[];
}

const STATE_PATH = join(homedir(), ".quetzal", "bridge-state.json");

export function loadBridgeState(): BridgeState {
  if (!existsSync(STATE_PATH)) return { scheduledExits: [] };
  return JSON.parse(readFileSync(STATE_PATH, "utf8")) as BridgeState;
}

export function saveBridgeState(state: BridgeState): void {
  mkdirSync(join(homedir(), ".quetzal"), { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

/**
 * Build an N-entry schedule of partial exits totaling `total` amount,
 * staggered by `intervalDays`. Per-exit amount = total/N +/- 20% deterministic
 * noise; the last entry is adjusted to make the sum equal `total` exactly.
 *
 * @throws if splitInto not in [2, 20] or intervalDays not in [1, 90]
 */
export function buildSplitSchedule(
  token: string,
  total: bigint,
  l1Recipient: string,
  splitInto: number,
  intervalDays: number,
): ScheduledExit[] {
  if (splitInto < 2 || splitInto > 20) {
    throw new Error(`--split-into must be in [2, 20], got ${splitInto}`);
  }
  if (intervalDays < 1 || intervalDays > 90) {
    throw new Error(`--interval-days must be in [1, 90], got ${intervalDays}`);
  }
  const now = Math.floor(Date.now() / 1000);
  const baseAmount = total / BigInt(splitInto);
  const amounts: bigint[] = [];
  let runningSum = 0n;
  for (let i = 0; i < splitInto - 1; i++) {
    // Deterministic +/- 20% noise: (i * 37) mod 41 yields a 0..40 spread; minus 20 -> -20..+20
    const noisePct = ((i * 37) % 41) - 20;
    const noisy = baseAmount + (baseAmount * BigInt(noisePct)) / 100n;
    amounts.push(noisy);
    runningSum += noisy;
  }
  // Last entry absorbs rounding error so total is preserved exactly
  amounts.push(total - runningSum);

  return amounts.map((amt, idx) => ({
    id: `ex_${now}_${idx.toString().padStart(2, "0")}_${Math.random().toString(36).slice(2, 6)}`,
    token,
    amount: amt.toString(),
    l1Recipient,
    submitAfterUnix: now + idx * intervalDays * 86400,
    status: "pending" as ExitStatus,
    l2TxHash: null,
    l2EpochAtSubmit: null,
    createdAtUnix: now,
  }));
}
