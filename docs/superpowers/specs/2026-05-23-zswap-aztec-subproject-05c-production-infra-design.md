# Sub-project 5c: Production Infrastructure

**Status:** Design
**Date:** 2026-05-23
**Parent project:** [Quetzal](2026-05-14-zswap-aztec-mvp-design.md) — sub-project 5 (final 5a / 5b / 5c split).
**Predecessor specs:**
- [Sub-5a Deterministic Addresses + Carryforward Fixes](2026-05-23-zswap-aztec-subproject-05a-deterministic-addresses-design.md) — SHIPPED.
- [Sub-5b L1 Bridge](2026-05-23-zswap-aztec-subproject-05b-l1-bridge-design.md) — SHIPPED.

## Goal

Close every remaining code-blocking gap for mainnet open of Quetzal and ship the production operations stack alongside it. Three independent work buckets: (A) bridge completion — `EmergencyPauser` role separation, `siblingPath` construction via standalone subprocess binary, `deploy-bridge.ts` end-to-end automation. (B) bridge expansion — `wBTC` as third asset, `recoverDeposit` flow for lost L2 wallets, `withdrawPrivate` L1 consumer. (C) ops infrastructure — Prometheus + Grafana + Alertmanager VPS stack, opt-in relayer service, audit-prep materials, on-call playbook, runbook upgrade. After Sub-5c ships, Quetzal is mainnet-ready in `$10k` cap mode pending only the external audit.

## Non-Goals

- L1 portal v2 upgrade design — Sub-5c ships v1; v2 is a separate post-launch project.
- Cross-chain bridges to non-Ethereum L1s — explicit never (privacy-maximalist Quetzal is Aztec-on-Ethereum only).
- Statistical privacy leak mitigation (deposit↔claim temporal linkage) — Sub-6 dummy-order territory.
- Audit findings remediation — separate project; planned reactively from audit deliverable.
- Public bug-bounty launch — operator team initiates post-Sub-5c.
- L1 portal mainnet audit itself — out-of-band coordination work (audit firm selection, contract terms, payment). Sub-5c delivers the prep materials only.
- Production on-call rotation creation — operator team process; Sub-5c delivers the playbook only.

## Section 1 — Architecture + Component Map

Sub-5c partitions into three independent buckets that may run partially in parallel:

```
┌─────────────────────────────────────────────────────────────┐
│ Bucket A — Bridge completion (mainnet code-blocking)        │
├─────────────────────────────────────────────────────────────┤
│ A1. EmergencyPauser topology                                │
│     - Separate 2-of-3 EmergencyMultisig                     │
│     - Separate TimelockController(delay=0) for pause only   │
│     - TokenBridge.sol: PAUSER_ROLE via OZ AccessControl     │
│     - Production: both governanceTL + emergencyTL as roles  │
│                                                             │
│ A2. siblingPath standalone TS subprocess binary             │
│     - bin/quetzal-outbox-proof (esbuild bundle, optional pkg) │
│     - CLI: bridge claim-l1 subcommand invokes subprocess    │
│                                                             │
│ A3. deploy-bridge.ts automation                             │
│     - Port testnet-m1-hello.ts state-persisted bootstrap    │
│     - Forge broadcast log parsing                           │
│     - Single command for mainnet/testnet deploy             │
└─────────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────────┐
│ Bucket B — Bridge expansion (not strictly mainnet-blocking  │
│         but ships together; needed during ramp phase)       │
├─────────────────────────────────────────────────────────────┤
│ B1. wBTC bridge (third asset)                               │
│     - TokenBridge.sol parametric — deploy script + CLI      │
│       alias + quetzal.config.json updates only                │
│                                                             │
│ B2. recoverDeposit(secret, l1Recipient)                     │
│     - Maker-side proof-of-ownership                         │
│     - 90-day time-lock + governance multisig approval       │
│       (double-spend prevention: L1 cannot verify L2         │
│       consumption directly)                                 │
│                                                             │
│ B3. withdrawPrivate(amount, recipient, l2Epoch, leafIndex,  │
│     siblingPath) — WITHDRAW_PRIVATE_TAG consumer            │
└─────────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────────┐
│ Bucket C — Ops infrastructure                               │
├─────────────────────────────────────────────────────────────┤
│ C1. Prometheus + Grafana + Alertmanager (VPS-hosted)        │
│     - L1 exporter: bridge TVL, pause state, pending msgs    │
│     - L2 exporter: clearings/epoch, treasury balance,       │
│       open orders, registry size                            │
│     - Grafana dashboards: bridge health, MEV-protection     │
│       health, aggregator competition                        │
│     - Alertmanager → Slack + PagerDuty                      │
│                                                             │
│ C2. Optional opt-in relayer service                         │
│     - Aggregator daemon extension (Sub-3 registry reuse)    │
│     - Maker exit_to_l1_* + opt-in fee → Treasury            │
│     - Daemon polls Outbox + auto cast send                  │
│     - Fee split: relayer X%, Treasury (100-X)%              │
│                                                             │
│ C3. Audit-prep materials                                    │
│     - contracts-l1/AUDIT.md (scope, threat model,           │
│       known issues, dependencies)                           │
│     - Commit-freeze git tag (sub5c-audit-snapshot)          │
│     - Test coverage + Slither report                        │
│                                                             │
│ C4. On-call playbook                                        │
│     - docs/on-call-playbook.md                              │
│     - Incident severity classification                      │
│     - Escalation tree + runbook links                       │
│                                                             │
│ C5. sub5c-runbook.md update                                 │
│     - Sub-5b's sub5b-runbook.md extended                    │
│     - Monitoring setup, relayer ops, incident response      │
└─────────────────────────────────────────────────────────────┘
```

**Total:** ~18 tasks across 7 phases (A-G), ~5-6 weeks. Buckets can run partially in parallel: A must complete before mainnet opens; B should ship with A for completeness during ramp; C audit-prep must precede the audit window.

## Section 2 — L1 Contract Changes (Buckets A + B)

### A1. EmergencyPauser — TokenBridge.sol refactor

`Ownable` → OZ `AccessControl` (Initializable/UUPSUpgradeable preserved):

```solidity
bytes32 public constant GOVERNANCE_ROLE       = keccak256("GOVERNANCE_ROLE");
bytes32 public constant EMERGENCY_PAUSER_ROLE = keccak256("EMERGENCY_PAUSER_ROLE");

function initialize(
    IERC20 _l1Token, bytes32 _l2TokenAddress, uint256 _l2Version,
    IInbox _inbox, IOutbox _outbox,
    address _governanceTimelock,   // 7-day timelock (was _owner)
    address _emergencyTimelock,    // NEW: delay=0 timelock
    uint256 _maxTvl
) external initializer {
    _grantRole(DEFAULT_ADMIN_ROLE, _governanceTimelock);
    _grantRole(GOVERNANCE_ROLE,     _governanceTimelock);
    _grantRole(EMERGENCY_PAUSER_ROLE, _emergencyTimelock);
    // ... existing init ...
}

function pause()    external onlyRole(EMERGENCY_PAUSER_ROLE) { _pause(); }
function unpause()  external onlyRole(EMERGENCY_PAUSER_ROLE) { _unpause(); }
function setMaxTvl(uint256 newCap)             external onlyRole(GOVERNANCE_ROLE) { ... }
function setL2TokenAddress(bytes32 newAddr)    external onlyRole(GOVERNANCE_ROLE) { ... }
function withdrawTreasuryDust(...)             external onlyRole(GOVERNANCE_ROLE) { ... }
function _authorizeUpgrade(address) internal override onlyRole(GOVERNANCE_ROLE) {}
```

Deploy ceremony spawns 2 `TimelockController` instances: governance (7d delay, multisig admin) + emergency (0d delay, 2-of-3 emergency-multisig admin). Both addresses passed to `initialize`.

### B2. recoverDeposit — three-phase maker-side recovery

Sender-identity gated; 90-day time-lock + governance multisig approval for double-spend prevention:

```solidity
struct Deposit {
    uint128 amount;
    uint64  timestamp;
    bool    isPrivate;
}
mapping(bytes32 => Deposit) public deposits;             // key: keccak256(sender, secretHash)
mapping(bytes32 => bool)    public pendingRecoveries;
mapping(bytes32 => bool)    public approvedRecoveries;

// Existing depositToL2Public/Private extended at the end:
//   bytes32 key = keccak256(abi.encode(msg.sender, secretHash));
//   deposits[key] = Deposit({amount: uint128(amount), timestamp: uint64(block.timestamp), isPrivate});

// Phase 1: maker requests recovery, 90 days post-deposit
function requestRecovery(bytes32 secretHash) external {
    bytes32 key = keccak256(abi.encode(msg.sender, secretHash));
    Deposit memory d = deposits[key];
    if (d.amount == 0) revert NoSuchDeposit();
    if (block.timestamp < d.timestamp + 90 days) revert DepositTooRecent();
    pendingRecoveries[key] = true;
    emit RecoveryRequested(msg.sender, secretHash, d.amount);
}

// Phase 2: governance multisig manually verifies L2 consumption + approves
function approveRecovery(bytes32 key) external onlyRole(GOVERNANCE_ROLE) {
    if (!pendingRecoveries[key]) revert NoSuchRequest();
    approvedRecoveries[key] = true;
    emit RecoveryApproved(key);
}

// Phase 3: maker executes
function executeRecovery(bytes32 secretHash, address l1Recipient) external {
    bytes32 key = keccak256(abi.encode(msg.sender, secretHash));
    if (!approvedRecoveries[key]) revert NotApproved();
    uint128 amount = deposits[key].amount;
    delete deposits[key];
    delete pendingRecoveries[key];
    delete approvedRecoveries[key];
    l1Token.safeTransfer(l1Recipient, amount);
    emit RecoveryExecuted(msg.sender, secretHash, l1Recipient, amount);
}
```

**Sender-identity gate:** only the original depositor recovers. Even if the secret leaks, an attacker with a different `msg.sender` cannot recover. Privacy impact: `depositToL2Private` already emits indexed `sender`; the new `deposits[key]` storage write reveals no information not already public on L1 (`sender` + `secretHash`).

### B3. withdrawPrivate — sibling function for private-tag exits

```solidity
function withdrawPrivate(
    uint256 amount,
    address recipient,
    uint256 l2Epoch,
    uint256 leafIndex,
    bytes32[] calldata siblingPath
) external whenNotPaused {
    if (amount == 0) revert ZeroAmount();
    if (recipient == address(0)) revert ZeroAddress();

    bytes32 content = _withdrawContent(recipient, amount, DataStructures.WITHDRAW_PRIVATE_TAG);
    DataStructures.L2ToL1Msg memory message = DataStructures.L2ToL1Msg({
        sender: DataStructures.L2Actor({actor: l2TokenAddress, version: l2Version}),
        recipient: DataStructures.L1Actor({actor: address(this), chainId: block.chainid}),
        content: content
    });
    outbox.consume(message, Epoch.wrap(l2Epoch), leafIndex, siblingPath);
    l1Token.safeTransfer(recipient, amount);
    emit WithdrawCompleted(recipient, amount, l2Epoch, leafIndex);
}
```

Uses `WITHDRAW_PRIVATE_TAG` content matching L2's `exit_to_l1_private`. CLI gains `quetzal bridge claim-l1 --private` flag; the relayer picks the function based on the L2 exit tag.

### B1. wBTC parametric expansion

Zero contract changes — only deploy script + CLI alias + config:

- `scripts/deploy-bridge.ts`: third asset env `L1_WBTC_ADDR` (mainnet `0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599`)
- `cli/src/commands/bridge.ts`: `aWBTC` → `config.tBTC` mapping already present
- `quetzal.config.json`: new `l1.wbtc` + `l1.wbtcBridge` + `tBTC` slot

## Section 3 — L2 + CLI Changes (Bucket A)

### A2. siblingPath standalone TS subprocess binary

**New binary:** `bin/quetzal-outbox-proof` (TypeScript source in `tools/outbox-proof/`, esbuild single-file bundle).

```
tools/outbox-proof/
├── package.json              ← @aztec/aztec.js + @aztec/merkle-tree deps
├── tsconfig.json             ← module: NodeNext, target: ES2022
├── src/
│   ├── main.ts               ← CLI entry: parse args, call buildProof, output JSON
│   └── build-proof.ts        ← core: getL2ToL1Messages → MerkleTree → siblingPath
└── build.mjs                 ← esbuild bundle to dist/quetzal-outbox-proof.mjs
```

**Subprocess argv API:**
```bash
quetzal-outbox-proof \
  --node-url https://rpc.testnet.aztec-labs.com \
  --l2-tx-hash 0x... \
  --expected-content 0x...
# stdout: {"l2Epoch":"123","leafIndex":"42","siblingPath":["0x...","0x..."],"content":"0x..."}
# stderr: human-readable progress logs
# exit code: 0 = OK, 1 = lookup failed, 2 = tree build failed
```

Implementation uses `@aztec/merkle-tree`'s Poseidon2 incremental tree + `getL2ToL1Messages(epoch)` flatten loop + Aztec canonical `OutboxTree.buildPath` helper. If Aztec 4.2.1 runtime only computes this via `portal_manager.withdrawFunds`, the implementer adapts to a thin wrapper around that helper. Final choice made at task time after source inspection.

**CLI consumer** (`cli/src/bridge-helpers.ts` — replaces the Sub-5b partial-fail throw):

```typescript
import { spawn } from "node:child_process";

export async function buildOutboxProof(
  nodeUrl: string, l2TxHash: string, expectedContent: string,
): Promise<OutboxProof> {
  const binPath = process.env.QUETZAL_OUTBOX_PROOF_BIN ?? "quetzal-outbox-proof";
  return new Promise((resolve, reject) => {
    const child = spawn(binPath, [
      "--node-url", nodeUrl,
      "--l2-tx-hash", l2TxHash,
      "--expected-content", expectedContent,
    ]);
    let stdout = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.on("exit", (code) => {
      if (code !== 0) return reject(new Error(`quetzal-outbox-proof exited ${code}`));
      resolve(JSON.parse(stdout) as OutboxProof);
    });
  });
}
```

**Audit isolation benefits:**
- Binary source is segregated under `tools/outbox-proof/` — auditor reviews only that directory
- Independent versioning (`tools/outbox-proof/package.json` has its own version)
- CLI depends on neither binary internals nor aztec.js directly — only on the stdout JSON contract
- Aztec version changes require only `tools/outbox-proof/` rebuild; main CLI untouched

**Distribution:**
- Sub-5c dev mode: `pnpm tsx tools/outbox-proof/src/main.ts ...`
- Production: `pnpm --filter @quetzal/outbox-proof build` → `tools/outbox-proof/dist/quetzal-outbox-proof.mjs` (single Node-runnable .mjs)
- Optional native binary (Sub-5c-2 follow-up): `bun build --compile` or `pkg` for platform-specific binary

### A3. deploy-bridge.ts automation

**Gap 1 — Forge broadcast log parsing.** Replaces the current throw-after-L1-deploy stub:

```typescript
async function deployL1Stack(): Promise<DeployedL1> {
  // ... existing forge spawn ...

  const broadcastPath = `contracts-l1/broadcast/DeployAllBridges.s.sol/${chainId}/run-latest.json`;
  const broadcast = JSON.parse(readFileSync(broadcastPath, "utf8"));

  // Forge broadcast records CREATE transactions in order. DeployAllBridges
  // ordering: TimelockController(governance) → TimelockController(emergency)
  // → TokenBridge impl USDC → ERC1967Proxy USDC → TokenBridge impl WETH
  // → ERC1967Proxy WETH → TokenBridge impl WBTC → ERC1967Proxy WBTC.
  const creates = broadcast.transactions.filter(
    (t: any) => t.transactionType === "CREATE" || t.transactionType === "CREATE2"
  );
  const timelocks = creates.filter((t: any) => t.contractName === "TimelockController");
  const proxies   = creates.filter((t: any) => t.contractName === "ERC1967Proxy");

  return {
    governanceTimelock: timelocks[0].contractAddress,
    emergencyTimelock:  timelocks[1].contractAddress,
    usdcBridge: proxies[0].contractAddress,
    wethBridge: proxies[1].contractAddress,
    wbtcBridge: proxies[2].contractAddress,
  };
}
```

**Gap 2 — L2 wallet bootstrap.** `scripts/testnet-m1-hello.ts`'s state-persisted faucet-drip → claim → deploy-with-FeeJuicePaymentMethodWithClaim pattern extracted to shared module:

```typescript
// scripts/lib/aztec-wallet-bootstrap.ts (new shared module)
export async function bootstrapAztecWallet(
  nodeUrl: string,
  stateFile: string,            // e.g., "deploy-bridge-state.json"
  faucetUrl?: string,           // optional — mainnet uses pre-funded wallet
): Promise<{ wallet: EmbeddedWallet; account: AztecAddress }> {
  const state = loadOrInit(stateFile);

  if (!state.signingKey) state.signingKey = randomFq();
  if (!state.salt)       state.salt       = randomFr();
  // ... same pattern: register account, request claim, wait, deploy ...
  // Resume-safe: each step persists; restart skips completed steps.

  return { wallet, account };
}
```

`deploy-bridge.ts` imports this helper; `scripts/testnet-m1-hello.ts` refactors to use it (DRY); `scripts/testnet-sub5b-bridge.ts`'s F2 step 3 delegates to it.

**Result:** `pnpm tsx scripts/deploy-bridge.ts` runs the L1 forge + L2 aztec.js + timelock wiring chain end-to-end with one command. The `SKIP_L1=1` workaround retired.

## Section 4 — Monitoring + Relayer (Bucket C)

### C1. Prometheus + Grafana + Alertmanager (VPS-hosted)

**Topology** — Docker Compose stack on `194.163.136.1`:

```
┌─ VPS (194.163.136.1) ─────────────────────────────────────────┐
│                                                               │
│  ┌──────────────┐   scrape:9100   ┌──────────────────────┐   │
│  │ Prometheus   │ ──────────────► │ zswap-l1-exporter    │   │
│  │ (:9090)      │   scrape:9101   │ (Node.js HTTP server)│   │
│  │              │ ──────────────► ├──────────────────────┤   │
│  │              │                 │ zswap-l2-exporter    │   │
│  └──────┬───────┘                 │ (Node.js HTTP server)│   │
│         │ alert rules                                         │
│         ▼                                                     │
│  ┌──────────────┐  webhook   ┌──────────────────┐            │
│  │ Alertmanager │ ─────────► │ Slack #quetzal-ops │            │
│  │ (:9093)      │ ─────────► │ PagerDuty (sev1) │            │
│  └──────────────┘            └──────────────────┘            │
│                                                               │
│  ┌──────────────┐                                             │
│  │ Grafana      │ ◄──── ops team browser                      │
│  │ (:3000)      │                                             │
│  └──────────────┘                                             │
│                                                               │
└───────────────────────────────────────────────────────────────┘
```

**New package:** `tools/exporters/` (own `package.json`, audit isolation).

**L1 exporter metrics** (`quetzal_bridge_*`):
```
quetzal_bridge_total_locked{token="USDC|WETH|wBTC"}                  # totalLocked()
quetzal_bridge_max_tvl{token="..."}                                  # maxTvl()
quetzal_bridge_tvl_utilization{token="..."}                          # locked/max ratio
quetzal_bridge_paused{token="..."}                                   # 0/1
quetzal_bridge_recovery_requests_pending                             # pendingRecoveries count
quetzal_bridge_inbox_pending_messages                                # Inbox queue depth
quetzal_bridge_outbox_unconsumed_messages{epoch="..."}               # L2→L1 backlog
```

**L2 exporter metrics** (`quetzal_l2_*`):
```
quetzal_l2_orderbook_open_orders_estimate                            # ~from tx logs
quetzal_l2_orderbook_last_clearing_timestamp                         # tx age = liveness
quetzal_l2_treasury_balance{token="USDC|WETH|wBTC"}                  # public-only
quetzal_l2_aggregator_registry_size                                  # bonded count
quetzal_l2_aggregator_active_last_24h                                # unique submitters
quetzal_l2_pool_reserve{pair="USDC/ETH|...",token="a|b"}             # pool depth
```

**Alertmanager rules** (`prometheus/alerts.yml`):
```yaml
- alert: BridgePaused
  expr: quetzal_bridge_paused > 0
  for: 1m
  severity: page                                                   # → PagerDuty sev1

- alert: BridgeTvlNearCap
  expr: quetzal_bridge_tvl_utilization > 0.9
  for: 5m
  severity: warn                                                   # → Slack

- alert: OrderbookStalled
  expr: time() - quetzal_l2_orderbook_last_clearing_timestamp > 3600
  for: 10m
  severity: page                                                   # 1h no clearing = aggregator down

- alert: OutboxBacklog
  expr: quetzal_bridge_outbox_unconsumed_messages > 50
  for: 30m
  severity: warn                                                   # makers can't withdraw
```

**Setup:** `tools/exporters/docker-compose.yml` + Grafana dashboards (bridge health, MEV-protection health, aggregator competition) JSON-as-code. README documents `ssh root@194.163.136.1 && cd /root/quetzal-ops && docker compose up -d`.

### C2. Optional opt-in relayer service

New mode in Sub-3's aggregator daemon. **A bonded aggregator may also serve as a relayer.**

**Maker-side opt-in (CLI):**
```bash
pnpm quetzal bridge exit --token aWETH --amount 100000000000000000 \
  --l1-recipient 0xAbcd... \
  --relayer-fee 0.5          # ← NEW: paid in Treasury fee credits, 0.5% of amount
```

Atomically on L2:
1. `aWETH.exit_to_l1_public(amount, l1_recipient)` (existing)
2. `treasury.queue_relayer_claim(l2_tx_hash, expected_content, l1_recipient, amount, fee)` (new)

`Treasury.sol` (Sub-3's treasury) gains new public storage:
```rust
pending_relayer_claims: PublicMutable<RelayerClaimQueue>;
// RelayerClaimQueue: list<{l2_tx_hash, expected_content, l1_recipient, amount, fee, requested_at}>
```

**Relayer-side (aggregator daemon extension):**
```typescript
// aggregator/src/relayer-mode.ts
async function relayerLoop() {
  while (true) {
    const queue = await treasury.methods.get_pending_relayer_claims().simulate();
    for (const claim of queue) {
      // 1. Build siblingPath via quetzal-outbox-proof binary (A2)
      const proof = await buildOutboxProof(nodeUrl, claim.l2TxHash, claim.expectedContent);
      // 2. Submit L1 cast send (or viem writeContract)
      await tokenBridge.write.withdraw([
        claim.amount, claim.l1Recipient, proof.l2Epoch, proof.leafIndex, proof.siblingPath,
      ]);
      // 3. Mark consumed in Treasury → fee transfers
      await treasury.methods.consume_relayer_claim(claim.id).send();
    }
    await sleep(60_000); // poll every 60s
  }
}
```

**Fee economy:**
- Maker `--relayer-fee 0.5` → 0.5% of withdraw amount locked in Treasury at queue time
- Successful L1 claim → relayer collects fee, Treasury keeps protocol cut (configurable; default 20% Treasury / 80% relayer)
- Race: first valid relayer wins; subsequent txs revert (Outbox.consumed flag)
- Maker self-claim preserved: `--relayer-fee 0` or omit flag → standard manual cast send template

**Sub-3 registry reuse:** only bonded aggregators may poll the relayer queue; the bond becomes the security guarantee for fee earnings.

## Section 5 — Audit-prep, On-call, Phasing, Success Criteria

### C3. Audit-prep materials

**New file:** `contracts-l1/AUDIT.md` (auditor single-source-of-truth):

```markdown
# Quetzal L1 Bridge — Audit Brief

## Scope (in-scope contracts)
- contracts-l1/src/TokenBridge.sol          (UUPS + AccessControl + Pausable)
- contracts-l1/src/interfaces/IInbox.sol    (interface mirror, no logic)
- contracts-l1/src/interfaces/IOutbox.sol   (interface mirror, no logic)
- contracts-l1/src/lib/DataStructures.sol   (structs + tag constants)
- contracts-l1/src/lib/TimeMath.sol         (Epoch type alias)
- contracts-l1/script/DeployAllBridges.s.sol

## Out-of-scope (Aztec rollup contracts — depended on, not built by us)
- @aztec/l1-artifacts@4.2.1 Inbox.sol, Outbox.sol implementations

## Trust model
- Owner: TimelockController (governance, 7d delay) + TimelockController (emergency, 0d delay)
- Governance multisig: 3-of-5
- Emergency multisig: 2-of-3 (independent signer set)
- TVL cap: per-portal soft limit (admin-adjustable, 7d-timelocked)

## Known issues (operator-acknowledged carryforwards)
- Fee-on-transfer ERC20 incompatibility: documented assumption on TVL cap math.
  Mitigation: launch assets (USDC, WETH, wBTC) are all standard.
- recoverDeposit's L2-consumption check: off-chain manual (governance approval).
  Mitigation: 90-day time-lock + governance multisig signoff.
- exit_to_l1_private: paired with withdrawPrivate, both ship in Sub-5c.

## Threat model
[T-1..T-10 enumerated: portal-fund-drain, ownership-takeover, replay attacks,
 governance-collusion, upgrade-after-pause, dust-sweep, etc.]

## Dependencies + supply chain
- @openzeppelin/contracts v5.0.2 (pinned, lib/ vendored)
- @openzeppelin/contracts-upgradeable v5.0.2
- Foundry: solc 0.8.27, via_ir enabled

## Test coverage
- 21 Foundry tests (forge test --gas-report attached)
- 5 Noir TXE tests (mode-gate revert paths)
- Sub-5c additions: ~8 new Foundry tests (EmergencyPauser, recoverDeposit
  3-phase flow, withdrawPrivate, wBTC parametric symmetry)

## Out-of-band verification artifacts
- Etherscan source verification (--verify on deploy)
- Slither static analysis report (committed to contracts-l1/audit/slither.txt)
- Foundry coverage report (forge coverage --report lcov)
```

**Commit-freeze git tag:** at Sub-5c's final commit, `git tag -a sub5c-audit-snapshot -m "Sub-5c code-complete; audit window opens"`. The audit firm targets this tag; intervening Sub-5d/6 work does not perturb the audit baseline.

**Slither static analysis:** Sub-5c adds `tools/audit/run-slither.sh` script — runs once at audit-prep time; output committed as `contracts-l1/audit/slither-<date>.txt`.

### C4. On-call playbook

**New file:** `docs/on-call-playbook.md`:

```markdown
# Quetzal On-Call Playbook

## Severity classification

| Sev | Definition | Response time | Channel |
|-----|------------|---------------|---------|
| SEV1 | Bridge funds at risk / paused / drain attempt | <15 min | PagerDuty + 2-of-3 emergency multisig huddle |
| SEV2 | Orderbook stalled (>1h no clearing) / aggregator outage | <1 hour | Slack + governance multisig (async) |
| SEV3 | Monitoring alert (TVL near cap, outbox backlog) | <4 hours | Slack |
| SEV4 | UX issue / docs gap | next business day | GitHub issue |

## Escalation tree
On-call (rotation) → Tech lead → Emergency multisig signer #1 → Signer #2 → ...

## Runbooks (linked per alert)
- BridgePaused → docs/superpowers/specs/sub5c-runbook.md#pause-investigation
- BridgeTvlNearCap → sub5c-runbook.md#tvl-cap-ramp
- OrderbookStalled → sub5c-runbook.md#aggregator-recovery
- OutboxBacklog → sub5c-runbook.md#withdraw-flow-debugging
- (new alert) → add runbook section + link here

## Rotation
PagerDuty schedule "quetzal-oncall" (initial: 3 engineers, weekly handoff).
Hand-off ritual: review last week's alerts, validate runbook accuracy.

## Post-mortem template
docs/post-mortems/YYYY-MM-DD-<incident>.md
- Timeline
- Root cause
- What worked
- What didn't
- Action items (file as GH issues with sub5d label)
```

### C5. sub5c-runbook.md (Sub-5b runbook extension)

Rename + extend Sub-5b's `sub5b-runbook.md` to `sub5c-runbook.md`:

- **New sections:** EmergencyPauser deploy ceremony, recoverDeposit 3-phase operator UX, withdrawPrivate sertification (relayer integration), wBTC adding-an-asset playbook.
- **Monitoring setup:** VPS Docker Compose instructions, Grafana dashboard import, Alertmanager Slack/PagerDuty config.
- **Relayer setup:** how an aggregator daemon enables relayer-mode, fee tuning, queue inspection commands.
- **Cap ramp policy:** Sub-5b's $10k→unlimited ramp preserved verbatim; wBTC adds its own row.
- **Incident response (refined):** SEV1-4 each with step-by-step procedure.

### Phasing (~18 tasks across 7 phases, ~5-6 weeks)

| Phase | Tasks | Duration | Mainnet blocker? |
|---|---|---|---|
| **A — Bridge completion (Bucket A)** | A1: EmergencyPauser refactor; A2: forge tests for new roles; A3: siblingPath subprocess binary + binary tests; A4: deploy-bridge.ts L2 wallet bootstrap + forge log parsing | ~2 weeks | ✅ Yes |
| **B — Bridge expansion (Bucket B)** | B1: TokenBridge.sol deposit-tracking + requestRecovery; B2: approveRecovery + executeRecovery + Foundry tests; B3: withdrawPrivate + Foundry tests; B4: wBTC deploy ceremony + CLI alias + config | ~1 week | ✅ With A |
| **C — Monitoring (Bucket C-1)** | C1: tools/exporters/ scaffold + L1 exporter; C2: L2 exporter; C3: Prometheus + Grafana + Alertmanager docker-compose + VPS deploy | ~1 week | ⚠️ Strongly recommended |
| **D — Relayer (Bucket C-2)** | D1: Treasury.sol queue_relayer_claim + consume + TXE tests; D2: aggregator/src/relayer-mode.ts loop; D3: CLI --relayer-fee flag + e2e test | ~1 week | ⚠️ Optional, may slip to ramp phase |
| **E — Audit-prep (Bucket C-3)** | E1: AUDIT.md threat model + scope + known issues; E2: tools/audit/run-slither.sh + initial report; E3: commit-freeze tag + audit-window opening communication | ~3-4 days | ✅ Required before audit |
| **F — On-call + runbook (Bucket C-4 + C-5)** | F1: docs/on-call-playbook.md; F2: docs/superpowers/specs/sub5c-runbook.md (extended) | ~3-4 days | ✅ Required before mainnet open |
| **G — Close** | G1: memory/project_subproject5c_complete.md + MEMORY.md + README CODE-COMPLETE block | ~1 day | — |

### Success criteria

1. **EmergencyPauser:** governance multisig pause() reverts (only emergency multisig may pause); emergency multisig pause() executes <2 min (delay=0); upgrade() still requires 7-day timelock.
2. **siblingPath binary:** `quetzal-outbox-proof --node-url <testnet> --l2-tx-hash <real-tx> --expected-content <hex>` returns valid JSON against testnet; output successfully consumed in a real L1 `withdraw()` tx.
3. **deploy-bridge.ts:** `NETWORK=mainnet pnpm tsx scripts/deploy-bridge.ts` completes L1 forge + L2 deploy + timelock wiring in one command (no manual operator step).
4. **recoverDeposit:** 3-phase flow passes Foundry tests: request (old deposit) → approveRecovery (governance role) → executeRecovery (original sender receives L1 token); foreign-sender calls revert.
5. **withdrawPrivate:** WITHDRAW_PRIVATE_TAG content consumable on L1; L2's `exit_to_l1_private` becomes functional.
6. **wBTC:** mainnet deploy includes the third portal + aWBTC L2 token; CLI `bridge claim/exit --token aWBTC` works.
7. **Monitoring:** Prometheus running on VPS; at least 4 alert rules (BridgePaused, BridgeTvlNearCap, OrderbookStalled, OutboxBacklog) firable; Grafana dashboards accessible.
8. **Relayer:** opt-in maker `--relayer-fee 0.5` exit + L1 claim completed automatically by aggregator daemon; fee paid via Treasury split.
9. **Audit-prep:** AUDIT.md delivered; Slither report committed; commit-freeze tag created.
10. **On-call:** playbook delivered; rotation organized (operator team confirms — Sub-5c delivers docs, actual rotation is operator process).

### Out-of-scope (Sub-5d, Sub-6+)

- L1 portal v2 upgrade design (Sub-5c ships v1 only)
- Cross-chain bridges to non-Ethereum L1s (explicit never — privacy-maximalist Aztec-on-Ethereum only)
- Statistical privacy leak mitigation (deposit↔claim temporal linkage) — Sub-6 dummy-order territory
- L2 wBTC bridge expansion to L1 mining pool deposits — Sub-6+
- Audit findings remediation — separate project, planned from audit deliverable
- Public bug-bounty launch — operator team initiates post-Sub-5c

### Dependencies

- Sub-5b SHIPPED (HEAD `579c850`) — Sub-5c's A1 extends Sub-5b's Ownable base by replacing with AccessControl
- Sub-3 SHIPPED — Treasury + AggregatorRegistry reused (recoverDeposit governance + relayer registry)
- VPS `194.163.136.1` access — for monitoring stack
- Multisig signer coordination (3-of-5 governance + 2-of-3 emergency) — out-of-band, ops team
