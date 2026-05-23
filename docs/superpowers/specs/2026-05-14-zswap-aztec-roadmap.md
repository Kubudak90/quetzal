# Quetzal — Protocol Roadmap

**Status:** Living document. Updated as sub-projects close.
**Date:** 2026-05-14

This document outlines the full 6-sub-project roadmap for Quetzal. Each sub-project has its own design spec written in a dedicated brainstorming session before implementation begins. Sub-project 1 is the currently active spec; the rest are scoped here but not yet detailed.

---

## Vision

Build the first serious dark-pool DEX on Aztec Network: a Penumbra-style frequent batch auction with native private state, MEV-proof by construction, permissionlessly run, bridged to Ethereum liquidity, and governed openly. The protocol exists as a primitive others can compose with — a privacy-preserving Uniswap that's also a CowSwap that's also a Renegade, native to Aztec.

## Why Aztec

Aztec's encrypted-note model gives us, natively and cheaply, what other privacy-preserving DEX designs build expensive bespoke infrastructure to obtain:

- Renegade Finance builds the equivalent on L1 with MPC, requiring complex relayer networks and out-of-band coordination.
- Penumbra runs on Cosmos with threshold encryption and DAR auctions, achieving similar properties but isolated from Ethereum liquidity.
- Aztec's per-user encrypted state + private function execution makes the core primitives ~10× simpler to build while remaining EVM-bridgeable through the Aztec portal contracts.

## Sub-project decomposition

```
Sub-project 1: MVP Vertical Slice                ← active spec
       │
       │ proves cryptographic core works
       v
Sub-project 2: Concentrated Liquidity
       │
       │ unlocks competitive LP economics
       v
Sub-project 3: DAR + Permissionless Aggregator
       │
       │ removes single point of failure / trust
       v
Sub-project 4: Multi-pair + Routing  ─────────┐
       │                                      │
Sub-project 5: L1 Bridge + Production Infra   │ (can parallelize after 3)
       │                                      │
       └─────────────┬────────────────────────┘
                     v
       Sub-project 6: Governance + Protocol Fees
```

---

## Sub-project 1 — MVP Vertical Slice

**Status:** spec in `2026-05-14-zswap-aztec-mvp-design.md`
**Estimated duration:** 12 weeks
**Outcome:** Single-pair (tUSDC/tETH), uniform-liquidity FBA running end-to-end on Aztec devnet. Private orders, private LP positions, fee accrual to LPs, FIFO carryover, order cancellation. Trusted singleton aggregator. CLI-only.

---

## Sub-project 2 — Concentrated Liquidity

**Estimated duration:** 6–8 weeks
**Depends on:** Sub-project 1

LP positions become range-bound (à la Uniswap V3), but private. The clearing circuit must compute per-position fill across the active price range, which significantly increases circuit complexity but unlocks competitive LP capital efficiency.

Key design questions to brainstorm:
- Range representation in `PositionNote`: discrete tick-spaced (like V3) or continuous?
- Fee accrual: per-tick cumulative-fee counter (more public storage) or per-position witness check?
- Position rebalancing UX without breaking privacy.
- Interaction with carryover: do remnants choose ticks dynamically?

---

## Sub-project 3 — DAR + Permissionless Aggregator

**Estimated duration:** 4–6 weeks
**Depends on:** Sub-project 1 (independent of 2; can run in parallel)

Replaces the trusted singleton aggregator with a permissionless role. Anyone with collected reveals can submit a valid clearing proof. Adds:

- Bonding/slashing for aggregators (live, in-protocol)
- Threshold encryption committee for reveals OR DAR (Dutch Auction Reveal) protocol — to be decided in brainstorming
- Censorship resistance: a fallback "force close" path that anyone can invoke after a livelock timeout

This sub-project addresses the only critical mainnet blocker from the MVP trust model.

---

## Sub-project 4 — Multi-pair + Routing

**Estimated duration:** 4 weeks
**Depends on:** Sub-project 1 (can run in parallel with 2 and 3)

Multiple pair pools (one `LiquidityPoolContract` instance per pair). Atomic multi-hop swaps where an order can route through several pools in one epoch. Key challenge: clearing has to coordinate across pools.

Two architectural options to brainstorm:
- **Independent per-pool clearing:** each pool clears its own epoch independently, the multi-hop is decomposed into per-pool legs.
- **Joint clearing:** single circuit clears all pools together with cross-pool order routing. More complex but smaller proof aggregate.

---

## Sub-project 5 — L1 Bridge + Production Infra

**Estimated duration:** 6–8 weeks
**Depends on:** Sub-project 1

- L1 portal contracts for ETH and USDC bridging into/out of Aztec
- Indexer service (TypeScript) — exposes pool TVL, recent clearings, historical fills via REST/GraphQL
- Web UI (Next.js + Aztec wallet SDK) — first-class deposit, order, position management
- Public devnet/testnet deployments with monitoring

This sub-project makes the protocol usable by people who aren't running CLIs. Bridge is a known design problem on Aztec (existing patterns in `aztec-standards`); web UI is mostly engineering, not novel.

---

## Sub-project 6 — Governance + Protocol Fees

**Estimated duration:** 3–4 weeks
**Depends on:** Sub-projects 1–5

- Protocol fee splitter: takes a configurable cut of swap fees and routes to treasury (configurable address, governed)
- Fee tier registry: different pool instances can have different swap-fee BPS (stablecoin pair lower, exotic pair higher)
- Governance contract: simple token-vote initially, with a hook for future delegation models
- Audit prep: third-party audit, formal verification of the clearing circuit's core invariants

This sub-project transitions the protocol from "team-run" to "DAO-run" and unlocks the protocol's own value capture.

---

## Total timeline estimate

| Path | Cumulative duration |
|---|---|
| 1 → 3 → 6 (minimum-viable mainnet) | ≈ 22–24 weeks (5.5 months) |
| 1 → 2 → 3 → 4 → 5 → 6 (full sequential) | ≈ 35–40 weeks (8.5–10 months) |
| 1 → (2 ∥ 3 ∥ 4 ∥ 5) → 6 (parallelized after 1) | ≈ 22–26 weeks (5.5–6 months) |

The parallel path requires multiple contributors; with a single developer, the sequential path is more realistic.

---

## What this roadmap is NOT

- A commitment to ship every sub-project. The MVP may reveal that the FBA design needs fundamental changes; the roadmap is the current best guess.
- A spec. Each sub-project's spec is written when its turn comes, not now.
- A marketing document. It's an internal planning artifact. External communications should be derived from this but adapted to audience.
