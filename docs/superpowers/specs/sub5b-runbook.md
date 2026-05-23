# Sub-5b Mainnet Deployment Runbook

Operator walkthrough for deploying the ZSwap-on-Aztec L1↔L2 bridge to
Ethereum mainnet + Aztec mainnet. Estimated walltime: 1-2 working days
excluding multisig signer coordination + the 7-day timelock window.

## Prerequisites

- [ ] Sub-5b code-complete + merged on `main` (HEAD includes A1-G2 commits).
- [ ] L1 audit complete: independent security review of `contracts-l1/` —
      ESPECIALLY `TokenBridge.sol` (UUPS upgrade pattern, custom-error
      ownership, TVL cap semantics, sha256ToField content-hash format).
- [ ] **EmergencyPauser role added before mainnet deploy.** The 7-day
      timelock on `pause()` is unacceptable for security incidents;
      `Sub-5b carryforward`: add a separate role with delay=0 timelock
      JUST for `pause()`. Must ship before initial deposits open.
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
- [ ] Monitoring infrastructure (Sub-5c carryforward) ready: TVL
      dashboard, L1↔L2 message-queue depth alert, pause-state
      monitoring.

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

## Initial cap ramp policy

| Day | Action | Rationale |
|-----|--------|-----------|
| 0 | $10,000 cap per portal | Smoke-test live volume |
| 30 | If no incidents: setMaxTvl(100,000) | First confidence ramp |
| 60 | If no incidents: setMaxTvl(1,000,000) | Mid-tier capital |
| 90 | If no incidents: setMaxTvl(0) (unlimited) | Full open |

Each cap change is timelocked 7 days. Total ramp ≈ 3 months.

**WARNING:** `setMaxTvl(0)` means UNLIMITED (no cap enforcement), NOT
zero deposits. To block deposits entirely, use `pause()` — not setMaxTvl.

## Incident response

### Pause sequence

**OPEN ISSUE:** Without the EmergencyPauser role (Sub-5b carryforward
flagged in prerequisites), `pause()` requires the 7-day timelock —
unacceptable for security incidents. Until that ships, mainnet
operations carry this risk: an exploit cannot be paused for 7 days.

Once EmergencyPauser is wired:

```bash
# Emergency role multisig (separate from Phase 3 multisig):
cast send $EMERGENCY_TIMELOCK "schedule(address,uint256,bytes,bytes32,bytes32,uint256)" \
  $USDC_BRIDGE 0 $(cast calldata "pause()") 0x0 0x0 0
cast send $EMERGENCY_TIMELOCK "execute(address,uint256,bytes,bytes32,bytes32)" \
  $USDC_BRIDGE 0 $(cast calldata "pause()") 0x0 0x0
# Repeat for WETHBridge.
```

### Resume after pause

1. Root-cause investigation (post-mortem doc).
2. Fix shipped + re-audited if scope warrants.
3. Multisig schedules `unpause()` via 7-day governance timelock
   (NOT the EmergencyPauser — emergency is one-way to pause only).
4. After 7 days, anyone executes the unpause.

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
- Sub-5c (when shipped): production monitoring + on-call rotation + EmergencyPauser
