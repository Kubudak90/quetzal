// Browser localStorage wrapper for the onboarded session. Schema-versioned so
// future migrations can detect & wipe old shapes without throwing into the UI.
const STORAGE_KEY = "quetzal-onboarded-v1";
const CURRENT_SCHEMA = 1 as const;

export interface PersistedSession {
  schemaVersion: typeof CURRENT_SCHEMA;
  /**
   * 0x-prefixed hex32 root. Stays in the user's browser — never sent to any
   * server. WalletPool.fromMaster re-derives the same N child secrets at
   * session-connect time.
   */
  masterSecret: `0x${string}`;
  poolSize: number;
  network: "alpha-testnet";
  /** L2 addresses corresponding to the deployed children, in index order. */
  deployedAddresses: `0x${string}`[];
  /** Unix ms when onboarding completed. */
  onboardedAt: number;
}

export function loadSession(): PersistedSession | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      (parsed as { schemaVersion?: number }).schemaVersion !== CURRENT_SCHEMA
    ) {
      return null;
    }
    return parsed as PersistedSession;
  } catch {
    return null;
  }
}

export function saveSession(s: PersistedSession): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
}

export function clearSession(): void {
  localStorage.removeItem(STORAGE_KEY);
}
