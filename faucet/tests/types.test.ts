import { describe, test, expect } from "vitest";
import { DripRequestSchema, DripResponseSchema, type DripResponse } from "@/lib/types";

describe("DripRequestSchema", () => {
  test("accepts a valid Aztec address + captcha token", () => {
    const ok = DripRequestSchema.safeParse({
      address: "0x" + "11".repeat(32),
      captchaToken: "abc-123",
    });
    expect(ok.success).toBe(true);
  });

  test("rejects missing fields", () => {
    expect(DripRequestSchema.safeParse({}).success).toBe(false);
    expect(DripRequestSchema.safeParse({ address: "0x00" }).success).toBe(false);
  });

  test("rejects malformed address", () => {
    const bad = DripRequestSchema.safeParse({ address: "0xnothex", captchaToken: "x" });
    expect(bad.success).toBe(false);
  });
});

describe("DripResponseSchema (success path)", () => {
  test("validates the canonical success shape", () => {
    const sample: DripResponse = {
      success: true,
      claimData: {
        claimAmount: "100000000000000000000",
        claimSecretHex: "0x" + "aa".repeat(32),
        claimSecretHashHex: "0x" + "bb".repeat(32),
        messageHashHex: "0x" + "cc".repeat(32),
        messageLeafIndex: "92847362",
        l1TxHash: "0x" + "dd".repeat(32),
      },
      tUSDCMint: { txHash: "0x" + "ee".repeat(32), amount: "1000000000" },
      tETHMint: { txHash: "0x" + "ff".repeat(32), amount: "500000000000000000" },
    };
    expect(DripResponseSchema.safeParse(sample).success).toBe(true);
  });
});
