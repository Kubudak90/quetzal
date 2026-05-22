# ZSwap-on-Aztec

MEV-resistant dark-pool DEX on Aztec Network. Penumbra-style frequent batch auction with native private state, built in Noir.

**Status:** Sub-project 3 (permissionless aggregator) complete; Sub-project 1 trustless clearing fully shipped via Sub-projects 1+3. New `AggregatorRegistry` and `Treasury` Noir contracts wire a bonded-race model on top of the W5d-4 clearing primitive — anyone can register as an aggregator by escrowing 1000 tUSDC, run a Fastify reveal-ingestion server + clearing daemon, and race to submit `close_epoch_and_clear_verified`. The first valid submission wins; the on-chain `_assert_aggregator_registered` gate enforces a non-zero bond, then `_apply_verified_clearing` calls `Treasury.pay_aggregator(winner, fee)` with silent-partial-pay semantics (dry treasury does NOT block clearing). Off-chain `aggregator-manifest.json` maps addresses to HTTPS endpoints; maker PXEs hash-verify URLs against `view_bonded_amount` before broadcasting reveals. New CLI: `zswap aggregator {register, list, unregister}`. Test status: TXE Noir tests (orderbook + aggregator-registry + treasury) + JS aggregator tests (55 total) + CLI typecheck all green. O1 (registration gate), R1/R2/R4/R6 (Token-authwit-dependent paths), T1/T2/T4-deposit, and the e2e race test (`tests/integration/aggregator-race.test.ts`) are dormant pending the dev stack — same pattern as W5d-4's claim-merkle e2e. Deploy script writes 8 fields to zswap.config.json (adds `aggregatorRegistry`, `treasury`); the 4-deploy circular dep between Orderbook and Treasury is an MVP wart flagged for Sub-5. Previous Sub-1 carry-overs still apply: `MAX_ORDERS_PER_EPOCH=32`, ClearingPublic 19 fields, bb proof 500/contract 456, bb vk 115/contract 127, fills_root Merkle settlement per epoch. Next: sub-project 2 of 6.

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
