// sdk/src/privacy/decoy-registry.browser.ts
// Browser-compatible shim for decoy-registry.ts.
// Swapped in by Vite alias during frontend production build.
// Uses localStorage instead of node:fs so it can run in a browser context.

export interface DecoyRegistry {
  [nonceHex: string]: boolean;
}

function storageKey(walletAddrHex: string): string {
  const safe = walletAddrHex.toLowerCase().replace(/[^0-9a-fx]/g, "");
  return `quetzal:decoy-registry:${safe}`;
}

export function loadDecoyRegistry(walletAddrHex: string): DecoyRegistry {
  try {
    const raw = localStorage.getItem(storageKey(walletAddrHex));
    return raw ? (JSON.parse(raw) as DecoyRegistry) : {};
  } catch {
    return {};
  }
}

export function saveDecoyRegistry(walletAddrHex: string, reg: DecoyRegistry): void {
  try {
    localStorage.setItem(storageKey(walletAddrHex), JSON.stringify(reg));
  } catch {
    // Silently ignore quota errors — decoy privacy is best-effort in browser.
  }
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
  return Object.entries(reg)
    .filter(([, v]) => v === true)
    .map(([k]) => k);
}
