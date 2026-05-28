# RUNBOOK — Quetzal Aggregator (Sub-8.1)

## Service location

- VPS: `194.163.136.1`
- Container: `quetzal-aggregator` (docker-compose at `/root/quetzal-aggregator/aggregator/docker-compose.yml`)
- Port: 3001 host → 3000 container (Caddy reverse-proxies HTTPS at
  `https://aggregator.quetzaldex.xyz/` once DNS is wired)
- Logs: `docker logs quetzal-aggregator` (stdout, JSON-line format)
- Data: `/root/quetzal-aggregator/aggregator/data/` (snapshot JSONLs persist
  across restarts; bind-mount, safe for `tar`-style backups)

## What's wired (MVP scope)

This is the **reveal-server-only MVP**. The container:

1. Accepts `POST /reveal` payloads from makers, validates the schema, and
   enqueues them in-memory (deduped by `(epoch_id, order_nonce)`).
2. Reports queue size + watcher status via `GET /health`.
3. Runs a background epoch-watcher that polls `Orderbook.get_epoch()` every
   `WATCHER_INTERVAL_MS` (default 15s) and logs the current epoch + block.

**The container does NOT submit `close_epoch_and_clear_verified` clearing txs
yet.** When the epoch closes and the queue has matching reveals, the watcher
logs `wouldClear: true` and that's it. Submitting the actual clearing tx
requires:

- A funded L2 wallet (fee-juice claimed via the faucet, deployed on L2)
- `nargo` + `bb` binaries in the container (currently absent — they're ~1GB
  of Noir tooling)
- `runOneClearingCycle` wired with real `runNargoExecute` / `runBbProve` /
  `submitClearing` callbacks against the testnet orderbook

That work is **Sub-8.1.next**, see "Deferred work" below.

## What's deferred to Sub-8.1.next

| Item | Why | Effort |
|---|---|---|
| Funded aggregator L2 wallet | Needs faucet drip + claim + deploy + persisted state | 1-2h |
| `nargo` + `bb` in container | ~1GB toolchain; needs separate Docker layer | 1-2h |
| `runOneClearingCycle` wire-up | Implement real `getPool` + `submitClearing` + `runBbProve` adapters | 4-8h |
| On-chain `AggregatorRegistry` registration | Bonded registration; single-operator MVP doesn't need it | 1h |
| Frontend `VITE_AGGREGATOR_URL` env wiring | `client.aggregator.broadcastReveal` already exists; just needs URL → addr manifest | 1h |
| DNS A record `aggregator.quetzaldex.xyz` → `194.163.136.1` | Vercel domains management | 5min |

## Reverse proxy + TLS (Caddy)

Adds a Caddy site block to `/etc/caddy/Caddyfile` (already present on VPS):

```
aggregator.quetzaldex.xyz {
    encode gzip
    reverse_proxy localhost:3001
}
```

After edit: `systemctl reload caddy`. Caddy obtains the cert via HTTP-01
within ~5s once the DNS A record is in place.

For the soft launch before DNS is wired, `http://194.163.136.1:3001/health`
works directly.

## Daily health check

```bash
# Local from VPS:
ssh root@194.163.136.1 'curl -s http://localhost:3001/health | jq .'

# Public (after DNS):
curl -s https://aggregator.quetzaldex.xyz/health | jq .
```

Expected (with watcher enabled):

```json
{
  "ok": true,
  "service": "quetzal-aggregator",
  "queueSize": 0,
  "watcher": {
    "status": "polling",
    "lastEpochSeen": 42,
    "lastBlockSeen": 12345,
    "lastError": null,
    "lastPollAt": "2026-05-28T17:00:00.000Z"
  }
}
```

`watcher.status` field:

- `polling`: healthy, epoch reads succeeding
- `idle`: watcher hasn't run a poll yet (cold-start window)
- `disabled`: env missing (`AZTEC_NODE_URL` or `ORDERBOOK_ADDRESS` or
  `AGGREGATOR_L2_SECRET` not set) — reveal server still works
- `error`: bootstrap or last poll failed; see `watcher.lastError`

If `watcher.status === "error"` with `lastError` mentioning "public bytecode
has not been transpiled", the Noir artifact in `contracts/orderbook/target/`
needs to be regenerated against the testnet rollup version. Run `pnpm
compile` from the monorepo root + rebuild the image. The reveal server keeps
working through this.

## First-time deploy (one-shot)

```bash
# 1. Clone on VPS
ssh root@194.163.136.1 'mkdir -p /root/quetzal-aggregator && cd /root/quetzal-aggregator && git clone https://github.com/Kubudak90/quetzal.git .'

# 2. Fill in .env.aggregator
ssh root@194.163.136.1 'cp /root/quetzal-aggregator/aggregator/.env.aggregator.example /root/quetzal-aggregator/aggregator/.env.aggregator'
ssh root@194.163.136.1 "sed -i 's|0xREPLACE_ME_RUN_openssl_rand_hex_32|0x$(openssl rand -hex 32)|' /root/quetzal-aggregator/aggregator/.env.aggregator"

# 3. Install workspace deps + compile Noir artifacts (optional; required for epoch watcher)
ssh root@194.163.136.1 'cd /root/quetzal-aggregator && pnpm install'
# (pnpm compile is optional — only needed for the on-chain epoch poll path)

# 4. Build + start the container
ssh root@194.163.136.1 'cd /root/quetzal-aggregator/aggregator && docker compose up -d --build'
ssh root@194.163.136.1 'docker logs -f --tail 30 quetzal-aggregator'

# Wait for these log lines:
#   {"msg":"http server listening","port":3000}
#   {"msg":"epoch watcher: PXE bootstrap complete"} (only if watcher env wired)

# 5. Local smoke test
ssh root@194.163.136.1 'curl -s http://localhost:3001/health | jq .'

# 6. Add Caddy vhost
ssh root@194.163.136.1 'printf "\n# Sub-8.1 Quetzal Aggregator\naggregator.quetzaldex.xyz {\n    encode gzip\n    reverse_proxy localhost:3001\n}\n" >> /etc/caddy/Caddyfile && systemctl reload caddy'

# 7. After DNS is wired (Vercel domains → A 194.163.136.1):
curl -s https://aggregator.quetzaldex.xyz/health | jq .
```

## Deploying a new build

```bash
ssh root@194.163.136.1 'cd /root/quetzal-aggregator && git pull && cd aggregator && docker compose up -d --build'
docker logs -f --tail 50 quetzal-aggregator
```

The `./data` bind-mount survives the rebuild; in-flight queue state does NOT
(it's in-memory only — see queue.ts docstring).

## Failure modes

| Symptom | Likely cause | Fix |
|---|---|---|
| `/health` returns `watcher.status: "disabled"` | env vars missing | Check `.env.aggregator` has `AZTEC_NODE_URL` + `ORDERBOOK_ADDRESS` + `AGGREGATOR_L2_SECRET` |
| `/health` returns `watcher.status: "error"` with "public bytecode" message | Noir artifact missing or version skew | `pnpm compile` then `docker compose up -d --build` |
| `/health` returns `watcher.lastError: "Failed to fetch"` | L2 RPC unreachable | Check `AZTEC_NODE_URL` resolves + testnet is up |
| Container restart-loop | Port collision or env-file missing | `docker logs quetzal-aggregator --tail=100` to see the fatal line |
| `POST /reveal` returns 400 | Payload schema mismatch | See `RevealSchema` in `src/main.ts` — check `order_nonce` is `0x...` hex |
| Queue size drops to 0 unexpectedly | Container restarted (in-memory only) | Reveals are queue-on-broadcast; makers retry next epoch |

## Mainnet readiness checklist (NOT READY)

This MVP is testnet-only. Before mainnet:

- [ ] **Persistent reveal queue** (currently in-memory; restart loses in-flight)
- [ ] **Funded L2 wallet** with audited custody (currently zero-funded read-only)
- [ ] **Real clearing tx submission** wired (currently `wouldClear: true` log only)
- [ ] **Prometheus metrics endpoint** exposed (currently logs-only)
- [ ] **Alertmanager rules** for watcher.status going from `polling` → `error`
- [ ] **Multi-aggregator deployment** + bonded registry registration (Sub-3 race)
- [ ] **Rate-limit on `/reveal`** to prevent log-flood DoS
- [ ] **CORS allowlist** matching the production frontend origin
- [ ] **Audit log** of every accepted reveal (currently debug-log-only)
- [ ] **Snapshot retention policy** (currently unbounded JSONL accumulation in `data/`)
- [ ] **Onbox audit + Slither-equivalent** for the on-chain submission path
- [ ] **Key rotation procedure** for the L2 wallet secret

## On-call playbook (current MVP)

If `/health` is unreachable:

```bash
ssh root@194.163.136.1
docker ps -a | grep aggregator
docker logs quetzal-aggregator --tail=200
# If container is dead:
cd /root/quetzal-aggregator/aggregator && docker compose up -d
# If watcher is stuck in error:
docker compose restart aggregator
```

If reveals are accumulating but never clearing (expected in MVP):

That's the MVP state. Sub-8.1.next wires the clearing loop. In the meantime
the orderbook's on-chain `force_close_epoch` (if exposed by the contract)
lets the admin manually advance epochs without aggregator help.
