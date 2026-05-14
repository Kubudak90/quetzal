# ZSwap-on-Aztec

MEV-resistant dark-pool DEX on Aztec Network. Penumbra-style frequent batch auction with native private state, built in Noir.

**Status:** Pre-alpha. Week 1 of MVP implementation.

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

# In a separate terminal, start the local dev stack (anvil + aztec)
scripts/dev.sh

# Then run TypeScript integration tests
pnpm test
```

## Testing

- **Noir TXE tests** run via `pnpm test:noir`. They don't need the dev stack — the Aztec Test Execution Environment (TXE) is in-process.
- **TypeScript integration tests** run via `pnpm test` against a live dev stack (`scripts/dev.sh` must be running in another terminal). They deploy real contracts and assert on private balances.
- The TypeScript test runner is `node --import tsx --test`, **not** Vitest. The `@aztec/*` packages use ESM import attributes (`import ... with { type: "json" }`) that the vite-node loader (Vitest 2.x/3.x + Vite 5/6) strips before delegating to Node, which then rejects the import. `tsx` (esbuild-based) preserves import attributes, making node:test + tsx the only viable path. If you add unit tests for pure-TS modules later, Vitest is fine for those — only `@aztec`-touching tests require this setup.

## Documentation

- [MVP Design Spec](docs/superpowers/specs/2026-05-14-zswap-aztec-mvp-design.md)
- [Protocol Roadmap](docs/superpowers/specs/2026-05-14-zswap-aztec-roadmap.md)
- [Week 1 Implementation Plan](docs/superpowers/plans/2026-05-14-zswap-aztec-week-01-foundation.md)

## License

MIT.
