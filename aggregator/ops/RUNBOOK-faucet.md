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
