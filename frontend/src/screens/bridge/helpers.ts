// Bridge helpers: shared types, constants, and utilities used across bridge tab files.

// ─── Shared toast types ────────────────────────────────────────────────────────
export interface ToastIn { kind: string; text: string }
export type PushToast = (t: ToastIn) => void;

// ─── BridgeToken type + constant + lookup ─────────────────────────────────────
export interface BridgeToken {
  id: string;
  label: string;
  l1Bal: string;
  l2Bal: string;
  priv: string;
  pub: string;
}

export const BRIDGE_TOKENS: BridgeToken[] = [
  { id: "USDC", label: "USDC", l1Bal: "12,430.00", l2Bal: "8,127.42", priv: "5,200.00", pub: "2,927.42" },
  { id: "WETH", label: "WETH", l1Bal: "4.21",       l2Bal: "2.840",    priv: "1.500",    pub: "1.340"    },
  { id: "wBTC", label: "wBTC", l1Bal: "0.124",      l2Bal: "0.0842",   priv: "0.060",    pub: "0.0242"   },
];

export function tokenById(id: string): BridgeToken {
  return BRIDGE_TOKENS.find(t => t.id === id) ?? BRIDGE_TOKENS[0]!;
}

// ─── Amount helper ─────────────────────────────────────────────────────────────
/** Parse a display amount string (e.g. "1,234.56") to bigint with given decimals. */
export function parseAmount(s: string, decimals: number = 6): bigint {
  const clean = s.replace(/,/g, "").trim();
  if (!clean || clean === ".") return 0n;
  const [whole = "0", frac = ""] = clean.split(".");
  const fracPadded = frac.padEnd(decimals, "0").slice(0, decimals);
  try {
    return BigInt(whole + fracPadded);
  } catch {
    return 0n;
  }
}

// ─── Browser-compatible bridge-state helpers ───────────────────────────────────
// SDK's loadBridgeState() / saveBridgeState() from @quetzal/sdk/privacy/bridge-schedule
// use Node's node:fs / node:os / node:path — unusable in the browser.
// TODO(sdk-browser-state): SDK needs a browser-portable bridge-state backend.
// Until then, the shape { scheduledExits: ScheduledExit[] } is mirrored here via localStorage.
export interface BridgeScheduledExit {
  id: number;
  token: string;
  amount: string;
  recipient: string;
  part: string;
  scheduled: string;
  status: "submitted" | "pending";
}

export function loadBrowserBridgeState(): { scheduledExits: BridgeScheduledExit[] } {
  try {
    const raw = localStorage.getItem("quetzal-bridge-state");
    return raw ? (JSON.parse(raw) as { scheduledExits: BridgeScheduledExit[] }) : { scheduledExits: [] };
  } catch {
    return { scheduledExits: [] };
  }
}
