# Sub-project 7a: Quetzal Faucet — design

**Status:** design  
**Date:** 2026-05-27  
**Parent:** Sub-7 "Public testnet DEX" (3-part: 7a faucet, 7b in-browser onboarding, 7c bridge UI)  
**Predecessor memory:** [[project-public-onboarding-gap]]

## Goal

Stand up an open-source, operator-controlled **API-only faucet** that drips three assets per request — L2 fee-juice, tUSDC, and tETH — so a brand-new visitor of `aztec-project.vercel.app` can land, generate a wallet, get funded, deploy, and place a real order **without operator-side intervention**. Today the only path to fund a wallet is the Nethermind public faucet (per-IP 8h rate-limit) plus operator-side scripts; this blocks public testnet UX.

## Non-goals

- Standalone faucet web UI page. We're API-only; the visible UI lives in Sub-7b's onboarding wizard at `aztec-project.vercel.app`.
- Mainnet path. Faucets exist only on testnet by definition; no thought given to L1 mainnet behaviour.
- Sybil-grade abuse resistance (Discord/Twitter OAuth, hardware-attestation, etc.). hCaptcha + per-IP 8h cooldown is the explicit policy.
- Multi-tenant / customer-managed deployments.
- Real-time analytics dashboard. Logs to disk + Prometheus counters; operator can grep / pull metrics as needed.

## Architecture

```
┌──────────────────────────┐         ┌────────────────────────────────────┐
│  aztec-project.vercel.app │  POST   │  Quetzal Faucet (VPS 194.163.136.1)│
│  (Sub-7b onboarding wiz) │ ──────► │  Next.js 14 API route /api/drip    │
└──────────────────────────┘         │  ┌─────────────┐ ┌──────────────┐  │
                                     │  │ rate-limit  │ │ hCaptcha vfy │  │
                                     │  │ (per-IP 8h) │ │              │  │
                                     │  └─────────────┘ └──────────────┘  │
                                     │  ┌───────────────────────────────┐ │
                                     │  │ L1 actor (viem WalletClient)  │ │
                                     │  │   bridgeTokensPublic() on     │ │
                                     │  │   FeeJuicePortal (Sepolia)    │ │
                                     │  └───────────────────────────────┘ │
                                     │  ┌───────────────────────────────┐ │
                                     │  │ L2 actor (@aztec/aztec.js)    │ │
                                     │  │   tUSDC.mint_to_public(addr,  │ │
                                     │  │     1000_000_000)             │ │
                                     │  │   tETH.mint_to_public(addr,   │ │
                                     │  │     500_000_000_000_000_000)  │ │
                                     │  └───────────────────────────────┘ │
                                     └────────────────────────────────────┘
```

Operator runs ONE Node process behind nginx on `194.163.136.1`. Process:
- Holds a Sepolia EOA key (`FAUCET_L1_PK`) with ETH + pre-bridged fee-juice
- Holds the L2 admin key (`FAUCET_L2_SECRET`, same as `quetzal.config.json:admin`) with mint rights on tUSDC + tETH
- Exposes a single `POST /api/drip` endpoint
- Persists rate-limit state in SQLite (file-backed; survives restarts)

Fork base: [NethermindEth/aztec-faucet](https://github.com/NethermindEth/aztec-faucet) (MIT-licensed Next.js 14 + TypeScript + Aztec SDK 4.2.0-rc.1). We strip the standalone UI, swap the in-memory rate-limit for SQLite, add the L2 token-mint hooks, and rebrand. Aztec SDK pinned to **4.2.1** to match the rest of the repo.

## API contract

### `POST /api/drip`

Request body:
```json
{
  "address": "0x110dd9e81660443f5f116c025285f0d05b64d4db978c7fa8209b6ebb0c26c5f6",
  "captchaToken": "10000000-aaaa-bbbb-cccc-000000000001"
}
```

Response body (200):
```json
{
  "success": true,
  "claimData": {
    "claimAmount": "100000000000000000000",
    "claimSecretHex": "0x...",
    "claimSecretHashHex": "0x...",
    "messageHashHex": "0x...",
    "messageLeafIndex": "92847362",
    "l1TxHash": "0x..."
  },
  "tUSDCMint": {
    "txHash": "0x...",
    "amount": "1000000000"
  },
  "tETHMint": {
    "txHash": "0x...",
    "amount": "500000000000000000"
  }
}
```

Response shape (non-200):
- **400** — `{ "success": false, "error": "invalid address" | "invalid captcha" }`
- **429** — `{ "success": false, "error": "rate-limited", "retryAfterSeconds": 28800 }`
- **503** — `{ "success": false, "error": "faucet drained" | "L1 RPC unreachable" }`

The `claimData` shape mirrors `scripts/lib/aztec-wallet-bootstrap.ts:WalletBootstrapState.claimData` so existing tooling and Sub-7b's onboarding wizard can consume both this faucet and Nethermind's interchangeably.

### `GET /api/health`

Returns:
```json
{
  "status": "ok" | "degraded",
  "l1": {
    "blockNumber": 7142000,
    "operatorBalanceEth": "0.482",
    "operatorBalanceFeeJuice": "8400000000000000000000"
  },
  "l2": {
    "rollupVersion": 4127419662,
    "operatorBalanceTUSDC": "994000000000",
    "operatorBalanceTETH": "98500000000000000000"
  },
  "rateLimit": {
    "totalRequests24h": 142,
    "throttled24h": 17
  }
}
```

`status: "degraded"` when any operator balance falls below 10× the per-drip amount.

### `GET /api/metrics`

Prometheus exposition format. Counters: `faucet_drip_total`, `faucet_drip_failed_total`, `faucet_throttled_total`. Gauges: `faucet_l1_balance_eth`, `faucet_l1_balance_fee_juice`, `faucet_l2_balance_tusdc`, `faucet_l2_balance_teth`.

## Per-drip amounts (initial defaults; env-overridable)

| Asset | Atomic amount | Human | Env override |
|---|---|---|---|
| Fee juice | `100_000_000_000_000_000_000` | 100 | `FAUCET_FEE_JUICE_AMOUNT` |
| tUSDC | `1_000_000_000` (6 decimals) | 1000 | `FAUCET_TUSDC_AMOUNT` |
| tETH | `500_000_000_000_000_000` (18 decimals) | 0.5 | `FAUCET_TETH_AMOUNT` |

Rationale: a typical order is ~10 tUSDC × 0.005 tETH, so 1000 tUSDC / 0.5 tETH gives ~50-100 trade attempts before a user runs out. Fee juice (100) covers ~10 unfinalised tx slots on a single wallet (Aztec PXE cap ~20, our 18 + headroom).

## Rate-limiting

**Per-IP 8-hour cooldown.** First request from an IP is allowed; subsequent requests within 8h return 429 with `retryAfterSeconds`. State: SQLite table `(ip TEXT PRIMARY KEY, last_request_at INTEGER)`. Cleanup task evicts rows older than 24h to keep the file small.

**Per-address cooldown** is NOT enforced. Rationale: addresses are cheap to generate (one `Fr.random()`); IP-based is the only meaningful gate, and overlapping per-address limits would only hurt legitimate retries.

**Per-process global limit** of 500 drips / 24h (env: `FAUCET_GLOBAL_DAILY_CAP`). When hit, all requests return 503. Operator sees this in the health endpoint and can top up + raise the cap.

## hCaptcha

The browser (Sub-7b) renders an hCaptcha widget with site key from a public env var; on success the user gets a token which `aztec-project.vercel.app` forwards verbatim to `POST /api/drip`. The faucet validates the token via hCaptcha's `siteverify` endpoint with its secret key (server-side env `HCAPTCHA_SECRET_KEY`). Invalid → 400.

Test mode: `FAUCET_HCAPTCHA_BYPASS_KEY` (single shared secret). If `captchaToken === FAUCET_HCAPTCHA_BYPASS_KEY`, captcha verify is skipped. Used for CI + local dev; the value lives only in `.env.faucet` (gitignored) and is rotated on any leak.

## Funding requirements

Operator pre-funds before the faucet goes live:

| Resource | Where | Amount | Notes |
|---|---|---|---|
| Sepolia ETH on `FAUCET_L1_PK` | L1 EOA | ~0.5 ETH | Pays gas for `bridgeTokensPublic()` calls. ~0.001 ETH/call → ~500 drips per refill. |
| Fee juice on `FAUCET_L1_PK` | L1 FeeJuicePortal | ~10000 fee-juice | Locked in portal; 100/drip → ~100 drips per refill. (Bigger refills cheaper per-gas.) |
| tUSDC on L2 admin | L2 | ~1_000_000 (1M tUSDC) | Operator mints to self once via existing `Token.mint_to_public`; ~1000 drips capacity. |
| tETH on L2 admin | L2 | ~500 tETH | Same flow; ~1000 drips capacity. |

Restock playbook lives in `aggregator/ops/RUNBOOK-faucet.md` (created in implementation phase).

## Hosting

- **VPS:** `194.163.136.1` (shared box per CLAUDE.md global memory).
- **Container:** single Docker image `quetzal-faucet:latest` running on port `3030`.
- **Reverse proxy:** nginx with TLS via Let's Encrypt. URL: `https://faucet.<TBD-domain>/`. Until a real domain is pointed, exposed via `http://194.163.136.1:3030/` (Sub-7b consumer reads URL from build-time env var).
- **Persistence:** SQLite file in container volume `/data/faucet.sqlite`; backups are nice-to-have but not required (rate-limit state is regeneratable — worst case we lose 8h of cooldown).
- **Process supervision:** Docker restart policy `unless-stopped`. No PM2 or systemd layer needed.

CORS: `aztec-project.vercel.app` + Vercel preview pattern `*-kubudak90s-projects.vercel.app` whitelisted via `Access-Control-Allow-Origin`. All other origins return 403 on `/api/drip` (the public `/api/health` and `/api/metrics` are world-readable).

## Configuration

```
# .env.faucet (gitignored, deployed via docker-compose env_file)
FAUCET_PORT=3030
FAUCET_NODE_ENV=production

# L1
FAUCET_L1_RPC_URL=https://sepolia.drpc.org
FAUCET_L1_PK=0x<sepolia EOA secret>
FAUCET_L1_FEE_JUICE_PORTAL=0x<existing Aztec testnet FeeJuicePortal>

# L2
FAUCET_L2_NODE_URL=https://rpc.testnet.aztec-labs.com
FAUCET_L2_SECRET=0x<same as quetzal.config.json:admin>
FAUCET_L2_TUSDC=0x09075988b52dec9c83c7da73ca3f746c14431a7974ccd8fb899e6476ef6b6b22
FAUCET_L2_TETH=0x1c839479228a2cf9304a61ea4d0b3b2d3c319f3e72c8f4d87c3ade3a5809a198

# Amounts
FAUCET_FEE_JUICE_AMOUNT=100000000000000000000
FAUCET_TUSDC_AMOUNT=1000000000
FAUCET_TETH_AMOUNT=500000000000000000

# Abuse
HCAPTCHA_SECRET_KEY=0x<hCaptcha secret>
FAUCET_HCAPTCHA_BYPASS_KEY=<long-random-string-for-CI>
FAUCET_GLOBAL_DAILY_CAP=500
FAUCET_PER_IP_COOLDOWN_SECONDS=28800

# CORS
FAUCET_ALLOWED_ORIGINS=https://aztec-project.vercel.app,/^https:\/\/.*-kubudak90s-projects\.vercel\.app$/
```

## Security

- **L1 + L2 secrets** live ONLY in `.env.faucet` on the VPS. Never committed; transferred via `scp` over SSH; rotated if leak suspected.
- **No client-side trust.** All validation server-side. Captcha enforced before any L1/L2 call.
- **L1 nonce protection** — viem's `WalletClient` manages nonce; on RPC drift we retry with `cast nonce` style refresh (port what `scripts/deploy-bridge.ts` already does).
- **Drained-mode degradation** — if `operatorBalanceFeeJuice < 10 × FAUCET_FEE_JUICE_AMOUNT`, drip endpoint returns 503 with `"faucet drained"` rather than partial state. Avoids leaving users with fee juice but no tUSDC/tETH.
- **Audit log** — every drip request logged to `/data/faucet.log` (JSONL): `{ts, ip-hash, address, success, claimAmount, mintTxs, error}`. IP is sha256-hashed to keep raw IPs out of disk; operator can grep for abuse patterns without holding PII.

## Testing

- **Unit tests** (Vitest) for: address validation, hCaptcha bypass, rate-limit cooldown math, amount-env parsing.
- **Integration test** that boots the faucet with `FAUCET_L1_RPC_URL` pointing at Anvil + mocked Aztec node, asserts `POST /api/drip` returns 200 with the right `claimData` shape. CI-gateable.
- **Manual E2E** via `scripts/wallet-pool-bootstrap.ts derive` followed by `curl -X POST .../api/drip -d '{"address":"…","captchaToken":"BYPASS"}'`, then `scripts/wallet-pool-bootstrap.ts deploy`. Validates the whole faucet → claim → deploy chain end-to-end.

## Out of scope (deferred or different sub-project)

| Item | Where it lives |
|---|---|
| In-browser onboarding wizard | Sub-7b |
| Bridge UI (Sepolia → Aztec for aUSDC/aWETH/aWBTC) | Sub-7c |
| Discord/Twitter OAuth | future Sub-7d if abuse pressure forces it |
| Multi-network support (devnet etc.) | YAGNI — Quetzal targets testnet+mainnet only |
| Analytics dashboard | YAGNI — Prometheus + Grafana stack from Sub-5c reused |
| Per-address ban list | YAGNI until first incident |
| Mainnet paymaster (relayer-sponsored deploy) | Sub-7b (covered via FeeJuicePaymentMethodWithClaim alternative path) |

## Open questions resolved during brainstorm

1. **Topology** — API-only (no separate UI page) ← user choice
2. **Order** — Sequential 7a → 7b → 7c ← user choice
3. **Abuse mitigation** — hCaptcha + per-IP 8h ← user choice
4. **Amounts** — Conservative: 100 fee-juice + 1000 tUSDC + 0.5 tETH ← user choice
5. **Fork base** — Nethermind's MIT-licensed faucet (verified via WebFetch)
6. **Host** — Existing VPS `194.163.136.1`

## Acceptance criteria

- [ ] Faucet running at `http://194.163.136.1:3030/api/drip` (or TLS subdomain)
- [ ] Curl-driven E2E: drip → claim → deploy succeeds on Aztec testnet
- [ ] hCaptcha enforcement live; bypass key works for CI
- [ ] Per-IP 8h cooldown enforced; SQLite state file persists across container restarts
- [ ] `/api/health` returns `degraded` when balances are too low
- [ ] Prometheus metrics scrapeable
- [ ] Operator can refill operator wallets via documented playbook (`aggregator/ops/RUNBOOK-faucet.md`)
- [ ] aztec-project.vercel.app CORS allowlist works
- [ ] Sub-7b ready to consume `POST /api/drip` from browser
