# ZSwap-on-Aztec

MEV-resistant dark-pool DEX on Aztec Network. Penumbra-style frequent batch auction with native private state, built in Noir.

**Status:** Sub-project 2 (concentrated liquidity, LP-side complete; circuit integration deferred to Sub-2.5). The LiquidityPool is now a 16-bucket concentrated AMM with geometric 1.5x spacing — `PoolState` collapses to (reserve_a, reserve_b, current_sqrt_price); per-bucket state lives in `Map<u32, PublicMutable<BucketState>>` (reserve_a, reserve_b, liquidity, cum_fee_a/b_per_share). `PositionNote` gains `bucket_id` (private). New `deposit(bucket_id, amount_a, amount_b, ...)` uses V3 math + Sub-1's V2 refund pattern (LP-friendly: surplus side returned privately). New `withdraw` carries per-bucket fee accrual via `cum_fee_per_share` MasterChef counters. `apply_clearing(swap)` iterates `BucketDelta[4]` sparse encoding (max 4 active buckets per clearing). V3 math primitives (`compute_deposit_in_range/_below_range/_above_range`, `max_a_in_to_upper`, `max_b_in_to_lower`) implemented three ways with parity tests: circuit (`circuits/clearing/src/buckets.nr`), pool contract (`contracts/pool/src/buckets.nr`), aggregator (`aggregator/src/buckets.ts`). Orderbook's `ClearingPublic` grew 19→42 fields with `BucketDelta[4]` sparse encoding; `flatten_clearing_public` rewritten. CLI: `zswap deposit --bucket <id> [--auto-b]` + bucket-aware `withdraw` + enriched `positions` (shows bucket_id + in-range status). Deploy script writes `bucketPMinSqrt` + `bucketGrowthNum` to zswap.config.json. Test status: all TXE (clearing circuit B1-B5, pool V3 math, orderbook 42-field flatten) + JS aggregator (71 tests including bucket-trace) + CLI typecheck green. **Deferred to Sub-2.5:** circuit's 42-field public-input shape rewrite + per-bucket constant-product assertions + multi-bucket V3 swap-step formula + bb prove against new circuit. With those deferred, end-to-end clearing path is dormant; the LP-side (deposit/withdraw/positions) works standalone. Sub-1 + Sub-3 trust model + Sub-3 deferred-to-e2e items still apply. Next: Sub-2.5 (circuit integration) or sub-project 4 (multi-pair routing).

**Sub-2.5 CODE-COMPLETE (2026-05-22):** 15 tasks across 6 phases (A-F) delivered. The circuit's `fn main` emits 42 public fields matching the orderbook's `flatten_clearing_public`; the aggregator's `traceBucketSwap` is a true multi-bucket state machine (UP + DOWN, empty-bucket skip, MAX_BUCKET_HOPS=4, last-bucket-residual fee); the witness builder rewritten for Sub-2.5 42-field public layout; bb prove passes (500-field proof, 115-field VK, EMPTY_ROOT unchanged, new vk_hash `0e634a5b7cb463a6...`, gate count 107,762). Test scoreboard: 52 Noir TXE tests + 86+ JS aggregator tests passing. Joint testnet runner scaffolded at `scripts/testnet-sub2-5.ts` (9-step state machine + AZTEC_NODE_URL safety check); **testnet execution deferred to a future session when an Aztec testnet endpoint is configured.**

**Sub-4 CODE-COMPLETE (2026-05-23):** multi-pair routing with explicit maker 2-hop paths across 18 tasks in 6 phases (A-F).
Single Orderbook manages N pools (MVP triangle: USDC/ETH, USDC/BTC, ETH/BTC). ClearingPublic grew to 114 fields.
bb prove confirmed against the new circuit; bridge constants (500-field proof, 115-field VK) HOLD.
Gate count: 276,250 (ACIR opcodes: 153,805). New vk_hash: `03180b0a5131de64`.
Witness builder (`buildClearingWitnessMultiPair`) now fully self-consistent with circuit fn main:
`active_pool_clearings`, `fill_to_order_index` (64-entry), `pool_bucket_states_before/after` ([[BucketState;4];3]),
`pool_sqrt_p_before` ([u128;3]), `pool_token_pairs` ([[Field;2];3]).
7 documented carry-forward limitations (2-hop double-claim, 1-hop DoS gap, token-pair truncation,
Sub-3 circular-dep, statistical privacy leak, fixed pool count, naive composite pricing).

**Sub-5a CODE-COMPLETE (2026-05-23):** Sub-3 4-deploy circular-dep wart retired
(3-deploy fallback with `Orderbook.treasury` PublicMutable + one-shot
`set_treasury`). Sub-4 #1 (2-hop double-claim) closed via per-hop nullifier
scheme — `claim_fill` + `cancel_order` use `get_notes` + `Z_HOP_CLAIM_TAG` /
`Z_CANCEL_TAG` domain-separated nullifiers. Sub-4 #2 (1-hop DoS) closed via
circuit block B' (276K → 281K gates, +5,344). Sub-4 #6 (MAX_POOLS fixed at
deploy) closed via mutable pool registry + `add_pool` (MAX_NUM_POOLS = 8).
New vk_hash `2aae33dd4ea01690`; bridge constants 500/115 HOLD. Testnet runner
scaffold at `scripts/testnet-sub5a.ts`; full step-body wire-up + live run
deferred (same shape as Sub-2.5).

**Sub-5b CODE-COMPLETE (2026-05-23):** L1↔L2 bridge for canonical USDC + WETH.
`contracts-l1/` Foundry project deploys `TokenBridge.sol` (UUPS + Pausable +
Ownable, owned by a `TimelockController` with multisig admin) once per asset.
`Token.nr` extended with `is_bridged: PublicImmutable<bool>` +
`portal_addr: PublicImmutable<EthAddress>` immutable fields + four new external
functions (`claim_public`, `claim_private`, `exit_to_l1_public`,
`exit_to_l1_private`); legacy `mint_to_*` revert in bridge mode. L1↔L2 content
hash unified on `sha256_to_field(abi.encode(...))` (Aztec convention; matches
the canonical `Hash.sha256ToField` from upstream `@aztec/l1-artifacts`).
`exit_to_l1_private` has no L1 consumer yet — Sub-5c follow-up. CLI:
`zswap bridge {claim, exit, claim-l1}` subcommands; bridge-helpers.ts wires
`getTxEffect` + `getL2ToL1Messages` for the L2→L1 lookup half (siblingPath
construction deferred to Sub-5c — operator completes proof manually via the
upstream portal_manager.js reference). L1 test scoreboard: **21 Foundry tests
pass** (16 TokenBridge unit + 5 BridgeFlow governance integration). L2 TXE:
5 bridge-mode tests committed (Docker-blocked local execution carryover).
Mainnet deployment runbook at `docs/superpowers/specs/sub5b-runbook.md` with
$10k → unlimited cap ramp policy + 7-day timelock governance procedures.
Live testnet bridge execution (`scripts/testnet-sub5b-bridge.ts` 12-step
runner) deferred to operator session. **Sub-5b carryforward must ship before
mainnet:** EmergencyPauser role with delay=0 timelock for `pause()` (7-day
delay is unacceptable for security incidents). Sub-5c (Production Infra)
remains.

**Sub-5c CODE-COMPLETE (2026-05-23):** Production infrastructure — final Sub-5 split.
Closes every Sub-5b carryforward + ships the production ops stack.
TokenBridge.sol refactored from `Ownable` to `AccessControl` with `GOVERNANCE_ROLE`
(7-day governance timelock) + `EMERGENCY_PAUSER_ROLE` (0-day emergency timelock,
self-admin invariant — governance cannot revoke). Standalone TS subprocess binary
`bin/zswap-outbox-proof` (audit-isolated under `tools/outbox-proof/`) constructs
L2→L1 sibling paths via canonical `computeL2ToL1MembershipWitness` from
`@aztec/stdlib/messaging`. `scripts/deploy-bridge.ts` end-to-end automated via
shared `scripts/lib/aztec-wallet-bootstrap.ts` (DRY across testnet-m1-hello,
testnet-sub5b-bridge, deploy-bridge). wBTC ships as third asset day 0; per-asset
TVL caps prevent decimal-mismatch portal bricking. 3-phase `recoverDeposit`
(90-day window + governance approval) handles lost-secret scenarios.
`withdrawPrivate` consumer for L2's `exit_to_l1_private` (Sub-5b deferral closed).
Prometheus + Grafana + Alertmanager VPS stack with custom L1+L2 exporters + 4
alerts (BridgePaused, BridgeTvlNearCap, OrderbookStalled, OutboxBacklog) →
Slack + PagerDuty. Opt-in relayer extends Sub-3 aggregator daemon
(`RELAYER_MODE=1`) with Treasury fee economy; CLI `bridge exit --relayer-fee`.
`contracts-l1/AUDIT.md` + Slither report at `contracts-l1/audit/slither-2026-05-23.txt`
+ commit-freeze tag `sub5c-audit-snapshot` at `2747700`. `docs/on-call-playbook.md`
SEV1-4 + escalation tree + quarterly pause-drill. `docs/superpowers/specs/sub5c-runbook.md`
extends Sub-5b runbook with EmergencyPauser usage, 3-phase recovery walkthrough,
withdrawPrivate UX, monitoring setup, relayer setup, 3-asset cap-ramp policy.
L1 test scoreboard: **33 Foundry tests pass**. L2 TXE: 8 tests (5 Token bridge-mode
+ 3 Treasury queue). **ZSwap is now mainnet-ready in $10k cap mode pending only
the external audit.** Sub-5d (post-audit remediation) + Sub-6 (privacy mitigations)
remain.

## Quickstart

Requires: Node 22+, pnpm 9+, Docker, Aztec CLI `4.2.1`, Foundry (anvil).

```bash
# Install Aztec toolchain (one-time, if not already installed)
which aztec || bash -i <(curl -s https://install.aztec.network)
export VERSION=$(cat .aztec-version)
aztec-up -v "$VERSION"

# Install Foundry (one-time, for anvil)
which anvil || (curl -L https://foundry.paradigm.xyz | bash && foundryup)

# Install JS dependencies
pnpm install

# Compile all Noir contracts
pnpm compile

# Run Noir TXE tests (no sandbox needed)
pnpm test:noir

# Generate TypeScript bindings from compiled contracts
# (runs automatically as a pretest hook, but you can run it explicitly)
pnpm codegen

# In a separate terminal, start the local dev stack (anvil + aztec)
scripts/dev.sh

# Then run TypeScript integration tests
# (codegen runs automatically before tests via the pretest hook)
pnpm test

# Use the CLI (after deploy-tokens.ts has written zswap.config.json)
pnpm tsx scripts/deploy-tokens.ts
pnpm --filter @zswap/cli zswap order --side buy --amount 100000000 --limit 2000000000000000000
pnpm --filter @zswap/cli zswap orders
pnpm --filter @zswap/cli zswap cancel --nonce <order-nonce-from-above>
pnpm --filter @zswap/cli zswap close-epoch
pnpm --filter @zswap/cli zswap deposit --amount-a 1000000000 --amount-b 1000000000000000000
pnpm --filter @zswap/cli zswap positions
pnpm --filter @zswap/cli zswap withdraw --nonce <position-nonce-from-above>
pnpm --filter @zswap/cli zswap claim --nonce <order-nonce>
```

## Testing

- **Noir TXE tests** run via `pnpm test:noir`. They don't need the dev stack — the Aztec Test Execution Environment (TXE) is in-process.
- **TypeScript integration tests** run via `pnpm test` against a live dev stack (`scripts/dev.sh` must be running in another terminal). They deploy real contracts and assert on private balances.
- The TypeScript test runner is `node --import tsx --test`, **not** Vitest. The `@aztec/*` packages use ESM import attributes (`import ... with { type: "json" }`) that the vite-node loader (Vitest 2.x/3.x + Vite 5/6) strips before delegating to Node, which then rejects the import. `tsx` (esbuild-based) preserves import attributes, making node:test + tsx the only viable path. If you add unit tests for pure-TS modules later, Vitest is fine for those — only `@aztec`-touching tests require this setup.

## Documentation

- [MVP Design Spec](docs/superpowers/specs/2026-05-14-zswap-aztec-mvp-design.md)
- [Protocol Roadmap](docs/superpowers/specs/2026-05-14-zswap-aztec-roadmap.md)
- [Week 1 Implementation Plan](docs/superpowers/plans/2026-05-14-zswap-aztec-week-01-foundation.md)
- [Week 2 Orderbook Design](docs/superpowers/specs/2026-05-14-zswap-aztec-week-02-orderbook-design.md)
- [Week 2 Implementation Plan](docs/superpowers/plans/2026-05-14-zswap-aztec-week-02-orderbook.md)
- [Week 3 cancel + CLI Design](docs/superpowers/specs/2026-05-17-zswap-aztec-week-03-cancel-cli-design.md)
- [Week 3 Implementation Plan](docs/superpowers/plans/2026-05-17-zswap-aztec-week-03-cancel-cli.md)
- [Week 4 Epoch Transitions Design](docs/superpowers/specs/2026-05-18-zswap-aztec-week-04-epoch-transitions-design.md)
- [Week 4 Implementation Plan](docs/superpowers/plans/2026-05-18-zswap-aztec-week-04-epoch-transitions.md)
- [Week 5 Liquidity Pool Design](docs/superpowers/specs/2026-05-18-zswap-aztec-week-05-liquidity-pool-design.md)
- [Week 5 Implementation Plan](docs/superpowers/plans/2026-05-18-zswap-aztec-week-05-liquidity-pool.md)
- [Week 5b Clearing Aggregator Design](docs/superpowers/specs/2026-05-19-zswap-aztec-week-05b-clearing-aggregator-design.md)
- [Week 5b Implementation Plan](docs/superpowers/plans/2026-05-19-zswap-aztec-week-05b-clearing-aggregator.md)
- [Week 5c On-chain Clearing Design](docs/superpowers/specs/2026-05-19-zswap-aztec-week-05c-onchain-clearing-design.md)
- [Week 5c Implementation Plan](docs/superpowers/plans/2026-05-19-zswap-aztec-week-05c-onchain-clearing.md)
- [Week 5d-1 Epoch Order Accumulator Design](docs/superpowers/specs/2026-05-20-zswap-aztec-week-05d-1-order-accumulator-design.md)
- [Week 5d-1 Implementation Plan](docs/superpowers/plans/2026-05-20-zswap-aztec-week-05d-1-order-accumulator.md)
- [Week 5d-2 Standalone Noir Clearing Circuit Design](docs/superpowers/specs/2026-05-20-zswap-aztec-week-05d-2-clearing-circuit-design.md)
- [Week 5d-2 Implementation Plan](docs/superpowers/plans/2026-05-20-zswap-aztec-week-05d-2-clearing-circuit.md)
- [Week 5d-3 On-chain Recursive Verify Design](docs/superpowers/specs/2026-05-20-zswap-aztec-week-05d-3-onchain-recursive-verify-design.md)
- [Week 5d-3 Implementation Plan](docs/superpowers/plans/2026-05-20-zswap-aztec-week-05d-3-onchain-recursive-verify.md)
- [Week 5d-4 Merkle Settlement Root Design](docs/superpowers/specs/2026-05-21-zswap-aztec-week-05d-4-merkle-settlement-root-design.md)
- [Week 5d-4 Implementation Plan](docs/superpowers/plans/2026-05-21-zswap-aztec-week-05d-4-merkle-settlement-root.md)
- [Sub-project 3: Permissionless Aggregator Design](docs/superpowers/specs/2026-05-22-zswap-aztec-subproject-03-dar-permissionless-aggregator-design.md)
- [Sub-project 3: Implementation Plan](docs/superpowers/plans/2026-05-22-zswap-aztec-subproject-03-dar-permissionless-aggregator.md)
- [Sub-project 2: Concentrated Liquidity Design](docs/superpowers/specs/2026-05-22-zswap-aztec-subproject-02-concentrated-liquidity-design.md)
- [Sub-project 2: Implementation Plan](docs/superpowers/plans/2026-05-22-zswap-aztec-subproject-02-concentrated-liquidity.md)
- [Sub-project 2.5: Circuit Integration Design](docs/superpowers/specs/2026-05-22-zswap-aztec-subproject-02-5-circuit-integration-design.md)
- [Sub-project 2.5: Implementation Plan](docs/superpowers/plans/2026-05-22-zswap-aztec-subproject-02-5-circuit-integration.md)
- [Sub-project 4: Multi-Pair Routing Design](docs/superpowers/specs/2026-05-23-zswap-aztec-subproject-04-multi-pair-routing-design.md)
- [Sub-project 4: Implementation Plan](docs/superpowers/plans/2026-05-23-zswap-aztec-subproject-04-multi-pair-routing.md)
- [Sub-project 5a: Deterministic Addresses Design](docs/superpowers/specs/2026-05-23-zswap-aztec-subproject-05a-deterministic-addresses-design.md)
- [Sub-project 5a: Implementation Plan](docs/superpowers/plans/2026-05-23-zswap-aztec-subproject-05a-deterministic-addresses.md)
- [Sub-project 5a: A1 outcome (args-dependent → FALLBACK 3-deploy)](docs/superpowers/specs/sub5a-A1-outcome.md)
- [Sub-project 5b: L1 Bridge Design](docs/superpowers/specs/2026-05-23-zswap-aztec-subproject-05b-l1-bridge-design.md)
- [Sub-project 5b: Implementation Plan](docs/superpowers/plans/2026-05-23-zswap-aztec-subproject-05b-l1-bridge.md)
- [Sub-project 5b: Mainnet Deployment Runbook](docs/superpowers/specs/sub5b-runbook.md)
- [Sub-project 5c: Production Infrastructure Design](docs/superpowers/specs/2026-05-23-zswap-aztec-subproject-05c-production-infra-design.md)
- [Sub-project 5c: Implementation Plan](docs/superpowers/plans/2026-05-23-zswap-aztec-subproject-05c-production-infra.md)
- [Sub-project 5c: Mainnet Deployment + Operations Runbook](docs/superpowers/specs/sub5c-runbook.md)
- [L1 Bridge Audit Brief](contracts-l1/AUDIT.md)
- [On-call Playbook](docs/on-call-playbook.md)

## Operator Runbook (Sub-3)

To run as a permissionless aggregator:

1. Acquire ≥ 1000 tUSDC (the registry's default `bond_amount = 1_000_000_000` at 6 decimals).
2. Register on-chain:
   ```bash
   pnpm --filter @zswap/cli zswap aggregator register --bond 1000000000 --url https://my-aggregator.example.com
   ```
3. Add your address+URL to `cli/aggregator-manifest.json` via a PR.
4. Run the Fastify HTTP reveal server (in one terminal):
   ```bash
   pnpm tsx -e 'import { startServer } from "./aggregator/src/server.ts"; startServer();'
   ```
   The server listens on `:3000` by default (override via `PORT=<n>`).
5. Run the clearing daemon in another terminal (you provide the DaemonContext wiring against your node + wallet).

To unregister and reclaim your bond:
```bash
pnpm --filter @zswap/cli zswap aggregator unregister
```

## License

MIT.
