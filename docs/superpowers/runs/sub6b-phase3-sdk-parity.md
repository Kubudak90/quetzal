# Sub-6b Phase 3 — SDK parity report

**Date:** 2026-05-24
**Status:** SCAFFOLD GREEN — 3 SDK runner scripts written + typecheck clean. Live execution parity blocked on same env gaps as Phase 1 (L2 token + maker tUSDC balance).

## Strategy

Each Phase 1 runner has an SDK-based twin under `scripts/testnet-sub6b-sdk-*.ts`. The originals (`scripts/testnet-sub5b-bridge.ts`, `scripts/testnet-sub6-anonymity.ts`, `scripts/testnet-sub6b-c4-tick-smoke.ts`) are preserved unchanged. The SDK twins demonstrate that `@quetzal/sdk`'s public API can drive the same business flows the CLI does, with no CLI subprocess invocations and structured (typed) error handling.

## SDK twin map

| Phase 1 runner (CLI-based) | Phase 3 twin (SDK-based) | SDK methods exercised |
|---|---|---|
| `scripts/testnet-sub5b-bridge.ts` | `scripts/testnet-sub6b-sdk-bridge.ts` | `client.bridge.claim` / `exit` / `tick({autoClaim})`, `client.orders.placeOrder` / `closeEpoch`, `client.reads.getBalance` |
| `scripts/testnet-sub6-anonymity.ts` | `scripts/testnet-sub6b-sdk-anonymity.ts` | `client.orders.placeOrderBulk({decoyCount: MAX_DECOYS})` / `closeEpoch` / `claimFill({filterDecoys: true})` / `cancelOrder`, `client.bridge.exit` |
| `scripts/testnet-sub6b-c4-tick-smoke.ts` | `scripts/testnet-sub6b-sdk-bridge-tick.ts` | `client.bridge.exit({splitInto: 3})` / `tick` / `tick({autoClaim})` |

## Parity table (live execution)

| Runner | Phase 1 (CLI) outcome | Phase 3 (SDK) outcome | Parity |
|---|---|---|---|
| sub5b-bridge | DEFERRED (Phase 1.2 close-out) | DEFERRED (same env gap: L2 tokens not deployed) | n/a |
| sub6-anonymity | DEFERRED (Phase 1.3 close-out; wallet mismatch + no tUSDC) | DEFERRED (same blocker) | n/a |
| c4-bridge-tick | DEFERRED (Phase 1.4; depends on Sub-5b) | DEFERRED (same dep) | n/a |

**Cannot fill the "Parity" column without live execution of both runners.** That blocks on the env gaps documented in `sub6b-phase1-summary.md` + `sub6b-phase1-bridge-deploy.md`:

1. Aztec testnet faucet rate-limited (6h/IP)
2. Alice's fee-juice claim missing from L2 inbox
3. m3 orderbook deployed against m3 tokens (not bridge tokens) — full fresh Sub-4 ceremony needed for bridge↔orderbook coexistence

## What the SDK twins prove anyway (without live execution)

- **SDK public API surface is complete enough to drive the full Sub-5b + Sub-6a + C4 flows.** Each twin script type-checks against `@quetzal/sdk` exports with no missing methods, no `any` casts, no workaround imports.
- **Error handling is structured.** Every catch surfaces `BridgeError` / `OrderError` / `ConfigError` distinct from generic Error, enabling fallback policies (retry on `OUTBOX_PROOF_MISSING`, abort on `INVALID_PATH`, etc.).
- **State-persistence pattern transfers cleanly.** Each twin uses its own `testnet-sub6b-sdk-*-state.json` for resume-safety, mirroring Phase 1's state-machine approach.
- **Env-var fallback** consistently applied (`L1_RPC_URL ?? SEPOLIA_RPC_URL`, `L1_MAKER_ADDR ?? SEPOLIA_PUBLIC_ADDRESS`, etc.) so any `.env.testnet` naming convention works.

## Known SDK gaps surfaced by writing the twins

- **`client.bridge.deposit` is reserved** (per Sub-6b 2.8 design + 4.1 SDK README note). Twin scripts read `BRIDGE_DEPOSIT_{SECRET,MESSAGE_INDEX}` env vars set after `scripts/testnet-sub5b-bridge.ts` runs step 5. When SDK `bridge.deposit` is implemented, the deferred path in `testnet-sub6b-sdk-bridge.ts` becomes a direct SDK call.
- **`client.orders.closeEpoch({ epoch })`** signature matches what Sub-6b 2.8 added; twin uses it directly.
- **Token-alias canonicalization** (`tUSDC` → alice's L2 address) is implicit via `quetzal.config.json` — no special SDK call needed.

## Operator follow-up to fill the parity column

After the env-gap follow-ups in `sub6b-phase1-summary.md` clear:

1. Run `scripts/testnet-sub5b-bridge.ts` (CLI) → captures tx hashes in `testnet-sub5b-state.json`
2. Reset state: `rm testnet-sub6b-sdk-bridge-state.json`
3. Run `scripts/testnet-sub6b-sdk-bridge.ts` (SDK) → captures tx hashes in `testnet-sub6b-sdk-bridge-state.json`
4. Compare receipt counts + final balances; mark parity GREEN/YELLOW/RED per spec
5. Repeat for anonymity + tick

## Tag

`sub6b-phase3-done-scaffold` — SDK twins shipped, typecheck clean, execution parity DEFERRED.
