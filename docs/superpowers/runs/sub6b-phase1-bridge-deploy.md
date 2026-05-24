# Sub-6b Phase 1 — Bridge deploy attempt (2026-05-24 afternoon)

**Status:** L1 GREEN (5 contracts live on Sepolia) — L2 BLOCKED on alice's fee-juice claim missing from L2 inbox

## L1 deploy outcome

Foundry script `contracts-l1/script/DeployAllBridges.s.sol` broadcast to Sepolia (chain 11155111). 5 contracts deployed + verified live via `cast code`:

| Contract | Sepolia address | code size |
|---|---|---|
| GovernanceTimelock | `0xA27E6be0CC923f377b0367e913B2B0Fa25487838` | 10903 bytes |
| EmergencyTimelock | `0x1469f18c5cd5c713e099f9acdA9C63648A8ed711` | 10903 bytes |
| USDCBridge (ERC1967Proxy) | `0x58E978ceeb768Ae906cF21757Bb4AA7166EC78Ed` | 263 bytes |
| WETHBridge (ERC1967Proxy) | `0x4cA362a6021910828fc14c55b4F138d90CB716eC` | 263 bytes |
| wBTCBridge (ERC1967Proxy) | `0x233DD76dF07Ce1C56D4D5fd3cE3F89994Fa64200` | 263 bytes |

Wired into `quetzal.config.json` under `l1.{governanceTimelock, emergencyTimelock, usdcBridge, wethBridge, wbtcBridge}`.

L1 inbox/outbox + canonical USDC/WETH/wBTC addresses (read via `node.getL1ContractAddresses()` from Aztec testnet):
- inbox: `0xf1bb424ac888aa239f1e658b5bddabc65a1c94e6`
- outbox: `0x5fe63c32b7ca20445e813bdb1019f1ffc5f52376`
- Sepolia USDC: `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238` (Circle)
- Sepolia WETH9: `0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14`
- Sepolia WBTC: `0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599`

Multisig (governance + emergency) wired to the deployer EOA `0xcF582A37AaE1E580b63666587FFa42d84169bA62` for testnet simplicity — this is a single-signer "multisig" stub. For mainnet a real Safe is needed (per Sub-5c runbook).

Forge's broadcast tool crashed at the end with `attempt to divide by zero` due to Infura rate-limit responses (429s) preventing receipt fetch. The on-chain state is correct (all 5 contracts live, verified independently via `cast code`) — only the broadcast post-processing crashed.

## L2 deploy blocker

The script then attempts to deploy 3 L2 bridge-mode tokens (`aUSDC`, `aWETH`, `aWBTC`) using alice's wallet (from `.env.testnet`'s AZTEC_SECRET_KEY + AZTEC_PRIVATE_KEY → address `0x10a85d0b...`).

First attempt failed with `Not enough balance for fee payer`: alice's fee-juice claim from the faucet was never consumed (the earlier 1.1 deploy attempt failed at the tUSDC constructor before consuming the claim).

A patch was applied to `scripts/deploy-bridge.ts` (`Sub-6b 1.2 patch: if alice's fee-juice claim is still un-consumed ...`) to use `FeeJuicePaymentMethodWithClaim` for the FIRST L2 token deploy tx. This is the correct fix in principle.

Second attempt failed differently: `No L1 to L2 message found for message hash 0x00aa94a1bfca88c254d727af58fb8dd1f1e2694233d8930c77843aeb6c55f99e`. The fee-juice claim message that the faucet supposedly produced (per `AZTEC_FAUCET_CLAIM_*` env vars) is NOT present on the L2 inbox. Possible causes:
- The earlier 1.1 attempt's claim was partially consumed (nullifier inserted on L2) but the tx itself reverted at simulation, leaving the message unusable
- The faucet's L1 → L2 message hash computation diverged from what aztec.js computes from the claim secret + recipient
- Faucet message landed before alice's account address was finalized, and was consumed by a different recipient

Without a fresh faucet drip (rate-limited 6 hours per IP per request), there is no way forward for L2 token deploys in this session.

## State of partial progress

- **L1 stack:** ✅ deployed + verified
- **L2 stack (aUSDC / aWETH / aWBTC):** ❌ blocked on alice fee-juice
- **Timelock wiring (setL2TokenAddress):** ❌ depends on L2 stack
- **Sub-5b deposit→claim→exit cycle:** ❌ depends on L2 stack
- **Bridge tick C4 smoke:** ❌ depends on Sub-5b

## Carry-forward to next operator session

1. Wait ≥6 hours for faucet rate-limit reset, then re-run with a fresh wallet (delete `deploy-bridge-state.json` to force fresh faucet drip)
2. OR fund alice's account with fee-juice via a different path (the Aztec faucet `claim` endpoint may have a separate "I have a claim, give me fee-juice" flow)
3. OR use a different .env.testnet wallet that already has fee-juice on L2

Once L2 tokens deploy, the script will automatically:
- Call `wirePortalL2Token` for each (timelock schedule + execute with `delay=0` for testnet)
- Overwrite `quetzal.config.json.{tUSDC, tETH, tBTC}` with the new bridge-mode addresses
- Make Sub-5b runner runnable

**Note on config conflict:** after the L2 deploy lands, the m3-era trade tokens (current tUSDC/tETH) will be replaced. The m3 Orderbook + Pool + Treasury + AggregatorRegistry are wired against the m3 tokens — they cannot trade aUSDC/aWETH. A FULL FRESH Sub-4 ceremony redeploy would be required to wire Orderbook against the bridge tokens. Alternatively keep the m3 trade stack as-is and use bridge tokens only for L1↔L2 round-trips (no on-chain trades).

## Git artifacts

- `quetzal.config.json` — extended with `l1.*` section + 5 bridge addresses (commit pending)
- `scripts/deploy-bridge.ts` — patched with `FeeJuicePaymentMethodWithClaim` fallback (commit pending)
- `contracts-l1/broadcast/` — Foundry broadcast log (gitignored; local-only)
- `deploy-bridge-state.json` — wallet bootstrap state (gitignored)
- `quetzal.config.m3-backup.json` — pre-bridge config snapshot (gitignored)

## Tag

`sub6b-phase1-bridge-deploy-partial` — partial green (L1 done, L2 blocked).
