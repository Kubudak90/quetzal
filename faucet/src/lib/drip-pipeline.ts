// Sub-7a Task 13: pure-functional drip pipeline.
//
// All side-effects come in via injected `deps` so this module is fully
// unit-testable without a live L1/L2 stack. The HTTP route + the runtime
// singleton handle the wiring (see /pages/api/drip.ts + lib/runtime.ts).
//
// The pipeline shape is unchanged from the Task 13 plan. The L1Bridge type
// surface that landed in Task 11 (commit 364522d) has a `claimAmount: bigint`
// field on BridgeFeeJuiceResult beyond the plan's 5 fields and l1TxHash is
// `string | undefined` (lookup can fail). The pipeline:
//   - uses deps.config.feeJuiceAmount for the response.claimAmount (the
//     bridged amount is canonical — the result's claimAmount is just an echo);
//   - the *adapter* in lib/runtime.ts must throw if l1TxHash is undefined so
//     the pipeline's catch block converts it into a 503 (matches the spec:
//     "missing l1TxHash means audit signal lost → treat as L1 confirmation
//     failure").

import { validateL2Address } from "./address.js";
import type { RateLimiter, Clock } from "./rate-limit.js";
import type { DripResponse } from "./types.js";
import type { BridgeFeeJuiceResult } from "./l1-bridge.js";
import type { MintResult } from "./l2-mint.js";
import type { AuditLog } from "./audit-log.js";

export interface DripDeps {
  verifyCaptcha: (token: string) => Promise<boolean>;
  rateLimiter: RateLimiter;
  clock?: Clock;
  bridgeFeeJuice: (recipient: `0x${string}`, amount: bigint) => Promise<BridgeFeeJuiceResult>;
  mintTUSDC: (to: `0x${string}`, amount: bigint) => Promise<MintResult>;
  mintTETH: (to: `0x${string}`, amount: bigint) => Promise<MintResult>;
  checkDrained: () => Promise<boolean>;
  config: {
    feeJuiceAmount: bigint;
    tUSDCAmount: bigint;
    tETHAmount: bigint;
    drainThresholdMultiplier: number;
  };
  auditLog: Pick<AuditLog, "append">;
}

export interface DripPipelineInput {
  address: string;
  captchaToken: string;
  ip: string;
  deps: DripDeps;
}

export interface DripPipelineOutput {
  status: number;
  body: DripResponse;
}

export async function runDripPipeline(input: DripPipelineInput): Promise<DripPipelineOutput> {
  const { address, captchaToken, ip, deps } = input;
  const clock: Clock = deps.clock ?? { now: () => Math.floor(Date.now() / 1000) };
  const ts = clock.now();

  if (!validateL2Address(address)) {
    deps.auditLog.append({ ts, ip, address, success: false, error: "invalid-address" });
    return { status: 400, body: { success: false, error: "invalid address" } };
  }

  const ok = await deps.verifyCaptcha(captchaToken);
  if (!ok) {
    deps.auditLog.append({ ts, ip, address, success: false, error: "invalid-captcha" });
    return { status: 400, body: { success: false, error: "invalid captcha" } };
  }

  const rl = deps.rateLimiter.checkAndRecord(ip, clock);
  if (!rl.allowed) {
    deps.auditLog.append({ ts, ip, address, success: false, error: `rate-limit:${rl.reason}` });
    if (rl.reason === "global-cap") {
      return { status: 503, body: { success: false, error: "faucet drained (global cap)" } };
    }
    return {
      status: 429,
      body: { success: false, error: "rate-limited", retryAfterSeconds: rl.retryAfterSeconds },
    };
  }

  if (await deps.checkDrained()) {
    deps.auditLog.append({ ts, ip, address, success: false, error: "drained" });
    return { status: 503, body: { success: false, error: "faucet drained" } };
  }

  try {
    const bridged = await deps.bridgeFeeJuice(address as `0x${string}`, deps.config.feeJuiceAmount);
    // Pipeline-side narrowing: the L1Bridge type allows l1TxHash to be
    // undefined (the post-bridge event-log lookup is best-effort). For the
    // happy-path drip we require the L1 tx hash so the audit trail + the
    // user response have a usable signal. Missing → treat as transient L1
    // failure (caught below, surfaces as 503).
    if (!bridged.l1TxHash) {
      throw new Error("L1 tx hash unavailable from bridge result");
    }
    const mintUSDC = await deps.mintTUSDC(address as `0x${string}`, deps.config.tUSDCAmount);
    const mintETH = await deps.mintTETH(address as `0x${string}`, deps.config.tETHAmount);

    deps.auditLog.append({
      ts,
      ip,
      address,
      success: true,
      claimAmount: deps.config.feeJuiceAmount.toString(),
      mintTxs: { tUSDC: mintUSDC.txHash, tETH: mintETH.txHash },
    });

    return {
      status: 200,
      body: {
        success: true,
        claimData: {
          claimAmount: deps.config.feeJuiceAmount.toString(),
          claimSecretHex: bridged.claimSecretHex,
          claimSecretHashHex: bridged.claimSecretHashHex,
          messageHashHex: bridged.messageHashHex,
          messageLeafIndex: bridged.messageLeafIndex.toString(),
          l1TxHash: bridged.l1TxHash,
        },
        tUSDCMint: { txHash: mintUSDC.txHash, amount: deps.config.tUSDCAmount.toString() },
        tETHMint: { txHash: mintETH.txHash, amount: deps.config.tETHAmount.toString() },
      },
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    deps.auditLog.append({
      ts,
      ip,
      address,
      success: false,
      error: `pipeline:${msg.slice(0, 200)}`,
    });
    return { status: 503, body: { success: false, error: "transient failure: " + msg.slice(0, 80) } };
  }
}
