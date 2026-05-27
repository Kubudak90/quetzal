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
# fill in: FAUCET_L1_PK, FAUCET_L1_FEE_JUICE_PORTAL (optional), FAUCET_L2_SECRET,
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
