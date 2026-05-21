# ZSwap-on-Aztec

MEV-resistant dark-pool DEX on Aztec Network. Penumbra-style frequent batch auction with native private state, built in Noir.

**Status:** Sub-project 1 (trustless clearing via ZK proof) complete through Week 5d-4. The clearing circuit emits a single `fills_root: Field` Merkle root (depth-5 Poseidon2 over 32 fill leaves) instead of the flat 32-fill public-input vector — `ClearingPublic` shrunk from 83 to 19 public-input fields (~4× smaller calldata). On-chain, the orderbook stores a per-epoch `fills_root: Map<u32, Field>` (1 slot per clearing, down from up to 32). `claim_fill` is now inclusion-proof based: `(order_nonce, claimed_amount_out, epoch_id, siblings[5], leaf_index)`. The maker reads the per-epoch snapshot at `aggregator/snapshots/epoch-<N>.json`, constructs the path, and the contract walks the 5-level Merkle tree against `fills_root[epoch_id]`. Three-way Merkle parity (Noir circuit / JS aggregator / Noir contract) is pinned by the bb-verified empty-root constant. Cancel-after-fill protection moved from a `fills` Map check to the token contract's `transfer_public_to_private` underflow (apply_clearing already moved the filled amount_in to the pool, so a cancel attempt reverts at the token level). Previous 5d-3 carry-overs still apply: `MAX_ORDERS_PER_EPOCH=32`, bb proof file 500 fields (truncate to contract's 456), bb vk file 115 fields (pad with `Fr.ZERO` to contract's 127), `vk_hash` (not full VK) stored on-chain. Test status: TXE Noir tests + JS aggregator tests + CLI typecheck all green. `tests/integration/claim-merkle.test.ts` is typecheck-clean but dormant pending the dev stack (Docker broken on dev box per `memory/project_week05c_integration_gap.md`); subsumes the deferred 5d-3 testnet validation. Next: sub-project 2 of 6.

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

## License

MIT.
