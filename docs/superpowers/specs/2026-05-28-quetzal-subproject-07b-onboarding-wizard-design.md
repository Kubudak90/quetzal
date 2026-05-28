# Sub-project 7b: In-browser onboarding wizard — design

**Status:** design  
**Date:** 2026-05-28  
**Parent:** Sub-7 "Public testnet DEX" (7a faucet ✅, 7b onboarding wizard, 7c bridge UI)  
**Predecessors:** [[project-subproject7a-complete]], [[project-faucet-live-at-vps]]

## Goal

A new visitor of `quetzaldex.xyz` can — in one continuous flow, without an installed wallet extension — generate a master secret, derive a 3-child `WalletPool`, claim fee-juice + tUSDC + tETH from the Sub-7a faucet, deploy the children's schnorr accounts on Aztec testnet, and land in the trade screen with a working pool. The wizard handles the 2-4 min per-drip latency gracefully and persists the master to browser `localStorage` so refresh-reload keeps the session.

## Non-goals

- Bridging real Sepolia USDC / WETH into Aztec (that's Sub-7c).
- Replacing the existing Aztec Wallet (extension) onboarding path in `SetupScreen`. The wizard extends only the **WalletPool** path; the "Aztec Wallet" path stays unchanged.
- hCaptcha widget — testnet MVP uses the `FAUCET_HCAPTCHA_BYPASS_KEY` shipped via Vite env. A real hCaptcha widget + per-account OAuth deferred to Sub-7d "public-testnet abuse hardening".
- Server-side master-secret backup or recovery. The master is the user's responsibility (we surface a copy-to-clipboard + paper-print warning).
- Mainnet. The wizard targets `alpha-testnet` only.

## Architecture

```
                    ┌─────────────────────────────────────────────┐
quetzaldex.xyz      │  frontend/src/screens/landing.tsx           │
(Vite + React 18)   │    SetupScreen (existing, Sub-6c)           │
                    │    └─ Step 3: Faucet ── Sub-7b replaces ────┤
                    │                                              │
                    │       frontend/src/onboarding/               │
                    │         ├─ wizard-step3.tsx  ← UI            │
                    │         ├─ faucet-client.ts  ← POST /api/drip│
                    │         ├─ claim-deploy.ts   ← Aztec SDK     │
                    │         └─ persistence.ts    ← localStorage  │
                    └─────────────────────────────────────────────┘
                                  │
                                  │ POST /api/drip × N (parallel)
                                  ▼
                    https://faucet.quetzaldex.xyz (Sub-7a)
                                  │
                                  ▼ L1 bridge → L2 mints → return claimData
                                  │
                                  ▼ FeeJuicePaymentMethodWithClaim
                    Aztec testnet — child accounts deploy
```

The wizard runs ENTIRELY in the browser. The faucet is the only external HTTP call; everything else (master derivation, claim+deploy txs, L2 reads) happens via `@aztec/wallets/embedded` + `@aztec/aztec.js` browser bundles already polyfilled in `frontend/vite.config.ts` (Sub-6c).

## Required Sub-7a-side changes (small)

The current Sub-7a rate-limit blocks the wizard's N=3 parallel drips because per-IP cooldown allows only 1 drip per 8h. Sub-7b needs a paired Sub-7a refactor:

- `RateLimiter` per-IP semantics: from "single hit, cooldownSeconds" → "count of hits in last N seconds, threshold". New env: `FAUCET_PER_IP_MAX_DRIPS_PER_WINDOW=4`, `FAUCET_PER_IP_WINDOW_SECONDS=28800`. Default 4 per 8h covers a default-N=3 pool + 1 retry buffer.
- `bypass key` allowed origin: confirm `Origin: https://quetzaldex.xyz` is in `FAUCET_ALLOWED_ORIGINS` (already is per Task 3 spec).
- No API contract change; response shape stays the same.

These ship as one Sub-7a fix commit before Sub-7b's wizard wires up (since the wizard's parallel drips need the new rate-limit semantics to function).

## Components

### `frontend/src/onboarding/faucet-client.ts`

Single-purpose fetch wrapper. Exports one function:

```ts
export interface DripResult {
  l2Address: `0x${string}`;
  claimData: ClaimData;          // mirrors WalletBootstrapState.claimData
  tUSDCMint: { txHash: string };
  tETHMint:  { txHash: string };
}

export async function dripFaucet(opts: {
  faucetUrl: string;       // https://faucet.quetzaldex.xyz
  address:   `0x${string}`;
  bypassKey: string;       // VITE_FAUCET_BYPASS_KEY from Vite env
  signal?:   AbortSignal;  // wizard can cancel mid-flight
  timeoutMs?: number;      // default 5 min (drip can take 2-4 min server-side)
}): Promise<DripResult>;
```

Throws typed errors: `FaucetRateLimitedError`, `FaucetDrainedError`, `FaucetTimeoutError`, `FaucetNetworkError`. The wizard catches each and renders specific UI.

### `frontend/src/onboarding/claim-deploy.ts`

Uses the wallet built into the embedded SDK. Exports:

```ts
export async function claimAndDeploy(opts: {
  nodeUrl: string;
  childSecretHex:   `0x${string}`;
  childSigningKey:  `0x${string}`;  // from WalletPool's HD derivation
  claimData: ClaimData;
  signal?: AbortSignal;
  onProgress?: (phase: "claiming" | "proving" | "sending" | "waiting" | "done") => void;
}): Promise<{ deployTxHash: string; deployedAddress: `0x${string}` }>;
```

Internal flow mirrors `scripts/lib/aztec-wallet-bootstrap.ts:bootstrapAztecWallet` Step 4, but driven by the wizard not a Node script:

1. Boot `EmbeddedWallet` against `nodeUrl` (browser PXE).
2. `createSchnorrAccount(secret, Fr.ZERO, signingKey)` — deterministic from WalletPool's derivation.
3. Build `FeeJuicePaymentMethodWithClaim(address, claimData)`.
4. `accountManager.getDeployMethod().send({ fee: { paymentMethod }, from: NO_FROM })`.
5. Wait for receipt — emit `phase` callbacks for the UI.

### `frontend/src/onboarding/persistence.ts`

Thin localStorage wrapper, schema-versioned:

```ts
const KEY = "quetzal-onboarded-v1";

export interface PersistedSession {
  schemaVersion: 1;
  masterSecret:  `0x${string}`;   // user's responsibility; we warn before save
  poolSize:      number;
  network:       "alpha-testnet";
  deployedAddresses: `0x${string}`[];
  onboardedAt:   number;           // unix ms
}

export function loadSession(): PersistedSession | null;
export function saveSession(s: PersistedSession): void;
export function clearSession(): void;
```

Wizard checks `loadSession()` on mount. If non-null AND `deployedAddresses.length >= poolSize`, skip step 3 entirely and call `connectWalletPool({ masterSecret })` directly.

### `frontend/src/onboarding/wizard-step3.tsx`

Replaces the inline Step 3 block in `SetupScreen` (`landing.tsx` lines 392-460-ish). State machine:

```
idle → dripping(i) → claiming(i) → proving(i) → done(i) → idle (next child)
                          ↓
                       error(i)
                          ↓
              retry button → dripping(i)
```

Per-child rows show:
- Address (truncated, full on hover)
- Current phase ("Dripping fee-juice...", "Generating proof (~50s)...", "Deploying account...")
- Progress (indeterminate while proving, time-elapsed counter)
- Result: tx hash + "✓ Funded & deployed"

After all children done, the existing `handleConnectPool()` is called and the wizard transitions to /trade.

### `frontend/src/onboarding/derive-children.ts`

Imports `deriveChildSecret` from `@quetzal/sdk` (Sub-6c) + the SDK's `accountAddressFromSecret` helper (added if missing). Returns `Array<{ index, secret, signingKey, address }>`. Pure function, easily testable.

## Data flow (happy path, N=3)

```
0. user lands → SetupScreen → step 0 (mode) → "WalletPool" picked
1. step 1: generate / import master (existing)
2. step 2: N=3, network=alpha-testnet (existing — but n default changed from 3 to 3 stays)
3. step 3 (NEW):
   a. derive children locally → 3 addresses
   b. start 3 parallel drips (Promise.all on dripFaucet × 3)
      - each takes 2-4 min server-side
      - rate-limit per-IP allows 4/8h so all 3 fit
      - UI shows 3 progress rows simultaneously
   c. for each completed drip → claimAndDeploy in PARALLEL (browser PXE handles concurrent proofs; 1 proof at a time per child due to PXE single-threaded prover, but children can be deployed in series internally — wizard just shows them as concurrent rows)
   d. when all 3 children deployed:
      - persistence.saveSession(...)
      - call existing handleConnectPool({ masterSecret, n: 3 })
4. transition to /trade — pool is ready
```

## Error handling

| Failure | UI response |
|---|---|
| `FaucetRateLimitedError` | "You hit the per-IP rate limit. Try again in {retryAfterSeconds / 3600}h, or contact us to whitelist your IP." — block + retry button |
| `FaucetDrainedError` | "The testnet faucet is temporarily out of funds. Please come back in a few hours." — block + status link to /api/health |
| `FaucetTimeoutError` | "The faucet is slow today — the mint likely still landed. Reload and we'll re-check." — refresh button |
| `FaucetNetworkError` | "Could not reach the faucet. Check your connection and try again." — retry button |
| `claimAndDeploy` failed | "Account deploy failed — usually a slow testnet RPC. Retry?" — single-child retry, leaves other children's progress intact |
| `claimAndDeploy` ran out of retries | Surface the underlying SDK error verbatim + link to GitHub issues |
| User refreshes mid-flow | persistence.ts has nothing saved yet (only after all deploys done) → wizard restarts from step 3 with same master (since master is in component state until save). Lost progress only on the in-flight deploys; faucet drips already burned. |

## Testing

- **Unit tests** (Vitest, existing frontend test setup):
  - `derive-children.ts` — deterministic addresses for known masters
  - `faucet-client.ts` — happy path, each error class, abort signal
  - `persistence.ts` — load/save/clear, schema-version mismatch fallback
- **Component tests** (Vitest + React Testing Library):
  - `wizard-step3.tsx` — mocks `faucet-client` + `claim-deploy`, asserts state-machine transitions + error UI
- **Manual E2E** against live testnet:
  - Fresh master, N=3
  - Wizard runs end-to-end (~10 min total including proofs)
  - Land at /trade, see balances
  - Refresh tab → session persists, no re-onboard
  - Documented as a runbook step in `aggregator/ops/RUNBOOK-faucet.md` "smoke test" addition

## Configuration

Vite env vars (committed to `frontend/.env.example`, override-able per deploy):

```
VITE_FAUCET_URL=https://faucet.quetzaldex.xyz
VITE_FAUCET_BYPASS_KEY=<shipped to browser; testnet only — DOCUMENT this is public>
VITE_AZTEC_NODE_URL=https://rpc.testnet.aztec-labs.com
VITE_DEFAULT_POOL_SIZE=3
```

The bypass key in `VITE_FAUCET_BYPASS_KEY` is INTENTIONALLY shipped public for testnet. Per Sub-7d carry-forward, prod will replace this with hCaptcha. Document the trade-off explicitly in the env example.

## Out of scope (deferred)

| Item | Where it lives |
|---|---|
| Real hCaptcha widget + private siteverify | Sub-7d (production hardening) |
| Per-account OAuth (Discord/Twitter) | Sub-7d |
| Adding children to existing pool from Settings | Sub-7e or later UX polish |
| L2 → L1 bridge UI for cashing out | Sub-7c |
| Multi-network support | YAGNI — testnet-only target |
| Server-side master backup / recovery | YAGNI — privacy-maximalism: master never leaves browser |
| Apex `quetzaldex.xyz` → Vercel | Already done in task #359 |

## Acceptance criteria

- [ ] Sub-7a-side rate-limit refactor lands as paired commit
- [ ] Fresh visitor of `quetzaldex.xyz` can complete onboarding in ≤ 10 minutes end-to-end
- [ ] N=3 children all funded + deployed (or 0 — no partial-success silent failures)
- [ ] Each error path renders a specific message + actionable retry (no generic 500-pages)
- [ ] Refresh-after-onboard skips wizard, lands at /trade with restored session
- [ ] `localStorage` master persists across browser tabs in same origin; warning UI before save
- [ ] No master secret ever appears in any HTTP body sent to faucet or any other server (verified via DevTools Network panel inspection)
- [ ] Trade screen `useQuetzalClient()` returns a connected client after wizard completion
- [ ] `pnpm -F @quetzal/frontend build` succeeds; production bundle includes Aztec SDK polyfills
- [ ] Manual E2E walkthrough documented in `aggregator/ops/RUNBOOK-onboarding.md`
