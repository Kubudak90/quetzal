# RUNBOOK — Quetzal Aggregator (Sub-8.1)

## Service location

- VPS: `194.163.136.1`
- Container: `quetzal-aggregator` (docker-compose at `/root/quetzal-aggregator/aggregator/docker-compose.yml`)
- Port: 3001 host → 3000 container (Caddy reverse-proxies HTTPS at
  `https://aggregator.quetzaldex.xyz/` once DNS is wired)
- Public endpoint (current): `http://194.163.136.1:3001/health` — no TLS
  yet. DNS A record `aggregator.quetzaldex.xyz → 194.163.136.1` must be
  added via Vercel domains; Caddyfile is already configured for the
  vhost (issued on first request once DNS resolves).
- Logs: `docker logs quetzal-aggregator` (stdout, JSON-line format)
- Data: `/root/quetzal-aggregator/aggregator/data/` (snapshot JSONLs persist
  across restarts; bind-mount, safe for `tar`-style backups)
- L2 read-only wallet address (current deploy):
  `0x2cce3e9c086406a8b974abcd37ee258a6c08d88b260381b299a14ad16e070713`
  Derived from `AGGREGATOR_L2_SECRET` in `.env.aggregator`; never funded
  in the MVP (read-only via PXE simulate()).

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
| `/health` returns `watcher.status: "error"` with "public bytecode" message | Noir artifact missing or version skew (CURRENT STATE on 2026-05-28 — testnet rollup version 4127419662 needs a re-compile + transpile of `contracts/orderbook/`) | Run `pnpm compile` on a box with `nargo` installed + transpile against the matching aztec.js version. Then SCP the JSON artifacts to the VPS at `/root/quetzal-aggregator/contracts/*/target/` and `docker compose up -d --build`. Reveal server keeps working regardless. |
| `/health` returns `watcher.status: "error"` with "greater or equal to field modulus" | `AGGREGATOR_L2_SECRET` is too large for BN254 Fr | Regenerate so the first byte is `< 0x30` (safe upper bound): `openssl rand -hex 31 \| sed 's/^/00/'` |
| `/health` returns `watcher.lastError: "Failed to fetch"` | L2 RPC unreachable | Check `AZTEC_NODE_URL` resolves + testnet is up |
| `/health` returns `watcher.lastError: "Cannot find module ... tests/integration/generated/Orderbook.js"` | `QUETZAL_CONTRACTS_DIR` is unset and SDK is using cwd-relative path | Add `QUETZAL_CONTRACTS_DIR=/repo/tests/integration/generated` to `.env.aggregator` then `docker compose down && docker compose up -d` (restart doesn't re-read env-file). |
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

## Verification (Sub-8.5: soft-launch direct-reveal path)

After deploying the Sub-8.5 frontend (which wires `VITE_AGGREGATOR_URL`), you
can verify reveals are landing in the aggregator queue by:

```bash
# 1. Place an order via the UI at https://aztec-project.vercel.app/trade
#    Watch DevTools Network tab — you should see a POST to
#    http://194.163.136.1:3001/reveal returning HTTP 200.

# 2. Query the queue size from the VPS:
ssh root@194.163.136.1 'curl -s http://localhost:3001/health | jq ".queueSize"'
# Expected: increments by 1 per order placed.

# 3. Send a test reveal manually:
curl -X POST -H "Content-Type: application/json" \
  -d '{
    "epoch_id": 1,
    "order_nonce": "0xdeadbeefdeadbeef",
    "side": true,
    "amount_in": "1000000",
    "limit_price": "3000000000",
    "submitted_at_block": 42,
    "owner": "0xabcdef1234567890"
  }' \
  http://194.163.136.1:3001/reveal
# Expected: {"ok":true}
```

**Important**: The Sub-8.5 soft-launch path uses `client.aggregator.directReveal`
(not `broadcastReveal`). `directReveal` bypasses the on-chain `AggregatorRegistry`
and POSTs directly to the URL in `VITE_AGGREGATOR_URL`. This is intentional:
the aggregator is not yet bonded-registered with the `AggregatorRegistry` contract
(that's Sub-8.1.next). Once registered, the standard `broadcastReveal` flow
(registry-based discovery) will be used instead.

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

---

## Sub-9.3 — Multi-pair clearing loop wired (2026-05-29)

**Status:** OPERATIONAL on Aztec testnet. First successful aggregator-driven
`close_epoch()` tx on testnet:
`0x1a45a5ab718347c9f272c2af3a836c4d036251b62920dff6ad718d233432eaec`
(epoch 0 → 1 advance, 2026-05-29 06:37 UTC).

### What's new vs Sub-8.1 MVP

1. `aggregator/src/clearing-cycle.ts` — full multi-pair (Sub-4 shape)
   orchestrator: drain queue → validate against on-chain order_acc → read
   per-pool state (16 buckets) → computeClearingMultiPair → witness builder →
   shell out to `nargo execute` + `bb prove` → close_epoch_and_clear_verified.
2. Watcher reads L2 block-now (via `aztecNode.getBlockNumber`) instead of
   relying on the orderbook's `closes_at_block`. `wouldClear: true` now
   actually fires after the epoch window expires.
3. Background cycle runs in setImmediate so it doesn't block the next poll;
   module-level mutex prevents concurrent cycles.
4. No-cross fallback: when validated reveals exist but the clearing doesn't
   cross (e.g. pool has no liquidity), the cycle falls back to plain
   `close_epoch()` to advance the epoch rather than leave orders stuck.

### Dockerfile change

Runtime base switched from `node:22-trixie-slim` to `aztecprotocol/aztec:4.2.1`
which bakes in `nargo` + `bb` (the alternative — bespoke toolchain install —
breaks on every Aztec release). Image size: ~600MB → ~2.4GB. First VPS
rebuild took ~25 minutes (mostly the node_modules copy + image export).
Subsequent rebuilds with cached deps are ~3-5 min.

### New env vars (see .env.aggregator.example)

| var | purpose | default |
|---|---|---|
| `CLEARING_ENABLED` | gate the full close_epoch path | (off) |
| `POOL_USDC_ETH_ADDRESS` | pool 0 contract addr | none |
| `POOL_USDC_BTC_ADDRESS` | pool 1 contract addr | none |
| `POOL_ETH_BTC_ADDRESS` | pool 2 contract addr | none |
| `TBTC_ADDRESS` | tBTC L2 token addr | none |
| `AGGREGATOR_L2_SALT` | reach pre-deployed wallet (admin reuse) | `Fr.ZERO` |
| `AGGREGATOR_L2_SIGNING_KEY` | reach pre-deployed wallet | derived |
| `SNAPSHOTS_DIR` | fills snapshot output | `/repo/aggregator/data/snapshots` |
| `CIRCUIT_DIR` | nargo project dir | `/repo/circuits/clearing` |
| `NARGO_BIN` | nargo binary | `/usr/src/noir/noir-repo/target/release/nargo` |
| `BB_BIN` | bb binary | `/usr/src/barretenberg/ts/build/amd64-linux/bb` |
| `PROVE_DEADLINE_MS` | per-prove deadline | 300000 |
| `PXE_DATA_DIRECTORY` | persistent PXE store | (ephemeral) |

### Operator concern: aggregator wallet reuses admin's L2 secret

MVP shortcut. The aggregator's `AGGREGATOR_L2_SECRET` + `AGGREGATOR_L2_SALT` +
`AGGREGATOR_L2_SIGNING_KEY` is set to **admin's M1 wallet**
(`0x0524b493…92a00`). Admin pays ~10-30 FJ per clearing/close_epoch tx out
of its already-funded balance.

**Why this is OK for MVP:**
- Single-operator testnet; no separation-of-concerns risk.
- Avoids burning a faucet drip on a fresh wallet bootstrap (rate-limited).
- ~80 FJ headroom = 4-8 clearings before refuel.

**Why this is NOT OK for mainnet:**
- Operator key conflation (admin can mutate pool registry, etc.).
- Single point of failure if admin's wallet is compromised.
- Sub-9.4 (or mainnet ramp): bootstrap a dedicated aggregator wallet via
  `aggregator/ops/bootstrap-wallet.ts` + the wallet-pool faucet drip flow.

### Operator concern: pool 0 has zero liquidity after Sub-9.2 redeploy

Sub-9.2 redeployed pools but did not re-run `seed-lp.ts`. As a result, pool 0
(tUSDC/tETH) reports `reserve_a = 0, reserve_b = 0` for both u128-canonical
sides. The Sub-9.3 cycle handles this gracefully via the no-cross fallback
(calls `close_epoch()` to advance), but **no user order can actually FILL
against pool 0 until reseed**. Operator todo:

```bash
rm -f seed-lp-state-{0,1,2}.json
AZTEC_NODE_URL=https://rpc.testnet.aztec-labs.com SEED_LP_POOL=0 pnpm tsx scripts/seed-lp.ts
# Repeat for pools 1, 2 if those user orders are expected.
```

After reseed, the cycle's `computeClearingMultiPair` will cross orders and
`close_epoch_and_clear_verified` will fire (instead of plain `close_epoch()`).

### Sub-9.3 carry-forwards

1. **Reveal payload `submitted_at_block` discrepancy**: the SDK reports the
   L2 head when an order is placed, but the contract stores the *anchor block*
   (typically `head - 1` or `head - small_delta`). The reveal validation
   replays c_i against the reported block, which mismatches the contract's
   stored value. Workaround (this session): fuzz-scan a small window around
   the reported value to find the right block. **Sub-9.4 proper fix:** have
   the SDK's `placeOrder` return `result.anchorBlock` from the tx receipt
   (the same value the contract sees), so the reveal payload carries the
   correct value first time. Alternative: the aggregator reads the maker's
   OrderNote via `get_orders(owner)` and uses the on-chain stored value.
2. **`getOrders` arithmetic overflow** (carryover from Sub-9.2): the
   orderbook's `get_orders(owner)` view fn throws
   `Assertion failed: attempt to multiply with overflow 'pow * 2'` for the
   smoke user. Looks like a u32→Field overflow in the path serializer.
3. **`resolvePoolId` in `aggregator/src/path.ts` uses full bigint**: Sub-9.3
   added `buildU128PoolRegistry` + `resolvePoolIdU128` in clearing-cycle.ts
   to work around. The legacy path.ts helpers should be aligned next.
4. **bb prove path not yet exercised in production**: the cycle wires it,
   but it has not yet been triggered with a non-trivial clearing because
   pool liquidity is zero. Once pools are reseeded + a smoke user submits
   an in-the-money order, bb prove fires for real. First-prove will be
   slow (~30-120s on the VPS).
5. **Snapshot hop-fill paths not yet persisted**: `clearing-cycle.ts` writes
   the 2-field tree snapshot (compatible with `cli/src/commands/claim`)
   but does not yet emit the 4-field hop-fill tree paths needed for
   the multi-pair `claim_fill` flow. Carryforward.
6. **No Sub-3 bonded race**: the cycle does not register with
   `AggregatorRegistry`. Single-operator MVP; multi-operator races shipped
   in Sub-3 but not wired here yet.

### Verifying the close_epoch path

```bash
# 1. Confirm cycle wired
curl -s http://194.163.136.1:3001/health | jq .
# Expect: watcher.status=polling, watcher.lastEpochSeen >= 1 after first close

# 2. Tail the structured logs
sshpass -p '<vps-pw>' ssh root@194.163.136.1 'docker logs -f quetzal-aggregator --tail=20'

# 3. Re-broadcast a reveal (after the smoke); verify the cycle fires
curl -X POST -H "Content-Type: application/json" \
  -d '{ "epoch_id":<...>, "order_nonce":"<...>", "side":<...>, ... }' \
  http://194.163.136.1:3001/reveal

# Expect log progression:
#   epoch poll (wouldClear:true)
#   draining reveals
#   reveals validated
#   pool states read
#   {clearing did not cross OR clearing computed}
#   {close_epoch() OR close_epoch_and_clear_verified} submitted
```

