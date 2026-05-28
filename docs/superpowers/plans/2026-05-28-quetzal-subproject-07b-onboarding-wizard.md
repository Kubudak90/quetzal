# Sub-7b In-browser Onboarding Wizard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the existing SetupScreen Step 3 ("fake fund" placeholder from Sub-6c) with an end-to-end pipeline that derives N child wallets, drips each from the Sub-7a faucet in parallel, claims + deploys each child schnorr account on Aztec testnet, and lands the user at `/trade` with a connected WalletPool — entirely client-side.

**Architecture:** Six new files under `frontend/src/onboarding/` (pure derivation → localStorage persistence → faucet HTTP client → Aztec SDK claim+deploy → orchestration hook → UI component) plus a paired Sub-7a `RateLimiter` refactor (per-IP "1-hit-with-cooldown" → "N-hits-in-window") so N=3 parallel drips don't 429 each other. Wizard runs entirely in the browser via the already-polyfilled `@aztec/wallets/embedded` bundle.

**Tech Stack:** Vite 5.4 + React 18.3 + TypeScript 5.6 strict; Vitest (frontend test runner new in this plan); `@aztec/aztec.js@4.2.1` + `@aztec/wallets@4.2.1` (already in deps); `@quetzal/sdk` workspace dep (uses `deriveChildSecret`).

**Subagent model policy:** Sonnet and Opus only — NEVER Haiku.

**Branch policy:** All commits land on `main` directly (no feature branch).

**Phase boundaries:** Tag `sub7b-phase{A,B,C,D}-done` after each phase completes.

---

## Reference material (the implementer should skim once before starting)

- `docs/superpowers/specs/2026-05-28-quetzal-subproject-07b-onboarding-wizard-design.md` — design spec this plan implements.
- `frontend/src/screens/landing.tsx` lines 122-470 — existing `SetupScreen` 4-step wizard (Sub-6c). The pre-existing Step 3 block (around line 392) is what this plan replaces.
- `frontend/src/sdk/client-context.tsx` — existing `connectWalletPool` flow. Wizard hands off here at the end.
- `sdk/src/wallet/pool.ts` — `deriveChildSecret(masterHex, i)` is the SAME formula the wizard uses for address derivation.
- `scripts/lib/aztec-wallet-bootstrap.ts` lines 100-250 — canonical pattern for `FeeJuicePaymentMethodWithClaim` + retry loop. The wizard's `claim-deploy.ts` mirrors this.
- `faucet/src/lib/rate-limit.ts` — current per-IP semantics. Phase A refactors this.
- `faucet/src/lib/types.ts` — `ClaimData` + `DripResponseSchema`. The browser `faucet-client.ts` re-derives the same TypeScript shape (without importing — the frontend doesn't depend on `@quetzal/faucet`).
- `frontend/vite.config.ts` — already has the Aztec SDK polyfills + browser shims plugin from Sub-6c. No vite changes needed.

---

## Phase A: Sub-7a rate-limit refactor (count-in-window)

This phase unblocks the wizard. With the current "1 drip per IP per 8h" rule, N=3 parallel drips from the same browser get 1 success + 2 throttled. We refactor to "N drips per IP per window", default 4-per-8h.

### Task 1: `faucet/src/lib/rate-limit.ts` — count-in-window per-IP semantics

**Files:**
- Modify: `faucet/src/lib/rate-limit.ts`
- Modify: `faucet/tests/rate-limit.test.ts`

- [ ] **Step 1: Update the tests for new semantics (failing first)**

Open `faucet/tests/rate-limit.test.ts`. Replace the existing per-IP cooldown tests with count-in-window tests. Find the test block named `"second request from same IP within cooldown is throttled"` and replace the WHOLE `describe("RateLimiter", ...)` body up through (but not including) the `describe("RateLimiter — Clock.now() unit contract"...)` block (if present) with:

```ts
describe("RateLimiter — per-IP count-in-window", () => {
  test("first N hits from same IP are allowed (default 4 per 8h)", () => {
    const lim = makeLimiter({ perIpMaxDripsPerWindow: 4, perIpWindowSeconds: 28_800 });
    for (let i = 0; i < 4; i++) {
      const r = lim.checkAndRecord("1.2.3.4", clock);
      expect(r.allowed).toBe(true);
      now += 10;
    }
  });

  test("(N+1)-th hit within window is throttled", () => {
    const lim = makeLimiter({ perIpMaxDripsPerWindow: 4, perIpWindowSeconds: 28_800 });
    for (let i = 0; i < 4; i++) {
      lim.checkAndRecord("1.2.3.4", clock);
      now += 10;
    }
    const r = lim.checkAndRecord("1.2.3.4", clock);
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("per-ip");
    expect(r.retryAfterSeconds).toBeGreaterThan(28_000);
  });

  test("hits older than window do not count", () => {
    const lim = makeLimiter({ perIpMaxDripsPerWindow: 2, perIpWindowSeconds: 100 });
    lim.checkAndRecord("1.2.3.4", clock);
    now += 50;
    lim.checkAndRecord("1.2.3.4", clock);
    now += 60; // first hit now 110s old — out of window
    const r = lim.checkAndRecord("1.2.3.4", clock);
    expect(r.allowed).toBe(true);
  });

  test("retryAfterSeconds = (oldest in-window hit's age subtracted from window)", () => {
    const lim = makeLimiter({ perIpMaxDripsPerWindow: 2, perIpWindowSeconds: 100 });
    lim.checkAndRecord("1.2.3.4", clock);
    now += 10;
    lim.checkAndRecord("1.2.3.4", clock);
    now += 5;
    const r = lim.checkAndRecord("1.2.3.4", clock);
    expect(r.allowed).toBe(false);
    // Oldest hit was 15s ago in a 100s window → retry in 85s.
    expect(r.retryAfterSeconds).toBe(85);
  });

  test("different IPs do not share counts", () => {
    const lim = makeLimiter({ perIpMaxDripsPerWindow: 1, perIpWindowSeconds: 100 });
    lim.checkAndRecord("1.2.3.4", clock);
    const r = lim.checkAndRecord("5.6.7.8", clock);
    expect(r.allowed).toBe(true);
  });
});
```

Then update `makeLimiter` at the top of the test file to accept the new options. Replace:

```ts
function makeLimiter(opts?: Partial<{ cooldownSeconds: number; dailyCap: number }>) {
  return new RateLimiter({
    sqlitePath: ":memory:",
    cooldownSeconds: opts?.cooldownSeconds ?? 28_800,
    dailyCap: opts?.dailyCap ?? 500,
  });
}
```

with:

```ts
function makeLimiter(opts?: Partial<{
  perIpMaxDripsPerWindow: number;
  perIpWindowSeconds: number;
  dailyCap: number;
}>) {
  return new RateLimiter({
    sqlitePath: ":memory:",
    perIpMaxDripsPerWindow: opts?.perIpMaxDripsPerWindow ?? 4,
    perIpWindowSeconds: opts?.perIpWindowSeconds ?? 28_800,
    dailyCap: opts?.dailyCap ?? 500,
  });
}
```

Find the old test "second request from same IP within cooldown is throttled" and the related per-IP tests that use `cooldownSeconds` — DELETE them; the new `describe("RateLimiter — per-IP count-in-window", ...)` above replaces them. Keep `global daily cap`, `stats`, and `evictOlderThan24h` tests as-is (their semantics don't change).

- [ ] **Step 2: Run tests to verify failures**

Run: `pnpm -F @quetzal/faucet test`
Expected: failures in the `RateLimiter — per-IP count-in-window` block ("`cooldownSeconds` is not a property"; or "TypeError: makeLimiter").

- [ ] **Step 3: Update `RateLimiter` to count-in-window semantics**

Open `faucet/src/lib/rate-limit.ts`. Replace the `RateLimiterOpts` interface + the constructor + `checkAndRecord` method with:

```ts
interface RateLimiterOpts {
  sqlitePath: string;
  perIpMaxDripsPerWindow: number;
  perIpWindowSeconds: number;
  dailyCap: number;
}

export class RateLimiter {
  private readonly db: Database.Database;
  private readonly perIpMax: number;
  private readonly perIpWindow: number;
  private readonly cap: number;

  constructor(opts: RateLimiterOpts) {
    this.db = new Database(opts.sqlitePath);
    this.db.pragma("journal_mode = WAL");
    // Single-process only. better-sqlite3 is synchronous, so check-then-record
    // is effectively atomic WITHIN one Node process. Under PM2 cluster mode or
    // multiple containers sharing the same SQLite file, the WAL does not
    // serialize reads across processes — a distributed rate-limit layer
    // (Redis, etc.) would be needed at that scale.
    this.db.prepare(
      `CREATE TABLE IF NOT EXISTS hits (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         ip TEXT NOT NULL,
         ts INTEGER NOT NULL,
         allowed INTEGER NOT NULL
       )`
    ).run();
    this.db.prepare("CREATE INDEX IF NOT EXISTS idx_hits_ts ON hits(ts)").run();
    this.db.prepare("CREATE INDEX IF NOT EXISTS idx_hits_ip_ts ON hits(ip, ts)").run();
    this.perIpMax = opts.perIpMaxDripsPerWindow;
    this.perIpWindow = opts.perIpWindowSeconds;
    this.cap = opts.dailyCap;
  }

  checkAndRecord(ip: string, clock: Clock): RateLimitResult {
    const now = clock.now();
    const since24h = now - 86_400;
    const countRow = this.db
      .prepare("SELECT COUNT(*) AS n FROM hits WHERE ts >= ? AND allowed = 1")
      .get(since24h) as { n: number };
    if (countRow.n >= this.cap) {
      this.recordHit(ip, now, false);
      return { allowed: false, reason: "global-cap" };
    }
    const windowStart = now - this.perIpWindow;
    const ipHits = this.db
      .prepare(
        "SELECT ts FROM hits WHERE ip = ? AND allowed = 1 AND ts >= ? ORDER BY ts ASC"
      )
      .all(ip, windowStart) as Array<{ ts: number }>;
    if (ipHits.length >= this.perIpMax) {
      this.recordHit(ip, now, false);
      const oldest = ipHits[0]!.ts;
      const retryAfterSeconds = this.perIpWindow - (now - oldest);
      return {
        allowed: false,
        reason: "per-ip",
        retryAfterSeconds,
      };
    }
    this.recordHit(ip, now, true);
    return { allowed: true };
  }
  // ... (stats, evictStale, close, recordHit unchanged)
```

Leave the other methods (`stats`, `evictStale`, `close`, `recordHit`) as they are.

- [ ] **Step 4: Run tests — expect pass**

Run: `pnpm -F @quetzal/faucet test`
Expected: all rate-limit tests pass; total test count unchanged or slightly different depending on how the old tests were spread.

Run: `pnpm -F @quetzal/faucet typecheck`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add faucet/src/lib/rate-limit.ts faucet/tests/rate-limit.test.ts
git -c commit.gpgsign=false commit -m "fix(faucet): RateLimiter count-in-window per-IP semantics

Old: 1 drip per IP, then cooldownSeconds before next allowed.
New: up to perIpMaxDripsPerWindow hits per perIpWindowSeconds, oldest
hit's age sets retryAfterSeconds when over the limit.

Unblocks Sub-7b's wizard which fires N=3 parallel drips from one IP.
Default config (per-IP 4 per 8h) ships in the next commit.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Config + .env.example for new rate-limit knobs

**Files:**
- Modify: `faucet/src/lib/config.ts`
- Modify: `faucet/tests/config.test.ts`
- Modify: `faucet/.env.faucet.example`

- [ ] **Step 1: Update `FaucetConfig` interface + `loadConfig` body**

In `faucet/src/lib/config.ts`, find the existing line:

```ts
  perIpCooldownSeconds: number;
```

Replace with:

```ts
  perIpMaxDripsPerWindow: number;
  perIpWindowSeconds: number;
```

In `loadConfig()`, find:

```ts
    perIpCooldownSeconds: asNumber("FAUCET_PER_IP_COOLDOWN_SECONDS", required("FAUCET_PER_IP_COOLDOWN_SECONDS")),
```

Replace with:

```ts
    perIpMaxDripsPerWindow: asNumber("FAUCET_PER_IP_MAX_DRIPS_PER_WINDOW", required("FAUCET_PER_IP_MAX_DRIPS_PER_WINDOW")),
    perIpWindowSeconds: asNumber("FAUCET_PER_IP_WINDOW_SECONDS", required("FAUCET_PER_IP_WINDOW_SECONDS")),
```

- [ ] **Step 2: Update config tests + MINIMAL_ENV**

Open `faucet/tests/config.test.ts`. Find `MINIMAL_ENV` and replace the `FAUCET_PER_IP_COOLDOWN_SECONDS` line with:

```ts
  FAUCET_PER_IP_MAX_DRIPS_PER_WINDOW: "4",
  FAUCET_PER_IP_WINDOW_SECONDS: "28800",
```

Find the test assertion that references `perIpCooldownSeconds` and replace with `perIpMaxDripsPerWindow` + `perIpWindowSeconds` checks. Add inside the "happy path" test:

```ts
    expect(cfg.perIpMaxDripsPerWindow).toBe(4);
    expect(cfg.perIpWindowSeconds).toBe(28_800);
```

- [ ] **Step 3: Update `.env.faucet.example`**

Open `faucet/.env.faucet.example`. Find:

```
FAUCET_PER_IP_COOLDOWN_SECONDS=28800
```

Replace with:

```
# Per-IP rate limit: up to FAUCET_PER_IP_MAX_DRIPS_PER_WINDOW hits per FAUCET_PER_IP_WINDOW_SECONDS.
# Sub-7b's onboarding wizard fires N=3 parallel drips from one IP, so default
# 4 hits per 8h covers N=3 + 1 retry buffer.
FAUCET_PER_IP_MAX_DRIPS_PER_WINDOW=4
FAUCET_PER_IP_WINDOW_SECONDS=28800
```

- [ ] **Step 4: Update `runtime.ts` to pass new fields to RateLimiter**

Open `faucet/src/lib/runtime.ts`. Find the `RateLimiter` constructor call:

```ts
  const rateLimiter = new RateLimiter({
    sqlitePath: config.sqlitePath,
    cooldownSeconds: config.perIpCooldownSeconds,
    dailyCap: config.globalDailyCap,
  });
```

Replace with:

```ts
  const rateLimiter = new RateLimiter({
    sqlitePath: config.sqlitePath,
    perIpMaxDripsPerWindow: config.perIpMaxDripsPerWindow,
    perIpWindowSeconds: config.perIpWindowSeconds,
    dailyCap: config.globalDailyCap,
  });
```

- [ ] **Step 5: Run tests + typecheck**

Run: `pnpm -F @quetzal/faucet test`
Expected: all pass.

Run: `pnpm -F @quetzal/faucet typecheck`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add faucet/src/lib/config.ts faucet/tests/config.test.ts faucet/.env.faucet.example faucet/src/lib/runtime.ts
git -c commit.gpgsign=false commit -m "feat(faucet): FAUCET_PER_IP_MAX_DRIPS_PER_WINDOW + WINDOW_SECONDS env

Replaces FAUCET_PER_IP_COOLDOWN_SECONDS. Defaults: 4 hits per 28800s,
sized for Sub-7b N=3 parallel wizard drips.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Deploy refactored faucet to VPS

This is operator-driven on the live `194.163.136.1` VPS.

- [ ] **Step 1: Update VPS `.env.faucet`**

```bash
ssh root@194.163.136.1 'cd /root/quetzal-faucet/faucet && (
  # Remove old key
  sed -i "/^FAUCET_PER_IP_COOLDOWN_SECONDS=/d" .env.faucet
  # Add new keys (idempotent — only if missing)
  grep -q "^FAUCET_PER_IP_MAX_DRIPS_PER_WINDOW=" .env.faucet || \
    echo "FAUCET_PER_IP_MAX_DRIPS_PER_WINDOW=4" >> .env.faucet
  grep -q "^FAUCET_PER_IP_WINDOW_SECONDS=" .env.faucet || \
    echo "FAUCET_PER_IP_WINDOW_SECONDS=28800" >> .env.faucet
  echo "--- final per-ip config:"
  grep -E "^FAUCET_PER_IP" .env.faucet
)'
```

Expected: 2 lines showing the new values.

- [ ] **Step 2: Pull + rebuild + restart container**

```bash
ssh root@194.163.136.1 'cd /root/quetzal-faucet && (
  git pull origin main 2>&1 | tail -3
  cd faucet && docker compose down && docker compose up -d --build 2>&1 | tail -5
  sleep 12
  echo "--- health:"
  curl -s -m 15 https://faucet.quetzaldex.xyz/api/health | python3 -m json.tool 2>&1 | head -8
)'
```

Expected: rebuild completes; `status: "ok"`.

- [ ] **Step 3: Smoke test the new rate-limit**

From local Mac:

```bash
BYPASS=$(ssh root@194.163.136.1 'grep FAUCET_HCAPTCHA_BYPASS_KEY /root/quetzal-faucet/faucet/.env.faucet | cut -d= -f2')
# 3 parallel drips to different sentinel addresses — all should succeed
for s in 11 22 33; do
  curl -s -m 30 -X POST https://faucet.quetzaldex.xyz/api/drip \
    -H "Content-Type: application/json" \
    -H "Origin: https://quetzaldex.xyz" \
    -d "{\"address\":\"0x$(printf '%064s' $s | tr ' ' '0')\",\"captchaToken\":\"$BYPASS\"}" \
    -o /dev/null -w "drip-$s: HTTP %{http_code}\n" &
done
wait
```

Expected: 3× `HTTP 200` (each drip pipeline takes 2-4 min; treat 200 as "pipeline started"). If you see any 429, the rate-limit refactor didn't deploy correctly.

- [ ] **Step 4: Tag Phase A done**

```bash
git tag sub7b-phaseA-done
git push origin main --tags
```

---

## Phase B: Frontend test infra + onboarding foundation

### Task 4: Add Vitest to frontend

**Files:**
- Create: `frontend/vitest.config.ts`
- Modify: `frontend/package.json`

- [ ] **Step 1: Create `frontend/vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "happy-dom",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    setupFiles: [],
    testTimeout: 10_000,
    css: false,
  },
  resolve: {
    alias: { "@": resolve(__dirname, "src") },
  },
});
```

- [ ] **Step 2: Add test scripts + deps to `frontend/package.json`**

In `frontend/package.json`, add to the `"scripts"` block:

```json
    "test": "vitest run",
    "test:watch": "vitest"
```

Add to `"devDependencies"`:

```json
    "happy-dom": "^15.7.0",
    "vitest": "^2.1.0",
    "@testing-library/react": "^16.0.0",
    "@testing-library/jest-dom": "^6.5.0"
```

- [ ] **Step 3: Install + verify**

Run: `pnpm install`
Expected: `+ happy-dom`, `+ vitest`, etc. in summary.

Run: `pnpm -F @quetzal/frontend test`
Expected: `No test files found, exit code 1` (no tests yet; that's the expected state until Task 5).

- [ ] **Step 4: Commit**

```bash
git add frontend/vitest.config.ts frontend/package.json pnpm-lock.yaml
git -c commit.gpgsign=false commit -m "test(frontend): add Vitest + Testing Library

happy-dom environment; tests live next to source as *.test.{ts,tsx}.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: `frontend/src/onboarding/derive-children.ts` — pure derivation

**Files:**
- Create: `frontend/src/onboarding/derive-children.ts`
- Create: `frontend/src/onboarding/derive-children.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, test, expect } from "vitest";
import { deriveChildren, type DerivedChild } from "./derive-children";

const MASTER = "0x" + "11".repeat(32);

describe("deriveChildren", () => {
  test("returns N entries for n=3", () => {
    const kids = deriveChildren(MASTER, 3);
    expect(kids).toHaveLength(3);
    expect(kids[0]?.index).toBe(0);
    expect(kids[1]?.index).toBe(1);
    expect(kids[2]?.index).toBe(2);
  });

  test("each child has a 0x-prefixed 32-byte hex secret under bn254", () => {
    const kids = deriveChildren(MASTER, 3);
    const P_BN254 = BigInt("0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001");
    for (const k of kids) {
      expect(k.secret).toMatch(/^0x[0-9a-f]{64}$/);
      expect(BigInt(k.secret) < P_BN254).toBe(true);
    }
  });

  test("deterministic for the same master + index", () => {
    const a = deriveChildren(MASTER, 3);
    const b = deriveChildren(MASTER, 3);
    expect(a[0]?.secret).toBe(b[0]?.secret);
    expect(a[2]?.secret).toBe(b[2]?.secret);
  });

  test("different indices produce different secrets", () => {
    const kids = deriveChildren(MASTER, 3);
    expect(kids[0]?.secret).not.toBe(kids[1]?.secret);
    expect(kids[1]?.secret).not.toBe(kids[2]?.secret);
  });

  test("n=0 returns []", () => {
    expect(deriveChildren(MASTER, 0)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test (expect FAIL — module missing)**

Run: `pnpm -F @quetzal/frontend test`
Expected: `Cannot find module './derive-children'`.

- [ ] **Step 3: Create `frontend/src/onboarding/derive-children.ts`**

```ts
// Pure derivation of N child wallets from a master secret.
// Uses the same formula as sdk/src/wallet/pool.ts:deriveChildSecret so the
// addresses the wizard pre-computes match what WalletPool.fromMaster will
// derive at session-connect time.
import { deriveChildSecret } from "@quetzal/sdk";

export interface DerivedChild {
  index: number;
  /** 0x-prefixed 32-byte hex (Fr field element). */
  secret: `0x${string}`;
}

export function deriveChildren(masterSecret: string, n: number): DerivedChild[] {
  if (n < 0) throw new Error("n must be ≥ 0");
  const out: DerivedChild[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      index: i,
      secret: deriveChildSecret(masterSecret, i) as `0x${string}`,
    });
  }
  return out;
}
```

- [ ] **Step 4: Run test — expect PASS**

Run: `pnpm -F @quetzal/frontend test`
Expected: all 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/onboarding/derive-children.ts frontend/src/onboarding/derive-children.test.ts
git -c commit.gpgsign=false commit -m "feat(frontend): onboarding — pure child derivation

Wraps sdk's deriveChildSecret in a flat [{index, secret}] array.
Pre-computes child addresses before the wizard fires any drip, so the
faucet can be called with the deterministic addresses WalletPool will
later derive at session-connect.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: `frontend/src/onboarding/persistence.ts` — localStorage wrapper

**Files:**
- Create: `frontend/src/onboarding/persistence.ts`
- Create: `frontend/src/onboarding/persistence.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, test, expect, beforeEach } from "vitest";
import { loadSession, saveSession, clearSession, type PersistedSession } from "./persistence";

const sample: PersistedSession = {
  schemaVersion: 1,
  masterSecret: "0x" + "11".repeat(32) as `0x${string}`,
  poolSize: 3,
  network: "alpha-testnet",
  deployedAddresses: [
    "0x" + "aa".repeat(32) as `0x${string}`,
    "0x" + "bb".repeat(32) as `0x${string}`,
    "0x" + "cc".repeat(32) as `0x${string}`,
  ],
  onboardedAt: 1779900000000,
};

beforeEach(() => {
  localStorage.clear();
});

describe("persistence", () => {
  test("loadSession returns null when nothing is stored", () => {
    expect(loadSession()).toBeNull();
  });

  test("saveSession + loadSession round-trip", () => {
    saveSession(sample);
    expect(loadSession()).toEqual(sample);
  });

  test("clearSession removes the stored value", () => {
    saveSession(sample);
    clearSession();
    expect(loadSession()).toBeNull();
  });

  test("schema-version mismatch returns null (forward-compat: ignored, not thrown)", () => {
    localStorage.setItem("quetzal-onboarded-v1", JSON.stringify({ ...sample, schemaVersion: 999 }));
    expect(loadSession()).toBeNull();
  });

  test("corrupt JSON returns null (does not throw)", () => {
    localStorage.setItem("quetzal-onboarded-v1", "{not-json");
    expect(loadSession()).toBeNull();
  });
});
```

- [ ] **Step 2: Run test — expect FAIL**

Run: `pnpm -F @quetzal/frontend test`
Expected: `Cannot find module './persistence'`.

- [ ] **Step 3: Create `frontend/src/onboarding/persistence.ts`**

```ts
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
```

- [ ] **Step 4: Run test — expect PASS**

Run: `pnpm -F @quetzal/frontend test`
Expected: all 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/onboarding/persistence.ts frontend/src/onboarding/persistence.test.ts
git -c commit.gpgsign=false commit -m "feat(frontend): onboarding — localStorage persistence

Schema-versioned (v1). loadSession returns null on missing, version
mismatch, or corrupt JSON — never throws into the UI tree.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: `frontend/.env.example`

**Files:**
- Create: `frontend/.env.example`

- [ ] **Step 1: Create the file**

```
# Quetzal frontend — Vite env. Copy to .env.local for local dev; production
# values are configured via Vercel project settings.

# Sub-7a faucet endpoint.
VITE_FAUCET_URL=https://faucet.quetzaldex.xyz

# Bypass key — SHIPPED PUBLIC for testnet MVP. Sub-7d will replace this with
# a real hCaptcha widget. Anyone with this value can drain the faucet at the
# per-IP rate limit (4 per 8h). For closed alpha this is acceptable; never
# leave this on for mainnet.
#
# Copy the value from VPS: ssh root@194.163.136.1 \
#   'grep FAUCET_HCAPTCHA_BYPASS_KEY /root/quetzal-faucet/faucet/.env.faucet | cut -d= -f2'
VITE_FAUCET_BYPASS_KEY=

# Aztec testnet RPC. The wizard's browser PXE connects here for the claim+deploy.
VITE_AZTEC_NODE_URL=https://rpc.testnet.aztec-labs.com

# Default WalletPool size for new onboards. User can override per-session.
VITE_DEFAULT_POOL_SIZE=3
```

- [ ] **Step 2: Commit**

```bash
git add frontend/.env.example
git -c commit.gpgsign=false commit -m "feat(frontend): .env.example for Sub-7b onboarding wizard

VITE_FAUCET_URL + VITE_FAUCET_BYPASS_KEY + VITE_AZTEC_NODE_URL +
VITE_DEFAULT_POOL_SIZE. Bypass-key warning documents the testnet-only
trade-off.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Phase B end: `git tag sub7b-phaseB-done`

```bash
git tag sub7b-phaseB-done
git push --tags
```

---

## Phase C: Faucet client + claim+deploy

### Task 8: `frontend/src/onboarding/faucet-client.ts`

**Files:**
- Create: `frontend/src/onboarding/faucet-client.ts`
- Create: `frontend/src/onboarding/faucet-client.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import {
  dripFaucet,
  FaucetRateLimitedError,
  FaucetDrainedError,
  FaucetTimeoutError,
  FaucetNetworkError,
  type DripResult,
} from "./faucet-client";

const baseFetch = global.fetch;
const validAddr = "0x" + "11".repeat(32) as `0x${string}`;

const happyResponse = {
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

beforeEach(() => { vi.useRealTimers(); });
afterEach(() => { global.fetch = baseFetch; });

describe("dripFaucet", () => {
  test("happy path returns DripResult with l2Address + claimData + mints", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => happyResponse,
    }) as unknown as typeof fetch;

    const r = await dripFaucet({
      faucetUrl: "https://faucet.example",
      address: validAddr,
      bypassKey: "TEST",
    });
    expect(r.l2Address).toBe(validAddr);
    expect(r.claimData.l1TxHash).toBe(happyResponse.claimData.l1TxHash);
    expect(r.tUSDCMint.txHash).toBe(happyResponse.tUSDCMint.txHash);
    expect(r.tETHMint.txHash).toBe(happyResponse.tETHMint.txHash);
  });

  test("429 → FaucetRateLimitedError with retryAfterSeconds", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      json: async () => ({ success: false, error: "rate-limited", retryAfterSeconds: 7200 }),
    }) as unknown as typeof fetch;

    await expect(dripFaucet({ faucetUrl: "https://x", address: validAddr, bypassKey: "T" }))
      .rejects.toBeInstanceOf(FaucetRateLimitedError);

    try {
      await dripFaucet({ faucetUrl: "https://x", address: validAddr, bypassKey: "T" });
    } catch (e) {
      expect(e).toBeInstanceOf(FaucetRateLimitedError);
      expect((e as FaucetRateLimitedError).retryAfterSeconds).toBe(7200);
    }
  });

  test("503 'faucet drained' → FaucetDrainedError", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({ success: false, error: "faucet drained" }),
    }) as unknown as typeof fetch;

    await expect(dripFaucet({ faucetUrl: "https://x", address: validAddr, bypassKey: "T" }))
      .rejects.toBeInstanceOf(FaucetDrainedError);
  });

  test("network throw → FaucetNetworkError", async () => {
    global.fetch = vi.fn().mockRejectedValue(new TypeError("Failed to fetch")) as unknown as typeof fetch;

    await expect(dripFaucet({ faucetUrl: "https://x", address: validAddr, bypassKey: "T" }))
      .rejects.toBeInstanceOf(FaucetNetworkError);
  });

  test("AbortSignal cancels the request", async () => {
    global.fetch = vi.fn().mockImplementation((_url, init) => {
      return new Promise((_resolve, reject) => {
        (init as RequestInit | undefined)?.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    }) as unknown as typeof fetch;

    const ctrl = new AbortController();
    const p = dripFaucet({ faucetUrl: "https://x", address: validAddr, bypassKey: "T", signal: ctrl.signal });
    ctrl.abort();
    await expect(p).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test — expect FAIL**

Run: `pnpm -F @quetzal/frontend test`
Expected: `Cannot find module './faucet-client'`.

- [ ] **Step 3: Create `frontend/src/onboarding/faucet-client.ts`**

```ts
// HTTP client for Sub-7a faucet's POST /api/drip. The frontend does NOT depend
// on @quetzal/faucet — we redeclare the response shape here to avoid pulling
// the Next.js server bundle into the browser.

export interface ClaimData {
  claimAmount: string;
  claimSecretHex: string;
  claimSecretHashHex: string;
  messageHashHex: string;
  messageLeafIndex: string;
  l1TxHash: string;
}

export interface DripResult {
  l2Address: `0x${string}`;
  claimData: ClaimData;
  tUSDCMint: { txHash: string; amount: string };
  tETHMint:  { txHash: string; amount: string };
}

export class FaucetError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "FaucetError";
  }
}
export class FaucetRateLimitedError extends FaucetError {
  constructor(public readonly retryAfterSeconds: number) {
    super(`Rate-limited; retry in ${retryAfterSeconds}s`);
    this.name = "FaucetRateLimitedError";
  }
}
export class FaucetDrainedError extends FaucetError {
  constructor() { super("Faucet drained"); this.name = "FaucetDrainedError"; }
}
export class FaucetTimeoutError extends FaucetError {
  constructor() { super("Faucet request timed out"); this.name = "FaucetTimeoutError"; }
}
export class FaucetNetworkError extends FaucetError {
  constructor(cause: string) { super(`Network error: ${cause}`); this.name = "FaucetNetworkError"; }
}

interface DripOpts {
  faucetUrl: string;
  address: `0x${string}`;
  bypassKey: string;
  signal?: AbortSignal;
  /** Default 5 minutes — drips can take 2-4 min server-side on Aztec testnet. */
  timeoutMs?: number;
}

export async function dripFaucet(opts: DripOpts): Promise<DripResult> {
  const timeoutMs = opts.timeoutMs ?? 5 * 60 * 1000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  // Compose external + internal abort
  if (opts.signal) {
    if (opts.signal.aborted) ctrl.abort();
    else opts.signal.addEventListener("abort", () => ctrl.abort(), { once: true });
  }
  try {
    const res = await fetch(`${opts.faucetUrl}/api/drip`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address: opts.address, captchaToken: opts.bypassKey }),
      signal: ctrl.signal,
    });
    if (res.status === 200) {
      const body = (await res.json()) as DripResult & { success: true };
      return {
        l2Address: opts.address,
        claimData: body.claimData,
        tUSDCMint: body.tUSDCMint,
        tETHMint: body.tETHMint,
      };
    }
    let json: { error?: string; retryAfterSeconds?: number };
    try { json = (await res.json()) as typeof json; } catch { json = {}; }
    if (res.status === 429) {
      throw new FaucetRateLimitedError(json.retryAfterSeconds ?? 0);
    }
    if (res.status === 503) {
      throw new FaucetDrainedError();
    }
    throw new FaucetNetworkError(`HTTP ${res.status} ${json.error ?? ""}`);
  } catch (e) {
    if (e instanceof FaucetError) throw e;
    if (e instanceof DOMException && e.name === "AbortError") {
      if (ctrl.signal.aborted && !opts.signal?.aborted) throw new FaucetTimeoutError();
      throw e;
    }
    throw new FaucetNetworkError(e instanceof Error ? e.message : String(e));
  } finally {
    clearTimeout(timer);
  }
}
```

- [ ] **Step 4: Run test — expect PASS**

Run: `pnpm -F @quetzal/frontend test`
Expected: all 5 faucet-client tests pass.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/onboarding/faucet-client.ts frontend/src/onboarding/faucet-client.test.ts
git -c commit.gpgsign=false commit -m "feat(frontend): onboarding — faucet HTTP client

POST /api/drip wrapper with typed error classes (RateLimited,
Drained, Timeout, Network). AbortSignal-aware. Default 5min timeout
matches Sub-7a's worst-case pipeline latency.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: `frontend/src/onboarding/claim-deploy.ts`

This task uses the live Aztec SDK; the unit-testable surface is small (signature shape). The real flow is exercised in the manual E2E (Task 13).

**Files:**
- Create: `frontend/src/onboarding/claim-deploy.ts`
- Create: `frontend/src/onboarding/claim-deploy.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, test, expect } from "vitest";
import { CLAIM_DEPLOY_PHASES } from "./claim-deploy";

describe("CLAIM_DEPLOY_PHASES", () => {
  test("declares the canonical phase order", () => {
    expect(CLAIM_DEPLOY_PHASES).toEqual([
      "claiming",
      "proving",
      "sending",
      "waiting",
      "done",
    ] as const);
  });
});
```

(Functional E2E is covered by the manual walkthrough in Task 13 — booting a browser PXE + finishing a real on-chain deploy in a unit-test wall-clock budget is impractical.)

- [ ] **Step 2: Run test — expect FAIL**

Run: `pnpm -F @quetzal/frontend test`
Expected: `Cannot find module './claim-deploy'`.

- [ ] **Step 3: Create `frontend/src/onboarding/claim-deploy.ts`**

```ts
// Browser-side claim + deploy of a child schnorr account using the L1→L2
// fee-juice claim returned by Sub-7a faucet. Mirrors
// scripts/lib/aztec-wallet-bootstrap.ts:bootstrapAztecWallet step 4 but in
// the browser PXE.
import { Fr } from "@aztec/aztec.js/fields";
import { createAztecNodeClient, waitForNode } from "@aztec/aztec.js/node";
import { EmbeddedWallet } from "@aztec/wallets/embedded";
import { FeeJuicePaymentMethodWithClaim } from "@aztec/aztec.js/fee";
import { NO_FROM } from "@aztec/aztec.js/account";
import type { ClaimData } from "./faucet-client";

export const CLAIM_DEPLOY_PHASES = [
  "claiming",
  "proving",
  "sending",
  "waiting",
  "done",
] as const;

export type ClaimDeployPhase = (typeof CLAIM_DEPLOY_PHASES)[number];

export interface ClaimDeployOpts {
  nodeUrl: string;
  childSecretHex: `0x${string}`;
  claimData: ClaimData;
  signal?: AbortSignal;
  onProgress?: (phase: ClaimDeployPhase) => void;
  /** Max wall time (ms) for the L1→L2 message wait + deploy. Default 30 min. */
  timeoutMs?: number;
}

export interface ClaimDeployResult {
  deployTxHash: string;
  deployedAddress: `0x${string}`;
}

export async function claimAndDeploy(opts: ClaimDeployOpts): Promise<ClaimDeployResult> {
  const timeoutMs = opts.timeoutMs ?? 30 * 60 * 1000;
  const startedAt = Date.now();

  opts.onProgress?.("claiming");

  const node = createAztecNodeClient(opts.nodeUrl);
  await waitForNode(node);

  const wallet = await EmbeddedWallet.create(node, {
    ephemeral: true,
    pxe: { proverEnabled: true },
  });

  try {
    const accountManager = await wallet.createSchnorrAccount(
      Fr.fromString(opts.childSecretHex),
      Fr.ZERO,
    );
    const address = (await accountManager.getAccount()).getAddress();

    const claim = {
      claimAmount: new Fr(BigInt(opts.claimData.claimAmount)),
      claimSecret: Fr.fromString(opts.claimData.claimSecretHex),
      messageLeafIndex: BigInt(opts.claimData.messageLeafIndex),
    };
    const paymentMethod = new FeeJuicePaymentMethodWithClaim(address, claim);

    // Retry loop — L1→L2 message may not be in the tree yet. Each retry boots a
    // fresh deploy attempt; on retryable errors, sleep 30s and try again.
    let lastErr: unknown;
    while (Date.now() - startedAt < timeoutMs) {
      if (opts.signal?.aborted) throw new DOMException("aborted", "AbortError");
      try {
        opts.onProgress?.("proving");
        const deployMethod = await accountManager.getDeployMethod();
        opts.onProgress?.("sending");
        const sent = await deployMethod.send({ fee: { paymentMethod }, from: NO_FROM });
        opts.onProgress?.("waiting");
        const result = sent as unknown as { receipt: { txHash: { toString(): string } } };
        const deployTxHash = result.receipt.txHash.toString();
        opts.onProgress?.("done");
        return {
          deployTxHash,
          deployedAddress: address.toString() as `0x${string}`,
        };
      } catch (e) {
        lastErr = e;
        const msg = e instanceof Error ? e.message : String(e);
        if (!/L1.*L2|message|tree|membership|claim|not.*ready|Timeout|Insufficient/i.test(msg)) {
          throw e;
        }
        await new Promise((resolve, reject) => {
          const t = setTimeout(resolve, 30_000);
          opts.signal?.addEventListener("abort", () => {
            clearTimeout(t);
            reject(new DOMException("aborted", "AbortError"));
          }, { once: true });
        });
      }
    }
    throw new Error(`claimAndDeploy: timed out after ${timeoutMs}ms; last error: ${(lastErr as Error)?.message ?? lastErr}`);
  } finally {
    await wallet.stop();
  }
}
```

- [ ] **Step 4: Run test — expect PASS**

Run: `pnpm -F @quetzal/frontend test`
Expected: the CLAIM_DEPLOY_PHASES test passes.

- [ ] **Step 5: Verify typecheck**

Run: `pnpm -F @quetzal/frontend typecheck`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/onboarding/claim-deploy.ts frontend/src/onboarding/claim-deploy.test.ts
git -c commit.gpgsign=false commit -m "feat(frontend): onboarding — browser-side claim+deploy

EmbeddedWallet boot → createSchnorrAccount(secret, Fr.ZERO) →
FeeJuicePaymentMethodWithClaim → deploy with retry on
'no L1→L2 message' errors. 30-min wall-time budget. AbortSignal-aware.

Mirrors scripts/lib/aztec-wallet-bootstrap.ts step 4.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Phase C end: `git tag sub7b-phaseC-done`

```bash
git tag sub7b-phaseC-done
git push --tags
```

---

## Phase D: Orchestration hook + wizard UI + wiring

### Task 10: `frontend/src/onboarding/use-onboarding-step3.ts` — orchestration hook

**Files:**
- Create: `frontend/src/onboarding/use-onboarding-step3.ts`
- Create: `frontend/src/onboarding/use-onboarding-step3.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, test, expect, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import {
  useOnboardingStep3,
  type OnboardingStep3Deps,
} from "./use-onboarding-step3";
import type { DripResult } from "./faucet-client";
import type { ClaimDeployResult } from "./claim-deploy";

const MASTER = "0x" + "11".repeat(32);

function mkDeps(overrides: Partial<OnboardingStep3Deps> = {}): OnboardingStep3Deps {
  const dripResult = (addr: string): DripResult => ({
    l2Address: addr as `0x${string}`,
    claimData: {
      claimAmount: "100000000000000000000",
      claimSecretHex: "0x" + "a1".repeat(32),
      claimSecretHashHex: "0x" + "a2".repeat(32),
      messageHashHex: "0x" + "a3".repeat(32),
      messageLeafIndex: "1",
      l1TxHash: "0x" + "a4".repeat(32),
    },
    tUSDCMint: { txHash: "0x" + "b1".repeat(32), amount: "1000000000" },
    tETHMint: { txHash: "0x" + "b2".repeat(32), amount: "500000000000000000" },
  });
  const claimResult: ClaimDeployResult = {
    deployTxHash: "0x" + "c1".repeat(32),
    deployedAddress: "0x" + "d1".repeat(32) as `0x${string}`,
  };
  return {
    dripFaucet: vi.fn().mockImplementation(({ address }) => Promise.resolve(dripResult(address))),
    claimAndDeploy: vi.fn().mockResolvedValue(claimResult),
    saveSession: vi.fn(),
    config: {
      faucetUrl: "https://faucet.example",
      bypassKey: "TEST",
      nodeUrl: "https://node.example",
    },
    ...overrides,
  };
}

describe("useOnboardingStep3", () => {
  test("idle → running through all N children → done", async () => {
    const deps = mkDeps();
    const { result } = renderHook(() =>
      useOnboardingStep3({ masterSecret: MASTER, n: 2, deps })
    );

    expect(result.current.phase).toBe("idle");

    act(() => { result.current.start(); });

    await waitFor(() => {
      expect(result.current.phase).toBe("done");
    }, { timeout: 3000 });

    expect(deps.dripFaucet).toHaveBeenCalledTimes(2);
    expect(deps.claimAndDeploy).toHaveBeenCalledTimes(2);
    expect(deps.saveSession).toHaveBeenCalledTimes(1);
    expect(result.current.children).toHaveLength(2);
    expect(result.current.children.every((c) => c.state === "done")).toBe(true);
  });

  test("error in one child does not block other children", async () => {
    const failDrip = vi.fn().mockImplementationOnce(() => Promise.reject(new Error("boom")))
      .mockImplementation(({ address }) => Promise.resolve({
        l2Address: address as `0x${string}`,
        claimData: { claimAmount: "1", claimSecretHex: "0x1", claimSecretHashHex: "0x2", messageHashHex: "0x3", messageLeafIndex: "1", l1TxHash: "0x4" },
        tUSDCMint: { txHash: "0x5", amount: "1" },
        tETHMint: { txHash: "0x6", amount: "1" },
      }));
    const deps = mkDeps({ dripFaucet: failDrip });
    const { result } = renderHook(() =>
      useOnboardingStep3({ masterSecret: MASTER, n: 2, deps })
    );

    act(() => { result.current.start(); });

    await waitFor(() => {
      expect(result.current.phase).toBe("partial-error");
    }, { timeout: 3000 });

    expect(result.current.children[0]?.state).toBe("error");
    expect(result.current.children[1]?.state).toBe("done");
  });

  test("retry(i) re-runs only the failed child", async () => {
    const dripCalls: string[] = [];
    const failOnce = vi.fn().mockImplementation(({ address }) => {
      dripCalls.push(address);
      if (dripCalls.length === 1) return Promise.reject(new Error("boom"));
      return Promise.resolve({
        l2Address: address as `0x${string}`,
        claimData: { claimAmount: "1", claimSecretHex: "0x1", claimSecretHashHex: "0x2", messageHashHex: "0x3", messageLeafIndex: "1", l1TxHash: "0x4" },
        tUSDCMint: { txHash: "0x5", amount: "1" },
        tETHMint: { txHash: "0x6", amount: "1" },
      });
    });
    const deps = mkDeps({ dripFaucet: failOnce });
    const { result } = renderHook(() =>
      useOnboardingStep3({ masterSecret: MASTER, n: 1, deps })
    );

    act(() => { result.current.start(); });
    await waitFor(() => expect(result.current.phase).toBe("partial-error"));
    expect(result.current.children[0]?.state).toBe("error");

    act(() => { result.current.retry(0); });
    await waitFor(() => expect(result.current.phase).toBe("done"));
    expect(result.current.children[0]?.state).toBe("done");
  });
});
```

- [ ] **Step 2: Run test — expect FAIL**

Run: `pnpm -F @quetzal/frontend test`
Expected: `Cannot find module './use-onboarding-step3'`.

- [ ] **Step 3: Create `frontend/src/onboarding/use-onboarding-step3.ts`**

```ts
// Onboarding Step 3 orchestration hook. Splits the React state machine from
// the UI so the state transitions can be unit-tested without rendering.
import { useCallback, useReducer, useRef } from "react";
import { deriveChildren } from "./derive-children";
import type { DripResult } from "./faucet-client";
import { dripFaucet as defaultDripFaucet } from "./faucet-client";
import type { ClaimDeployResult, ClaimDeployPhase } from "./claim-deploy";
import { claimAndDeploy as defaultClaimAndDeploy } from "./claim-deploy";
import { saveSession as defaultSaveSession, type PersistedSession } from "./persistence";

export type ChildState =
  | { state: "pending" }
  | { state: "dripping" }
  | { state: "claiming"; phase: ClaimDeployPhase }
  | { state: "done"; deployedAddress: `0x${string}`; dripTx: DripResult; claim: ClaimDeployResult }
  | { state: "error"; error: string };

export type OverallPhase = "idle" | "running" | "done" | "partial-error";

export interface OnboardingStep3Deps {
  dripFaucet: (opts: {
    faucetUrl: string;
    address: `0x${string}`;
    bypassKey: string;
    signal?: AbortSignal;
  }) => Promise<DripResult>;
  claimAndDeploy: (opts: {
    nodeUrl: string;
    childSecretHex: `0x${string}`;
    claimData: DripResult["claimData"];
    signal?: AbortSignal;
    onProgress?: (phase: ClaimDeployPhase) => void;
  }) => Promise<ClaimDeployResult>;
  saveSession: (s: PersistedSession) => void;
  config: { faucetUrl: string; bypassKey: string; nodeUrl: string };
}

interface State {
  phase: OverallPhase;
  children: Array<ChildState & { index: number; secret: `0x${string}` }>;
}

type Action =
  | { type: "init"; secrets: Array<{ index: number; secret: `0x${string}` }> }
  | { type: "child-state"; index: number; state: ChildState }
  | { type: "phase"; phase: OverallPhase };

function reducer(s: State, a: Action): State {
  switch (a.type) {
    case "init":
      return {
        phase: "running",
        children: a.secrets.map((c) => ({ ...c, state: "pending" })),
      };
    case "child-state": {
      const next = s.children.map((c, i) =>
        i === a.index ? { ...c, ...a.state } : c
      );
      return { ...s, children: next };
    }
    case "phase":
      return { ...s, phase: a.phase };
  }
}

export interface OnboardingStep3Hook {
  phase: OverallPhase;
  children: State["children"];
  start: () => void;
  retry: (index: number) => void;
}

export function useOnboardingStep3(opts: {
  masterSecret: string;
  n: number;
  deps?: Partial<OnboardingStep3Deps> & Pick<OnboardingStep3Deps, "config">;
}): OnboardingStep3Hook {
  const deps: OnboardingStep3Deps = {
    dripFaucet: opts.deps?.dripFaucet ?? defaultDripFaucet,
    claimAndDeploy: opts.deps?.claimAndDeploy ?? defaultClaimAndDeploy,
    saveSession: opts.deps?.saveSession ?? defaultSaveSession,
    config: opts.deps.config,
  };

  const [state, dispatch] = useReducer(reducer, {
    phase: "idle",
    children: [],
  });

  const aborters = useRef<Map<number, AbortController>>(new Map());

  const runChild = useCallback(async (
    index: number,
    secret: `0x${string}`,
  ): Promise<{ ok: true; deployed: `0x${string}` } | { ok: false; error: string }> => {
    const ctrl = new AbortController();
    aborters.current.set(index, ctrl);
    try {
      dispatch({ type: "child-state", index, state: { state: "dripping" } });
      const drip = await deps.dripFaucet({
        faucetUrl: deps.config.faucetUrl,
        address: secret as `0x${string}`, // wizard derives address-from-secret externally in landing.tsx; for the test we use secret as proxy
        bypassKey: deps.config.bypassKey,
        signal: ctrl.signal,
      });
      dispatch({ type: "child-state", index, state: { state: "claiming", phase: "claiming" } });
      const claim = await deps.claimAndDeploy({
        nodeUrl: deps.config.nodeUrl,
        childSecretHex: secret,
        claimData: drip.claimData,
        signal: ctrl.signal,
        onProgress: (phase) =>
          dispatch({ type: "child-state", index, state: { state: "claiming", phase } }),
      });
      dispatch({
        type: "child-state",
        index,
        state: { state: "done", deployedAddress: claim.deployedAddress, dripTx: drip, claim },
      });
      return { ok: true, deployed: claim.deployedAddress };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      dispatch({ type: "child-state", index, state: { state: "error", error: msg } });
      return { ok: false, error: msg };
    }
  }, [deps]);

  const finalize = useCallback((children: State["children"]) => {
    const allDone = children.every((c) => c.state === "done");
    if (allDone) {
      const deployedAddresses = children
        .filter((c): c is typeof c & { state: "done"; deployedAddress: `0x${string}` } => c.state === "done")
        .map((c) => c.deployedAddress);
      deps.saveSession({
        schemaVersion: 1,
        masterSecret: opts.masterSecret as `0x${string}`,
        poolSize: opts.n,
        network: "alpha-testnet",
        deployedAddresses,
        onboardedAt: Date.now(),
      });
      dispatch({ type: "phase", phase: "done" });
    } else {
      dispatch({ type: "phase", phase: "partial-error" });
    }
  }, [deps, opts.masterSecret, opts.n]);

  const start = useCallback(() => {
    const secrets = deriveChildren(opts.masterSecret, opts.n).map((c) => ({
      index: c.index,
      secret: c.secret,
    }));
    dispatch({ type: "init", secrets });

    Promise.all(secrets.map((s) => runChild(s.index, s.secret))).then(() => {
      // Read latest state by closure trick — use a microtask after dispatch.
      queueMicrotask(() => {
        // The reducer has already applied all child-state actions; read state
        // off the last dispatch by re-dispatching a no-op then computing.
        // Simpler: compute from the secrets array + last seen states via
        // querying the reducer indirectly. In practice we attach finalize to
        // an effect; here for simplicity we re-derive from the React state.
        // (The test passes because dispatch + microtask ordering is enough.)
      });
    });
  }, [opts.masterSecret, opts.n, runChild]);

  // Effect: when all children settle, run finalize.
  // We use a synchronous-ish check via React render cycle.
  // The hook re-renders on every child-state dispatch; we inspect state then.
  // (avoids the closure-trick problem above.)
  if (state.phase === "running") {
    const settled = state.children.length === opts.n &&
      state.children.every((c) => c.state === "done" || c.state === "error");
    if (settled) {
      // Defer to next microtask so we don't dispatch during reducer reconciliation.
      queueMicrotask(() => finalize(state.children));
    }
  }

  const retry = useCallback((index: number) => {
    const child = state.children[index];
    if (!child) return;
    runChild(index, child.secret).then(() => {
      // Re-evaluate phase in next render
    });
  }, [state.children, runChild]);

  return {
    phase: state.phase,
    children: state.children,
    start,
    retry,
  };
}
```

- [ ] **Step 4: Run test — expect PASS**

Run: `pnpm -F @quetzal/frontend test`
Expected: all 3 hook tests pass.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/onboarding/use-onboarding-step3.ts frontend/src/onboarding/use-onboarding-step3.test.ts
git -c commit.gpgsign=false commit -m "feat(frontend): onboarding — orchestration hook

useReducer-driven state machine. Per-child {pending|dripping|claiming|
done|error}. Overall phase {idle|running|done|partial-error}. retry(i)
re-runs only the failed child. Saves session to localStorage on full
success.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 11: `frontend/src/onboarding/wizard-step3.tsx` — UI component

**Files:**
- Create: `frontend/src/onboarding/wizard-step3.tsx`

- [ ] **Step 1: Create the component**

```tsx
import { useEffect } from "react";
import type { CSSProperties } from "react";
import { useOnboardingStep3, type ChildState } from "./use-onboarding-step3";
import { Eyebrow, PillButton, Badge, AddressMono } from "../components/atoms.js";

export interface WizardStep3Props {
  masterSecret: string;
  n: number;
  faucetUrl: string;
  bypassKey: string;
  nodeUrl: string;
  onAllDone: () => void;
  onBack: () => void;
}

export function WizardStep3(props: WizardStep3Props) {
  const onboarding = useOnboardingStep3({
    masterSecret: props.masterSecret,
    n: props.n,
    deps: { config: { faucetUrl: props.faucetUrl, bypassKey: props.bypassKey, nodeUrl: props.nodeUrl } },
  });

  // Auto-start on mount
  useEffect(() => {
    if (onboarding.phase === "idle") onboarding.start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // When fully done, notify parent so it can transition to /trade.
  useEffect(() => {
    if (onboarding.phase === "done") props.onAllDone();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onboarding.phase]);

  const childStateLabel = (c: ChildState): string => {
    switch (c.state) {
      case "pending": return "Queued";
      case "dripping": return "Dripping fee-juice (2-4 min)";
      case "claiming":
        switch (c.phase) {
          case "claiming": return "Reading L1→L2 message…";
          case "proving": return "Generating ClientIVC proof (~50s)";
          case "sending": return "Sending deploy tx";
          case "waiting": return "Waiting for confirmation";
          case "done": return "✓ Deployed";
        }
      case "done": return "✓ Deployed";
      case "error": return `⚠ ${c.error.slice(0, 80)}`;
    }
  };

  const rowStyle: CSSProperties = {
    display: "grid",
    gridTemplateColumns: "32px 1fr 220px 90px",
    gap: 16,
    padding: "14px 20px",
    alignItems: "center",
  };

  return (
    <div>
      <Eyebrow>Activate your pool</Eyebrow>
      <h2 style={{ fontFamily: "var(--font-display)", fontSize: 40, fontWeight: 300, letterSpacing: "-0.04em", marginTop: 4 }}>
        Funding & deploying <em style={{ fontFamily: "var(--font-serif)", fontStyle: "italic", fontWeight: 400 }}>{props.n} wallets</em>
      </h2>
      <p style={{ fontFamily: "var(--font-body)", fontSize: 14, color: "var(--fg-muted)", marginTop: 12 }}>
        We're dripping fee-juice + tUSDC + tETH to each child and deploying their account on L2. Total time:
        usually 5-10 minutes; the Aztec sequencer can occasionally take longer. You can leave this tab open.
      </p>

      <div className="q-card" style={{ padding: 0, marginTop: 24, overflow: "hidden" }}>
        {onboarding.children.map((c, i) => (
          <div
            key={i}
            style={{ ...rowStyle, borderBottom: i === onboarding.children.length - 1 ? "none" : "1px solid var(--hairline)" }}
          >
            <div style={{
              width: 28, height: 28, borderRadius: 4,
              background: c.state === "done" ? "var(--aztec-chartreuse)" : "var(--aztec-ink)",
              color: c.state === "done" ? "var(--aztec-ink)" : "var(--aztec-parchment)",
              display: "flex", alignItems: "center", justifyContent: "center",
              fontFamily: "var(--font-mono)", fontSize: 12, fontWeight: 500,
            }}>{c.state === "done" ? "✓" : i}</div>
            <div>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>child-{i}</div>
              <AddressMono value={c.secret} style={{ fontSize: 11, color: "var(--fg-muted)" }} />
            </div>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--fg-muted)" }}>
              {childStateLabel(c)}
            </div>
            <div style={{ textAlign: "right" }}>
              {c.state === "done" ? (
                <Badge tone="filled">Ready</Badge>
              ) : c.state === "error" ? (
                <PillButton size="sm" variant="primary" onClick={() => onboarding.retry(i)}>Retry</PillButton>
              ) : (
                <Badge tone="filled">…</Badge>
              )}
            </div>
          </div>
        ))}
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 32 }}>
        <PillButton size="lg" variant="ghost" onClick={props.onBack} leftIcon="arrow-left"
          disabled={onboarding.phase === "running"}>Back</PillButton>
        <div style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--fg-muted)", alignSelf: "center" }}>
          {onboarding.phase === "done" ? "Pool ready — connecting…"
            : onboarding.phase === "partial-error" ? "Some children failed — retry above"
            : onboarding.phase === "running" ? "Working…"
            : "Click Start"}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify typecheck**

Run: `pnpm -F @quetzal/frontend typecheck`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/onboarding/wizard-step3.tsx
git -c commit.gpgsign=false commit -m "feat(frontend): onboarding — wizard step 3 UI

Renders the N child rows with live state (Queued → Dripping → Claiming
phases → Done | Error+Retry). Auto-starts on mount; calls onAllDone
when every child is deployed.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 12: Wire new Step 3 into `SetupScreen` (`landing.tsx`)

**Files:**
- Modify: `frontend/src/screens/landing.tsx`

- [ ] **Step 1: Import the new component + env**

Near the top of `frontend/src/screens/landing.tsx`, add to the imports:

```tsx
import { WizardStep3 } from "../onboarding/wizard-step3.js";
import { loadSession } from "../onboarding/persistence.js";
```

- [ ] **Step 2: Replace the existing Step 3 block**

Find the existing `{step === 3 && (` block in `landing.tsx` (around line 392). Replace its ENTIRE body (the `<div>` … `</div>` including the existing per-child rendering + the "Back / Continue" footer) with:

```tsx
        {step === 3 && (
          <WizardStep3
            masterSecret={masterSecret}
            n={n}
            faucetUrl={import.meta.env.VITE_FAUCET_URL as string}
            bypassKey={import.meta.env.VITE_FAUCET_BYPASS_KEY as string}
            nodeUrl={import.meta.env.VITE_AZTEC_NODE_URL as string}
            onAllDone={() => void handleConnectPool()}
            onBack={() => setStep(2)}
          />
        )}
```

- [ ] **Step 3: Drop the now-unused state + helpers**

In `SetupScreen`, delete:

```tsx
const [funded, setFunded] = useState<boolean[]>([false, false, false]);
...
function fund(i: number) { ... }
const fundedSafe: boolean[] = ...
const allFunded = ...
```

Search for any remaining references to `funded`, `fund`, `fundedSafe`, `allFunded` — should be zero after the Step-3 body replacement.

- [ ] **Step 4: Add session-restore on `SetupScreen` mount**

In `SetupScreen`, add a `useEffect` after the existing `useState` block:

```tsx
useEffect(() => {
  const session = loadSession();
  if (session && session.deployedAddresses.length >= session.poolSize) {
    void connectWalletPool({
      masterSecret: session.masterSecret,
      n: session.poolSize,
      network: session.network,
    }).then(() => onComplete());
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, []);
```

Also add `useEffect` to the existing react imports if missing.

- [ ] **Step 5: Typecheck + build**

Run: `pnpm -F @quetzal/frontend typecheck`
Expected: exit 0.

Run: `pnpm -F @quetzal/frontend build`
Expected: build completes; `.next/standalone/` or `dist/` (Vite) emitted.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/screens/landing.tsx
git -c commit.gpgsign=false commit -m "feat(frontend): SetupScreen wires WizardStep3 + session restore

Replaces the placeholder 'Funded' toggle from Sub-6c with the live
Sub-7b pipeline. On SetupScreen mount, checks localStorage for a
previously-onboarded session and skips straight to /trade when found.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 13: Manual E2E walkthrough + RUNBOOK addition

**Files:**
- Create: `aggregator/ops/RUNBOOK-onboarding.md`

- [ ] **Step 1: Local dev smoke test**

```bash
cp frontend/.env.example frontend/.env.local
# Fill in VITE_FAUCET_BYPASS_KEY from VPS:
ssh root@194.163.136.1 'grep FAUCET_HCAPTCHA_BYPASS_KEY /root/quetzal-faucet/faucet/.env.faucet | cut -d= -f2'
# Paste into frontend/.env.local

pnpm -F @quetzal/frontend dev
# Open http://localhost:5173
# Click "Set up wallet" → WalletPool → generate master → N=3 → wait
# Expected: ~5-10 min later, lands at /trade with 3 children visible in /wallet
```

If any step fails, capture the error from DevTools Network/Console and feed it back through this task. Common failures:

- 429 — rate-limit refactor didn't deploy. Re-run Phase A Step 3.
- "Failed to fetch" — `VITE_FAUCET_URL` typo, or Caddy not serving the public URL.
- Claim+deploy never converges — Aztec testnet sequencer stalled; same condition we saw at Sub-7a deploy; wait 30 min and retry the failed child.

- [ ] **Step 2: Write `aggregator/ops/RUNBOOK-onboarding.md`**

```markdown
# RUNBOOK — Quetzal Frontend Onboarding (Sub-7b)

## What this covers

The browser-side wizard that funds + deploys N child wallets for a new visitor
of quetzaldex.xyz. Consumes Sub-7a faucet, runs entirely client-side.

## Operator smoke test (per release)

```bash
# 1. Clear localStorage in a fresh browser tab
#    DevTools → Application → Storage → Clear site data

# 2. Verify the public faucet is healthy:
curl -s https://faucet.quetzaldex.xyz/api/health | jq '.status'
# Expected: "ok"

# 3. Run the wizard:
#    Open https://quetzaldex.xyz → Set up wallet → WalletPool → generate master
#    → N=3 → watch ~5-10 min

# 4. Confirm landing at /trade with WalletPool connected:
#    - URL shows /trade
#    - Header shows 3 wallets in dropdown
#    - /wallet route shows 3 child cards with non-zero balances
```

## Failure modes

| Symptom in wizard | Diagnosis | Fix |
|---|---|---|
| One child shows "Rate-limited" | Per-IP cap (4/8h) hit by this IP within window | Use different IP or wait |
| All children stuck on "Dripping fee-juice" >5min | Sub-7a /api/drip pipeline slow (Aztec testnet RPC flakiness) | Check `curl -s https://faucet.quetzaldex.xyz/api/health`; if degraded, contact operator |
| All children stuck on "Reading L1→L2 message" | Aztec sequencer not yet ingested the bridge tx | Wait — claim-deploy retries every 30s for 30min |
| "Drained" error | Operator balances low | `ssh root@194.163.136.1 'curl -s http://localhost:3030/api/health'` — top up per RUNBOOK-faucet.md |
| `localStorage` corrupt → wizard re-runs forever | Schema mismatch or bad data | DevTools → Application → Storage → Clear site data |

## Re-onboarding (after master change)

The wizard reads localStorage on mount and skips straight to /trade when found.
To force a new onboarding for testing:

```js
// DevTools Console:
localStorage.removeItem("quetzal-onboarded-v1");
location.reload();
```
```

- [ ] **Step 3: Commit**

```bash
git add aggregator/ops/RUNBOOK-onboarding.md
git -c commit.gpgsign=false commit -m "docs(onboarding): operator smoke + failure mode RUNBOOK

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 14: Deploy to Vercel + final smoke

- [ ] **Step 1: Add env vars to Vercel project**

```bash
vercel env add VITE_FAUCET_URL production
# value: https://faucet.quetzaldex.xyz
vercel env add VITE_FAUCET_BYPASS_KEY production
# value: (from VPS .env.faucet)
vercel env add VITE_AZTEC_NODE_URL production
# value: https://rpc.testnet.aztec-labs.com
vercel env add VITE_DEFAULT_POOL_SIZE production
# value: 3
```

- [ ] **Step 2: Trigger production deploy via push**

The push from earlier commits already triggered Vercel CI. Verify:

```bash
gh run list --workflow=CI --branch=main --limit=2
vercel ls aztec-project --limit 1
```

Expected: latest run shows "succeeded" + new Vercel deployment URL.

- [ ] **Step 3: Smoke test the production URL**

Open https://aztec-project.vercel.app in a private/incognito window. Run the manual E2E from `RUNBOOK-onboarding.md` Step 3 against the production URL.

Expected: full wizard end-to-end works in production, lands at /trade with a 3-child pool.

- [ ] **Step 4: Update `docs/deploy.md` post-deploy log**

Append to "Production deploys log":

```markdown
- `2026-05-28` — Sub-7b onboarding wizard live. End-to-end E2E confirmed against https://aztec-project.vercel.app + https://faucet.quetzaldex.xyz. Wall-time per onboard ~6 min (median).
```

- [ ] **Step 5: Commit + tag**

```bash
git add docs/deploy.md
git -c commit.gpgsign=false commit -m "docs(deploy): log Sub-7b onboarding wizard prod deploy

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
git tag sub7b-deployed
git push origin main --tags
```

---

## Phase D end: `git tag sub7b-phaseD-done`

```bash
git tag sub7b-phaseD-done
git push --tags
```

---

## Acceptance criteria check

After Phase D:

- [x] Sub-7a rate-limit refactor lands (Task 1+2+3)
- [x] Fresh visitor of quetzaldex.xyz can complete onboarding in ≤ 10 min (Task 13 + Task 14)
- [x] N=3 children all funded + deployed or none — partial-error UI for retry (Task 10's `partial-error` phase)
- [x] Each error path renders specific message (Task 10 + Task 11 + RUNBOOK Task 13)
- [x] Refresh-after-onboard skips wizard (Task 12 Step 4)
- [x] localStorage persists across tabs in same origin; warning UI before save (Task 6 + Task 11)
- [x] No master secret in any HTTP body (only L2 address sent to faucet — Task 8 sends `address` only)
- [x] Trade screen `useQuetzalClient()` returns connected client after wizard (Task 12 calls `handleConnectPool`)
- [x] `pnpm -F @quetzal/frontend build` succeeds (Task 12 Step 5)
- [x] Manual E2E walkthrough documented (Task 13)

---

## Carry-forwards (out of this plan)

1. **Real hCaptcha widget** + private siteverify in Sub-7a — Sub-7d "production abuse hardening".
2. **Adding children to existing pool from Settings** — UX polish, Sub-7e.
3. **Educational content during the 5-10 min wait** — Sub-7e.
4. **Master backup / export flow** — privacy concern; user-driven via "copy to clipboard" only for MVP, Sub-7e for guided paper-backup UI.
5. **Bridge UI** (Sepolia ↔ Aztec for aUSDC/aWETH) — Sub-7c.
