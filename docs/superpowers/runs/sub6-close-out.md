# Sub-6 series — close-out summary

**Date:** 2026-05-27
**Status:** All 3 sub-projects (6a, 6b, 6c) shipped to varying completeness.

## What shipped

### Sub-6a — Anonymity Set (2026-05-23)

22 tasks across 7 phases. K=5 (Sub-6a A5 measurement post-downsize) submit_order_bulk with 1 real + up to 4 decoys; decoy registry at `~/.quetzal/decoy-registry-<wallet>.json`; selective claim + cancel-decoys; bridge round-trip advisory (`isRoundTripRisk` 5% tolerance + `--ack-delay`); multi-hop bridge exit (`--split-into N`); amount-pattern fingerprint warn-heuristic + `--ack-round`; AUDIT T-13/T-14/T-15 + Known Issue #5. 74/74 CLI unit tests + 6 Noir TXE tests. Tagged `sub6a-phase{1..g}-done`.

### Sub-6b — Testnet operability + SDK (2026-05-23..05-24)

23 tasks across 4 phases. Phase 2: `@quetzal/sdk` workspace package extracted from CLI (74 → 86 unit tests; 12 new SDK-specific). Phase 4: `sdk/README.md` + `docs/frontend-quickstart.md` + 3 runnable `examples/`. Phase 1 + 3: testnet validation — Sub-3 4-deploy cite from existing m3 (2026-05-22); L1 bridges deployed twice on Sepolia (first with `l2Version=1` bug, second with `L2_VERSION=4127419662` fix); 3 L2 bridge-mode tokens (aUSDC/aWETH/aWBTC) deployed via fresh wallet; 3 portal wirings verified on-chain. L2 `claim_public` BLOCKED on fee-juice depletion + reorg (carryforward). SDK runner twins (Phase 3.1/3.2/3.3) shipped as scaffolds; live execution deferred.

Tagged: `sub6b-phase1-done`, `sub6b-phase1-bridge-full`, `sub6b-phase1-bridge-roundtrip-partial`, `sub6b-phase2-done`, `sub6b-phase3-done-scaffold`, `sub6b-phase4-done`.

### Sub-6c — Trade-direction canonicalization + WalletPool (2026-05-27)

13 tasks across 3 phases. Phase A: Noir circuit `path[0] < path[path_len-1]` assertion + SDK `canonicalizePath` auto-flip + 6 unit tests + 3 TXE tests. Phase B: `WalletPool` HD-derived N-child class + per-child pending-tx counter (JS Proxy) + aggregated reads + 14 unit tests + `docs/wallet-pool.md`. Phase C: AUDIT T-16/T-17 + this series summary + memory note. ~98 SDK unit tests total (84 pre-existing + 6 canonicalize + 7 WalletPool B1 + 3 WalletPool B2 + 4 WalletPool B4). 9 Noir TXE tests total (6 Sub-6a bulk + 3 Sub-6c canonical).

Tagged: `sub6c-phaseA-done`, `sub6c-phaseB-done`, `sub6c-phaseC-done`.

## Deferred to Sub-6d / Sub-7

- **#6 aggregator-side metadata reveals** — threshold T-of-N multi-sig OR rotating aggregators. ~20-30 task work; deferred at Sub-6c brainstorm gate.
- **#2 escrow-side direction leak (full obscure)** — Sub-6c A1 closes the path-order leak; the `Token.transfer_private_to_public` call still reveals which token the maker escrowed. Per-token shielded pool would close this; ~15-20 task work.
- **L2 `claim_public` end-to-end** — Sub-6b Phase 1.4 carryforward. Blocked on alpha-testnet fee-juice budget (account deploy consumes nearly all 100 from faucet claim). Operator session with fresh wallet + sponsored paymaster setup unblocks.
- **Sub-4 ceremony bridge-wired Treasury seed** — Sub-6b carryforward. Requires L1→L2 bridge deposit of aUSDC to the new orderbook's treasury. Same L2-claim blocker as above.

## Frontend integration readiness

A frontend dev opening this codebase today can:

1. Clone, `pnpm install`
2. Read `sdk/README.md` (30 min)
3. Read `docs/frontend-quickstart.md` (15 min)
4. Read `docs/wallet-pool.md` (10 min)
5. Read `docs/frontend-brief.md` (overview + AI-UI-gen prompt; 10 min)
6. Browse `examples/01-place-order.ts` / `02-bridge-deposit.ts` / `03-bulk-with-decoys.ts`
7. Import `QuetzalClient` (or `WalletPool` for high-throughput) and place an order on alpha-testnet (assuming Sub-4 ceremony stack is wired against bridge-token-funded maker)

The privacy mitigations are transparent — SDK auto-canonicalizes path, auto-distributes across child wallets, auto-warns on round amounts. Dev doesn't need to know about them.

## Test scoreboard (end of Sub-6)

| Layer | Count | Status |
|---|---|---|
| CLI unit tests | 74 | green (no regression across 6b + 6c) |
| SDK unit tests | ~98 (Sub-6c +14) | green |
| Noir TXE tests | 9 (6 Sub-6a + 3 Sub-6c) | green (compile gate; cross-contract fixture limit per Sub-6a A2) |
| L1 Foundry tests | unchanged from Sub-5c (~25) | green |
| TypeScript typecheck | 0 errors workspace-wide | green |

## What's NOT in Sub-6

- Production mainnet deployment (Sub-5c runbook covers; pending audit)
- Frontend itself (separate sub-project; backend now ready for it)
- Bridge fee-juice economics / sponsored paymasters (Aztec ecosystem-level concern)
- Threshold aggregator (deferred to Sub-6d)
- Escrow-side full direction obscure (deferred to Sub-6d)

## Git tag tree

```
sub6a-phase1-done .. sub6a-phaseg-done       (Sub-6a)
sub6b-phase{1,2,3,4}-done + bridge-{full,roundtrip-partial}   (Sub-6b)
sub6c-phase{A,B,C}-done                       (Sub-6c)
```

## Commit ranges

- Sub-6a: `e13164c..7613997` (25 commits)
- Sub-6b: ~30 commits spanning `256ea60..1ed8a59`
- Sub-6c: ~13 commits, Phase A `c8a1034..379cb96`, Phase B `c8c9cd4..64facef`, Phase C `d3b9590..(pending)`
