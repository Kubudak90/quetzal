# ZSwap-on-Aztec

MEV-resistant dark-pool DEX on Aztec Network. Penumbra-style frequent batch auction with native private state, built in Noir.

**Status:** Sub-project 2 (concentrated liquidity, LP-side complete; circuit integration deferred to Sub-2.5). The LiquidityPool is now a 16-bucket concentrated AMM with geometric 1.5x spacing — `PoolState` collapses to (reserve_a, reserve_b, current_sqrt_price); per-bucket state lives in `Map<u32, PublicMutable<BucketState>>` (reserve_a, reserve_b, liquidity, cum_fee_a/b_per_share). `PositionNote` gains `bucket_id` (private). New `deposit(bucket_id, amount_a, amount_b, ...)` uses V3 math + Sub-1's V2 refund pattern (LP-friendly: surplus side returned privately). New `withdraw` carries per-bucket fee accrual via `cum_fee_per_share` MasterChef counters. `apply_clearing(swap)` iterates `BucketDelta[4]` sparse encoding (max 4 active buckets per clearing). V3 math primitives (`compute_deposit_in_range/_below_range/_above_range`, `max_a_in_to_upper`, `max_b_in_to_lower`) implemented three ways with parity tests: circuit (`circuits/clearing/src/buckets.nr`), pool contract (`contracts/pool/src/buckets.nr`), aggregator (`aggregator/src/buckets.ts`). Orderbook's `ClearingPublic` grew 19→42 fields with `BucketDelta[4]` sparse encoding; `flatten_clearing_public` rewritten. CLI: `zswap deposit --bucket <id> [--auto-b]` + bucket-aware `withdraw` + enriched `positions` (shows bucket_id + in-range status). Deploy script writes `bucketPMinSqrt` + `bucketGrowthNum` to zswap.config.json. Test status: all TXE (clearing circuit B1-B5, pool V3 math, orderbook 42-field flatten) + JS aggregator (71 tests including bucket-trace) + CLI typecheck green. **Deferred to Sub-2.5:** circuit's 42-field public-input shape rewrite + per-bucket constant-product assertions + multi-bucket V3 swap-step formula + bb prove against new circuit. With those deferred, end-to-end clearing path is dormant; the LP-side (deposit/withdraw/positions) works standalone. Sub-1 + Sub-3 trust model + Sub-3 deferred-to-e2e items still apply. Next: Sub-2.5 (circuit integration) or sub-project 4 (multi-pair routing).

**Sub-2.5 CODE-COMPLETE (2026-05-22):** 15 tasks across 6 phases (A-F) delivered. The circuit's `fn main` emits 42 public fields matching the orderbook's `flatten_clearing_public`; the aggregator's `traceBucketSwap` is a true multi-bucket state machine (UP + DOWN, empty-bucket skip, MAX_BUCKET_HOPS=4, last-bucket-residual fee); the witness builder rewritten for Sub-2.5 42-field public layout; bb prove passes (500-field proof, 115-field VK, EMPTY_ROOT unchanged, new vk_hash `0e634a5b7cb463a6...`, gate count 107,762). Test scoreboard: 52 Noir TXE tests + 86+ JS aggregator tests passing. Joint testnet runner scaffolded at `scripts/testnet-sub2-5.ts` (9-step state machine + AZTEC_NODE_URL safety check); **testnet execution deferred to a future session when an Aztec testnet endpoint is configured.**

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
