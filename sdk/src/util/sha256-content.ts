// sdk/src/util/sha256-content.ts
// Sub-5c D3: JS-side reconstruction of the L1 _withdrawContent hash.
//
// Matches contracts-l1/src/TokenBridge.sol's:
//   _sha256ToField(abi.encode(bytes32(uint256(uint160(recipient))), amount, tag))
// which is: sha256(packed) → first 31 bytes → prepend 0x00 → bytes32.

import { createHash } from "node:crypto";

/**
 * @param l1RecipientHex  0x-prefixed 20-byte address
 * @param amount          uint256 amount
 * @param isPrivate       false → WITHDRAW_PUBLIC_TAG; true → WITHDRAW_PRIVATE_TAG
 * @returns 0x-prefixed 32-byte field-fitting hash (matches L1 + L2 reconstruction)
 */
export function computeWithdrawContent(
  l1RecipientHex: string,
  amount: bigint,
  isPrivate: boolean,
): string {
  if (!l1RecipientHex.startsWith("0x") || l1RecipientHex.length !== 42) {
    throw new Error(`l1RecipientHex must be 0x-prefixed 20-byte address, got: ${l1RecipientHex}`);
  }

  // Domain tags MUST match both:
  //   contracts-l1/src/lib/DataStructures.sol: WITHDRAW_PUBLIC_TAG / WITHDRAW_PRIVATE_TAG
  //   contracts/token/src/main.nr             globals
  // (Sub-5b C1 set these to ZSWAP_WD_\x03 / ZSWAP_WD_\x04 ASCII packed.)
  const WITHDRAW_PUBLIC_TAG = "000000000000000000000000000000000000000000005a535741505f57445f03";
  const WITHDRAW_PRIVATE_TAG = "000000000000000000000000000000000000000000005a535741505f57445f04";
  const tag = isPrivate ? WITHDRAW_PRIVATE_TAG : WITHDRAW_PUBLIC_TAG;

  const recipientBytes32 = l1RecipientHex.slice(2).padStart(64, "0");
  const packed = recipientBytes32 + amount.toString(16).padStart(64, "0") + tag;
  const bytes = Buffer.from(packed, "hex");

  const digest = createHash("sha256").update(bytes).digest();
  const first31 = digest.subarray(0, 31);
  const result = Buffer.concat([Buffer.alloc(1, 0), first31]);
  return "0x" + result.toString("hex");
}
