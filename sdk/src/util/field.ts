// sdk/src/util/field.ts
// Field-arithmetic helpers shared by SDK + CLI.

import { webcrypto } from "node:crypto";

/** A random BN254 field element (31 random bytes stay under the field modulus). */
export function randomField(): bigint {
  const buf = new Uint8Array(31);
  webcrypto.getRandomValues(buf);
  let n = 0n;
  for (const byte of buf) n = (n << 8n) | BigInt(byte);
  return n;
}

/**
 * Parse a CLI-supplied field value. `BigInt` natively accepts both decimal
 * and `0x`-prefixed hex strings.
 */
export function parseField(raw: string): bigint {
  return BigInt(raw.trim());
}
