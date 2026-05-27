# Sub-7a Quetzal Faucet Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up a Next.js 14 API-only faucet service on VPS `194.163.136.1` (exposed at `https://faucet.quetzaldex.xyz/`) that drips L2 fee-juice + tUSDC + tETH per request, gated by hCaptcha + per-IP 8h cooldown.

**Architecture:** Single Node process behind nginx + Docker. POST `/api/drip` runs the pipeline: address validate → captcha verify → rate-limit check → L1 `bridgeTokensPublic()` for fee-juice → L2 `Token.mint_to_public()` for tUSDC + tETH → return claim data + mint tx hashes. SQLite-backed rate-limit state survives restarts.

**Tech Stack:** Next.js 14, TypeScript 5.6 strict, `@aztec/aztec.js@4.2.1`, `@aztec/wallets@4.2.1`, `@aztec/stdlib@4.2.1`, `viem@2.x`, `better-sqlite3@11.x`, `zod@3.x`, `prom-client@15.x`, Vitest, hCaptcha siteverify. Reference (don't literally fork): https://github.com/NethermindEth/aztec-faucet (MIT).

**Subagent model policy:** Sonnet and Opus only — NEVER Haiku.

**Branch policy:** All commits land on `main` directly (no feature branch).

**Phase boundaries:** Tag `sub7a-phase{A,B,C,D,E}-done` after each phase completes.

---

## Reference material (the implementer should skim once before starting)

- `docs/superpowers/specs/2026-05-27-quetzal-subproject-07a-custom-faucet-design.md` — design spec; this plan implements it.
- `scripts/lib/aztec-wallet-bootstrap.ts` — source-of-truth `WalletBootstrapState.claimData` shape (drip response must match field-for-field).
- `scripts/testnet-m1-hello.ts` — minimal L1 bridge + L2 deploy example.
- `scripts/deploy-bridge.ts` — viem + nonce-drift retry pattern.
- `quetzal.config.json` — tUSDC + tETH + admin addresses to use.
- `aggregator/ops/RUNBOOK-sub5c.md` — operator playbook style template (if exists, mirror it).
- https://github.com/NethermindEth/aztec-faucet — reference impl; copy attribution license, write from scratch.

---

## Phase A: Workspace skeleton + dependencies

### Task 1: Create `faucet/` workspace + package.json + tsconfig

**Files:**
- Create: `faucet/package.json`
- Create: `faucet/tsconfig.json`
- Create: `faucet/next.config.mjs`
- Modify: `pnpm-workspace.yaml`
- Modify: `.gitignore`

- [ ] **Step 1: Create `faucet/package.json`**

```json
{
  "name": "@quetzal/faucet",
  "version": "0.1.0",
  "private": true,
  "license": "MIT",
  "scripts": {
    "dev": "next dev -p 3030",
    "build": "next build",
    "start": "next start -p 3030",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@aztec/aztec.js": "4.2.1",
    "@aztec/wallets": "4.2.1",
    "@aztec/stdlib": "4.2.1",
    "better-sqlite3": "^11.5.0",
    "next": "14.2.0",
    "prom-client": "^15.1.3",
    "react": "18.3.1",
    "react-dom": "18.3.1",
    "viem": "^2.21.0",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.11",
    "@types/node": "^22.7.0",
    "@types/react": "^18.3.0",
    "tsx": "^4.21.0",
    "typescript": "5.6.2",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: Create `faucet/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "resolveJsonModule": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "jsx": "preserve",
    "incremental": true,
    "isolatedModules": true,
    "allowJs": false,
    "noEmit": true,
    "baseUrl": ".",
    "paths": { "@/*": ["src/*"] }
  },
  "include": ["src/**/*.ts", "src/**/*.tsx", "tests/**/*.ts"],
  "exclude": ["node_modules", ".next"]
}
```

- [ ] **Step 3: Create `faucet/next.config.mjs`**

```js
/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  experimental: { instrumentationHook: true },
  reactStrictMode: false,
};

export default nextConfig;
```

- [ ] **Step 4: Add `faucet` to `pnpm-workspace.yaml`**

Open `pnpm-workspace.yaml` and add `faucet` to the packages list. Final content:

```yaml
packages:
  - 'tests/**'
  - 'aggregator'
  - 'cli'
  - 'sdk'
  - 'examples'
  - 'frontend'
  - 'faucet'
  - 'tools/outbox-proof'
  - 'tools/exporters'
```

- [ ] **Step 5: Add ignores for faucet artifacts to `.gitignore`**

Append at the bottom of `.gitignore`:

```
# Sub-7a faucet
faucet/.next/
faucet/.env.faucet
faucet/data/
faucet/tsconfig.tsbuildinfo
```

- [ ] **Step 6: Install + verify**

Run: `pnpm install`
Expected: `+ @quetzal/faucet 0.1.0 <- faucet` in summary; no errors.

Run: `pnpm -F @quetzal/faucet typecheck`
Expected: `error TS18003: No inputs were found ...` (we haven't created `src/` yet — acceptable; Task 2 fixes it).

- [ ] **Step 7: Commit**

```bash
git add faucet/package.json faucet/tsconfig.json faucet/next.config.mjs pnpm-workspace.yaml .gitignore pnpm-lock.yaml
git commit -m "feat(faucet): scaffold @quetzal/faucet Next.js 14 workspace"
```

---

### Task 2: Add Vitest + create types module

**Files:**
- Create: `faucet/vitest.config.ts`
- Create: `faucet/src/lib/types.ts`
- Create: `faucet/tests/types.test.ts`

- [ ] **Step 1: Create `faucet/vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 10_000,
  },
  resolve: {
    alias: { "@": resolve(__dirname, "src") },
  },
});
```

- [ ] **Step 2: Write the failing test `faucet/tests/types.test.ts`**

```ts
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
```

- [ ] **Step 3: Run test (expected to FAIL)**

Run: `pnpm -F @quetzal/faucet test`
Expected: `Cannot find module '@/lib/types'` — module doesn't exist yet.

- [ ] **Step 4: Create `faucet/src/lib/types.ts`**

```ts
import { z } from "zod";

const HexAddress = z.string().regex(/^0x[0-9a-fA-F]{64}$/, "must be 0x-prefixed hex32");

export const DripRequestSchema = z.object({
  address: HexAddress,
  captchaToken: z.string().min(1).max(2048),
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
```

- [ ] **Step 5: Run tests (expected to PASS)**

Run: `pnpm -F @quetzal/faucet test`
Expected: `Tests  4 passed (4)`.

- [ ] **Step 6: Commit**

```bash
git add faucet/vitest.config.ts faucet/src/lib/types.ts faucet/tests/types.test.ts
git commit -m "feat(faucet): types module + zod schemas for drip request/response"
```

---

### Task 3: Create `.env.faucet.example`

**Files:**
- Create: `faucet/.env.faucet.example`

- [ ] **Step 1: Create the file with all knobs from the spec**

```
# Quetzal Faucet — environment template
# Copy to .env.faucet (gitignored) and fill in secrets before running.

# Server
FAUCET_PORT=3030
FAUCET_NODE_ENV=production

# L1 — Sepolia (Aztec testnet's L1)
FAUCET_L1_RPC_URL=https://sepolia.drpc.org
FAUCET_L1_PK=
# Look up the Aztec testnet FeeJuicePortal address with the JSON-RPC call:
#   curl -s -X POST $FAUCET_L2_NODE_URL -H 'Content-Type: application/json' \
#     -d '{"jsonrpc":"2.0","id":1,"method":"node_getNodeInfo","params":[]}' \
#     | jq -r '.result.l1ContractAddresses.feeJuicePortalAddress'
FAUCET_L1_FEE_JUICE_PORTAL=

# L2 — Aztec testnet
FAUCET_L2_NODE_URL=https://rpc.testnet.aztec-labs.com
FAUCET_L2_SECRET=
FAUCET_L2_TUSDC=0x09075988b52dec9c83c7da73ca3f746c14431a7974ccd8fb899e6476ef6b6b22
FAUCET_L2_TETH=0x1c839479228a2cf9304a61ea4d0b3b2d3c319f3e72c8f4d87c3ade3a5809a198

# Per-drip amounts (atomic)
FAUCET_FEE_JUICE_AMOUNT=100000000000000000000
FAUCET_TUSDC_AMOUNT=1000000000
FAUCET_TETH_AMOUNT=500000000000000000

# Abuse
HCAPTCHA_SECRET_KEY=
FAUCET_HCAPTCHA_BYPASS_KEY=
FAUCET_GLOBAL_DAILY_CAP=500
FAUCET_PER_IP_COOLDOWN_SECONDS=28800

# CORS — comma-separated; supports plain origins + /regex/ entries
FAUCET_ALLOWED_ORIGINS=https://quetzaldex.xyz,https://www.quetzaldex.xyz,https://aztec-project.vercel.app,/^https:\/\/.*-kubudak90s-projects\.vercel\.app$/

# Drain threshold — service returns 503 when balance < 10 * per-drip amount
FAUCET_DRAIN_THRESHOLD_MULTIPLIER=10

# Storage
FAUCET_SQLITE_PATH=./data/faucet.sqlite
FAUCET_AUDIT_LOG_PATH=./data/faucet.log
```

- [ ] **Step 2: Commit**

```bash
git add faucet/.env.faucet.example
git commit -m "feat(faucet): .env.faucet.example template (quetzaldex.xyz CORS)"
```

---

## Phase A end: `git tag sub7a-phaseA-done`

```bash
git tag sub7a-phaseA-done
git push --tags
```

---

## Phase B: Library modules (TDD per file)

### Task 4: `src/lib/config.ts` — env loader + validator

**Files:**
- Create: `faucet/src/lib/config.ts`
- Create: `faucet/tests/config.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { loadConfig, ConfigError } from "@/lib/config";

const MINIMAL_ENV: Record<string, string> = {
  FAUCET_PORT: "3030",
  FAUCET_NODE_ENV: "test",
  FAUCET_L1_RPC_URL: "https://sepolia.example",
  FAUCET_L1_PK: "0x" + "11".repeat(32),
  FAUCET_L1_FEE_JUICE_PORTAL: "0x" + "22".repeat(20),
  FAUCET_L2_NODE_URL: "https://node.example",
  FAUCET_L2_SECRET: "0x" + "33".repeat(32),
  FAUCET_L2_TUSDC: "0x" + "44".repeat(32),
  FAUCET_L2_TETH: "0x" + "55".repeat(32),
  FAUCET_FEE_JUICE_AMOUNT: "100000000000000000000",
  FAUCET_TUSDC_AMOUNT: "1000000000",
  FAUCET_TETH_AMOUNT: "500000000000000000",
  HCAPTCHA_SECRET_KEY: "test-secret",
  FAUCET_HCAPTCHA_BYPASS_KEY: "BYPASS",
  FAUCET_GLOBAL_DAILY_CAP: "500",
  FAUCET_PER_IP_COOLDOWN_SECONDS: "28800",
  FAUCET_ALLOWED_ORIGINS: "https://quetzaldex.xyz",
  FAUCET_DRAIN_THRESHOLD_MULTIPLIER: "10",
  FAUCET_SQLITE_PATH: ":memory:",
  FAUCET_AUDIT_LOG_PATH: "/dev/null",
};

const savedEnv = { ...process.env };

beforeEach(() => {
  for (const k of Object.keys(MINIMAL_ENV)) delete process.env[k];
});
afterEach(() => {
  process.env = { ...savedEnv };
});

describe("loadConfig", () => {
  test("returns a typed config from a valid env", () => {
    Object.assign(process.env, MINIMAL_ENV);
    const cfg = loadConfig();
    expect(cfg.port).toBe(3030);
    expect(cfg.feeJuiceAmount).toBe(100000000000000000000n);
    expect(cfg.tUSDCAmount).toBe(1_000_000_000n);
    expect(cfg.allowedOrigins.length).toBe(1);
    expect(cfg.drainThresholdMultiplier).toBe(10);
  });

  test("throws ConfigError when a required key is missing", () => {
    Object.assign(process.env, { ...MINIMAL_ENV });
    delete process.env.FAUCET_L1_PK;
    expect(() => loadConfig()).toThrow(ConfigError);
  });

  test("parses comma-separated allowed origins + /regex/ entries", () => {
    Object.assign(process.env, {
      ...MINIMAL_ENV,
      FAUCET_ALLOWED_ORIGINS: "https://quetzaldex.xyz,/^https:\\/\\/.*\\.vercel\\.app$/",
    });
    const cfg = loadConfig();
    expect(cfg.allowedOrigins).toHaveLength(2);
    expect(cfg.allowedOrigins[0]).toBe("https://quetzaldex.xyz");
    expect(cfg.allowedOrigins[1]).toBeInstanceOf(RegExp);
  });
});
```

- [ ] **Step 2: Run test (expected to FAIL)**

Run: `pnpm -F @quetzal/faucet test`
Expected: `Cannot find module '@/lib/config'`.

- [ ] **Step 3: Create `faucet/src/lib/config.ts`**

```ts
export class ConfigError extends Error {
  constructor(msg: string) { super(`[config] ${msg}`); this.name = "ConfigError"; }
}

export interface FaucetConfig {
  port: number;
  nodeEnv: string;
  l1RpcUrl: string;
  l1Pk: `0x${string}`;
  l1FeeJuicePortal: `0x${string}`;
  l2NodeUrl: string;
  l2Secret: `0x${string}`;
  l2TUSDC: `0x${string}`;
  l2TETH: `0x${string}`;
  feeJuiceAmount: bigint;
  tUSDCAmount: bigint;
  tETHAmount: bigint;
  hcaptchaSecretKey: string;
  hcaptchaBypassKey: string;
  globalDailyCap: number;
  perIpCooldownSeconds: number;
  allowedOrigins: Array<string | RegExp>;
  drainThresholdMultiplier: number;
  sqlitePath: string;
  auditLogPath: string;
}

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.length === 0) throw new ConfigError(`missing required env ${name}`);
  return v;
}

function asBigint(name: string, raw: string): bigint {
  try { return BigInt(raw); } catch { throw new ConfigError(`${name} not a bigint: ${raw}`); }
}

function asNumber(name: string, raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new ConfigError(`${name} not a number: ${raw}`);
  return n;
}

function parseAllowedOrigins(raw: string): Array<string | RegExp> {
  return raw.split(",").map((s) => s.trim()).filter(Boolean).map((s) => {
    if (s.startsWith("/") && s.endsWith("/")) {
      return new RegExp(s.slice(1, -1));
    }
    return s;
  });
}

export function loadConfig(): FaucetConfig {
  return {
    port: asNumber("FAUCET_PORT", required("FAUCET_PORT")),
    nodeEnv: required("FAUCET_NODE_ENV"),
    l1RpcUrl: required("FAUCET_L1_RPC_URL"),
    l1Pk: required("FAUCET_L1_PK") as `0x${string}`,
    l1FeeJuicePortal: required("FAUCET_L1_FEE_JUICE_PORTAL") as `0x${string}`,
    l2NodeUrl: required("FAUCET_L2_NODE_URL"),
    l2Secret: required("FAUCET_L2_SECRET") as `0x${string}`,
    l2TUSDC: required("FAUCET_L2_TUSDC") as `0x${string}`,
    l2TETH: required("FAUCET_L2_TETH") as `0x${string}`,
    feeJuiceAmount: asBigint("FAUCET_FEE_JUICE_AMOUNT", required("FAUCET_FEE_JUICE_AMOUNT")),
    tUSDCAmount: asBigint("FAUCET_TUSDC_AMOUNT", required("FAUCET_TUSDC_AMOUNT")),
    tETHAmount: asBigint("FAUCET_TETH_AMOUNT", required("FAUCET_TETH_AMOUNT")),
    hcaptchaSecretKey: required("HCAPTCHA_SECRET_KEY"),
    hcaptchaBypassKey: required("FAUCET_HCAPTCHA_BYPASS_KEY"),
    globalDailyCap: asNumber("FAUCET_GLOBAL_DAILY_CAP", required("FAUCET_GLOBAL_DAILY_CAP")),
    perIpCooldownSeconds: asNumber("FAUCET_PER_IP_COOLDOWN_SECONDS", required("FAUCET_PER_IP_COOLDOWN_SECONDS")),
    allowedOrigins: parseAllowedOrigins(required("FAUCET_ALLOWED_ORIGINS")),
    drainThresholdMultiplier: asNumber("FAUCET_DRAIN_THRESHOLD_MULTIPLIER", required("FAUCET_DRAIN_THRESHOLD_MULTIPLIER")),
    sqlitePath: required("FAUCET_SQLITE_PATH"),
    auditLogPath: required("FAUCET_AUDIT_LOG_PATH"),
  };
}
```

- [ ] **Step 4: Run tests (expected to PASS)**

Run: `pnpm -F @quetzal/faucet test`
Expected: all 3 `loadConfig` tests pass; types tests still pass.

- [ ] **Step 5: Commit**

```bash
git add faucet/src/lib/config.ts faucet/tests/config.test.ts
git commit -m "feat(faucet): typed env loader + ConfigError"
```

---

### Task 5: `src/lib/address.ts` — Aztec L2 address validation

**Files:**
- Create: `faucet/src/lib/address.ts`
- Create: `faucet/tests/address.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, test, expect } from "vitest";
import { validateL2Address } from "@/lib/address";

describe("validateL2Address", () => {
  test("accepts a valid Fr field element (under bn254 modulus)", () => {
    expect(validateL2Address("0x" + "00".repeat(31) + "01")).toBe(true);
  });

  test("rejects non-hex strings", () => {
    expect(validateL2Address("0xnotahex" + "0".repeat(58))).toBe(false);
    expect(validateL2Address("nohexprefix" + "0".repeat(54))).toBe(false);
  });

  test("rejects wrong length", () => {
    expect(validateL2Address("0xab")).toBe(false);
    expect(validateL2Address("0x" + "0".repeat(63))).toBe(false);
    expect(validateL2Address("0x" + "0".repeat(65))).toBe(false);
  });

  test("rejects values >= bn254 Fr modulus", () => {
    expect(validateL2Address("0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001")).toBe(false);
    expect(validateL2Address("0x" + "f".repeat(64))).toBe(false);
  });

  test("rejects zero address", () => {
    expect(validateL2Address("0x" + "00".repeat(32))).toBe(false);
  });
});
```

- [ ] **Step 2: Run test (FAIL)**

Run: `pnpm -F @quetzal/faucet test`
Expected: `Cannot find module '@/lib/address'`.

- [ ] **Step 3: Create `faucet/src/lib/address.ts`**

```ts
const P_BN254 = BigInt("0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001");

export function validateL2Address(hex: string): boolean {
  if (typeof hex !== "string") return false;
  if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) return false;
  let asBigint: bigint;
  try { asBigint = BigInt(hex); } catch { return false; }
  if (asBigint === 0n) return false;
  if (asBigint >= P_BN254) return false;
  return true;
}
```

- [ ] **Step 4: Run tests (PASS)**

Run: `pnpm -F @quetzal/faucet test`
Expected: all address tests pass.

- [ ] **Step 5: Commit**

```bash
git add faucet/src/lib/address.ts faucet/tests/address.test.ts
git commit -m "feat(faucet): L2 address validator with bn254 modulus check"
```

---

### Task 6: `src/lib/captcha.ts` — hCaptcha siteverify + bypass-key

**Files:**
- Create: `faucet/src/lib/captcha.ts`
- Create: `faucet/tests/captcha.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { verifyCaptcha } from "@/lib/captcha";

const baseFetch = global.fetch;

beforeEach(() => { vi.restoreAllMocks(); });
afterEach(() => { global.fetch = baseFetch; });

describe("verifyCaptcha", () => {
  test("accepts the bypass key without calling hCaptcha", async () => {
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;
    const ok = await verifyCaptcha({
      token: "BYPASS-XYZ",
      secretKey: "real-secret",
      bypassKey: "BYPASS-XYZ",
    });
    expect(ok).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("calls hCaptcha siteverify when token != bypass key (success)", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true }),
    }) as unknown as typeof fetch;
    const ok = await verifyCaptcha({ token: "real-token", secretKey: "secret", bypassKey: "BYPASS" });
    expect(ok).toBe(true);
  });

  test("returns false when hCaptcha rejects", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: false, "error-codes": ["invalid-input-response"] }),
    }) as unknown as typeof fetch;
    const ok = await verifyCaptcha({ token: "stale", secretKey: "secret", bypassKey: "BYPASS" });
    expect(ok).toBe(false);
  });

  test("returns false on hCaptcha HTTP error", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false }) as unknown as typeof fetch;
    const ok = await verifyCaptcha({ token: "x", secretKey: "secret", bypassKey: "BYPASS" });
    expect(ok).toBe(false);
  });

  test("returns false on network throw", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("ENOTFOUND")) as unknown as typeof fetch;
    const ok = await verifyCaptcha({ token: "x", secretKey: "secret", bypassKey: "BYPASS" });
    expect(ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run test (FAIL)**

Run: `pnpm -F @quetzal/faucet test`
Expected: `Cannot find module '@/lib/captcha'`.

- [ ] **Step 3: Create `faucet/src/lib/captcha.ts`**

```ts
const HCAPTCHA_SITEVERIFY = "https://api.hcaptcha.com/siteverify";

interface VerifyCaptchaOpts {
  token: string;
  secretKey: string;
  bypassKey: string;
}

interface SiteverifyResponse {
  success: boolean;
  "error-codes"?: string[];
}

export async function verifyCaptcha(opts: VerifyCaptchaOpts): Promise<boolean> {
  if (opts.token === opts.bypassKey) return true;
  try {
    const res = await fetch(HCAPTCHA_SITEVERIFY, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ response: opts.token, secret: opts.secretKey }).toString(),
    });
    if (!res.ok) return false;
    const body = (await res.json()) as SiteverifyResponse;
    return body.success === true;
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Run tests (PASS)**

Run: `pnpm -F @quetzal/faucet test`
Expected: all captcha tests pass.

- [ ] **Step 5: Commit**

```bash
git add faucet/src/lib/captcha.ts faucet/tests/captcha.test.ts
git commit -m "feat(faucet): hCaptcha verify + bypass-key short-circuit"
```

---

### Task 7: `src/lib/rate-limit.ts` — SQLite per-IP 8h cooldown + global cap

**Files:**
- Create: `faucet/src/lib/rate-limit.ts`
- Create: `faucet/tests/rate-limit.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, test, expect, beforeEach } from "vitest";
import { RateLimiter } from "@/lib/rate-limit";

function makeLimiter(opts?: Partial<{ cooldownSeconds: number; dailyCap: number }>) {
  return new RateLimiter({
    sqlitePath: ":memory:",
    cooldownSeconds: opts?.cooldownSeconds ?? 28_800,
    dailyCap: opts?.dailyCap ?? 500,
  });
}

let now = 1_700_000_000;
const clock = { now: () => now };

beforeEach(() => { now = 1_700_000_000; });

describe("RateLimiter", () => {
  test("first request for an IP is allowed", () => {
    const lim = makeLimiter();
    const r = lim.checkAndRecord("1.2.3.4", clock);
    expect(r.allowed).toBe(true);
    expect(r.retryAfterSeconds).toBeUndefined();
  });

  test("second request from same IP within cooldown is throttled", () => {
    const lim = makeLimiter();
    lim.checkAndRecord("1.2.3.4", clock);
    now += 100;
    const r = lim.checkAndRecord("1.2.3.4", clock);
    expect(r.allowed).toBe(false);
    expect(r.retryAfterSeconds).toBeGreaterThan(28_000);
  });

  test("request from same IP AFTER cooldown is allowed", () => {
    const lim = makeLimiter();
    lim.checkAndRecord("1.2.3.4", clock);
    now += 28_801;
    const r = lim.checkAndRecord("1.2.3.4", clock);
    expect(r.allowed).toBe(true);
  });

  test("different IPs do not share cooldown", () => {
    const lim = makeLimiter();
    lim.checkAndRecord("1.2.3.4", clock);
    const r = lim.checkAndRecord("5.6.7.8", clock);
    expect(r.allowed).toBe(true);
  });

  test("global daily cap blocks all requests at the limit", () => {
    const lim = makeLimiter({ dailyCap: 2 });
    expect(lim.checkAndRecord("1.1.1.1", clock).allowed).toBe(true);
    now += 1; expect(lim.checkAndRecord("2.2.2.2", clock).allowed).toBe(true);
    now += 1;
    const r = lim.checkAndRecord("3.3.3.3", clock);
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("global-cap");
  });

  test("stats: totalRequests24h and throttled24h", () => {
    const lim = makeLimiter();
    lim.checkAndRecord("1.1.1.1", clock);
    now += 1; lim.checkAndRecord("1.1.1.1", clock);
    now += 1; lim.checkAndRecord("2.2.2.2", clock);
    const s = lim.stats(clock);
    expect(s.totalRequests24h).toBe(3);
    expect(s.throttled24h).toBe(1);
  });

  test("evictOlderThan24h drops stale rows", () => {
    const lim = makeLimiter();
    lim.checkAndRecord("1.1.1.1", clock);
    now += 86_401;
    lim.evictStale(clock);
    const s = lim.stats(clock);
    expect(s.totalRequests24h).toBe(0);
  });
});
```

- [ ] **Step 2: Run test (FAIL)**

Run: `pnpm -F @quetzal/faucet test`
Expected: `Cannot find module '@/lib/rate-limit'`.

- [ ] **Step 3: Create `faucet/src/lib/rate-limit.ts`**

```ts
import Database from "better-sqlite3";

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds?: number;
  reason?: "per-ip" | "global-cap";
}

export interface Clock { now(): number; }

interface RateLimiterOpts {
  sqlitePath: string;
  cooldownSeconds: number;
  dailyCap: number;
}

/**
 * SQLite-backed per-IP cooldown + global daily cap.
 * Schema bootstrap uses prepare().run() per statement (safer than multi-statement
 * helpers; same end state).
 */
export class RateLimiter {
  private readonly db: Database.Database;
  private readonly cooldown: number;
  private readonly cap: number;

  constructor(opts: RateLimiterOpts) {
    this.db = new Database(opts.sqlitePath);
    this.db.pragma("journal_mode = WAL");
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
    this.cooldown = opts.cooldownSeconds;
    this.cap = opts.dailyCap;
  }

  checkAndRecord(ip: string, clock: Clock): RateLimitResult {
    const now = clock.now();
    const since = now - 86_400;
    const countRow = this.db
      .prepare("SELECT COUNT(*) AS n FROM hits WHERE ts >= ? AND allowed = 1")
      .get(since) as { n: number };
    if (countRow.n >= this.cap) {
      this.recordHit(ip, now, false);
      return { allowed: false, reason: "global-cap" };
    }
    const lastRow = this.db
      .prepare("SELECT ts FROM hits WHERE ip = ? AND allowed = 1 ORDER BY ts DESC LIMIT 1")
      .get(ip) as { ts: number } | undefined;
    if (lastRow && now - lastRow.ts < this.cooldown) {
      this.recordHit(ip, now, false);
      return {
        allowed: false,
        reason: "per-ip",
        retryAfterSeconds: this.cooldown - (now - lastRow.ts),
      };
    }
    this.recordHit(ip, now, true);
    return { allowed: true };
  }

  stats(clock: Clock): { totalRequests24h: number; throttled24h: number } {
    const since = clock.now() - 86_400;
    const total = this.db
      .prepare("SELECT COUNT(*) AS n FROM hits WHERE ts >= ?")
      .get(since) as { n: number };
    const throttled = this.db
      .prepare("SELECT COUNT(*) AS n FROM hits WHERE ts >= ? AND allowed = 0")
      .get(since) as { n: number };
    return { totalRequests24h: total.n, throttled24h: throttled.n };
  }

  evictStale(clock: Clock): void {
    this.db.prepare("DELETE FROM hits WHERE ts < ?").run(clock.now() - 86_400);
  }

  close(): void { this.db.close(); }

  private recordHit(ip: string, ts: number, allowed: boolean): void {
    this.db
      .prepare("INSERT INTO hits (ip, ts, allowed) VALUES (?, ?, ?)")
      .run(ip, ts, allowed ? 1 : 0);
  }
}
```

- [ ] **Step 4: Run tests (PASS)**

Run: `pnpm -F @quetzal/faucet test`
Expected: all 7 rate-limit tests pass.

- [ ] **Step 5: Commit**

```bash
git add faucet/src/lib/rate-limit.ts faucet/tests/rate-limit.test.ts
git commit -m "feat(faucet): SQLite per-IP cooldown + global daily cap"
```

---

### Task 8: `src/lib/cors.ts` — origin allowlist matcher

**Files:**
- Create: `faucet/src/lib/cors.ts`
- Create: `faucet/tests/cors.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, test, expect } from "vitest";
import { matchOrigin } from "@/lib/cors";

describe("matchOrigin", () => {
  test("exact-string match", () => {
    const allow: Array<string | RegExp> = ["https://quetzaldex.xyz"];
    expect(matchOrigin("https://quetzaldex.xyz", allow)).toBe(true);
    expect(matchOrigin("https://quetzaldex.xyz/", allow)).toBe(false);
    expect(matchOrigin("https://evil.example", allow)).toBe(false);
  });

  test("regex match", () => {
    const allow: Array<string | RegExp> = [/^https:\/\/.*-kubudak90s-projects\.vercel\.app$/];
    expect(matchOrigin("https://aztec-project-deadbeef-kubudak90s-projects.vercel.app", allow)).toBe(true);
    expect(matchOrigin("https://other.vercel.app", allow)).toBe(false);
  });

  test("mixed list", () => {
    const allow: Array<string | RegExp> = [
      "https://quetzaldex.xyz",
      /^https:\/\/preview-\d+\.example$/,
    ];
    expect(matchOrigin("https://quetzaldex.xyz", allow)).toBe(true);
    expect(matchOrigin("https://preview-7.example", allow)).toBe(true);
    expect(matchOrigin("https://preview-x.example", allow)).toBe(false);
  });

  test("null/empty origin rejected", () => {
    expect(matchOrigin("", ["https://x"])).toBe(false);
    expect(matchOrigin(null as unknown as string, ["https://x"])).toBe(false);
  });
});
```

- [ ] **Step 2: Run test (FAIL)**

Run: `pnpm -F @quetzal/faucet test`
Expected: `Cannot find module '@/lib/cors'`.

- [ ] **Step 3: Create `faucet/src/lib/cors.ts`**

```ts
export function matchOrigin(origin: string, allowed: Array<string | RegExp>): boolean {
  if (!origin || typeof origin !== "string") return false;
  for (const entry of allowed) {
    if (typeof entry === "string") {
      if (entry === origin) return true;
    } else {
      if (entry.test(origin)) return true;
    }
  }
  return false;
}
```

- [ ] **Step 4: Run tests (PASS)**

Run: `pnpm -F @quetzal/faucet test`
Expected: all CORS tests pass.

- [ ] **Step 5: Commit**

```bash
git add faucet/src/lib/cors.ts faucet/tests/cors.test.ts
git commit -m "feat(faucet): CORS origin allowlist matcher (strings + regex)"
```

---

### Task 9: `src/lib/audit-log.ts` — JSONL append-only logger with hashed IP

**Files:**
- Create: `faucet/src/lib/audit-log.ts`
- Create: `faucet/tests/audit-log.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, test, expect, beforeEach } from "vitest";
import { readFileSync, mkdtempSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AuditLog } from "@/lib/audit-log";

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "faucet-audit-"));
  path = join(dir, "faucet.log");
});

describe("AuditLog", () => {
  test("writes one JSONL line per record with sha256-hashed IP", () => {
    const log = new AuditLog(path);
    log.append({
      ts: 1_700_000_000,
      ip: "1.2.3.4",
      address: "0x" + "11".repeat(32),
      success: true,
      claimAmount: "100000000000000000000",
      mintTxs: { tUSDC: "0xabc", tETH: "0xdef" },
    });
    log.append({
      ts: 1_700_000_010,
      ip: "1.2.3.4",
      address: "0x" + "22".repeat(32),
      success: false,
      error: "captcha",
    });
    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    const r0 = JSON.parse(lines[0]);
    expect(r0.ipHash).toMatch(/^[0-9a-f]{64}$/);
    expect(r0.ip).toBeUndefined();
    expect(r0.success).toBe(true);
    const r1 = JSON.parse(lines[1]);
    expect(r1.ipHash).toBe(r0.ipHash);
    expect(r1.error).toBe("captcha");
  });

  test("creates parent directory if missing", () => {
    const nested = join(dir, "nested", "deep", "faucet.log");
    const log = new AuditLog(nested);
    log.append({ ts: 1, ip: "x", address: "x", success: true });
    expect(existsSync(nested)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test (FAIL)**

Run: `pnpm -F @quetzal/faucet test`
Expected: `Cannot find module '@/lib/audit-log'`.

- [ ] **Step 3: Create `faucet/src/lib/audit-log.ts`**

```ts
import { appendFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname } from "node:path";

export interface AuditRecord {
  ts: number;
  ip: string;
  address: string;
  success: boolean;
  claimAmount?: string;
  mintTxs?: { tUSDC?: string; tETH?: string };
  error?: string;
}

export class AuditLog {
  constructor(private readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
  }

  append(r: AuditRecord): void {
    const ipHash = createHash("sha256").update(r.ip).digest("hex");
    const { ip: _drop, ...rest } = r;
    void _drop;
    appendFileSync(this.path, JSON.stringify({ ...rest, ipHash }) + "\n");
  }
}
```

- [ ] **Step 4: Run tests (PASS)**

Run: `pnpm -F @quetzal/faucet test`
Expected: all audit-log tests pass.

- [ ] **Step 5: Commit**

```bash
git add faucet/src/lib/audit-log.ts faucet/tests/audit-log.test.ts
git commit -m "feat(faucet): JSONL audit log with sha256-hashed IP"
```

---

### Task 10: `src/lib/metrics.ts` — Prometheus counters + gauges

**Files:**
- Create: `faucet/src/lib/metrics.ts`
- Create: `faucet/tests/metrics.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, test, expect, beforeEach } from "vitest";
import { metrics, resetMetricsForTest } from "@/lib/metrics";

beforeEach(() => { resetMetricsForTest(); });

describe("metrics", () => {
  test("dripTotal counter increments + serializes", async () => {
    metrics.dripTotal.inc();
    metrics.dripTotal.inc();
    metrics.dripFailedTotal.inc();
    const text = await metrics.registry.metrics();
    expect(text).toMatch(/faucet_drip_total 2/);
    expect(text).toMatch(/faucet_drip_failed_total 1/);
  });

  test("gauges set + serialize", async () => {
    metrics.l1BalanceEth.set(0.5);
    metrics.l1BalanceFeeJuice.set(8400000000000000000000);
    const text = await metrics.registry.metrics();
    expect(text).toMatch(/faucet_l1_balance_eth 0.5/);
  });
});
```

- [ ] **Step 2: Run test (FAIL)**

Run: `pnpm -F @quetzal/faucet test`
Expected: `Cannot find module '@/lib/metrics'`.

- [ ] **Step 3: Create `faucet/src/lib/metrics.ts`**

```ts
import { Counter, Gauge, Registry } from "prom-client";

const registry = new Registry();

const dripTotal = new Counter({
  name: "faucet_drip_total",
  help: "Total successful drips",
  registers: [registry],
});
const dripFailedTotal = new Counter({
  name: "faucet_drip_failed_total",
  help: "Total failed drips (any cause)",
  registers: [registry],
});
const throttledTotal = new Counter({
  name: "faucet_throttled_total",
  help: "Total rate-limited drip attempts",
  registers: [registry],
});

const l1BalanceEth = new Gauge({
  name: "faucet_l1_balance_eth",
  help: "Operator Sepolia ETH balance",
  registers: [registry],
});
const l1BalanceFeeJuice = new Gauge({
  name: "faucet_l1_balance_fee_juice",
  help: "Operator L1 fee-juice balance",
  registers: [registry],
});
const l2BalanceTUSDC = new Gauge({
  name: "faucet_l2_balance_tusdc",
  help: "Operator tUSDC balance on L2",
  registers: [registry],
});
const l2BalanceTETH = new Gauge({
  name: "faucet_l2_balance_teth",
  help: "Operator tETH balance on L2",
  registers: [registry],
});

export const metrics = {
  registry,
  dripTotal,
  dripFailedTotal,
  throttledTotal,
  l1BalanceEth,
  l1BalanceFeeJuice,
  l2BalanceTUSDC,
  l2BalanceTETH,
};

export function resetMetricsForTest(): void {
  registry.resetMetrics();
}
```

- [ ] **Step 4: Run tests (PASS)**

Run: `pnpm -F @quetzal/faucet test`
Expected: all metrics tests pass.

- [ ] **Step 5: Commit**

```bash
git add faucet/src/lib/metrics.ts faucet/tests/metrics.test.ts
git commit -m "feat(faucet): Prometheus counters + balance gauges"
```

---

## Phase B end: `git tag sub7a-phaseB-done`

```bash
git tag sub7a-phaseB-done
git push --tags
```

---

## Phase C: L1/L2 actors

### Task 11: `src/lib/l1-bridge.ts` — viem WalletClient + bridgeTokensPublic

**Files:**
- Create: `faucet/src/lib/l1-bridge.ts`
- Create: `faucet/tests/l1-bridge.test.ts`

- [ ] **Step 1: Read reference**

Before writing, open the Nethermind faucet source at https://github.com/NethermindEth/aztec-faucet (search the repo for `bridgeTokensPublic`) and confirm the ABI + return values for the L1 FeeJuicePortal. The Solidity signature we target:

```solidity
function bridgeTokensPublic(
  bytes32 to,
  uint256 amount,
  bytes32 secretHash
) external returns (bytes32 messageHash, uint256 messageLeafIndex)
```

If the live contract has a different shape, override the ABI in Step 3 to match what `cast interface $FAUCET_L1_FEE_JUICE_PORTAL --rpc-url $FAUCET_L1_RPC_URL` prints.

- [ ] **Step 2: Write the failing test**

```ts
import { describe, test, expect } from "vitest";
import { generateClaimSecret, computeClaimSecretHash } from "@/lib/l1-bridge";

describe("generateClaimSecret", () => {
  test("returns a 0x-prefixed 32-byte hex string under bn254 modulus", () => {
    const secret = generateClaimSecret();
    expect(secret).toMatch(/^0x[0-9a-f]{64}$/);
    const P_BN254 = BigInt("0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001");
    expect(BigInt(secret) < P_BN254).toBe(true);
  });

  test("produces distinct secrets on repeated calls", () => {
    const a = generateClaimSecret();
    const b = generateClaimSecret();
    expect(a).not.toBe(b);
  });
});

describe("computeClaimSecretHash", () => {
  test("deterministic for the same input", () => {
    const s = "0x" + "11".repeat(32);
    expect(computeClaimSecretHash(s)).toBe(computeClaimSecretHash(s));
  });
  test("distinct for distinct inputs", () => {
    expect(computeClaimSecretHash("0x" + "11".repeat(32)))
      .not.toBe(computeClaimSecretHash("0x" + "22".repeat(32)));
  });
});
```

- [ ] **Step 3: Run test (FAIL)**

Run: `pnpm -F @quetzal/faucet test`
Expected: `Cannot find module '@/lib/l1-bridge'`.

- [ ] **Step 4: Create `faucet/src/lib/l1-bridge.ts`**

```ts
import { createWalletClient, createPublicClient, http, type Address, type WalletClient, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { Fr } from "@aztec/aztec.js/fields";
import { sha256ToField } from "@aztec/foundation/crypto";

const FEE_JUICE_PORTAL_ABI = [{
  type: "function",
  name: "bridgeTokensPublic",
  stateMutability: "nonpayable",
  inputs: [
    { name: "to", type: "bytes32" },
    { name: "amount", type: "uint256" },
    { name: "secretHash", type: "bytes32" },
  ],
  outputs: [
    { name: "messageHash", type: "bytes32" },
    { name: "messageLeafIndex", type: "uint256" },
  ],
}] as const;

export const ERC20_BALANCE_OF_ABI = [{
  type: "function",
  name: "balanceOf",
  stateMutability: "view",
  inputs: [{ name: "owner", type: "address" }],
  outputs: [{ name: "balance", type: "uint256" }],
}] as const;

export function generateClaimSecret(): `0x${string}` {
  return Fr.random().toString() as `0x${string}`;
}

export function computeClaimSecretHash(secretHex: string): `0x${string}` {
  const secretFr = Fr.fromString(secretHex);
  return sha256ToField([secretFr]).toString() as `0x${string}`;
}

export interface BridgeFeeJuiceResult {
  l1TxHash: `0x${string}`;
  messageHashHex: `0x${string}`;
  messageLeafIndex: bigint;
  claimSecretHex: `0x${string}`;
  claimSecretHashHex: `0x${string}`;
}

export class L1Bridge {
  private readonly publicClient: PublicClient;
  private readonly walletClient: WalletClient;
  private readonly portalAddress: Address;

  constructor(opts: { rpcUrl: string; privateKey: `0x${string}`; portalAddress: Address }) {
    const account = privateKeyToAccount(opts.privateKey);
    this.publicClient = createPublicClient({ chain: sepolia, transport: http(opts.rpcUrl) });
    this.walletClient = createWalletClient({ chain: sepolia, transport: http(opts.rpcUrl), account });
    this.portalAddress = opts.portalAddress;
  }

  async getEthBalance(): Promise<bigint> {
    const address = this.walletClient.account!.address;
    return this.publicClient.getBalance({ address });
  }

  async getFeeJuiceBalance(tokenAddress: Address): Promise<bigint> {
    const owner = this.walletClient.account!.address;
    return this.publicClient.readContract({
      address: tokenAddress,
      abi: ERC20_BALANCE_OF_ABI,
      functionName: "balanceOf",
      args: [owner],
    }) as Promise<bigint>;
  }

  async bridgeFeeJuice(recipient: `0x${string}`, amount: bigint): Promise<BridgeFeeJuiceResult> {
    const claimSecretHex = generateClaimSecret();
    const claimSecretHashHex = computeClaimSecretHash(claimSecretHex);

    const { request, result } = await this.publicClient.simulateContract({
      address: this.portalAddress,
      abi: FEE_JUICE_PORTAL_ABI,
      functionName: "bridgeTokensPublic",
      args: [recipient, amount, claimSecretHashHex],
      account: this.walletClient.account!,
    });
    const l1TxHash = await this.walletClient.writeContract(request);
    await this.publicClient.waitForTransactionReceipt({ hash: l1TxHash });

    const [messageHash, messageLeafIndex] = result as unknown as [`0x${string}`, bigint];

    return {
      l1TxHash,
      messageHashHex: messageHash,
      messageLeafIndex,
      claimSecretHex,
      claimSecretHashHex,
    };
  }
}
```

- [ ] **Step 5: Run tests (PASS — unit-level only; full L1 call covered in integration test)**

Run: `pnpm -F @quetzal/faucet test`
Expected: all 4 l1-bridge helper tests pass.

- [ ] **Step 6: Commit**

```bash
git add faucet/src/lib/l1-bridge.ts faucet/tests/l1-bridge.test.ts
git commit -m "feat(faucet): L1 fee-juice bridge via viem + bridgeTokensPublic ABI"
```

---

### Task 12: `src/lib/l2-mint.ts` — Aztec wallet + Token.mint_to_public for tUSDC + tETH

**Files:**
- Create: `faucet/src/lib/l2-mint.ts`
- Create: `faucet/tests/l2-mint.test.ts`

- [ ] **Step 1: Read reference**

Open `tests/integration/generated/Token.ts` to confirm the `mint_to_public(to: AztecAddressLike, amount: U128Like)` method signature on the generated TokenContract binding. This is the source of truth for the call shape used elsewhere in the repo.

Open `scripts/testnet-m1-hello.ts` lines 1-50 for the canonical `EmbeddedWallet.create` + `createSchnorrAccount` boot pattern.

- [ ] **Step 2: Write the failing test**

```ts
import { describe, test, expect } from "vitest";
import { L2_TOKEN_DECIMALS } from "@/lib/l2-mint";

describe("L2_TOKEN_DECIMALS", () => {
  test("tUSDC has 6 decimals", () => {
    expect(L2_TOKEN_DECIMALS.tUSDC).toBe(6);
  });
  test("tETH has 18 decimals", () => {
    expect(L2_TOKEN_DECIMALS.tETH).toBe(18);
  });
});
```

(End-to-end L2 mint requires a live Aztec testnet node; that lives in Task 17 integration.)

- [ ] **Step 3: Run test (FAIL)**

Run: `pnpm -F @quetzal/faucet test`
Expected: `Cannot find module '@/lib/l2-mint'`.

- [ ] **Step 4: Create `faucet/src/lib/l2-mint.ts`**

```ts
import { Fr } from "@aztec/aztec.js/fields";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { createAztecNodeClient, waitForNode } from "@aztec/aztec.js/node";
import { EmbeddedWallet } from "@aztec/wallets/embedded";
import { Contract } from "@aztec/aztec.js/contracts";
import TokenContractArtifactJson from "../../../contracts/token/target/token-Token.json" with { type: "json" };
import { loadContractArtifact, type NoirCompiledContract } from "@aztec/aztec.js/abi";

const TokenArtifact = loadContractArtifact(TokenContractArtifactJson as NoirCompiledContract);

export const L2_TOKEN_DECIMALS = { tUSDC: 6, tETH: 18 } as const;

export interface L2MintOpts {
  nodeUrl: string;
  operatorSecret: `0x${string}`;
  tokenAddress: `0x${string}`;
}

export interface MintResult { txHash: string; }

let walletPromise: Promise<EmbeddedWallet> | null = null;

async function getWallet(nodeUrl: string): Promise<EmbeddedWallet> {
  if (!walletPromise) {
    const node = createAztecNodeClient(nodeUrl);
    await waitForNode(node);
    walletPromise = EmbeddedWallet.create(node, {
      ephemeral: false,
      pxe: { proverEnabled: true },
    });
  }
  return walletPromise;
}

export async function mintToPublic(opts: L2MintOpts, to: `0x${string}`, amount: bigint): Promise<MintResult> {
  const wallet = await getWallet(opts.nodeUrl);
  const accountManager = await wallet.createSchnorrAccount(
    Fr.fromString(opts.operatorSecret),
    Fr.ZERO,
  );
  const account = await accountManager.getAccount();
  const token = await Contract.at(
    AztecAddress.fromString(opts.tokenAddress),
    TokenArtifact,
    account as unknown as import("@aztec/aztec.js/wallet").Wallet,
  );
  const sent = await token.methods
    .mint_to_public(AztecAddress.fromString(to), amount)
    .send();
  const receipt = await sent.wait();
  return { txHash: receipt.txHash.toString() };
}

export async function getOperatorL2Balance(opts: L2MintOpts): Promise<bigint> {
  const wallet = await getWallet(opts.nodeUrl);
  const accountManager = await wallet.createSchnorrAccount(
    Fr.fromString(opts.operatorSecret),
    Fr.ZERO,
  );
  const account = await accountManager.getAccount();
  const token = await Contract.at(
    AztecAddress.fromString(opts.tokenAddress),
    TokenArtifact,
    account as unknown as import("@aztec/aztec.js/wallet").Wallet,
  );
  const bal = await token.methods.balance_of_public(account.getAddress()).simulate();
  return BigInt(bal);
}
```

- [ ] **Step 5: Run tests (PASS — decimals only)**

Run: `pnpm -F @quetzal/faucet test`
Expected: 2 L2_TOKEN_DECIMALS tests pass.

- [ ] **Step 6: Commit**

```bash
git add faucet/src/lib/l2-mint.ts faucet/tests/l2-mint.test.ts
git commit -m "feat(faucet): L2 mint module (tUSDC + tETH via Token.mint_to_public)"
```

---

## Phase C end: `git tag sub7a-phaseC-done`

```bash
git tag sub7a-phaseC-done
git push --tags
```

---

## Phase D: API routes

### Task 13: `src/pages/api/drip.ts` — POST /api/drip handler + pipeline

**Files:**
- Create: `faucet/src/pages/api/drip.ts`
- Create: `faucet/src/lib/drip-pipeline.ts`
- Create: `faucet/src/lib/runtime.ts`
- Create: `faucet/tests/drip-pipeline.test.ts`

- [ ] **Step 1: Write the failing test for the pipeline**

```ts
import { describe, test, expect, vi } from "vitest";
import { runDripPipeline, type DripDeps } from "@/lib/drip-pipeline";
import { RateLimiter } from "@/lib/rate-limit";

function mkDeps(overrides: Partial<DripDeps> = {}): DripDeps {
  return {
    verifyCaptcha: vi.fn().mockResolvedValue(true),
    rateLimiter: new RateLimiter({ sqlitePath: ":memory:", cooldownSeconds: 28800, dailyCap: 500 }),
    clock: { now: () => 1_700_000_000 },
    bridgeFeeJuice: vi.fn().mockResolvedValue({
      l1TxHash: "0x" + "aa".repeat(32),
      messageHashHex: "0x" + "bb".repeat(32),
      messageLeafIndex: 42n,
      claimSecretHex: "0x" + "cc".repeat(32),
      claimSecretHashHex: "0x" + "dd".repeat(32),
    }),
    mintTUSDC: vi.fn().mockResolvedValue({ txHash: "0x" + "ee".repeat(32) }),
    mintTETH: vi.fn().mockResolvedValue({ txHash: "0x" + "ff".repeat(32) }),
    config: {
      feeJuiceAmount: 100_000_000_000_000_000_000n,
      tUSDCAmount: 1_000_000_000n,
      tETHAmount: 500_000_000_000_000_000n,
      hcaptchaSecretKey: "secret",
      hcaptchaBypassKey: "BYPASS",
      drainThresholdMultiplier: 10,
    },
    checkDrained: vi.fn().mockResolvedValue(false),
    auditLog: { append: vi.fn() },
    ...overrides,
  };
}

describe("runDripPipeline", () => {
  test("happy path returns success + composite response", async () => {
    const deps = mkDeps();
    const result = await runDripPipeline({
      address: "0x" + "11".repeat(32),
      captchaToken: "valid",
      ip: "1.1.1.2",
      deps,
    });
    expect(result.status).toBe(200);
    expect(result.body.success).toBe(true);
    if (result.body.success) {
      expect(result.body.claimData.l1TxHash).toMatch(/^0x[0-9a-f]+$/);
      expect(result.body.tUSDCMint.amount).toBe("1000000000");
      expect(result.body.tETHMint.amount).toBe("500000000000000000");
    }
  });

  test("invalid address -> 400", async () => {
    const result = await runDripPipeline({
      address: "not-hex",
      captchaToken: "valid",
      ip: "1.1.1.1",
      deps: mkDeps(),
    });
    expect(result.status).toBe(400);
    expect(result.body.success).toBe(false);
  });

  test("invalid captcha -> 400", async () => {
    const result = await runDripPipeline({
      address: "0x" + "11".repeat(32),
      captchaToken: "stale",
      ip: "1.1.1.1",
      deps: mkDeps({ verifyCaptcha: vi.fn().mockResolvedValue(false) }),
    });
    expect(result.status).toBe(400);
    if (!result.body.success) {
      expect(result.body.error).toMatch(/captcha/i);
    }
  });

  test("rate-limited -> 429 with retryAfter", async () => {
    const deps = mkDeps();
    await runDripPipeline({ address: "0x" + "11".repeat(32), captchaToken: "v", ip: "5.5.5.5", deps });
    const r2 = await runDripPipeline({ address: "0x" + "22".repeat(32), captchaToken: "v", ip: "5.5.5.5", deps });
    expect(r2.status).toBe(429);
    if (!r2.body.success) {
      expect(r2.body.retryAfterSeconds).toBeGreaterThan(0);
    }
  });

  test("drained -> 503", async () => {
    const result = await runDripPipeline({
      address: "0x" + "11".repeat(32),
      captchaToken: "v",
      ip: "1.1.1.9",
      deps: mkDeps({ checkDrained: vi.fn().mockResolvedValue(true) }),
    });
    expect(result.status).toBe(503);
    if (!result.body.success) expect(result.body.error).toMatch(/drained/i);
  });

  test("L1 bridge throw -> 503 + audit log includes error", async () => {
    const auditAppend = vi.fn();
    const result = await runDripPipeline({
      address: "0x" + "11".repeat(32),
      captchaToken: "v",
      ip: "9.9.9.9",
      deps: mkDeps({
        bridgeFeeJuice: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
        auditLog: { append: auditAppend },
      }),
    });
    expect(result.status).toBe(503);
    expect(auditAppend).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test (FAIL)**

Run: `pnpm -F @quetzal/faucet test`
Expected: `Cannot find module '@/lib/drip-pipeline'`.

- [ ] **Step 3: Create `faucet/src/lib/drip-pipeline.ts`**

```ts
import { validateL2Address } from "./address.js";
import type { RateLimiter, Clock } from "./rate-limit.js";
import type { DripResponse } from "./types.js";
import type { BridgeFeeJuiceResult } from "./l1-bridge.js";
import type { MintResult } from "./l2-mint.js";
import type { AuditLog } from "./audit-log.js";

export interface DripDeps {
  verifyCaptcha: (token: string) => Promise<boolean>;
  rateLimiter: RateLimiter;
  clock?: Clock;
  bridgeFeeJuice: (recipient: `0x${string}`, amount: bigint) => Promise<BridgeFeeJuiceResult>;
  mintTUSDC: (to: `0x${string}`, amount: bigint) => Promise<MintResult>;
  mintTETH: (to: `0x${string}`, amount: bigint) => Promise<MintResult>;
  checkDrained: () => Promise<boolean>;
  config: {
    feeJuiceAmount: bigint;
    tUSDCAmount: bigint;
    tETHAmount: bigint;
    hcaptchaSecretKey: string;
    hcaptchaBypassKey: string;
    drainThresholdMultiplier: number;
  };
  auditLog: Pick<AuditLog, "append">;
}

export interface DripPipelineInput {
  address: string;
  captchaToken: string;
  ip: string;
  deps: DripDeps;
}

export interface DripPipelineOutput {
  status: number;
  body: DripResponse;
}

export async function runDripPipeline(input: DripPipelineInput): Promise<DripPipelineOutput> {
  const { address, captchaToken, ip, deps } = input;
  const clock: Clock = deps.clock ?? { now: () => Math.floor(Date.now() / 1000) };
  const ts = clock.now();

  if (!validateL2Address(address)) {
    deps.auditLog.append({ ts, ip, address, success: false, error: "invalid-address" });
    return { status: 400, body: { success: false, error: "invalid address" } };
  }

  const ok = await deps.verifyCaptcha(captchaToken);
  if (!ok) {
    deps.auditLog.append({ ts, ip, address, success: false, error: "invalid-captcha" });
    return { status: 400, body: { success: false, error: "invalid captcha" } };
  }

  const rl = deps.rateLimiter.checkAndRecord(ip, clock);
  if (!rl.allowed) {
    deps.auditLog.append({ ts, ip, address, success: false, error: `rate-limit:${rl.reason}` });
    if (rl.reason === "global-cap") {
      return { status: 503, body: { success: false, error: "faucet drained (global cap)" } };
    }
    return { status: 429, body: { success: false, error: "rate-limited", retryAfterSeconds: rl.retryAfterSeconds } };
  }

  if (await deps.checkDrained()) {
    deps.auditLog.append({ ts, ip, address, success: false, error: "drained" });
    return { status: 503, body: { success: false, error: "faucet drained" } };
  }

  try {
    const bridged = await deps.bridgeFeeJuice(address as `0x${string}`, deps.config.feeJuiceAmount);
    const mintUSDC = await deps.mintTUSDC(address as `0x${string}`, deps.config.tUSDCAmount);
    const mintETH = await deps.mintTETH(address as `0x${string}`, deps.config.tETHAmount);

    deps.auditLog.append({
      ts,
      ip,
      address,
      success: true,
      claimAmount: deps.config.feeJuiceAmount.toString(),
      mintTxs: { tUSDC: mintUSDC.txHash, tETH: mintETH.txHash },
    });

    return {
      status: 200,
      body: {
        success: true,
        claimData: {
          claimAmount: deps.config.feeJuiceAmount.toString(),
          claimSecretHex: bridged.claimSecretHex,
          claimSecretHashHex: bridged.claimSecretHashHex,
          messageHashHex: bridged.messageHashHex,
          messageLeafIndex: bridged.messageLeafIndex.toString(),
          l1TxHash: bridged.l1TxHash,
        },
        tUSDCMint: { txHash: mintUSDC.txHash, amount: deps.config.tUSDCAmount.toString() },
        tETHMint: { txHash: mintETH.txHash, amount: deps.config.tETHAmount.toString() },
      },
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    deps.auditLog.append({ ts, ip, address, success: false, error: `pipeline:${msg.slice(0, 200)}` });
    return { status: 503, body: { success: false, error: "transient failure: " + msg.slice(0, 80) } };
  }
}
```

- [ ] **Step 4: Run tests (PASS)**

Run: `pnpm -F @quetzal/faucet test`
Expected: 6 drip-pipeline tests pass.

- [ ] **Step 5: Create `faucet/src/lib/runtime.ts` (singleton wiring)**

```ts
import { loadConfig, type FaucetConfig } from "./config.js";
import { RateLimiter } from "./rate-limit.js";
import { L1Bridge } from "./l1-bridge.js";
import { mintToPublic, getOperatorL2Balance } from "./l2-mint.js";
import { AuditLog } from "./audit-log.js";

export interface Runtime {
  config: FaucetConfig;
  rateLimiter: RateLimiter;
  l1Bridge: L1Bridge;
  mintTUSDC: (to: `0x${string}`, amount: bigint) => Promise<{ txHash: string }>;
  mintTETH: (to: `0x${string}`, amount: bigint) => Promise<{ txHash: string }>;
  checkDrained: () => Promise<boolean>;
  auditLog: AuditLog;
}

let cached: Runtime | null = null;

export function getRuntime(): Runtime {
  if (cached) return cached;
  const config = loadConfig();
  const rateLimiter = new RateLimiter({
    sqlitePath: config.sqlitePath,
    cooldownSeconds: config.perIpCooldownSeconds,
    dailyCap: config.globalDailyCap,
  });
  const l1Bridge = new L1Bridge({
    rpcUrl: config.l1RpcUrl,
    privateKey: config.l1Pk,
    portalAddress: config.l1FeeJuicePortal,
  });
  const auditLog = new AuditLog(config.auditLogPath);
  const mintTUSDC = (to: `0x${string}`, amount: bigint) =>
    mintToPublic({ nodeUrl: config.l2NodeUrl, operatorSecret: config.l2Secret, tokenAddress: config.l2TUSDC }, to, amount);
  const mintTETH = (to: `0x${string}`, amount: bigint) =>
    mintToPublic({ nodeUrl: config.l2NodeUrl, operatorSecret: config.l2Secret, tokenAddress: config.l2TETH }, to, amount);
  const checkDrained = async (): Promise<boolean> => {
    const ethBal = await l1Bridge.getEthBalance();
    if (ethBal < config.feeJuiceAmount / 100n) return true;
    const tUSDCBal = await getOperatorL2Balance({ nodeUrl: config.l2NodeUrl, operatorSecret: config.l2Secret, tokenAddress: config.l2TUSDC });
    if (tUSDCBal < config.tUSDCAmount * BigInt(config.drainThresholdMultiplier)) return true;
    const tETHBal = await getOperatorL2Balance({ nodeUrl: config.l2NodeUrl, operatorSecret: config.l2Secret, tokenAddress: config.l2TETH });
    if (tETHBal < config.tETHAmount * BigInt(config.drainThresholdMultiplier)) return true;
    return false;
  };
  cached = { config, rateLimiter, l1Bridge, mintTUSDC, mintTETH, checkDrained, auditLog };
  return cached;
}
```

- [ ] **Step 6: Create the Next.js API route at `faucet/src/pages/api/drip.ts`**

```ts
import type { NextApiRequest, NextApiResponse } from "next";
import { DripRequestSchema } from "@/lib/types";
import { matchOrigin } from "@/lib/cors";
import { getRuntime } from "@/lib/runtime";
import { metrics } from "@/lib/metrics";
import { runDripPipeline } from "@/lib/drip-pipeline";
import { verifyCaptcha } from "@/lib/captcha";

export default async function handler(req: NextApiRequest, res: NextApiResponse): Promise<void> {
  const rt = getRuntime();

  const origin = req.headers.origin ?? "";
  if (origin && !matchOrigin(origin, rt.config.allowedOrigins)) {
    res.status(403).end(); return;
  }
  if (origin) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");

  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.status(204).end(); return;
  }
  if (req.method !== "POST") {
    res.status(405).json({ success: false, error: "method not allowed" }); return;
  }

  const parsed = DripRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: "invalid body: " + parsed.error.issues.map((i) => i.message).join("; ") });
    return;
  }

  const ip = (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() ?? (req.socket.remoteAddress ?? "unknown");

  const out = await runDripPipeline({
    address: parsed.data.address,
    captchaToken: parsed.data.captchaToken,
    ip,
    deps: {
      verifyCaptcha: (t) => verifyCaptcha({ token: t, secretKey: rt.config.hcaptchaSecretKey, bypassKey: rt.config.hcaptchaBypassKey }),
      rateLimiter: rt.rateLimiter,
      bridgeFeeJuice: (to, amount) => rt.l1Bridge.bridgeFeeJuice(to, amount),
      mintTUSDC: (to, amount) => rt.mintTUSDC(to, amount),
      mintTETH: (to, amount) => rt.mintTETH(to, amount),
      checkDrained: () => rt.checkDrained(),
      config: rt.config,
      auditLog: rt.auditLog,
    },
  });

  if (out.status === 200) metrics.dripTotal.inc();
  else if (out.status === 429) metrics.throttledTotal.inc();
  else metrics.dripFailedTotal.inc();

  res.status(out.status).json(out.body);
}
```

- [ ] **Step 7: Re-run tests + typecheck**

Run: `pnpm -F @quetzal/faucet test`
Expected: all tests pass.

Run: `pnpm -F @quetzal/faucet typecheck`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add faucet/src/pages/api/drip.ts faucet/src/lib/drip-pipeline.ts faucet/src/lib/runtime.ts faucet/tests/drip-pipeline.test.ts
git commit -m "feat(faucet): POST /api/drip handler + pipeline + runtime singleton"
```

---

### Task 14: `src/pages/api/health.ts` — GET /api/health

**Files:**
- Create: `faucet/src/pages/api/health.ts`

- [ ] **Step 1: Write the handler**

```ts
import type { NextApiRequest, NextApiResponse } from "next";
import { getRuntime } from "@/lib/runtime";
import type { HealthResponse } from "@/lib/types";
import { formatEther, createPublicClient, http } from "viem";
import { sepolia } from "viem/chains";
import { getOperatorL2Balance } from "@/lib/l2-mint";
import { createAztecNodeClient } from "@aztec/aztec.js/node";
import { metrics } from "@/lib/metrics";

export default async function handler(req: NextApiRequest, res: NextApiResponse): Promise<void> {
  if (req.method !== "GET") { res.status(405).end(); return; }
  const rt = getRuntime();
  try {
    const ethBal = await rt.l1Bridge.getEthBalance();
    const pc = createPublicClient({ chain: sepolia, transport: http(rt.config.l1RpcUrl) });
    const blockNumber = await pc.getBlockNumber();
    const feeJuiceBal = await rt.l1Bridge.getFeeJuiceBalance(rt.config.l1FeeJuicePortal);

    const node = createAztecNodeClient(rt.config.l2NodeUrl);
    const nodeInfo = await node.getNodeInfo();

    const tUSDCBal = await getOperatorL2Balance({ nodeUrl: rt.config.l2NodeUrl, operatorSecret: rt.config.l2Secret, tokenAddress: rt.config.l2TUSDC });
    const tETHBal = await getOperatorL2Balance({ nodeUrl: rt.config.l2NodeUrl, operatorSecret: rt.config.l2Secret, tokenAddress: rt.config.l2TETH });

    metrics.l1BalanceEth.set(Number(formatEther(ethBal)));
    metrics.l1BalanceFeeJuice.set(Number(feeJuiceBal));
    metrics.l2BalanceTUSDC.set(Number(tUSDCBal));
    metrics.l2BalanceTETH.set(Number(tETHBal));

    const drainThreshold = BigInt(rt.config.drainThresholdMultiplier);
    const degraded =
      tUSDCBal < rt.config.tUSDCAmount * drainThreshold ||
      tETHBal < rt.config.tETHAmount * drainThreshold;

    const stats = rt.rateLimiter.stats({ now: () => Math.floor(Date.now() / 1000) });

    const body: HealthResponse = {
      status: degraded ? "degraded" : "ok",
      l1: {
        blockNumber: Number(blockNumber),
        operatorBalanceEth: formatEther(ethBal),
        operatorBalanceFeeJuice: feeJuiceBal.toString(),
      },
      l2: {
        rollupVersion: nodeInfo.rollupVersion,
        operatorBalanceTUSDC: tUSDCBal.toString(),
        operatorBalanceTETH: tETHBal.toString(),
      },
      rateLimit: stats,
    };
    res.status(200).json(body);
  } catch (e) {
    res.status(503).json({ status: "degraded", error: String(e).slice(0, 200) });
  }
}
```

- [ ] **Step 2: Verify typecheck**

Run: `pnpm -F @quetzal/faucet typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add faucet/src/pages/api/health.ts
git commit -m "feat(faucet): GET /api/health (balances + rollup version + rate-limit stats)"
```

---

### Task 15: `src/pages/api/metrics.ts` — GET /api/metrics

**Files:**
- Create: `faucet/src/pages/api/metrics.ts`

- [ ] **Step 1: Write the handler**

```ts
import type { NextApiRequest, NextApiResponse } from "next";
import { metrics } from "@/lib/metrics";

export default async function handler(req: NextApiRequest, res: NextApiResponse): Promise<void> {
  if (req.method !== "GET") { res.status(405).end(); return; }
  res.setHeader("Content-Type", metrics.registry.contentType);
  res.status(200).send(await metrics.registry.metrics());
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm -F @quetzal/faucet typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add faucet/src/pages/api/metrics.ts
git commit -m "feat(faucet): GET /api/metrics (Prometheus exposition)"
```

---

## Phase D end: `git tag sub7a-phaseD-done`

```bash
git tag sub7a-phaseD-done
git push --tags
```

---

## Phase E: Integration test, containerization, deployment

### Task 16: Integration test against testnet — POST /api/drip → valid claim

**Files:**
- Create: `faucet/tests/drip.integration.test.ts`

Opt-in via env (`RUN_INTEGRATION_TESTS=1`) because it hits real Sepolia + Aztec testnet RPCs and consumes operator funds (~0.001 ETH + 100 fee-juice + 1000 tUSDC + 0.5 tETH per run).

- [ ] **Step 1: Write the integration test**

```ts
import { describe, test, expect } from "vitest";
import { L1Bridge } from "@/lib/l1-bridge";
import { mintToPublic } from "@/lib/l2-mint";
import { loadConfig } from "@/lib/config";

const RUN = process.env.RUN_INTEGRATION_TESTS === "1";

describe.skipIf(!RUN)("faucet integration (live testnet)", () => {
  test("L1 bridgeFeeJuice + L2 mintTUSDC + mintTETH succeed end-to-end for a fresh address", async () => {
    const cfg = loadConfig();
    const recipient = ("0x" + "00".repeat(31) + "01") as `0x${string}`;

    const bridge = new L1Bridge({
      rpcUrl: cfg.l1RpcUrl, privateKey: cfg.l1Pk, portalAddress: cfg.l1FeeJuicePortal,
    });
    const bridgeRes = await bridge.bridgeFeeJuice(recipient, cfg.feeJuiceAmount);
    expect(bridgeRes.l1TxHash).toMatch(/^0x[0-9a-f]+$/);
    expect(bridgeRes.messageLeafIndex).toBeGreaterThan(0n);
    expect(bridgeRes.claimSecretHex).toMatch(/^0x[0-9a-f]{64}$/);

    const usdcRes = await mintToPublic({ nodeUrl: cfg.l2NodeUrl, operatorSecret: cfg.l2Secret, tokenAddress: cfg.l2TUSDC }, recipient, cfg.tUSDCAmount);
    expect(usdcRes.txHash).toMatch(/^0x[0-9a-f]+$/);

    const ethRes = await mintToPublic({ nodeUrl: cfg.l2NodeUrl, operatorSecret: cfg.l2Secret, tokenAddress: cfg.l2TETH }, recipient, cfg.tETHAmount);
    expect(ethRes.txHash).toMatch(/^0x[0-9a-f]+$/);
  }, 600_000);
});
```

- [ ] **Step 2: Document how to run + verify skipped by default**

Run: `pnpm -F @quetzal/faucet test`
Expected: "faucet integration (live testnet)" suite is SKIPPED (not failed).

- [ ] **Step 3: Commit**

```bash
git add faucet/tests/drip.integration.test.ts
git commit -m "test(faucet): opt-in live-testnet integration for L1 bridge + L2 mints"
```

---

### Task 17: Dockerfile + docker-compose.yml + .dockerignore

**Files:**
- Create: `faucet/Dockerfile`
- Create: `faucet/docker-compose.yml`
- Create: `faucet/.dockerignore`

- [ ] **Step 1: Create `faucet/Dockerfile`**

```dockerfile
FROM node:22-bookworm-slim AS deps

RUN corepack enable pnpm

WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY sdk/package.json ./sdk/package.json
COPY cli/package.json ./cli/package.json
COPY aggregator/package.json ./aggregator/package.json
COPY frontend/package.json ./frontend/package.json
COPY examples/package.json ./examples/package.json
COPY faucet/package.json ./faucet/package.json
COPY tools/outbox-proof/package.json ./tools/outbox-proof/package.json
COPY tools/exporters/package.json ./tools/exporters/package.json
COPY tests ./tests
RUN pnpm install --frozen-lockfile=false

FROM deps AS build
COPY contracts ./contracts
COPY faucet ./faucet
WORKDIR /repo/faucet
RUN pnpm build

FROM node:22-bookworm-slim AS runtime
RUN corepack enable pnpm
WORKDIR /repo
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/sdk ./sdk
COPY --from=build /repo/contracts ./contracts
COPY --from=build /repo/faucet ./faucet
WORKDIR /repo/faucet

RUN pnpm rebuild better-sqlite3

EXPOSE 3030
ENV NODE_ENV=production
CMD ["pnpm", "start"]
```

- [ ] **Step 2: Create `faucet/.dockerignore`**

```
node_modules
.next
data
.env.faucet
*.log
.git
```

- [ ] **Step 3: Create `faucet/docker-compose.yml`**

```yaml
services:
  faucet:
    build:
      context: ..
      dockerfile: faucet/Dockerfile
    image: quetzal-faucet:latest
    container_name: quetzal-faucet
    restart: unless-stopped
    env_file: .env.faucet
    ports:
      - "3030:3030"
    volumes:
      - ./data:/repo/faucet/data
    healthcheck:
      test: ["CMD", "wget", "-q", "-O-", "http://localhost:3030/api/health"]
      interval: 60s
      timeout: 10s
      retries: 3
```

- [ ] **Step 4: Local build smoke test (skip if docker unavailable locally)**

Run: `cd faucet && docker build -t quetzal-faucet:local -f Dockerfile ..`
Expected: build completes without error.

- [ ] **Step 5: Commit**

```bash
git add faucet/Dockerfile faucet/docker-compose.yml faucet/.dockerignore
git commit -m "feat(faucet): Docker multi-stage build + compose for VPS deploy"
```

---

### Task 18: Operator restock + ops playbook

**Files:**
- Create: `aggregator/ops/RUNBOOK-faucet.md`

- [ ] **Step 1: Write the runbook**

```markdown
# RUNBOOK — Quetzal Faucet

## Service location

- VPS: `194.163.136.1`
- Container: `quetzal-faucet` (docker-compose at `/root/quetzal-faucet/faucet/docker-compose.yml`)
- Port: 3030 (TLS via nginx — `https://faucet.quetzaldex.xyz/`)
- Logs: `docker logs quetzal-faucet` (stdout) + `/root/quetzal-faucet/faucet/data/faucet.log` (audit JSONL)
- Metrics: `curl -s https://faucet.quetzaldex.xyz/api/metrics`

## Daily health check

Run from any shell:
```
ssh root@194.163.136.1 'curl -s http://localhost:3030/api/health | jq .'
```

Look at:
- `status` — should be `"ok"`. If `"degraded"`, balances are low.
- `l1.operatorBalanceEth` — should be ≥ 0.1 ETH. Refill below 0.05.
- `l1.operatorBalanceFeeJuice` — should be ≥ 1000 (1k × 1e18). Refill below 200.
- `l2.operatorBalanceTUSDC` — should be ≥ 100,000 × 1e6 (100k tUSDC).
- `l2.operatorBalanceTETH` — should be ≥ 50 × 1e18 (50 tETH).
- `rateLimit.totalRequests24h` — sanity check for traffic.

## Refill: L1 Sepolia ETH

Get more Sepolia ETH from a faucet (e.g. https://sepoliafaucet.com/) and send to `FAUCET_L1_PK`'s address. Aim for ~0.5 ETH refill (~500 drips of headroom).

## Refill: L1 fee-juice (locked in FeeJuicePortal)

Two Foundry scripts under `contracts-l1/script/` (write them as a follow-up if missing — out of scope for this RUNBOOK):
1. `MintFeeJuice.s.sol` — operator EOA mints fee-juice tokens to the faucet's L1 EOA.
2. `SeedFaucetPortal.s.sol` — faucet's L1 EOA approves + locks tokens in the FeeJuicePortal.

## Refill: L2 tUSDC + tETH

Run a minimal Node one-shot from the VPS shell:
```
docker run --rm --env-file /root/quetzal-faucet/faucet/.env.faucet \
  -v /root/quetzal-faucet:/repo \
  quetzal-faucet:latest \
  node /repo/faucet/scripts/refill-l2.mjs tUSDC 100000000000000
```
(`scripts/refill-l2.mjs` is a small wrapper around `mintToPublic` from `src/lib/l2-mint.ts`; write as a follow-up.)

Same pattern for tETH with amount `500000000000000000000` (= 500 tETH).

## Deploying a new build

From local repo root after merge to `main`:
```
ssh root@194.163.136.1 'cd /root/quetzal-faucet && git pull && cd faucet && docker-compose up -d --build'
docker logs -f --tail 50 quetzal-faucet
```

The container will pull, rebuild, restart with zero data loss (`./data/` volume persists).

## Rotating secrets

If `FAUCET_L1_PK` or `FAUCET_L2_SECRET` leaks:

1. Generate fresh keys.
2. Drain old wallets to new ones (send Sepolia ETH + bridge fee-juice + `Token.transfer_public`).
3. Update `.env.faucet` on VPS.
4. `docker-compose restart faucet`.
5. Wipe `data/faucet.sqlite` (optional — rate-limit history is hashed-IP, no PII).

## Forcing a reset

Wipe rate-limit + audit log:
```
ssh root@194.163.136.1 'docker stop quetzal-faucet && rm -f /root/quetzal-faucet/faucet/data/faucet.sqlite /root/quetzal-faucet/faucet/data/faucet.log && docker start quetzal-faucet'
```

## Common failure modes

| Symptom | Probable cause | Fix |
|---|---|---|
| 503 "faucet drained" | One of {L1 ETH, L1 fee-juice, L2 tUSDC, L2 tETH} < 10× per-drip | Refill (see above) |
| 429 from a single user | They legitimately drank within 8h | Wait or raise `FAUCET_PER_IP_COOLDOWN_SECONDS` |
| 503 "L1 RPC unreachable" | drpc.org down or rate-limited | Swap `FAUCET_L1_RPC_URL` to backup (alchemy, infura) |
| 503 on every request | Container died or L2 node 5xx | `docker restart quetzal-faucet`; check `docker logs` |
| `/api/health` returns 503 | startup failure (env, sqlite write, network) | `docker logs quetzal-faucet --tail 100` |
```

- [ ] **Step 2: Commit**

```bash
git add aggregator/ops/RUNBOOK-faucet.md
git commit -m "docs(faucet): operator restock + recovery playbook"
```

---

### Task 19: README + repo-level docs update

**Files:**
- Create: `faucet/README.md`
- Modify: `docs/deploy.md`

- [ ] **Step 1: Write `faucet/README.md`**

```markdown
# @quetzal/faucet

API-only faucet for Quetzal testnet. Drips 100 fee-juice + 1000 tUSDC + 0.5 tETH per request, gated by hCaptcha + per-IP 8h cooldown.

Lives on VPS `194.163.136.1:3030`, exposed at `https://faucet.quetzaldex.xyz/` (TLS via nginx). Consumed by `@quetzal/frontend`'s Sub-7b onboarding wizard via CORS-restricted POST.

## Endpoints

- `POST /api/drip` — drip request; body `{ address, captchaToken }` → response shape mirrors `WalletBootstrapState.claimData` for swap-compatibility with Nethermind's faucet.
- `GET /api/health` — service health; `status: "ok" | "degraded"`.
- `GET /api/metrics` — Prometheus exposition.

See `docs/superpowers/specs/2026-05-27-quetzal-subproject-07a-custom-faucet-design.md` for the full design.

## Local development

```
cp .env.faucet.example .env.faucet
# fill in: FAUCET_L1_PK, FAUCET_L1_FEE_JUICE_PORTAL, FAUCET_L2_SECRET,
#         HCAPTCHA_SECRET_KEY, FAUCET_HCAPTCHA_BYPASS_KEY

pnpm install
pnpm -F @quetzal/faucet dev   # http://localhost:3030
```

## Tests

```
pnpm -F @quetzal/faucet test           # unit suite (fast, no network)
pnpm -F @quetzal/faucet typecheck

# opt-in live testnet (consumes operator funds):
set -a; source faucet/.env.faucet; set +a
RUN_INTEGRATION_TESTS=1 pnpm -F @quetzal/faucet test tests/drip.integration.test.ts
```

## Production deploy

See `aggregator/ops/RUNBOOK-faucet.md`.

## Acknowledgements

Architecture inspired by [NethermindEth/aztec-faucet](https://github.com/NethermindEth/aztec-faucet) (MIT). This package is a clean re-implementation tuned to Quetzal's needs (Sub-7a brief).
```

- [ ] **Step 2: Add a faucet section to `docs/deploy.md`**

Find the "Production deploys log" section in `docs/deploy.md` and prepend a new section above it:

```markdown
## Faucet service

The Sub-7a Quetzal Faucet runs on the operator VPS (`194.163.136.1:3030`, exposed at `https://faucet.quetzaldex.xyz/`), separate from the Vercel-hosted frontend.

| | |
|---|---|
| Endpoint | `POST https://faucet.quetzaldex.xyz/api/drip` |
| Source | `faucet/` (workspace package `@quetzal/faucet`) |
| Image | `quetzal-faucet:latest` (Docker, multi-stage Node 22 build) |
| Restart policy | `unless-stopped` (docker-compose) |
| Persistence | `./data/{faucet.sqlite, faucet.log}` (volume-mounted) |
| Playbook | `aggregator/ops/RUNBOOK-faucet.md` |

Deploy: `ssh root@194.163.136.1 'cd /root/quetzal-faucet && git pull && cd faucet && docker-compose up -d --build'`.
```

- [ ] **Step 3: Commit**

```bash
git add faucet/README.md docs/deploy.md
git commit -m "docs(faucet): README + deploy.md faucet section"
```

---

### Task 20: DNS + nginx + TLS for faucet.quetzaldex.xyz

**Files:**
- Create: `infra/nginx/faucet.quetzaldex.xyz.conf` (template; deployed manually)
- Modify: `docs/deploy.md`

- [ ] **Step 1: Wait for `quetzaldex.xyz` nameserver propagation (Vercel-managed)**

Check via:
```
dig +short NS quetzaldex.xyz
```
Expected: 2-4 Vercel nameservers (`ns1.vercel-dns.com` etc.).

- [ ] **Step 2: Add a Vercel DNS A record for `faucet.quetzaldex.xyz` → `194.163.136.1`**

Via the Vercel dashboard:
1. Open Dashboard → Domains → `quetzaldex.xyz` → DNS Records.
2. Add: `faucet`, type `A`, value `194.163.136.1`, TTL 60.

Verify:
```
dig +short A faucet.quetzaldex.xyz
```
Expected: `194.163.136.1`.

- [ ] **Step 3: Create the nginx server-block template at `infra/nginx/faucet.quetzaldex.xyz.conf`**

```nginx
server {
    listen 80;
    server_name faucet.quetzaldex.xyz;

    # Let's Encrypt webroot challenge
    location /.well-known/acme-challenge/ {
        root /var/www/letsencrypt;
    }

    location / {
        return 301 https://$host$request_uri;
    }
}

server {
    listen 443 ssl http2;
    server_name faucet.quetzaldex.xyz;

    ssl_certificate     /etc/letsencrypt/live/faucet.quetzaldex.xyz/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/faucet.quetzaldex.xyz/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;

    # Forward client IP so the faucet can rate-limit accurately
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Real-IP       $remote_addr;
    proxy_set_header Host            $host;

    location / {
        proxy_pass http://127.0.0.1:3030;
        proxy_http_version 1.1;
        proxy_read_timeout 600s;
    }
}
```

- [ ] **Step 4: Deploy nginx + cert (manual operator step)**

Run on VPS:
```
ssh root@194.163.136.1
# 1. Install nginx + certbot if missing
apt-get install -y nginx certbot python3-certbot-nginx
# 2. Copy server block
scp infra/nginx/faucet.quetzaldex.xyz.conf root@194.163.136.1:/etc/nginx/sites-available/
ln -sf /etc/nginx/sites-available/faucet.quetzaldex.xyz.conf /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
# 3. Issue cert
certbot --nginx -d faucet.quetzaldex.xyz --non-interactive --agree-tos -m huseyinarslan89@hotmail.com
# 4. Re-test
systemctl reload nginx
curl -I https://faucet.quetzaldex.xyz/api/health
```

Expected: HTTP/2 200 with the health JSON.

- [ ] **Step 5: Update `.env.faucet` on VPS — confirm CORS allowlist includes `https://quetzaldex.xyz`**

The `.env.faucet.example` already lists this in the default; verify the production `.env.faucet` matches.

- [ ] **Step 6: Update `docs/deploy.md` — replace bare-IP faucet URL with `https://faucet.quetzaldex.xyz/`**

- [ ] **Step 7: Commit**

```bash
git add infra/nginx/faucet.quetzaldex.xyz.conf docs/deploy.md
git commit -m "ops(faucet): nginx + TLS template for faucet.quetzaldex.xyz"
```

---

### Task 21: First production deploy to VPS + E2E sign-off

**Files:**
- Modify: `docs/deploy.md` (post-deploy log entry)

- [ ] **Step 1: Pre-deploy checklist**

Confirm the following are committed + pushed to `main`:
- [ ] `faucet/` package with all source + tests
- [ ] `faucet/Dockerfile` + `faucet/docker-compose.yml`
- [ ] `aggregator/ops/RUNBOOK-faucet.md`
- [ ] `pnpm-workspace.yaml` updated
- [ ] `.gitignore` updated
- [ ] `infra/nginx/faucet.quetzaldex.xyz.conf`

Confirm operator pre-funded the following wallets (per `RUNBOOK-faucet.md`):
- [ ] `FAUCET_L1_PK` Sepolia EOA: ≥ 0.5 Sepolia ETH
- [ ] FeeJuicePortal: ≥ 10000 fee-juice locked
- [ ] L2 admin (same as `quetzal.config.json:admin`): ≥ 1M tUSDC, ≥ 500 tETH

- [ ] **Step 2: First-time setup on VPS**

```
ssh root@194.163.136.1 'mkdir -p /root/quetzal-faucet && cd /root/quetzal-faucet && git clone https://github.com/Kubudak90/quetzal.git . && cp faucet/.env.faucet.example faucet/.env.faucet'
ssh root@194.163.136.1 'nano /root/quetzal-faucet/faucet/.env.faucet'
```

Fill in all `FAUCET_*` + `HCAPTCHA_*` secrets per `RUNBOOK-faucet.md`.

- [ ] **Step 3: Build + start**

```
ssh root@194.163.136.1 'cd /root/quetzal-faucet/faucet && docker-compose up -d --build'
ssh root@194.163.136.1 'docker logs -f --tail 30 quetzal-faucet'
```

Watch for:
- `Started PXE connected to chain 11155111 version 4127419662` (L2 connect OK)
- `Server started on port 3030` (Next.js boot)

- [ ] **Step 4: Smoke test via TLS subdomain**

```
curl -s https://faucet.quetzaldex.xyz/api/health | jq .
```

Expected: status `"ok"`; all balance fields populated; `rollupVersion` 4127419662.

```
curl -s -X POST https://faucet.quetzaldex.xyz/api/drip \
  -H 'Content-Type: application/json' \
  -H 'Origin: https://quetzaldex.xyz' \
  -d '{"address":"0x'$(printf '00%.0s' {1..31})'01","captchaToken":"'"$FAUCET_HCAPTCHA_BYPASS_KEY"'"}' \
  | jq .
```

Expected: `success: true` with `claimData` and both `tUSDCMint` + `tETHMint` tx hashes.

(Bypass key value comes from your `.env.faucet` on the VPS — `ssh root@194.163.136.1 'grep FAUCET_HCAPTCHA_BYPASS_KEY /root/quetzal-faucet/faucet/.env.faucet'`.)

- [ ] **Step 5: Full chain E2E with WalletPool bootstrap**

```
QUETZAL_POOL_MASTER_SECRET=0x$(openssl rand -hex 32) \
QUETZAL_POOL_N=1 \
pnpm tsx scripts/wallet-pool-bootstrap.ts derive
# Note the derived address.

curl -s -X POST https://faucet.quetzaldex.xyz/api/drip \
  -H 'Content-Type: application/json' \
  -d '{"address":"<address from derive>","captchaToken":"<bypass key>"}' \
  | jq -r '.claimData' | tee /tmp/claim.json

# Manually transcribe claim into testnet-pool-state-0.json, OR add a script
# helper that maps faucet response → bootstrap state.

pnpm tsx scripts/wallet-pool-bootstrap.ts deploy
```

Expected: child wallet deploys successfully against our faucet's L1 message (same code path as Nethermind's drip).

- [ ] **Step 6: Update `docs/deploy.md` post-deploy log**

Append to the "Production deploys log" section:

```markdown
- `2026-05-27` (or whatever date) — Sub-7a faucet first deploy on VPS `194.163.136.1:3030`, exposed at `https://faucet.quetzaldex.xyz/`. Image `quetzal-faucet:latest`. Operator pre-funded with 0.5 ETH + 10k fee-juice + 1M tUSDC + 500 tETH. Smoke test passed; full E2E with `wallet-pool-bootstrap.ts deploy` passed.
```

- [ ] **Step 7: Commit + tag**

```bash
git add docs/deploy.md
git commit -m "docs(deploy): log Sub-7a faucet first VPS deploy"
git tag sub7a-deployed
git push origin main --tags
```

---

## Phase E end: `git tag sub7a-phaseE-done`

```bash
git tag sub7a-phaseE-done
git push --tags
```

---

## Acceptance criteria check

After Phase E:

- [x] Faucet running at `https://faucet.quetzaldex.xyz/api/drip` (Task 21)
- [x] Curl-driven E2E: drip → claim → deploy succeeds on Aztec testnet (Task 21 Step 5)
- [x] hCaptcha enforcement live; bypass key works for CI (Task 6 + Task 13 + Task 16)
- [x] Per-IP 8h cooldown enforced; SQLite state file persists across container restarts (Task 7 + Task 17 volume)
- [x] `/api/health` returns `degraded` when balances are too low (Task 14)
- [x] Prometheus metrics scrapeable (Task 15)
- [x] Operator can refill operator wallets via documented playbook (Task 18)
- [x] quetzaldex.xyz + aztec-project.vercel.app CORS allowlist works (Task 8 + Task 13)
- [x] Sub-7b ready to consume `POST /api/drip` from browser (Task 13 — response shape matches `WalletBootstrapState.claimData`)

---

## Carry-forwards (out of this plan)

1. **L1 fee-juice mint helper** (`contracts-l1/script/MintFeeJuice.s.sol` + `SeedFaucetPortal.s.sol`) — referenced in RUNBOOK; not yet written. Cleanest as a small follow-up PR.
2. **`faucet/scripts/refill-l2.mjs`** — wrapper around `mintToPublic` for ops use; not yet written.
3. **Sub-6b anonymity runner bug** — `Cannot convert tUSDC to a BigInt`. Unrelated to faucet; tracked separately.
4. **Sub-7b onboarding wizard** — direct downstream consumer. Plan in a separate spec; will hit `POST /api/drip` against this faucet.
5. **Apex `quetzaldex.xyz` → Vercel** — point apex + `www` records at the existing Vercel project (replaces `aztec-project.vercel.app` alias). Tracked as task #359 separately.
