# ZSwap-on-Aztec L1 Bridge — Audit Brief

**Audit target commit:** `2747700e48fc0eb8d84a489afdd4c4468d5918a9` (git tag `sub5c-audit-snapshot`)
**Audit window opens:** 2026-05-23 (Sub-5c code-complete)
**Scope owner:** ZSwap-on-Aztec core team
**Audit scope:** L1 portal contracts (`contracts-l1/`)

## Scope (in-scope contracts)

- `contracts-l1/src/TokenBridge.sol` — UUPS-upgradeable + AccessControl + Pausable L1 portal contract. **PRIMARY AUDIT TARGET.**
- `contracts-l1/src/interfaces/IInbox.sol` — interface mirror of Aztec's L1↔L2 message inbox. No logic; ABI shape only.
- `contracts-l1/src/interfaces/IOutbox.sol` — interface mirror of Aztec's L1↔L2 message outbox. No logic.
- `contracts-l1/src/lib/DataStructures.sol` — L1↔L2 message struct definitions + 4 domain-separator tag constants for the bridge's content hash.
- `contracts-l1/src/lib/TimeMath.sol` — minimal mirror of Aztec's `Epoch` user-defined value type (`type Epoch is uint256`).
- `contracts-l1/script/DeployAllBridges.s.sol` — Foundry deploy script that produces the production topology.

## Out-of-scope

- `@aztec/l1-artifacts@4.2.1` Inbox.sol + Outbox.sol implementations — the live Aztec rollup contracts on L1. ZSwap depends on these existing + behaving correctly; auditing them is Aztec's responsibility.
- Aztec L2 Noir contracts (`contracts/token/src/main.nr`, `contracts/orderbook/`, `contracts/pool/`, etc.) — separate Noir audit recommended (Aztec's `aztec-nr` is itself under continuous review).
- L2 ↔ L1 client integration (`cli/`, `aggregator/`, `tools/outbox-proof/`) — JS/TS code; safety surface limited to what L1 contracts enforce.
- OpenZeppelin v5.0.2 itself — pinned + vendored as `contracts-l1/lib/openzeppelin-contracts/` and `contracts-l1/lib/openzeppelin-contracts-upgradeable/`. Auditor reviews ZSwap's usage of OZ, not OZ's own code.

## Trust model

- **Owner:** Two TimelockController instances (OpenZeppelin v5.0.2 `TimelockController`):
  - **Governance timelock** — 7-day delay on mainnet (0 on testnet). Admin: 3-of-5 Gnosis Safe multisig. Has `GOVERNANCE_ROLE` on every TokenBridge: setMaxTvl, setL2TokenAddress, withdrawTreasuryDust, _authorizeUpgrade (UUPS), approveRecovery.
  - **Emergency timelock** — 0-day delay always. Admin: 2-of-3 separate Gnosis Safe multisig (distinct signer set from governance). Has `EMERGENCY_PAUSER_ROLE` on every TokenBridge: pause, unpause.

- **Role admin invariant:** `EMERGENCY_PAUSER_ROLE` is its own admin (set at `initialize` via `_setRoleAdmin`). The governance timelock holds `DEFAULT_ADMIN_ROLE` for everything else, but **cannot revoke or rotate the emergency role** — this prevents a compromised governance multisig from silently disabling the emergency pause path during a 7-day attack window.

- **TVL cap:** Per-portal soft limit (`uint256 maxTvl`). 0 = unlimited. Caps are token-native-units, NOT USD-normalized. Initial mainnet values: USDC 10,000_000_000 (~$10k), WETH 4_000_000_000_000_000_000 (~$10k @ $2.5k/ETH), wBTC 10_000_000 (~$10k @ $100k/BTC). Adjustable via `setMaxTvl` (7-day timelocked).

- **Per-asset deposit tracking:** Each `depositToL2Public/Private` writes a `Deposit` record keyed by `keccak256(msg.sender, secretHash)` for the 3-phase `recoverDeposit` flow. The original depositor is the only L1 entity that can recover. Knowledge of the secret alone is INSUFFICIENT for L1 recovery (the L2 claim path remains under secret-only control as before).

## Known issues (operator-acknowledged carryforwards)

1. **Fee-on-transfer / deflationary token incompatibility.** `_enforceTvlCap` projects post-deposit total as `balanceOf + amount`. This assumes a standard ERC20 where `amount` is exactly what arrives. Fee-on-transfer tokens would underflow the projection. **Mitigation:** ZSwap launches with USDC + WETH + wBTC — all standard ERC20s. Adding any non-standard token requires reviewing this assumption. Flagged in `setMaxTvl` NatSpec.

2. **`recoverDeposit`'s off-chain L2-consumption check.** Phase 2 (`approveRecovery`) requires the governance multisig to manually verify on L2 that the corresponding L1→L2 message has NOT been consumed. There is no on-chain L1 way to read L2 nullifier state directly. If governance approves a recovery for a deposit that WAS already consumed on L2, the maker double-spends. **Mitigation:** 90-day waiting period (`block.timestamp >= d.timestamp + 90 days`) gives operators ample time + observability. The audit should confirm the on-chain logic correctly prevents same-key replay (state clearing on execute) and that there is no race window across phases.

3. **`Number(BigInt)` precision in Prometheus exporter.** For 18-decimal tokens (WETH) at scales ≥ 9 ETH, gauge values lose precision (Number's 2^53 limit). Observability-level acceptable; not a fund-safety issue. Tools/exporters/src/l1-exporter.ts:NOTE.

4. **`exit_to_l1_private` ↔ `withdrawPrivate` pairing.** Sub-5b shipped `exit_to_l1_private` on L2 with a banner that "no L1 consumer exists yet." Sub-5c B3 ships `withdrawPrivate`. Both directions use `WITHDRAW_PRIVATE_TAG` content; cross-mode confusion impossible (different content hash from PUBLIC_TAG flow). Audit should confirm the byte-for-byte alignment between L1 + L2 reconstructions.

## Threat model

The following threats were considered during design. Each lists the mitigation in place; auditor verifies sufficiency.

| ID | Threat | Mitigation |
|---|---|---|
| **T-1** | Portal fund drain via direct external call | All withdraw paths go through `outbox.consume()` which is one-shot per (epoch, leafIndex) per Aztec rollup contract; `whenNotPaused` guard; `SafeERC20` |
| **T-2** | Ownership takeover via initialize re-entry | `Initializable._disableInitializers()` in constructor; `initializer` modifier on `initialize`; verified in A3 + A2 tests |
| **T-3** | Replay via Outbox double-consume | Aztec Outbox's `hasMessageBeenConsumedAtEpoch` flag; `outbox.consume` reverts on already-consumed; `test_withdraw_doubleConsume_reverts` covers |
| **T-4** | Governance collusion → drain | 7-day timelock window for all governance ops; community observation possible during window |
| **T-5** | Upgrade-during-pause exploit | Emergency role can only pause/unpause; cannot upgrade (`_authorizeUpgrade` requires GOVERNANCE_ROLE). An emergency pause cannot bundle a malicious upgrade |
| **T-6** | Treasury dust sweep abuse | `withdrawTreasuryDust` reverts if token == l1Token; can only sweep accidentally-sent OTHER ERC20s |
| **T-7** | TVL cap bypass | Pre-transfer balance projection check; assumes standard ERC20 (see Known Issue #1) |
| **T-8** | Recovery race / double-spend across L1+L2 | Sender-identity gate (only original depositor); 90-day window; multisig approval; full state clearing on `executeRecovery`; secret leak insufficient |
| **T-9** | Content-hash collision across flows | 4 domain-separator tags (DEPOSIT_PUBLIC/PRIVATE, WITHDRAW_PUBLIC/PRIVATE); 248-bit field-fitting values; ASCII-readable in logs; same byte values on L1 + L2 |
| **T-10** | Initialize race (impl init before proxy points at it) | `_disableInitializers()` in implementation constructor blocks any direct initialize on the implementation; only the proxy's delegated initialize works |
| **T-11** | Emergency-role takeover via governance | `EMERGENCY_PAUSER_ROLE` self-admin invariant set at initialize; governance cannot reach the role |
| **T-12** | Stale codegen → CLI misinvocation | Operator concern; runbook documents `pnpm codegen` step pre-deploy. Defense-in-depth: every contract function uses custom errors + revert messages so a wrong-ABI call returns a structured error, not silent corruption |

## Dependencies + supply chain

- **OpenZeppelin v5.0.2** (`contracts-l1/lib/openzeppelin-contracts/` + `openzeppelin-contracts-upgradeable/`) — pinned tag, vendored, not modified.
- **forge-std v1.7.x** — pinned in `lib/forge-std/`.
- **Foundry** — solc 0.8.27, via_ir = true, optimizer_runs = 200. Defined in `contracts-l1/foundry.toml`.
- **Aztec L1 artifacts** — `@aztec/l1-artifacts@4.2.1` (Inbox + Outbox interfaces mirrored into our `IInbox.sol` + `IOutbox.sol`).
- No on-chain proxy library used beyond `ERC1967Proxy` from OZ.

## Test coverage at audit-window-open

Post-Sub-5c numbers (run from `contracts-l1/`):

- **Foundry tests: 31 pass** (`forge test`):
  - 25 TokenBridgeTest unit tests in `contracts-l1/test/TokenBridge.t.sol` (covering deposit + withdraw + withdrawPrivate + pause + TVL cap + recoverDeposit 3-phase + role-separation + EMERGENCY_PAUSER_ROLE self-admin invariant)
  - 6 BridgeFlowTest integration tests in `contracts-l1/test/BridgeFlow.t.sol` (covering multisig→timelock→bridge governance flow + governanceTimelockCannotPause)
- **Noir TXE tests: 5 bridge-mode tests** in `contracts/token/src/test.nr` (Docker-blocked local execution; CI runs).
- **Forge coverage:** run `forge coverage --report lcov` for line/branch coverage; commit the LCOV.

## Out-of-band verification artifacts

- **Etherscan source verification** — `forge script ... --verify --etherscan-api-key $ETHERSCAN_API_KEY` is the canonical deploy invocation per sub5c-runbook.md. All 6 contracts (2 TimelockControllers + 3 TokenBridge proxies + 3 TokenBridge implementations) verified post-deploy.
- **Slither static analysis** — `tools/audit/run-slither.sh` runs Slither against `contracts-l1/`. Output committed as `contracts-l1/audit/slither-<date>.txt`.
- **Foundry gas report** — `forge test --gas-report > contracts-l1/audit/gas-report-<date>.txt` at audit window open.

## Audit deliverables expected

The audit firm should produce:

1. **Findings report** — Critical / High / Medium / Low / Informational categorization. Each finding with: location (file:line), description, impact, recommended fix.
2. **Threat model coverage** — confirmation each T-1..T-12 mitigation is sufficient, OR new threats identified.
3. **Code recommendations** — non-blocking improvements (style, gas, naming, NatSpec) at any severity.
4. **Sign-off statement** — text usable in a public bug-bounty announcement.

## Post-audit process

- All Critical + High findings: fixed BEFORE mainnet open, separate PR per finding referencing audit ID.
- Medium findings: triaged; may be accepted with explicit rationale in this doc.
- Low + Informational: tracked in GitHub issues; addressed during normal sprint.
- Findings remediation is its own project (Sub-5d candidate); Sub-5c does NOT block on the audit report.
