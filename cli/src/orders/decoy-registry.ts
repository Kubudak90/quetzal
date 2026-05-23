// cli/src/orders/decoy-registry.ts
// Sub-6a B1: maker-local JSON registry of decoy order nonces.
//
// Lives at: ~/.quetzal/decoy-registry-<walletAddrHex>.json
// Format: { "<nonce_hex>": true /* decoy */ | false /* real */ }
//
// Never written to L2. Aggregator, observers, Aztec ledger don't see it.
// Quetzal's privacy model treats real-vs-decoy as the maker's PXE secret.

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface DecoyRegistry {
  [nonceHex: string]: boolean;
}

function registryPath(walletAddrHex: string): string {
  const dir = join(homedir(), ".quetzal");
  mkdirSync(dir, { recursive: true });
  const safeAddr = walletAddrHex.toLowerCase().replace(/[^0-9a-fx]/g, "");
  return join(dir, `decoy-registry-${safeAddr}.json`);
}

export function loadDecoyRegistry(walletAddrHex: string): DecoyRegistry {
  const path = registryPath(walletAddrHex);
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf8")) as DecoyRegistry;
}

export function saveDecoyRegistry(walletAddrHex: string, reg: DecoyRegistry): void {
  writeFileSync(registryPath(walletAddrHex), JSON.stringify(reg, null, 2));
}

/** Merge new (nonce, isDecoy) entries into the existing registry. */
export function recordDecoyBatch(
  walletAddrHex: string,
  entries: Array<{ nonce: string; isDecoy: boolean }>,
): void {
  const reg = loadDecoyRegistry(walletAddrHex);
  for (const e of entries) {
    reg[e.nonce.toLowerCase()] = e.isDecoy;
  }
  saveDecoyRegistry(walletAddrHex, reg);
}

/** True ONLY when the nonce is explicitly recorded as a decoy. */
export function isDecoy(walletAddrHex: string, nonceHex: string): boolean {
  const reg = loadDecoyRegistry(walletAddrHex);
  return reg[nonceHex.toLowerCase()] === true;
}

/** List all decoy nonces (for batch-cancel). */
export function listDecoys(walletAddrHex: string): string[] {
  const reg = loadDecoyRegistry(walletAddrHex);
  return Object.entries(reg).filter(([, v]) => v === true).map(([k]) => k);
}
