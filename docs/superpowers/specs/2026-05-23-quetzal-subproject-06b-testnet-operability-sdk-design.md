# Sub-project 6b: Testnet Operability + SDK Extraction — Design

**Date:** 2026-05-23  
**Status:** Design (post-brainstorm; pending user spec review)  
**Parent:** Sub-6 (Privacy + operability) — Sub-6a (Anonymity Set) shipped; Sub-6c will carry Sub-6's remaining privacy items (trade-direction fingerprinting, PXE tagging-window relaxation, aggregator-side metadata reveals).

## Goal

When frontend work begins, no testnet-operability gap should remain in the backend. The current state has 4 runners that have never executed on live Aztec testnet + Sepolia, a fresh C4 `bridge tick` code path that has never sent an L2 tx, and a CLI-only consumer interface (no programmatic API for the frontend to import).

Sub-6b closes all of these in one sub-project:

1. **Phase 1** — Execute the 4 testnet runners against alpha-testnet + Sepolia; fix bugs found.
2. **Phase 2** — Extract `@quetzal/sdk` package from CLI command bodies; CLI becomes a thin commander wrapper.
3. **Phase 3** — Rewrite the 4 runners on the SDK; re-execute; confirm parity.
4. **Phase 4** — Frontend onboarding pack (`sdk/README.md` + `docs/frontend-quickstart.md` + 3 runnable examples).

## Out of scope (Sub-6c or later)

- Trade-direction fingerprinting mitigation (Sub-6 item #2)
- PXE tagging-window relaxation (Sub-6 item #5)
- Aggregator-side metadata reveals (Sub-6 item #6)
- Event emitters / WebSocket streams (frontend can poll initially)
- Production mainnet deployment (Sub-5c runbook already covers)
- npm publish (monorepo workspace is enough; publish in a later iteration)
- Production-grade observability hooks (basic logging only)
- Cross-network bridge UX (deposit on mainnet, claim on testnet) — single-network flows only

## Constraints

- **Privacy-maximalism:** maintained throughout. SDK does not introduce new public state or weaken the existing private-by-default flows.
- **Subagent model policy:** Sonnet and Opus only; never Haiku.
- **Working branch:** `main` (no worktrees).
- **PreToolUse security hook:** rejects shell-injecting subprocess patterns; SDK + scripts use `spawn`.

## Phase 1 — Testnet validation

### Scope

Execute the 4 runners in dependency order:

```
1.1 Sub-3 4-deploy validation
       -> (provides L2 addresses for downstream)
1.2 Sub-5b bridge runner execution
       -> (deploys aUSDC/aWETH bridges; Sub-6a S2 depends on it)
1.3 Sub-6a anonymity runner execution
       -> (proves bulk-submit + cancel-decoys)
1.4 C4 bridge tick smoke (--split-into 3 --interval-days 0)
```

### Per-runner deliverables

For each runner: complete any deferred step bodies (Sub-5b D2 outbox proof + Sub-6a E2 S1-S8 step bodies + C4 tick body assertions), execute against alpha-testnet, produce a green run report under `docs/superpowers/runs/`.

### Sub-3 4-deploy validation (Task 1.1)

- Deploy USDC + WETH + wBTC token contracts (`scripts/deploy-tokens.ts` already covers).
- Deploy Orderbook contract with deterministic address.
- Deploy Treasury contract.
- Deploy AggregatorRegistry contract.
- Validate `close_epoch_and_clear_verified` works on the deployed Orderbook (the Sub-3 4-deploy circular dependency was solved by Sub-5a's deterministic address fix; this is the live proof).
- Output: `docs/superpowers/runs/sub6b-phase1-deploy.md` — all deployed L2 addresses, first close-epoch tx hash, deterministic address derivation log.
- Walltime estimate: 30-45 minutes.

### Sub-5b bridge runner (Task 1.2)

- Complete the 12-step bodies in `scripts/testnet-sub5b-bridge.ts` (Sub-5b shipped scaffolds; some bodies deferred per memory `subproject5b-complete`).
- Execute USDC + WETH paths end-to-end:
  - `depositToL2Private` (L1) -> wait Aztec messaging window (~30 min) -> `claim_private` (L2)
  - `exit_to_l1_public` (L2) -> wait epoch settlement -> L1 `withdraw` via `buildOutboxProof` siblingPath
- Capture all tx hashes + the siblingPath JSON for the eventual SDK extraction.
- Output: `docs/superpowers/runs/sub6b-phase1-sub5b.md`.
- Walltime estimate: 2-3 hours (dominated by Aztec messaging window).

### Sub-6a anonymity runner (Task 1.3)

- Complete the 8-step bodies in `scripts/testnet-sub6-anonymity.ts` (E2 shipped scaffolds with `console.warn` placeholders).
- Execute K=5 bulk submit (1 real + 4 decoys; A5 downsize), registry round-trip, claim-fill with decoy filter, cancel-decoys batch reclaim, round-amount bridge advisory block + ack.
- Validate: K=5 lets a maker submit at least 2 consecutive bulk-with-decoys without hitting tagging-window stall (PXE caps at ~20 unfinalised private submits per wallet; 2 bulks consume 10 slots, leaving ~10 for follow-up actions like `claim` and `cancel-decoys`).
- Output: `docs/superpowers/runs/sub6b-phase1-sub6a.md`.
- Walltime estimate: 1-2 hours.

### C4 bridge tick smoke (Task 1.4)

- Use the bridge state machine from C4 (`bridge tick` + `--auto-claim`): `--split-into 3 --interval-days 0`.
- One deposit (Sub-5b machinery, ~3 USDC L1->L2), three `bridge tick` invocations each ~0 days apart (just under the time-check).
- Validate: `TokenBridge.withdraw(amount, recipient, l2Epoch, leafIndex, siblingPath)` ABI sequence matches the real deployed contract; `buildOutboxProof` returns ready status; viem `writeContract` succeeds on Sepolia.
- Output: `docs/superpowers/runs/sub6b-phase1-c4-tick.md`.
- Walltime estimate: ~1 hour.

### Bug-fix bucket (Task 1.5)

Any bugs surfaced in 1.1-1.4 get minimal CLI-side fixes (each in its own commit). Bug classification:

- **Blocking** (a runner cannot reach green without the fix): fix in Task 1.5, runner re-executes.
- **Non-blocking** (runner reaches green but a behavior is suboptimal, e.g., a logged warning, a non-critical step that times out gracefully): log to `docs/superpowers/specs/sub6b-followups.md` for Sub-6c review; runner is considered green.
- **Structural** (requires contract redeploy or substantial Noir change): runner is marked yellow in Phase 1 summary; explicit user decision needed before Phase 2 starts.

Phase 1 advances to Phase 2 only when all 4 runners are at least yellow (or green).

### Phase 1 close-out (Task 1.6)

`docs/superpowers/runs/sub6b-phase1-summary.md` — green-status table summarizing all 4 runs + any bug-fix commits + readiness assertion ("Phase 1 closed; safe to begin Phase 2").

### Credentials

Operator creates `.env.testnet` in the project root (gitignored) with:

```
AZTEC_NODE_URL=https://aztec-alpha-testnet.aztec.network
AZTEC_PRIVATE_KEY=0x...
L1_RPC_URL=https://sepolia.infura.io/v3/...
L1_PRIVATE_KEY=0x...
L1_MAKER_ADDR=0x...
DEPLOYER_PK=0x...
```

Plus, after Task 1.1 deploys, the file is appended with:

```
ORDERBOOK_ADDR=0x...
TREASURY_ADDR=0x...
AGGREGATOR_REGISTRY_ADDR=0x...
USDC_L1_ADDR=0x...
WETH_L1_ADDR=0x...
USDC_BRIDGE_ADDR=0x...
WETH_BRIDGE_ADDR=0x...
AUSDC_L2_ADDR=0x...
AWETH_L2_ADDR=0x...
```

Each runner sources `.env.testnet` via `dotenv -e .env.testnet -- pnpm tsx scripts/...`. Add `.env.testnet` to `.gitignore` as Task 1.0 (one-line setup).

## Phase 2 — SDK extraction

### Goal

Lift validated CLI command bodies into `@quetzal/sdk` package. CLI becomes a thin commander wrapper that imports SDK functions.

### Package structure

```
sdk/
+-- package.json          @quetzal/sdk; workspace; type=module
+-- tsconfig.json
+-- src/
    +-- index.ts          public re-exports
    +-- client.ts         QuetzalClient (PXE+wallet+config holder)
    +-- orders.ts         placeOrder, claimFill, cancelOrder, placeOrderBulk
    +-- bridge.ts         bridgeDeposit, bridgeClaim, bridgeExit, bridgeTick
    +-- reads.ts          getOrders, getPools, getCurrentEpoch, getBalance
    +-- aggregator.ts     registerAggregator, broadcastReveal (Sub-3)
    +-- privacy/
    |   +-- decoy-registry.ts
    |   +-- amount-heuristic.ts
    |   +-- bridge-history.ts
    +-- types.ts          ScheduledExit, OrderSide, ClearingPublic, etc.
    +-- errors.ts         QuetzalError class hierarchy
    +-- config.ts         NetworkConfig + TokenAlias resolver
    +-- wallet/
        +-- schnorr.ts    Schnorr {secret} adapter
        +-- pxe.ts        external {pxe} adapter
        +-- aztec-wallet.ts  Aztec Wallet provider adapter
```

### Public API (sketch)

```typescript
import { QuetzalClient } from "@quetzal/sdk";

const client = await QuetzalClient.connect({
  network: "alpha-testnet",
  account: { type: "schnorr", secret: process.env.AZTEC_PRIVATE_KEY! },
  // OR { type: "external-pxe", pxe }
  // OR { type: "aztec-wallet", provider: window.aztec }
});

const result = await client.orders.placeOrder({
  side: "sell",
  amount: 1_234_567n,
  limitPrice: 5000n,
  path: ["tUSDC", "tETH"],
});
// result: { txHash, nonce, orderNonce, epoch }

const fill = await client.orders.claimFill({ nonce: result.nonce, epoch: result.epoch });
```

### Wallet adapter contract

```typescript
export interface WalletAdapter {
  readonly address: AztecAddress;
  readonly pxe: PXE;
  signAndSend(tx: PreparedTx): Promise<TxReceipt>;
}
```

Three concrete implementations:
- `SchnorrSecretAdapter` — derives from `{secret}`; current CLI path
- `ExternalPxeAdapter` — wraps an externally provided PXE instance
- `AztecWalletAdapter` — adapts the Aztec Wallet provider (`window.aztec`) for frontend

### Error types

```typescript
export class QuetzalError extends Error {
  constructor(public code: string, message: string, public cause?: unknown) { ... }
}
export class OrderError extends QuetzalError { ... }    // code: "EPOCH_CLOSED" | "INVALID_PATH" | ...
export class BridgeError extends QuetzalError { ... }   // code: "L2_TX_FAILED" | "L1_CLAIM_NOT_READY" | ...
export class ConfigError extends QuetzalError { ... }   // code: "MISSING_ENV" | "UNKNOWN_TOKEN" | ...
```

### CLI conversion

After Phase 2: `cli/src/commands/order.ts` (and siblings) become ~30-line commander wrappers:

```typescript
import { openClient } from "../client.js"; // wraps QuetzalClient.connect from config
import { formatOrderResult } from "../format.js";

export function registerOrder(program: Command): void {
  program
    .command("order")
    .command("place")
    .option(/* ... existing options ... */)
    .action(async (_opts, cmd) => {
      const opts = cmd.optsWithGlobals();
      const client = await openClient(opts);
      const result = await client.orders.placeOrder({/* ... */});
      console.log(formatOrderResult(result));
    });
}
```

All existing CLI tests still pass after the conversion (74/74 unit tests as baseline — they cover the CLI surface and should be unaffected by SDK extraction since the formatting + IO concerns stay in CLI).

### Phase 2 task list

1. **Task 2.1** — `sdk/` scaffold: package.json, tsconfig, workspace wiring (`pnpm-workspace.yaml`), build script. Verify `pnpm -F @quetzal/sdk build` succeeds (empty package).
2. **Task 2.2** — `sdk/src/types.ts` + `sdk/src/errors.ts` + `sdk/src/config.ts` — move types from `cli/src/types.ts` (if exists) + define `QuetzalError` hierarchy + `NetworkConfig` + `TokenAlias` resolver (the `resolveTokenDecimals` from D2 lives here).
3. **Task 2.3** — `sdk/src/wallet/{schnorr,pxe,aztec-wallet}.ts` — three wallet adapters + shared `WalletAdapter` interface.
4. **Task 2.4** — `sdk/src/client.ts` — `QuetzalClient.connect()` + lifecycle (stop, getAddress, etc.). Currently this work lives in `cli/src/wallet.ts`'s `openCli(config, accountIndex)` (returns `CliContext` with `wallet`, `node`, contracts). Lift the contract-registration + node-wait + wallet-bootstrap into SDK; CLI keeps a thin `openClient` adapter that calls SDK's `QuetzalClient.connect()` and reshapes the result into `CliContext`.
5. **Task 2.5** — `sdk/src/orders.ts` — extract `placeOrder` + `placeOrderBulk` + `claimFill` + `cancelOrder` from `cli/src/commands/order.ts` + `claim.ts` + `cancel.ts`.
6. **Task 2.6** — `sdk/src/bridge.ts` — extract `bridgeDeposit` + `bridgeClaim` + `bridgeExit` + `bridgeTick` from `cli/src/commands/bridge.ts`. The C4 `bridge tick` body lifts cleanly here.
7. **Task 2.7** — `sdk/src/reads.ts` + `sdk/src/aggregator.ts` + `sdk/src/privacy/*` — move read-only helpers + Sub-3 aggregator flows + privacy modules (`decoy-registry`, `amount-heuristic`, `bridge-history` from B1/D1/C1).
8. **Task 2.8** — CLI conversion: every `cli/src/commands/*` action body becomes a thin wrapper around the SDK. `pnpm tsc --noEmit` + `pnpm test` stay green.
9. **Task 2.9** — `sdk/index.ts` public re-exports + smoke `pnpm -F @quetzal/sdk build` + `pnpm -F @quetzal/cli build` end-to-end.

## Phase 3 — SDK regression via testnet

### Strategy

Rewrite each Phase 1 runner using the SDK. The original CLI-based runners are replaced (not duplicated) — single bake site, one ground-truth. Git history preserves the originals if needed.

### Per-runner rewrite (Tasks 3.1-3.3)

- **Task 3.1** — `scripts/testnet-sub5b-bridge.ts` rewritten to use `client.bridge.*` instead of CLI-subprocess invocations. Re-execute against testnet; capture tx hashes; assert receipt-parity with Phase 1.2 run.
- **Task 3.2** — `scripts/testnet-sub6-anonymity.ts` rewritten to use `client.orders.placeOrderBulk` + `client.orders.claimFill({filterDecoys: true})` + `client.bridge.exit({ackRound: true, ackDelay: true})`. Re-execute; assert parity with Phase 1.3.
- **Task 3.3** — C4 bridge tick smoke rewritten as `scripts/testnet-sub6b-bridge-tick.ts` using `client.bridge.tick({autoClaim: true})`. Re-execute; assert parity with Phase 1.4.

### Phase 3 close-out (Task 3.4)

`docs/superpowers/runs/sub6b-phase3-sdk-parity.md` — green table comparing:

| Runner | Phase 1 (CLI) tx count | Phase 3 (SDK) tx count | Parity? |
|---|---|---|---|
| sub5b-bridge | N_1 | N_2 | yes/no |
| sub6-anonymity | M_1 | M_2 | yes/no |
| c4-bridge-tick | K_1 | K_2 | yes/no |

If parity holds: SDK extraction is validated end-to-end. If not: list deltas. "Non-blocking" means the same business outcome was reached (e.g., the order placed, the bridge claim landed) but with a different intermediate tx count -- carry-forward to Sub-6c. "Blocking" means the SDK runner failed to reach the same business outcome the CLI runner reached -- Phase 3 stays open until resolved.

## Phase 4 — Frontend onboarding pack

### Goal

Frontend dev's path from "0 to first transaction" is 30 minutes.

### Deliverables

- **Task 4.1** — `sdk/README.md`: package overview + install + minimal example + full public API table (every exported function with signature + 1-line description).
- **Task 4.2** — `docs/frontend-quickstart.md`:
  - Bird's eye view for a frontend dev with zero project context
  - Aztec Wallet provider setup (link to upstream Aztec docs)
  - `QuetzalClient.connect()` examples for all 3 wallet adapter variants
  - Walkthrough: "First order place" (~10 lines of code with explanations)
  - Walkthrough: "Bridge deposit + claim" (~15 lines)
  - Error handling examples: every `QuetzalError.code` with recommended fallback behavior
  - Network selection table: `alpha-testnet` vs `sandbox` vs `mainnet` (mainnet links to Sub-5c runbook caveats)
- **Task 4.3** — `examples/`:
  - `examples/01-place-order.ts` (~30 lines, runs against testnet from `.env.testnet`)
  - `examples/02-bridge-deposit.ts` (~30 lines)
  - `examples/03-bulk-with-decoys.ts` (~40 lines)
  - All 3 verified to run via `dotenv -e .env.testnet -- pnpm tsx examples/<n>.ts`.

## Test scoreboard target

At Sub-6b close-out:

- CLI unit tests: still 74/74 green (no regression from SDK extraction)
- SDK unit tests: new, ~30 cases covering wallet adapters + error types + config resolver
- Testnet runners (SDK-based): 3/3 green
- Sub-3 4-deploy: validated on live testnet
- Phase 1 reports: 4 green
- Phase 3 parity table: all-green

## Test scoreboard non-targets

- New L1 contract tests (no L1 changes)
- New Noir circuit tests (no contract changes; SDK is TS only)
- Property-based testing of SDK (deferred to Sub-7)

## Branch + commit policy

- All work on `main` (no worktrees)
- Each task is one or more atomic commits
- Phase boundaries marked with `git tag sub6b-phase{N}-done`

## Carry-forwards documented at close-out

- Sub-6c privacy items (2/5/6 from Sub-6 brainstorm)
- npm publish + semver release process
- WebSocket event streams (currently polling-only)
- Property-based testing of SDK
- Frontend integration itself (out of scope; Sub-6b prepares the ground)

## Success criterion

A frontend dev can:
1. Clone the repo
2. `pnpm install`
3. Read `sdk/README.md` + `docs/frontend-quickstart.md`
4. Connect their wallet via `QuetzalClient.connect({ account: ... })`
5. Call `client.orders.placeOrder(...)` and get a working tx on testnet

Without ever reading the CLI source code or the contract source code.
