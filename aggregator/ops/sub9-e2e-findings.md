# Sub-9.1 — Public-launch readiness validation

**Date:** 2026-05-29
**Operator:** Sub-9.1 (programmatic E2E)
**Goal:** Validate that a freshly-redeployed Sub-9 testnet stack can serve a
public user end-to-end (fresh wallet → faucet drip → claim/deploy → submit
order → reveal → observe fill). Surface every concrete blocker between
current state and a public launch.

## TL;DR

**Status: DONE_WITH_CONCERNS** — Phases A + B executed, six concrete
launch-blocking bugs found and fixed at the source, one bug (P3 below)
remains because fixing it requires a fresh Orderbook redeploy. Public-launch
is **NOT ready** until P3 is addressed.

| Phase | Outcome |
|-------|---------|
| A. Seed pools 1 + 2 | DONE — both pools have liquidity |
| B. Programmatic E2E smoke | BLOCKED at step 5 (placeOrder) by P3 |
| C. Findings + commit | DONE |

---

## Phase A — Seed pools 1 and 2

`scripts/seed-lp.ts` was refactored to accept a `--pool=<id>` flag plus a
per-pool seed plan keyed on the on-chain token canonical (`token_a`,
`token_b`) ordering. Pool 0's existing `seed-lp-state.json` was migrated
to `seed-lp-state-0.json` for backwards-compat parity.

### Result summary

| pool_id | pair (registry order) | token_a (seeded) | amount_a (atomic) | bucket | l_used        | deposit txHash                                                       | bucket reserve_a | bucket liquidity |
|---------|-----------------------|------------------|-------------------|--------|---------------|----------------------------------------------------------------------|------------------|------------------|
| 0       | tUSDC/tETH            | tUSDC            | 5 000 000 000     | 8      | 38 443 359 374| (Sub-9 earlier run; state in `seed-lp-state-0.json`)                 | 5 000 000 000    | 38 443 359 374   |
| 1       | tBTC/tUSDC            | tBTC             | 10 000 000        | 8      | 76 886 718    | `0x149ce2dc728fed8d964176f5ed7172a77ae1e2eb25a75ef90a10f58de4d18078` | 10 000 000       | 76 886 718       |
| 2       | tBTC/tETH             | tBTC             | 10 000 000        | 8      | 76 886 718    | `0x0fd288a5e5d04b377519f1552c1df0dec1d2de8f24206c83a917e6283749416f` | 10 000 000       | 76 886 718       |

All three pools are in **BelowRange** regime at the fresh-pool state
(`current_sqrt_price` = `p_min_sqrt` = `1e17` atomic), so only `token_a` was
actually deposited; `token_b` was zeroed pre-submit to skip a futile
escrow + refund round-trip. Bucket 8 was used in every pool.

### Notes

- **`txHash` reads as `"undefined"` in state files.** aztec.js 4.2.1 on this
  codebase doesn't expose `.txHash` directly on the `.send()` promise; the
  actual hash is logged via the embedded-wallet's `Sent transaction 0x…`
  line, which is what's quoted in the table above. The script's on-chain
  `bucket.liquidity > 0` check at step 7 is the authoritative success signal.
  Carry-forward: refactor the seed-lp + SDK placeOrder result-shape (same
  bug). Tracked as a Sub-9.1 follow-up.
- **Pool 1 + 2 seed tokens differ from brief.** The brief asked for
  5K tUSDC in pool 1 and 2 tETH in pool 2, but canonical registry order
  places `token_a = tBTC` on both pools (since `tBTC u128` < both
  `tUSDC u128` and `tETH u128`). V3 BelowRange only deposits `token_a`,
  so pool 1's effective liquidity is 0.1 tBTC, pool 2's is 0.1 tBTC.
  This is consistent with the brief's intent (pool 0 = primary test target
  with 5K tUSDC liquidity) and the dry-run regime check in the script
  rejects any seed where `amount_a > 0` and `l_used == 0`.

---

## Phase B — Programmatic E2E smoke

Script: `scripts/sub9-e2e-smoke.ts`
State: `sub9-e2e-state.json` (per-run; gitignored)
PXE  : `sub9-e2e-pxe/` (per-run; gitignored)
Fresh user wallet:
- master   = `0x2386cf5c…99fbb` (run #1) / `0xb1cb…7060d` (run #2)
- child[0] = `0x2c12…c943`     (run #1) / `0x2aeb…6346` (run #2)

### Step-by-step outcomes

| step | action                                     | outcome  | blocker(s) discovered                                  |
|------|--------------------------------------------|----------|--------------------------------------------------------|
| 1    | Generate master + child[0]                 | OK       | —                                                      |
| 2    | POST `/api/drip`                           | OK†      | P0 (env), P1 (drain)                                   |
| 3    | Claim + deploy (`FeeJuicePaymentMethodWithClaim`) | OK | —                                              |
| 4    | Verify PXE accounts                        | OK       | —                                                      |
| 5a   | Public→private transfer of tUSDC           | OK       | P2 (UX gap: no SDK helper)                             |
| 5    | `placeOrder` (tUSDC → tETH, 1 tUSDC, limit 1e15) | FAIL | P3 — orderbook says "pool not found"                  |
| 6    | Broadcast reveal                           | NOT REACHED | (blocked by P3)                                     |
| 7    | Poll aggregator `/health`                  | NOT REACHED |                                                     |
| 8    | Poll order fill                            | NOT REACHED |                                                     |
| 9    | Pool 0 post-snapshot                       | NOT REACHED |                                                     |

† Step 2 only succeeded on attempt #2 after fixing P0 + P1. Attempt #1
returned success-shaped JSON but the mint txs landed on the **old M3 token
contracts**, leaving the new user with zero public balance on the Sub-9
tokens.

### Discovered blockers (the meat of this phase)

#### P0. Faucet env-file pointed at the OLD M3 token contracts (CRITICAL)

The faucet's `/root/quetzal-faucet/faucet/.env.faucet` on the VPS still
contained the pre-Sub-9 token addresses:
```
FAUCET_L2_TUSDC=0x09075988…ef6b6b22  # m3_legacy.tUSDC
FAUCET_L2_TETH =0x1c839479…05809a198 # m3_legacy.tETH
```
…so every drip silently minted tokens on contracts the new orderbook doesn't
know about. Sub-9 redeploy updated `quetzal.config.json` but not the
faucet's env. Also: `docker compose restart` does NOT reload `env_file` —
you must `docker compose up -d --force-recreate`.

**Fix applied (live):**
1. `sed -i` on `.env.faucet` with new addresses
   (tUSDC=`0x0525a0e5…349c`, tETH=`0x2efbaf6b…1ab5`).
2. `cd /root/quetzal-faucet/faucet && docker compose up -d --force-recreate`.
3. Verified via `docker inspect` that container env now has Sub-9 addrs.

**Carry-forward:** the Sub-9 redeploy script (or a post-redeploy hook)
should rewrite `.env.faucet` automatically and trigger
`docker compose up -d --force-recreate`. Tracked as Sub-9.2 ops scope.

#### P1. Admin had zero PUBLIC balance on the new tokens → faucet "drained" (CRITICAL)

After the env fix, `/api/health` returned `status: "degraded"` because
`getOperatorL2Balance(admin, tUSDC_new) == 0`. The faucet's
`checkDrained()` trips when
`operatorBalance < tokenAmount * drainThresholdMultiplier` (defaults: 1e9 *
10 = 1e10 tUSDC atomic; 5e17 * 10 = 5e18 tETH atomic). The Sub-9 redeploy
admin had `mint_to_private`d 5K tUSDC + 2 tETH for pool 0 seeding (private
balance), but never minted to its own PUBLIC balance.

**Fix applied:** new script `scripts/sub9-fund-faucet-operator.ts` mints
exactly the drain-floor amounts (10K tUSDC + 5 tETH) to admin's PUBLIC
balance. Idempotent. After running:
```
[fund-faucet] minted 10000000000 tUSDC public (tx 0x14b25c81…fc7e9ba)
[fund-faucet] minted 5000000000000000000 tETH public (tx 0x13141838…c709c14d7e48)
```
`/api/health` returned `status: "ok"` immediately after.

**Carry-forward:** roll this into the Sub-9 deploy script as a post-deploy
step. Tracked as Sub-9.2 ops scope.

#### P2. Faucet drips PUBLIC tokens; orderbook requires PRIVATE balance (UX)

The faucet's `mintTUSDC` / `mintTETH` paths call
`Token.mint_to_public(user, amount)`. But `orderbook.submit_order` calls
`Token.transfer_private_to_public(maker, orderbook, amount, nonce)` on the
escrow leg — which reads the maker's PRIVATE balance.

A fresh user from the faucet has `public_balance > 0` and `private_balance ==
0`. Without a manual public→private hop, every `submit_order` reverts with
`'Balance too low'`. The wizard frontend at https://aztec-project.vercel.app
DOES NOT currently insert this hop, and the SDK has no helper for it.

**Smoke-script workaround:** new step 5a calls
`tUSDC.transfer_public_to_private(user, user, 1_000_000, Fr.ZERO)` (nonce
must be ZERO when `from == msg_sender`; learned via assertion failure
mid-run).

**Carry-forward (BLOCKER for public launch):** add a public→private wrapper
to either:
- the SDK (`client.tokens.publicToPrivate({ token, amount })`), and have the
  wizard call it after faucet drip; OR
- the faucet itself (mint privately via `mint_to_private` instead of
  `mint_to_public`). The latter is cleaner: avoids the extra user-side
  proof-generation tx, halves their gas cost, and removes a footgun.

#### P3. Orderbook constructor stored `pool_token_a/b` in WRONG canonical order (CRITICAL)

This one took the smoke down at step 5. Three places have to agree on how
to canonicalize an unordered (token_a, token_b) pair to a "lo/hi" tuple:

1. `scripts/redeploy-testnet.ts::canon` (deploy-time pool slot ordering).
2. `contracts/orderbook/src/main.nr::constructor` (writes whatever the
   deploy script passed, with the comment "Caller responsibility: token_a <
   token_b as Field").
3. `contracts/orderbook/src/main.nr::add_pool` and
   `_assert_path_pools_registered` (run-time pool lookup).

Items 2 and 3 use **u128 truncation** (`(addr.to_field() as u128)` <
comparison). The Field-to-u128 cast keeps only the lower 128 bits and is
NOT order-preserving for the practical AztecAddress range. Item 1 used a
**full-bigint compare** (`a.toBigInt() < b.toBigInt()`). For the Sub-9
testnet token addresses, these two orderings disagree:

```
tUSDC = 0x0525a0e5…349c   tETH = 0x2efbaf6b…1ab5
Full-bigint :  tUSDC < tETH  (top byte 0x05 < 0x2e)
u128 truncation: tUSDC u128 (0xf478…349c) > tETH u128 (0xa664…1ab5)
```

→ The deploy script told the orderbook to store
`pool_token_a[0] = tUSDC, pool_token_b[0] = tETH` (full-bigint canonical).
→ A user's `submit_order` with path `[tETH, tUSDC]` (u128 canonical) makes
the orderbook compute `(lo, hi) = (tETH, tUSDC)` and search the registry
for a row where `pool_token_a == tETH`. Found NONE. Assertion fires:
`'pool not found for path[0..2]'`.

**Source bug fixed forward** in `scripts/redeploy-testnet.ts::canon` (now
uses `& ((1n<<128n)-1n)` truncation). Any redeploy after 2026-05-29 will
produce a correctly-aligned orderbook on first try.

**No fix possible against the existing Sub-9 orderbook** at
`0x218ad28908f52d430a9d18a4f281e41e0cf3df547d7e2c74012e952c9e0d28cc` —
the slots were written in the constructor and the contract has no
"replace_pool" path (only `add_pool` to append). The orderbook MUST be
redeployed for Sub-9.1 public launch. Concretely:

1. Redeploy `Orderbook.constructor(...)` with `pool_token_a_addrs[]`
   and `pool_token_b_addrs[]` in **u128-canonical** order. (The fixed
   `canon()` helper now produces this.)
2. Wire `set_treasury` and `pool.set_orderbook(...)` against the new
   orderbook address.
3. Update `quetzal.config.json:orderbook` and re-deploy the frontend
   (one Vercel env var + one Vercel deploy).
4. Re-fund the faucet operator (already at the floor; no action needed).

Estimated time: ~15 min orderbook deploy + ~5 min wiring + ~3 min frontend
push. Run-cost: ~1 admin fee-juice tx for the deploy.

---

#### P4 (already fixed pre-blocker). SDK `placeOrder` called `BigInt()` on alias strings before resolving to addresses

`OrdersApi.placeOrder` was:
```ts
const canonical = canonicalizePath(input.side, input.path);  // input.path = ["tUSDC", "tETH"]
const { path_len, pathFields } = resolvePath(this.client, canonical.path);
```
`canonicalizePath` internally calls `BigInt(path[0])` → `BigInt("tUSDC")` →
`SyntaxError: Cannot convert tUSDC to a BigInt`. The comment claimed
"canonicalizePath operates on the alias strings (compared as BigInt)" which
was never true; alias strings aren't valid BigInts.

**Fix applied (sdk/src/orders.ts):** introduced `resolveAliasesToHex(path)`
and `pathHexToFields(hexPath)`. Order is now resolve → canonicalize →
pack. Pass-through is the same for already-hex inputs (so the migration
is backwards-compatible).

Also applied identical fix to `placeOrderBulk`.

Tests: all 130 existing SDK tests still pass (+1 new regression test for
P5 below = 131 total).

#### P5 (already fixed pre-blocker). SDK `canonicalizePath` used full bigint instead of u128 truncation

After fixing P4, the smoke hit:
```
Assertion failed: path must be canonical (lex-sorted endpoints)
'(path[0] as u128) < (last_hop_field as u128)'
```
…because the SDK's compare was full bigint, but the contract's compare is
u128 truncation, and for the Sub-9 token addrs the two disagree (same
example as P3).

**Fix applied (sdk/src/orders.ts):** `canonicalizePath` now masks both
endpoints with `((1n<<128n)-1n)` before comparing. Added regression test
`orders.canonicalize.test.ts: "u128 truncation disagrees with full-bigint compare"`
that pins the Sub-9 token addrs and asserts the canonical answer is
`[tETH, tUSDC]` + side flip.

#### P6 (low). seed-lp.ts records `txHash: "undefined"` because aztec.js 4.2.1 doesn't expose the field in the send-result shape this code expects

Cosmetic; on-chain state verification at step 7 catches real failures.
Tracked as carry-forward.

---

## Phase C — Files changed + commit

- `scripts/seed-lp.ts` — multi-pool `--pool=<id>` flag + per-pool seed plan
- `scripts/sub9-e2e-smoke.ts` — new programmatic E2E smoke (Phase B driver)
- `scripts/sub9-fund-faucet-operator.ts` — new helper to seed faucet operator's PUBLIC balance for new tokens
- `scripts/redeploy-testnet.ts` — `canon()` now u128-truncates (P3 fix)
- `sdk/src/orders.ts` — `placeOrder` + `placeOrderBulk` resolve aliases first; `canonicalizePath` u128-truncates (P4 + P5 fixes)
- `sdk/src/orders.canonicalize.test.ts` — regression test pinning Sub-9 token addrs
- `.gitignore` — sub9-e2e-pxe/, sub9-e2e-state.json, seed-lp-state-*.json, frontend/dist/
- `aggregator/ops/sub9-e2e-findings.md` — this file
- `seed-lp-state-0.json` — pool 0 seed state migrated from legacy
- `seed-lp-state-1.json` — pool 1 seed state (gitignored)
- `seed-lp-state-2.json` — pool 2 seed state (gitignored)

Live infra changes (NOT in repo):
- VPS `/root/quetzal-faucet/faucet/.env.faucet` — updated to Sub-9 token addrs
- VPS `docker compose up -d --force-recreate` against quetzal-faucet — picked up new env
- L2 testnet: 2 admin txs (tUSDC + tETH public mint for faucet operator)

---

## Updated public-launch checklist

| item                                                                                       | status      |
|--------------------------------------------------------------------------------------------|-------------|
| Pools 0, 1, 2 deployed                                                                     | ✓           |
| Pools 0, 1, 2 seeded with liquidity                                                        | ✓           |
| Aggregator polling cleanly                                                                 | ✓           |
| Frontend deployed at `aztec-project.vercel.app`                                            | ✓           |
| Faucet running with correct token addrs                                                    | ✓ (P0+P1 fix) |
| Faucet operator funded for drain check                                                     | ✓           |
| Programmatic E2E: wallet gen → drip                                                        | ✓           |
| Programmatic E2E: claim + deploy                                                           | ✓           |
| Programmatic E2E: public → private balance hop                                             | ✓ (in-script)|
| Programmatic E2E: submit order successfully                                                | ✗ blocked by P3 |
| **Redeploy Orderbook with u128-canonical token slots**                                     | **TODO**    |
| SDK helper for public→private (so wizard doesn't need a hand-rolled path)                  | TODO (P2)   |
| Wizard: insert public→private hop after drip                                               | TODO (P2)   |
| Sub-9 deploy automation: auto-rewrite faucet .env.faucet + restart                         | TODO        |
| Faucet drips PRIVATELY instead of publicly (cleanest fix to P2)                            | TODO (P2 alt)|
| Aggregator backfills `submitted_at_block` for reveals lacking it                           | TODO (UX)   |

---

## Operator next steps to actually launch publicly

1. **(Required)** Redeploy the Orderbook against the existing tokens + pools
   with the fixed `canon()`. Sketch:
   ```bash
   # Backup current quetzal.config.json:orderbook + state.
   AZTEC_NODE_URL=https://rpc.testnet.aztec-labs.com \
   pnpm tsx scripts/redeploy-orderbook-only.ts  # NEEDS TO BE WRITTEN
   ```
   The fastest path is probably to duplicate `scripts/redeploy-testnet.ts`'s
   step 8 (Orderbook constructor call) into a focused one-shot script that
   re-uses the existing tUSDC/tETH/tBTC + pool addresses. ~15 min total.

2. **(Required)** Update `quetzal.config.json:orderbook` to the new address.
   Update frontend's Vercel `ORDERBOOK_ADDRESS` env (or whatever the
   binding is) and trigger a fresh prod deploy.

3. **(Strongly recommended)** Pick a fix for P2:
   - Easy: have the wizard call `Token.transfer_public_to_private` after
     the drip (~30 LoC + an extra ~30s of user wait for proof gen).
   - Better: change the faucet to call `Token.mint_to_private` instead
     of `mint_to_public`. Removes the user-side hop entirely.

4. **(Recommended)** Re-run `scripts/sub9-e2e-smoke.ts` end-to-end against
   the new orderbook to confirm steps 5 → 9 succeed and a clearing
   actually fires. Will consume 1 faucet drip from VPS IP.

5. **(Operational)** After all the above, open the wizard at
   https://aztec-project.vercel.app from a real public IP and walk through
   the flow by hand. Verify the user lands on `/trade` with a non-zero
   balance and can place an order.

---

## Appendix: faucet drips consumed this session

- 1 successful drip on attempt #1 (master `0x2386cf5c…`), pre-P0 fix —
  tokens minted to wrong (M3) contract.
- 1 successful drip on attempt #2 (master `0xb1cb…7060d`), post-P0+P1 fix
  — tokens minted to correct Sub-9 contracts.

Total drips this session: 2 / 4 per-IP per-8h limit. Faucet healthy and
ready to serve users immediately after P3 is fixed.
