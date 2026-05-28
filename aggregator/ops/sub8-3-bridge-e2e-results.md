# Sub-8.3 — Bridge E2E testnet validation results

**Date**: 2026-05-28
**Goal**: Execute the full L1↔L2 bridge round trip (deposit → claim → exit →
L1 withdraw) on Aztec testnet to validate the Sub-7c UI surface end-to-end.

## Environment

| Field | Value |
|---|---|
| Aztec node | `https://rpc.testnet.aztec-labs.com` |
| Aztec rollup version | `4127419662` |
| L1 chain | Sepolia (`11155111`) |
| L1 USDC | `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238` |
| L1 USDCBridge | `0x219ffbb6a504fcd69ae80d1e70db699b48a9936b` |
| L2 aUSDC | `0x19aec530674b3b54977b5216fdcad01d5219346e902f2bcb84653a950dd23369` |
| L1 operator | `0xcF582A37AaE1E580b63666587FFa42d84169bA62` (`.env.testnet L1_PUBLIC_ADDRESS`) |
| L2 maker | `0x2399a3557af5cf714812a6911908d2fe998030b7b0c31c054a76034bfd6cb8dc` (`deploy-bridge-state.json`) |

Reused the existing operator wallet (the one used to deploy the bridges in
Sub-5b Phase 1.4) rather than minting a fresh test wallet — saves a faucet
drip and keeps the round-trip in a single, traceable account on both chains.

## Test amounts

- Deposit: 10 USDC (`10_000_000` at 6 decimals)
- Exit: 5 USDC (`5_000_000`)
- Expected net L1 USDC delta: `-5 USDC`

## Step-by-step results

Tx hashes, balance deltas, and per-step elapsed seconds are persisted live in
`testnet-bridge-e2e-state.json` (gitignored). This document captures the
post-run snapshot.

| # | Step | Status | Tx hash / value | Elapsed (s) |
|---|---|---|---|---|
| 1 | L1 `USDC.approve(bridge, 10 USDC)` | _running_ | _filled at run completion_ |  |
| 2 | L1 `USDCBridge.depositToL2Public` | _pending_ |  |  |
| 3 | Sleep 4 min for L1→L2 inbox window | _pending_ |  |  |
| 4 | L2 `aUSDC.claim_public` | _pending_ |  |  |
| 5 | Verify L2 aUSDC balance ↑10 USDC | _pending_ |  |  |
| 6 | L2 `aUSDC.exit_to_l1_public(5 USDC)` | _pending_ |  |  |
| 7 | Poll `buildOutboxProof` (epoch finalisation) | _pending_ |  |  |
| 8 | L1 `USDCBridge.withdraw(...)` | _pending_ |  |  |
| 9 | Verify L1 USDC balance Δ ≈ −5 USDC | _pending_ |  |  |

Final results section below is appended after the script run completes.

## Sub-7c verdict

_Filled in below at run completion._

## Notes

- The script is `scripts/testnet-bridge-e2e.ts`, resume-safe via
  `testnet-bridge-e2e-state.json`.
- Steps 1-6 should complete in 10-25 min.
- Step 7 (outbox proof) is bottlenecked on the Aztec testnet sequencer
  proving the exit epoch on L1 — typically 30-90 min per RUNBOOK-bridge.md.
  If that exceeds the session window, state is preserved and a rerun
  resumes from step 7 without re-doing 1-6.

## Run completion

_(appended live when the script exits)_
