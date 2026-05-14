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

## Documentation

- [MVP Design Spec](docs/superpowers/specs/2026-05-14-zswap-aztec-mvp-design.md)
- [Protocol Roadmap](docs/superpowers/specs/2026-05-14-zswap-aztec-roadmap.md)
- [Week 1 Implementation Plan](docs/superpowers/plans/2026-05-14-zswap-aztec-week-01-foundation.md)

## License

MIT.
