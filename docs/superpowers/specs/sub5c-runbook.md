# Sub-5c Mainnet Deployment + Operations Runbook

Operator walkthrough for deploying the ZSwap-on-Aztec L1↔L2 bridge to
Ethereum mainnet + Aztec mainnet. Estimated walltime: 1-2 working days
excluding multisig signer coordination + the 7-day timelock window.

## Prerequisites

- [ ] Sub-5b code-complete + merged on `main` (HEAD includes A1-G2 commits).
- [ ] L1 audit complete: independent security review of `contracts-l1/` —
      ESPECIALLY `TokenBridge.sol` (UUPS upgrade pattern, custom-error
      ownership, TVL cap semantics, sha256ToField content-hash format).
- [x] **EmergencyPauser shipped in Sub-5c (Phase A).** TokenBridge.sol is now AccessControl-based; `EMERGENCY_PAUSER_ROLE` is delegated to a separate 2-of-3 emergency multisig fronted by a 0-day TimelockController. Governance cannot revoke this role (self-admin invariant).
- [ ] 3-of-5 Gnosis Safe deployed on mainnet; signer identities documented:
  - [ ] Signer 1 (name, ETH address, custody method)
  - [ ] Signer 2 (name, ETH address, custody method)
  - [ ] Signer 3 (name, ETH address, custody method)
  - [ ] Signer 4 (name, ETH address, custody method)
  - [ ] Signer 5 (name, ETH address, custody method)
- [ ] L1 deployer wallet funded with ~1 ETH (deploy gas budget).
- [ ] Aztec mainnet deployer Schnorr account funded with fee-juice
      (via Aztec's mainnet bridge from L1 ETH).
- [ ] `zswap.config.json` populated with mainnet addresses:
      `l1.{usdc, weth, inbox, outbox, multisig}` + `nodeUrl`.
- [ ] Bug bounty active (Immunefi or equivalent, ≥$100k pool).
- [ ] Monitoring infrastructure ready: TVL dashboard, L1↔L2 message-queue
      depth alert, pause-state monitoring. (See `## Monitoring setup` below.)

## Deploy sequence

### Phase 1 — L1 deploy (~30 min active)

Set env vars:

```bash
export NETWORK=mainnet
export L1_RPC_URL=<mainnet RPC>
export L1_USDC_ADDR=0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48
export L1_WETH_ADDR=0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2
export L1_INBOX_ADDR=<mainnet Aztec Inbox>
export L1_OUTBOX_ADDR=<mainnet Aztec Outbox>
export L1_MULTISIG_ADDR=<3-of-5 Safe>
export DEPLOYER_PK=<funded mainnet deployer>
```

Run:

```bash
cd contracts-l1
forge script script/DeployAllBridges.s.sol:DeployAllBridges \
  --rpc-url $L1_RPC_URL \
  --private-key $DEPLOYER_PK \
  --broadcast \
  --verify \
  --etherscan-api-key $ETHERSCAN_API_KEY \
  --sig "run(address,address,address,address,address,uint256,uint256)" \
  $L1_USDC_ADDR $L1_WETH_ADDR $L1_INBOX_ADDR $L1_OUTBOX_ADDR $L1_MULTISIG_ADDR \
  604800 10000000000
```

The script prints 3 addresses to capture for `zswap.config.json`:
- `TimelockController:` 0x...
- `USDCBridge:` 0x...
- `WETHBridge:` 0x...

Each TokenBridge proxy is initialized with `l2TokenAddress = bytes32(0)`.
Phase 3 wires the actual L2 addresses via timelock.

### Phase 2 — L2 deploy (~1 hour)

```bash
export AZTEC_NODE_URL=<mainnet Aztec RPC>
pnpm tsx scripts/deploy-bridge.ts SKIP_L1=1
```

(Once `deploy-bridge.ts`'s L2 wallet bootstrap is fully wired in a Sub-5c
follow-up, the `SKIP_L1` path runs end-to-end. Until then, use the
`scripts/testnet-sub5b-bridge.ts` mainnet variant, or hand-deploy via
the M1-hello.ts pattern.)

Capture:
- `aUSDC` L2 address: 0x...
- `aWETH` L2 address: 0x...

### Phase 3 — Wire portals → L2 tokens (timelocked, 7 days)

Schedule via multisig. Use Safe SDK or pre-sign cast calldata for the
3-of-5 signers:

```bash
# USDCBridge -> aUSDC
INNER_USDC=$(cast calldata "setL2TokenAddress(bytes32)" $aUSDC_HEX)
# Multisig signs this scheduled tx via Safe UI / SDK:
cast send $TIMELOCK "schedule(address,uint256,bytes,bytes32,bytes32,uint256)" \
  $USDC_BRIDGE 0 $INNER_USDC 0x0 0x0 604800

# WETHBridge -> aWETH
INNER_WETH=$(cast calldata "setL2TokenAddress(bytes32)" $aWETH_HEX)
cast send $TIMELOCK "schedule(address,uint256,bytes,bytes32,bytes32,uint256)" \
  $WETH_BRIDGE 0 $INNER_WETH 0x0 0x0 604800
```

**WAIT 7 DAYS.**

Execute (anyone can call after delay):

```bash
cast send $TIMELOCK "execute(address,uint256,bytes,bytes32,bytes32)" \
  $USDC_BRIDGE 0 $INNER_USDC 0x0 0x0
cast send $TIMELOCK "execute(address,uint256,bytes,bytes32,bytes32)" \
  $WETH_BRIDGE 0 $INNER_WETH 0x0 0x0
```

### Phase 4 — Verify

```bash
cast call $USDC_BRIDGE "l2TokenAddress()" --rpc-url $L1_RPC_URL
# Expected: 0x<aUSDC_FIELD>

cast call $WETH_BRIDGE "l2TokenAddress()" --rpc-url $L1_RPC_URL
# Expected: 0x<aWETH_FIELD>

cast call $USDC_BRIDGE "owner()" --rpc-url $L1_RPC_URL
# Expected: 0x<TimelockController address>

cast call $USDC_BRIDGE "maxTvl()" --rpc-url $L1_RPC_URL
# Expected: 10000000000  (10k USDC at 6 decimals)

cast call $USDC_BRIDGE "paused()" --rpc-url $L1_RPC_URL
# Expected: false
```

Also verify on L2:

```bash
# Inspect aUSDC: is_bridged should be true, portal_addr should be USDCBridge
pnpm zswap --config zswap.config.json inspect-token aUSDC
```

(`zswap inspect-token` is a Sub-5c CLI follow-up; for now, use the
Aztec dev tools or aztec.js directly to query the token's storage.)

## EmergencyPauser usage

The emergency role is the operator's "big red button" for SEV1 incidents.
It bypasses the 7-day governance timelock entirely.

**Threshold:** 2-of-3 emergency multisig signers. Distinct from the 3-of-5
governance multisig.

**To pause a portal (e.g., USDCBridge):**

```bash
# Multisig signer 1: submit via Safe UI OR cast send directly:
cast send $EMERGENCY_TIMELOCK \
  "schedule(address,uint256,bytes,bytes32,bytes32,uint256)" \
  $USDC_BRIDGE 0 $(cast calldata "pause()") 0x0 0x0 0
# Signer 2 confirms (Safe UI) OR signer 2 also calls schedule with same args.

# After 2/3 sigs collected — anyone executes (delay=0):
cast send $EMERGENCY_TIMELOCK \
  "execute(address,uint256,bytes,bytes32,bytes32)" \
  $USDC_BRIDGE 0 $(cast calldata "pause()") 0x0 0x0
```

**To unpause:** same flow with `unpause()` in place of `pause()`.

**DO NOT pause via the governance multisig** — that's the 7-day timelock and
useless during an incident. The governance multisig CANNOT call pause (the
role gate enforces this; `test_governanceCannotPause` covers).

**What pause does:**
- Blocks `depositToL2Public/Private` (no new funds in)
- Blocks `withdraw` + `withdrawPrivate` (no funds out)
- Does NOT block `requestRecovery` / `executeRecovery` (recovery path is
  orthogonal to the deposit/withdraw flow; an active recovery on a paused
  portal can complete)
- Pending Inbox L1→L2 messages remain claimable on L2 (Inbox is Aztec's
  contract, not ours)
- Pending Outbox L2→L1 messages can be claimed once unpaused

## Loss-of-secret recovery (3-phase)

When a maker loses access to their L2 wallet AND has a deposit that hasn't
been claimed on L2, they can recover their L1 funds via the 3-phase flow.

**Hard requirement:** must be the original depositor (`msg.sender` match
against the deposit's `(sender, secretHash)` key). Secret knowledge alone
is not enough.

**Time floor:** 90 days from deposit timestamp. Earlier requests revert
`DepositTooRecent`.

### Phase 1 — Maker requests

```bash
cast send $USDC_BRIDGE \
  "requestRecovery(bytes32)" \
  $SECRET_HASH \
  --private-key $MAKER_PK \
  --rpc-url $L1_RPC_URL
```

This flags the pending recovery on-chain (`pendingRecoveries[key] = true`).

### Phase 2 — Governance reviews + approves

The governance multisig must MANUALLY verify off-chain that:
- The L1→L2 deposit message at the maker's secretHash is still unconsumed
  on L2 (query Aztec node's L1→L2 inbox state)
- The maker (sender address) is genuinely the original depositor (cross-
  check `DepositTracked` event logs against the maker's claim)
- No other recovery is already in flight for the same key

Compute the deposit key off-chain:
```bash
cast keccak $(cast abi-encode "f(address,bytes32)" $MAKER_ADDR $SECRET_HASH)
```

Then schedule via governance timelock:
```bash
cast send $GOVERNANCE_TIMELOCK \
  "schedule(address,uint256,bytes,bytes32,bytes32,uint256)" \
  $USDC_BRIDGE 0 \
  $(cast calldata "approveRecovery(bytes32)" $DEPOSIT_KEY) \
  0x0 0x0 604800  # 7-day delay
```

After 7 days:
```bash
cast send $GOVERNANCE_TIMELOCK \
  "execute(address,uint256,bytes,bytes32,bytes32)" \
  $USDC_BRIDGE 0 \
  $(cast calldata "approveRecovery(bytes32)" $DEPOSIT_KEY) \
  0x0 0x0
```

### Phase 3 — Maker executes

```bash
cast send $USDC_BRIDGE \
  "executeRecovery(bytes32,address)" \
  $SECRET_HASH $L1_RECIPIENT \
  --private-key $MAKER_PK \
  --rpc-url $L1_RPC_URL
```

The maker's L1 token balance is restored. State is fully cleared
(deposits/pendingRecoveries/approvedRecoveries) to prevent re-recovery.

**Foreign-sender attack:** if an attacker learns the secret but is not the
original depositor, they cannot call `executeRecovery` — `msg.sender` mismatch
computes a different key with no approval. `NotApproved` revert.

## withdrawPrivate (privacy-maximalist exit)

Sub-5c B3 ships the L1 consumer for L2's `exit_to_l1_private`. Use when
you want the L2 exit + L1 claim to use the WITHDRAW_PRIVATE_TAG domain
separator (vs the public-tag default).

### Maker UX

1. **L2 exit (private mode):**
   ```bash
   pnpm zswap bridge exit --token aWETH --amount 100000000000000000 \
     --l1-recipient 0xRecipient... \
     --private
   ```

2. **L1 claim (after 1-2 hours, the L2 epoch settles to L1 outbox):**
   ```bash
   pnpm zswap bridge claim-l1 --l2-tx 0xL2_TX_HASH... \
     --l1-recipient 0xRecipient... \
     --amount 100000000000000000 \
     --bridge $WETH_BRIDGE \
     --content 0xExpectedContent... \
     --private  # ← uses withdrawPrivate() instead of withdraw()
   ```

   This prints a ready-to-run `cast send` command using `withdrawPrivate`
   function selector. Paste + run.

### Optional relayer path

If you don't want to wait + submit the L1 tx yourself, add `--relayer-fee`
to step 1:

```bash
pnpm zswap bridge exit --token aWETH --amount 100000000000000000 \
  --l1-recipient 0xRecipient... \
  --private \
  --relayer-fee 500000000000000  # 0.5% of amount in WETH wei
```

This atomically:
- Submits the L2 exit_to_l1_private
- Calls Treasury.queue_relayer_claim with the expected content hash

A bonded aggregator (Sub-3 registry, with `RELAYER_MODE=1` env) polls the
queue every ~60s, builds the outbox proof, submits the L1 withdrawPrivate
on your behalf, and collects the fee from Treasury.

## Adding a new bridged asset (post-Sub-5c)

The TokenBridge.sol contract is parametric in the underlying L1 ERC20.
To add a new asset (e.g., DAI) post-Sub-5c:

1. **L1 portal deploy** via `forge create`:
   ```bash
   cd contracts-l1
   forge create --rpc-url $L1_RPC_URL --private-key $DEPLOYER_PK \
     src/TokenBridge.sol:TokenBridge
   ```
   Capture the implementation address `$DAI_IMPL`.

2. **Deploy the proxy:**
   ```bash
   INIT_DATA=$(cast calldata "initialize(address,bytes32,uint256,address,address,address,address,uint256)" \
     $DAI_ADDR \
     0x0 \
     1 \
     $L1_INBOX \
     $L1_OUTBOX \
     $GOVERNANCE_TIMELOCK \
     $EMERGENCY_TIMELOCK \
     10000000000000000000000)  # 10k DAI cap (DAI=18 decimals)
   forge create --rpc-url $L1_RPC_URL --private-key $DEPLOYER_PK \
     lib/openzeppelin-contracts/contracts/proxy/ERC1967/ERC1967Proxy.sol:ERC1967Proxy \
     --constructor-args $DAI_IMPL $INIT_DATA
   ```
   Capture `$DAI_BRIDGE`.

3. **L2 aDAI deploy** via aztec.js (mirror scripts/deploy-bridge.ts:deployL2Tokens):
   ```typescript
   const aDAI = await TokenContract.deployWithOpts(
     { wallet, method: "constructor_with_minter_bridged" },
     "aDAI".padEnd(31, "\0"), "aDAI".padEnd(31, "\0"), 18, account,
     Fr.fromString($DAI_BRIDGE.padEnd(66, "0").slice(0, 66)),
   ).send({ from: account });
   ```

4. **Wire setL2TokenAddress via governance timelock** (7-day delay).

5. **Update zswap.config.json** with the new bridge + L2 addresses.

6. **Update Prometheus exporter** — `tools/exporters/src/l1-exporter.ts`
   auto-discovers via the config's `l1.daiBridge` etc., but the metric
   label list ("USDC", "WETH", "wBTC") needs the new entry added.

7. **Update Grafana dashboards** to include the new asset in stat panels.

8. **Update sub5c-runbook.md** + AUDIT.md with the new asset row.

## Monitoring setup (VPS deploy)

The Prometheus + Grafana + Alertmanager stack runs on VPS `194.163.136.1`.

### Initial deploy

```bash
ssh root@194.163.136.1
mkdir -p /root/zswap-ops && cd /root/zswap-ops
git clone https://github.com/<org>/zswap-aztec.git .

# Set env vars (write to /root/zswap-ops/.env, NOT committed):
cat > .env <<EOF
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...
PAGERDUTY_ROUTING_KEY=...
GRAFANA_ADMIN_PASSWORD=...
EOF

cd tools/exporters
docker compose --env-file ../../.env up -d
```

### Verify

- Prometheus UI: http://194.163.136.1:9090/targets — all 2 exporters UP
- Alertmanager UI: http://194.163.136.1:9093 — 4 alerts loaded, 0 firing
- Grafana UI: http://194.163.136.1:3000 (admin / $GRAFANA_ADMIN_PASSWORD)
  — 3 dashboards auto-loaded under ZSwap folder

### Test the alert pipeline

Manually trigger a test alert to confirm Slack + PagerDuty delivery:

```bash
# SSH to the VPS and silence the BridgePaused alert temporarily:
docker exec -it alertmanager amtool silence add alertname=BridgePaused -d 5m -c "test"
# Then pause a testnet portal to fire the alert (real fire, real silence ack).
```

## Relayer setup (opt-in)

A bonded aggregator (Sub-3 registry member) can opt into relayer mode to
earn fees from makers using `--relayer-fee`.

### Enable

On the aggregator's daemon host (e.g., VPS):

```bash
export RELAYER_MODE=1
export L1_RPC_URL=https://eth-mainnet...
export L1_PRIVATE_KEY=0x...  # relayer's L1 funding wallet (must hold ETH for gas)
pnpm --filter @zswap/aggregator daemon
```

The daemon now polls Treasury.pending_relayer_claims every 60s.

### Fee economics

- Maker submits `--relayer-fee 0.5%` (in token native units)
- Relayer submits L1 withdraw, collects fee from Treasury on consume
- Race: first valid L1 submission wins (Outbox replay guard)

### Inspect queue

```bash
pnpm zswap aggregator inspect-relayer-queue  # (CLI cmd added in Sub-5d)
```

For now, query directly:
```bash
pnpm tsx -e '
  const node = require("@aztec/aztec.js/node").createAztecNodeClient(process.env.AZTEC_NODE_URL);
  // ... TreasuryContract.at(...).methods.get_pending_relayer_claims_count().simulate() ...
'
```

### Disable

Stop the daemon. The queue remains; another relayer (or the maker via
the manual cast-send template) will claim outstanding entries.

## Cap ramp policy

Per-asset, post-mainnet-open ramp. Each cap change is timelocked 7 days.

| Day | USDC cap | WETH cap | wBTC cap | Rationale |
|---|---|---|---|---|
| 0 | 10,000_000_000 ($10k) | 4_000_000_000_000_000_000 ($10k @ $2.5k) | 10_000_000 ($10k @ $100k) | Smoke-test live volume |
| 30 | 100,000 (×10) | 40 ETH (×10) | 1 BTC (×10) | First confidence ramp |
| 60 | 1,000,000 (×100) | 400 ETH | 10 BTC | Mid-tier capital |
| 90 | 0 (unlimited) | 0 (unlimited) | 0 (unlimited) | Full open |

**Cap = 0 means UNLIMITED, NOT zero deposits.** To block deposits entirely,
use `pause()` (emergency role, 0-day delay). DO NOT confuse the two.

## Incident response

Severity classification + escalation lives in `docs/on-call-playbook.md`.

Per-incident-type runbooks:

### EmergencyPauser incident response (SEV1)

See `## EmergencyPauser usage` above for pause/unpause commands. Additional
steps:

1. Page emergency multisig signers via PagerDuty + Signal/Telegram.
2. Pause affected portal(s).
3. Post status page update within 15 minutes.
4. Begin investigation in dedicated incident channel.
5. After mitigation + audit-review-of-fix: governance proposes
   `upgradeToAndCall(newImpl, "")` via 7-day timelock.
6. After timelock + execute: unpause via emergency timelock.

### TVL cap ramp (SEV3, BridgeTvlNearCap alert)

1. Verify the alert in Grafana.
2. Confirm legitimate volume (not a bot griefing).
3. Governance multisig schedules `setMaxTvl(newCap)` via 7-day timelock.
4. Operator monitors during the 7-day window.
5. Execute after window.

### Aggregator recovery (SEV1/SEV2, OrderbookStalled alert)

1. SSH to aggregator host. `docker logs --tail 200 zswap-aggregator-1`.
2. If crashed: `docker restart zswap-aggregator-1`.
3. If repeated crashes: spin up backup aggregator on standby VPS + update
   registered aggregator address via governance.

### Withdraw flow debugging (SEV3, OutboxBacklog alert)

1. Check relayer daemon health (if relayer-mode enabled).
2. Check L1 RPC connectivity from relayer host.
3. Check Outbox.consume gas usage on L1 (may need cap adjustment if
   siblingPath is unusually deep).
4. Encourage makers to self-claim via the manual cast-send template
   (CLI's `zswap bridge claim-l1` output).

## L1 portal upgrade (UUPS, 7-day timelock)

1. New TokenBridge implementation deployed:
   ```bash
   forge create --rpc-url $L1_RPC_URL --private-key $DEPLOYER_PK \
     contracts-l1/src/TokenBridge.sol:TokenBridge
   ```
   Capture the new implementation address.

2. Multisig schedules `upgradeToAndCall(newImpl, 0x)` via 7-day timelock:
   ```bash
   UPGRADE=$(cast calldata "upgradeToAndCall(address,bytes)" $NEW_IMPL "0x")
   cast send $TIMELOCK "schedule(address,uint256,bytes,bytes32,bytes32,uint256)" \
     $USDC_BRIDGE 0 $UPGRADE 0x0 0x0 604800
   ```
   Repeat for WETHBridge.

3. WAIT 7 days.

4. Anyone executes:
   ```bash
   cast send $TIMELOCK "execute(address,uint256,bytes,bytes32,bytes32)" \
     $USDC_BRIDGE 0 $UPGRADE 0x0 0x0
   ```

5. Verify:
   ```bash
   cast storage $USDC_BRIDGE 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc
   # ERC-1967 implementation slot — should equal $NEW_IMPL padded to bytes32
   ```

## See also

- Sub-5b spec: docs/superpowers/specs/2026-05-23-zswap-aztec-subproject-05b-l1-bridge-design.md
- Sub-5b plan: docs/superpowers/plans/2026-05-23-zswap-aztec-subproject-05b-l1-bridge.md
- Sub-5c spec: docs/superpowers/specs/2026-05-23-zswap-aztec-subproject-05c-operations.md (when shipped)
- On-call playbook: docs/on-call-playbook.md
