import { describe, test, expect, vi } from "vitest";
import { runDripPipeline, type DripDeps } from "@/lib/drip-pipeline";
import { RateLimiter } from "@/lib/rate-limit";

function mkDeps(overrides: Partial<DripDeps> = {}): DripDeps {
  return {
    verifyCaptcha: vi.fn().mockResolvedValue(true),
    rateLimiter: new RateLimiter({ sqlitePath: ":memory:", cooldownSeconds: 28800, dailyCap: 500 }),
    clock: { now: () => 1_700_000_000 },
    bridgeFeeJuice: vi.fn().mockResolvedValue({
      l1TxHash: "0x" + "aa".repeat(32),
      messageHashHex: "0x" + "bb".repeat(32),
      messageLeafIndex: 42n,
      claimSecretHex: "0x" + "cc".repeat(32),
      claimSecretHashHex: "0x" + "dd".repeat(32),
    }),
    mintTUSDC: vi.fn().mockResolvedValue({ txHash: "0x" + "ee".repeat(32) }),
    mintTETH: vi.fn().mockResolvedValue({ txHash: "0x" + "ff".repeat(32) }),
    config: {
      feeJuiceAmount: 100_000_000_000_000_000_000n,
      tUSDCAmount: 1_000_000_000n,
      tETHAmount: 500_000_000_000_000_000n,
      hcaptchaSecretKey: "secret",
      hcaptchaBypassKey: "BYPASS",
      drainThresholdMultiplier: 10,
    },
    checkDrained: vi.fn().mockResolvedValue(false),
    auditLog: { append: vi.fn() },
    ...overrides,
  };
}

describe("runDripPipeline", () => {
  test("happy path returns success + composite response", async () => {
    const deps = mkDeps();
    const result = await runDripPipeline({
      address: "0x" + "11".repeat(32),
      captchaToken: "valid",
      ip: "1.1.1.2",
      deps,
    });
    expect(result.status).toBe(200);
    expect(result.body.success).toBe(true);
    if (result.body.success) {
      expect(result.body.claimData.l1TxHash).toMatch(/^0x[0-9a-f]+$/);
      expect(result.body.tUSDCMint.amount).toBe("1000000000");
      expect(result.body.tETHMint.amount).toBe("500000000000000000");
    }
  });

  test("invalid address -> 400", async () => {
    const result = await runDripPipeline({
      address: "not-hex",
      captchaToken: "valid",
      ip: "1.1.1.1",
      deps: mkDeps(),
    });
    expect(result.status).toBe(400);
    expect(result.body.success).toBe(false);
  });

  test("invalid captcha -> 400", async () => {
    const result = await runDripPipeline({
      address: "0x" + "11".repeat(32),
      captchaToken: "stale",
      ip: "1.1.1.1",
      deps: mkDeps({ verifyCaptcha: vi.fn().mockResolvedValue(false) }),
    });
    expect(result.status).toBe(400);
    if (!result.body.success) {
      expect(result.body.error).toMatch(/captcha/i);
    }
  });

  test("rate-limited -> 429 with retryAfter", async () => {
    const deps = mkDeps();
    await runDripPipeline({ address: "0x" + "11".repeat(32), captchaToken: "v", ip: "5.5.5.5", deps });
    const r2 = await runDripPipeline({ address: "0x" + "22".repeat(32), captchaToken: "v", ip: "5.5.5.5", deps });
    expect(r2.status).toBe(429);
    if (!r2.body.success) {
      expect(r2.body.retryAfterSeconds).toBeGreaterThan(0);
    }
  });

  test("drained -> 503", async () => {
    const result = await runDripPipeline({
      address: "0x" + "11".repeat(32),
      captchaToken: "v",
      ip: "1.1.1.9",
      deps: mkDeps({ checkDrained: vi.fn().mockResolvedValue(true) }),
    });
    expect(result.status).toBe(503);
    if (!result.body.success) expect(result.body.error).toMatch(/drained/i);
  });

  test("L1 bridge throw -> 503 + audit log includes error", async () => {
    const auditAppend = vi.fn();
    const result = await runDripPipeline({
      address: "0x" + "11".repeat(32),
      captchaToken: "v",
      ip: "9.9.9.9",
      deps: mkDeps({
        bridgeFeeJuice: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
        auditLog: { append: auditAppend },
      }),
    });
    expect(result.status).toBe(503);
    expect(auditAppend).toHaveBeenCalled();
  });
});
