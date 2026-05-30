import { z } from "zod";

// 0x-prefixed 32-byte hex — format check only. The stricter bn254-modulus +
// non-zero check lives in @/lib/address.ts (added in Task 3) and is applied
// at API-route boundary BEFORE this schema runs.
const HexAddress = z.string().regex(/^0x[0-9a-fA-F]{64}$/, "must be 0x-prefixed 32-byte hex");

export const DripRequestSchema = z.object({
  address: HexAddress,
  // Audit #6: captcha is now governed by the server-side FAUCET_REQUIRE_CAPTCHA
  // toggle, so the frontend may omit this field entirely. When present it is
  // length-capped; when absent it defaults to "" and the server decides whether
  // verification is required (see lib/captcha.ts).
  captchaToken: z.string().max(2048).optional().default(""),
});
export type DripRequest = z.infer<typeof DripRequestSchema>;

export const ClaimDataSchema = z.object({
  claimAmount: z.string(),
  claimSecretHex: z.string(),
  claimSecretHashHex: z.string(),
  messageHashHex: z.string(),
  messageLeafIndex: z.string(),
  l1TxHash: z.string(),
});
export type ClaimData = z.infer<typeof ClaimDataSchema>;

export const MintReceiptSchema = z.object({
  txHash: z.string(),
  amount: z.string(),
});
export type MintReceipt = z.infer<typeof MintReceiptSchema>;

export const DripResponseSchema = z.discriminatedUnion("success", [
  z.object({
    success: z.literal(true),
    claimData: ClaimDataSchema,
    tUSDCMint: MintReceiptSchema,
    tETHMint: MintReceiptSchema,
  }),
  z.object({
    success: z.literal(false),
    error: z.string(),
    retryAfterSeconds: z.number().optional(),
  }),
]);
export type DripResponse = z.infer<typeof DripResponseSchema>;

export const HealthResponseSchema = z.object({
  status: z.enum(["ok", "degraded"]),
  l1: z.object({
    blockNumber: z.number(),
    operatorBalanceEth: z.string(),
    operatorBalanceFeeJuice: z.string(),
  }),
  l2: z.object({
    rollupVersion: z.number(),
    operatorBalanceTUSDC: z.string(),
    operatorBalanceTETH: z.string(),
  }),
  rateLimit: z.object({
    totalRequests24h: z.number(),
    throttled24h: z.number(),
  }),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;
