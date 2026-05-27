import { describe, test, expect } from "vitest";
import { generateClaimSecret, computeClaimSecretHash } from "@/lib/l1-bridge";

describe("generateClaimSecret", () => {
  test("returns a 0x-prefixed 32-byte hex string under bn254 modulus", () => {
    const secret = generateClaimSecret();
    expect(secret).toMatch(/^0x[0-9a-f]{64}$/);
    const P_BN254 = BigInt(
      "0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001",
    );
    expect(BigInt(secret) < P_BN254).toBe(true);
  });

  test("produces distinct secrets on repeated calls", () => {
    const a = generateClaimSecret();
    const b = generateClaimSecret();
    expect(a).not.toBe(b);
  });
});

describe("computeClaimSecretHash", () => {
  // NOTE: deviation from plan — the hash is poseidon2 (computeSecretHash from
  // @aztec/stdlib/hash), which is async. The plan's starting-point used
  // sha256ToField but that's incompatible with the L2 FeeJuice contract's
  // claim consumption logic. See l1-bridge.ts for the full rationale.
  test("deterministic for the same input", async () => {
    const s = ("0x" + "11".repeat(32)) as `0x${string}`;
    const h1 = await computeClaimSecretHash(s);
    const h2 = await computeClaimSecretHash(s);
    expect(h1).toBe(h2);
  });

  test("distinct for distinct inputs", async () => {
    const h1 = await computeClaimSecretHash(("0x" + "11".repeat(32)) as `0x${string}`);
    const h2 = await computeClaimSecretHash(("0x" + "22".repeat(32)) as `0x${string}`);
    expect(h1).not.toBe(h2);
  });
});
