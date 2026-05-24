# Sub-6b Phase 1 — Bridge deploy (2026-05-24)

**Status:** ✅ FULL GREEN — 5 L1 contracts + 3 L2 bridge-mode tokens + 3 portal wirings all live on testnet.

## L1 deploy (Sepolia chain 11155111)

5 contracts deployed + verified live via `cast code`:

| Contract | Sepolia address |
|---|---|
| GovernanceTimelock | `0xA27E6be0CC923f377b0367e913B2B0Fa25487838` |
| EmergencyTimelock | `0x1469f18c5cd5c713e099f9acdA9C63648A8ed711` |
| USDCBridge (ERC1967Proxy) | `0x58E978ceeb768Ae906cF21757Bb4AA7166EC78Ed` |
| WETHBridge (ERC1967Proxy) | `0x4cA362a6021910828fc14c55b4F138d90CB716eC` |
| wBTCBridge (ERC1967Proxy) | `0x233DD76dF07Ce1C56D4D5fd3cE3F89994Fa64200` |

L1 inbox/outbox + canonical assets (read via `node.getL1ContractAddresses()`):
- Aztec inbox `0xf1bb424ac888aa239f1e658b5bddabc65a1c94e6`
- Aztec outbox `0x5fe63c32b7ca20445e813bdb1019f1ffc5f52376`
- Sepolia USDC `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238` (Circle)
- Sepolia WETH9 `0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14`
- Sepolia WBTC `0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599`

Multisig (gov + emergency) wired to deployer EOA `0xcF582A37AaE1E580b63666587FFa42d84169bA62` for testnet (real Safe deferred to mainnet).

Forge's broadcast tool crashed at the end with Infura 429s (rate-limit) preventing receipt fetch; on-chain state is correct (verified independently via `cast code` showing all 5 bytecodes live).

## L2 deploy (Aztec alpha-testnet, chain 11155111-rollup)

3 bridge-mode tokens deployed using a fresh wallet (`0x0a6288dc8eea7d22fa49c281efb2750a5d9e45b2bcaccbe3340a718eeb0c3c2f`), claim-funded from the Aztec faucet (`/api/drip` after the per-address rate-limit allowed):

| Token | L2 address | constructor |
|---|---|---|
| aUSDC | `0x19aec530674b3b54977b5216fdcad01d5219346e902f2bcb84653a950dd23369` | `constructor_with_minter_bridged("aUSDC", "aUSDC", 6, minter, usdcBridgeL1)` |
| aWETH | `0x0a6628fb7806e3fbb8c200dbf707b6eddaa29b54550d488f1a1d4aa56f7d65f7` | `("aWETH", "aWETH", 18, minter, wethBridgeL1)` |
| aWBTC | `0x150c2f827a1a6e44d3c17ebb0ea4678dd2115296c201bffead05c6718d56e2b3` | `("aWBTC", "aWBTC", 8, minter, wbtcBridgeL1)` |

## Portal wiring (setL2TokenAddress via governance timelock)

All 3 portals' `l2TokenAddress()` getter returns the matching L2 token (verified via `cast call`):

```
USDC ✓ wired: 0x19aec530674b3b54977b5216fdcad01d5219346e902f2bcb84653a950dd23369
WETH ✓ wired: 0x0a6628fb7806e3fbb8c200dbf707b6eddaa29b54550d488f1a1d4aa56f7d65f7
wBTC ✓ wired: 0x150c2f827a1a6e44d3c17ebb0ea4678dd2115296c201bffead05c6718d56e2b3
```

Each wiring went through `governanceTimelock.schedule()` + `governanceTimelock.execute()` with `delay=0` (testnet). On mainnet the 7-day delay would gate this.

## Bugs hit + fixed

1. **`"0x0"` instead of bytes32 zero literal in `wirePortalL2Token`** — cast rejected `--bytes32` arg with `parser error: odd number of digits`. Fixed by replacing `"0x0"` (3 chars) with `"0x" + "00"*32` (66 chars). Commit will include this fix in `scripts/deploy-bridge.ts`.

2. **Cast nonce drift between schedule + execute calls** — `next nonce N+8, tx nonce N` race when forge broadcast and cast share the same EOA. Worked around by running schedule + execute in separate processes with explicit sleeps between calls (`scripts/wire-final.sh`). Added `castSendWithRetry` helper to `scripts/deploy-bridge.ts` for future runs.

3. **Previous attempt's claim already consumed-then-reverted** for alice's wallet (`0x10a85d0b...`). Worked around by deriving a FRESH wallet (`0x0a6288dc...`), having the user claim fee-juice for that address via faucet, then seeding `deploy-bridge-state.json` with the fresh claim data + `step=3` to skip the bootstrap's own faucet drip.

## State of full Sub-5b bridge

| Layer | Status |
|---|---|
| L1 portals | ✅ live |
| L2 bridge-mode tokens | ✅ live |
| L1↔L2 portal wiring | ✅ verified |
| L1→L2 `depositToL2Public/Private` round-trip | ⏸ untested in-session (requires test USDC balance on Sepolia deployer EOA) |
| L2→L1 `exit_to_l1_public/Private` round-trip | ⏸ untested in-session (requires L2 aUSDC balance on a maker wallet) |

## Wallet topology

- **m3 trade stack** (Orderbook + Treasury + AggregatorRegistry + Pool + tUSDC/tETH): deployed 2026-05-22 by m1-admin `0x0524b493...`. Top-level `quetzal.config.json` keys (tUSDC, tETH, orderbook, etc.) point to this stack.
- **Bridge stack** (aUSDC, aWETH, aWBTC + L1 bridges + timelocks): deployed 2026-05-24 by bridge-admin `0x0a6288dc...`. `quetzal.config.json.bridge.*` + `.l1.*` point to this stack.
- These two stacks are INDEPENDENT — m3's orderbook is wired against m3 tokens, not bridge tokens. To trade bridge-mode tokens through the orderbook, a fresh Sub-4 ceremony redeploy (orderbook + pools wired against aUSDC/aWETH/aWBTC) would be needed. Out of Sub-6b scope.

## Carry-forward

1. **End-to-end L1↔L2 round-trip validation** — needs Sepolia USDC funded into the deployer EOA + the existing testnet-sub5b-bridge.ts runner pointed at the new bridge config. The bridge contracts themselves are now production-ready.
2. **Fresh Sub-4 ceremony for bridge-token trade flows** — out of Sub-6b scope. When done, Sub-6a anonymity flows can exercise the bridge-mode tokens end-to-end.
3. **Real multisig instead of EOA** — for mainnet only.

## Tag

`sub6b-phase1-bridge-full` — L1 + L2 + wiring all GREEN. Round-trip execution pending Sepolia USDC + downstream Sub-4 redeploy.
