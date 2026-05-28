# Sub-project 7c: Sepolia ↔ Aztec bridge UI — design

**Status:** design
**Date:** 2026-05-28
**Parent:** Sub-7 "Public testnet DEX" (7a faucet ✅, 7b onboarding ✅, 7c bridge UI)
**Predecessors:** [[project-subproject5b_complete]], [[project-subproject5c_complete]], [[project-subproject7b_complete]]

## Goal

A user with a Sub-7b-onboarded WalletPool + a MetaMask wallet on Sepolia can move canonical USDC / WETH / WBTC both directions across the Sub-5b/5c L1↔L2 bridge entirely from `quetzaldex.xyz/bridge`. Deposit (L1→L2), claim (L2 receive), and exit (L2→L1) are all clickable; L1 withdraw is user-sovereign via MetaMask after the L2→L1 message lands in the L1 outbox. UI surfaces every wait state with countdowns and actionable next steps.

## Non-goals

- Relayer-based instant-withdrawal (Sub-5c's Treasury fee path). Deferred to Sub-7d; YAGNI for testnet alpha where users tolerate the ~30 min L2→L1 propagation wait.
- L1 wallet management beyond MetaMask. WalletConnect, Coinbase Wallet, Rainbow are wagmi-trivial to add later; ship MetaMask only for MVP.
- Mainnet deployment. Sub-7c targets `alpha-testnet` only.
- Faucet-style bypass for L1 funding. Users must source their own Sepolia USDC / WETH / WBTC.
- Decoy / mixing privacy for L1↔L2. Sub-6's anonymity-set already lives at the order layer; bridge moves are inherently linkable on L1 anyway.

## Architecture

```
                ┌──────────────────────────────────────────────────┐
quetzaldex.xyz  │  frontend/src/screens/bridge.tsx (existing      │
(Vite + React)  │    DepositTab + ClaimTab + ExitTab, Sub-6c)     │
                │                                                  │
                │    Sub-7c wires each tab to live operations:    │
                │      ├─ wagmi + viem (NEW for frontend)          │
                │      ├─ MetaMask connect (new TopBar item)       │
                │      └─ @quetzal/sdk's BridgeApi (extended)      │
                └──────────────────────────────────────────────────┘
                            │                          │
                            │ L1 sign + read           │ L2 sign + read
                            ▼                          ▼
                  ┌──────────────────┐         ┌─────────────────────┐
                  │ Sepolia          │         │ Aztec testnet       │
                  │ TokenBridge.sol  │         │ Token contract      │
                  │ (Sub-5b/5c)      │         │ claim_*/exit_*      │
                  │ Outbox           │         │ (Sub-5b)            │
                  │ (sibling paths)  │         │                     │
                  └──────────────────┘         └─────────────────────┘
```

The frontend gains a NEW L1 wallet context (wagmi) alongside the existing WalletPool (L2). Bridge ops sequence MetaMask + WalletPool transactions explicitly per flow. Pending claims and pending withdraws persist in localStorage so a tab refresh doesn't lose track.

## Phases (informs implementation plan structure)

| Phase | Purpose | Net new files |
|---|---|---|
| A — SDK additions | `deposit()`, `getMessageReady()`, `getOutboxProof()`, `withdrawOnL1()` on BridgeApi | sdk/src/bridge.ts (extend), sdk/src/bridge.test.ts (extend), sdk/src/util/outbox-proof.ts (NEW) |
| B — Frontend L1 wallet | wagmi + viem + MetaMask connect; L1 context provider | frontend/src/l1/{provider.tsx, hooks.ts, connect-button.tsx}; modify App.tsx + TopBar |
| C — Deposit tab wire-up | Replace "use script" error with live deposit flow | frontend/src/screens/bridge.tsx DepositTab refactor; persistence helper |
| D — Claim + Exit tab polish | Message-ready countdown, L1 withdraw button after exit, balance refresh | frontend/src/screens/bridge.tsx ClaimTab + ExitTab refactor; tests; deploy |

## Components

### `sdk/src/util/outbox-proof.ts` (NEW)

The Sub-5c `tools/outbox-proof/` is a standalone Node binary that talks to the Aztec node JSON-RPC to fetch a Merkle sibling-path for an L2→L1 message. For browser use, port the same logic to a browser-friendly function:

```ts
export interface OutboxProof {
  siblingPath: `0x${string}`[];
  index: bigint;
  blockNumber: bigint;
}

export async function fetchOutboxProof(
  nodeUrl: string,
  l2BlockNumber: bigint,
  l2MessageIndex: bigint,
): Promise<OutboxProof>;
```

Implementation delegates to `@aztec/aztec.js/node`'s `getL2ToL1MessageMembershipWitness` (or equivalent — verify the exact API in `@aztec/stdlib/messaging` since Sub-5c's tool uses a specific canonical helper). No subprocess required; pure async function.

### `sdk/src/bridge.ts` (EXTEND)

Add three new methods to `BridgeApi`:

```ts
/**
 * L1→L2 deposit. Caller MUST pass a viem WalletClient (MetaMask-backed).
 * Approves + calls bridge.depositToL2Public(amount, l2Recipient, secretHash).
 * Returns the messageIndex from the event log + the secret for claim_public.
 */
async deposit(input: BridgeDepositInput, l1Wallet: WalletClient): Promise<BridgeDepositResult>;

/**
 * Polls Aztec L1→L2 message tree for whether a deposit's message hash is yet
 * present + included in a finalised block. Returns `true` when claim_public
 * is safe to call.
 */
async getMessageReady(messageHash: `0x${string}`): Promise<boolean>;

/**
 * After exit() lands the L2 tx + Aztec rolls up to L1, the user calls
 * bridge.withdraw() on Sepolia with the outbox sibling path. This method:
 *   1. Fetches the outbox proof via util/outbox-proof.ts
 *   2. Composes the L1 tx data (no sign)
 *   3. Returns { to, data } for the caller to .sendTransaction on a viem WalletClient
 */
async prepareL1Withdraw(input: {
  l2TxHash: string;
  l2BlockNumber: bigint;
  l2MessageIndex: bigint;
  token: "aUSDC" | "aWETH" | "aWBTC";
  amount: bigint;
  l1Recipient: `0x${string}`;
}): Promise<{ to: `0x${string}`; data: `0x${string}` }>;
```

`deposit()` body uses viem (already in deps via `@aztec/ethereum` from Sub-5b/5c) to:
1. `wallet.writeContract(tokenAddr, ERC20_APPROVE_ABI, [bridge, amount])` — approve
2. `wallet.writeContract(bridgeAddr, BRIDGE_DEPOSIT_ABI, [recipient, amount, secretHash])` — deposit
3. Parse the receipt for `DepositToAztecPublic` event → return `{ l1TxHash, messageIndex, secret, secretHash }`

The secret is generated browser-side (`Fr.random()`); secretHash is `computeSecretHash(secret)` (mirrors Sub-7a faucet's L1Bridge). The secret never leaves the browser.

### `frontend/src/l1/provider.tsx` (NEW)

wagmi-based L1 wallet context. Uses `WagmiProvider` + a `QueryClient` (separate from the existing react-query client). Exports:

```tsx
export function L1Provider({ children }: { children: ReactNode }): JSX.Element;
```

Configures one chain (Sepolia), one connector (MetaMask via `injected()`), no auto-connect. State is lazy — no MetaMask popup until the user explicitly clicks "Connect L1".

### `frontend/src/l1/hooks.ts` (NEW)

Thin wrappers around wagmi hooks so the rest of the app doesn't import wagmi directly:

```ts
export function useL1Account(): { address?: `0x${string}`; isConnected: boolean };
export function useL1Connect(): { connect: () => void; isPending: boolean };
export function useL1Disconnect(): () => void;
export function useL1WalletClient(): WalletClient | null;
export function useL1Balance(token: "USDC" | "WETH" | "WBTC"): { value: bigint | null; isLoading: boolean };
```

`useL1Balance` reads the L1 ERC20 `balanceOf(l1Address)` directly via viem; refreshes on a 30s `staleTime`.

### `frontend/src/l1/connect-button.tsx` (NEW)

Atom-style button rendered in TopBar. Three states:
- Not connected → "Connect L1" PillButton, click → opens MetaMask popup
- Connecting → spinner
- Connected → shows truncated L1 address + dropdown for disconnect

### `frontend/src/screens/bridge.tsx` (REFACTOR)

Per-tab changes:

**DepositTab:**
- Reads `useL1Account()` — if not connected, renders "Connect L1 first" CTA inline.
- On submit: `client.bridge.deposit({...}, l1WalletClient)` → on success, `addLocalPendingClaim(...)`.
- Estimated-time chip: "L1→L2 message expected in ~3-15 min".

**ClaimTab:**
- For each pending claim row, poll `client.bridge.getMessageReady(messageHash)` every 30s via react-query.
- Show "✓ Ready to claim" or "⏳ Waiting for L1→L2 (avg 3-15 min)".
- "Claim" button only enabled when `getMessageReady === true`.

**ExitTab:**
- After successful `exit()`, store an L2→L1 pending withdraw in localStorage: `quetzal-pending-withdraws`.
- New row group below the existing one: "Pending L1 withdraws".
- Each row polls Aztec node for the L2 block-finalised flag. Once finalised + outbox proof available, render "Withdraw on L1" button.
- Click → `client.bridge.prepareL1Withdraw(...)` → `l1WalletClient.sendTransaction({to, data})` → on receipt, mark withdraw "complete".

### `frontend/src/App.tsx` (MODIFY)

- Wrap existing `<ClientProvider>` with `<L1Provider>` at root.
- Pass `<ConnectButton />` into the TopBar component.

## Data flow

### Deposit (L1 → L2)

```
User           Browser                  L1 (Sepolia)       Aztec sequencer
 │
 1. fill form + click "Deposit"
 │
 ├─→ FE: Fr.random() → secret
 ├─→ FE: computeSecretHash(secret)
 ├─→ FE: client.bridge.deposit(...)
 │   ├─→ ERC20.approve(bridge, amount)  ──→ L1 tx (MetaMask sign)
 │   ├─→ bridge.depositToL2Public(...)  ──→ L1 tx (MetaMask sign)
 │   ├─→ parse receipt → messageIndex, messageHash
 │   └─→ addLocalPendingClaim({ secret, secretHash, messageIndex })
 │
 2. UI shows pending claim in ClaimTab
 │
 ├─→ poll getMessageReady(messageHash) every 30s
 │   └─→ Aztec node: getL1ToL2MessageMembershipWitness(hash)
 │       └─→ returns membership when sequencer has rolled up
 │
 3. UI flips row to "Ready to claim"; user clicks "Claim"
 │
 └─→ client.bridge.claim({ token, amount, secret, messageIndex })
     └─→ L2 token.claim_public(...) signed by WalletPool
         └─→ tokens credited on L2; remove from localStorage
```

### Exit (L2 → L1)

```
User           Browser                       Aztec                L1 (Sepolia)
 │
 1. fill form + click "Exit"
 │
 ├─→ client.bridge.exit({ token, amount, l1Recipient, isPrivate })
 │   ├─→ amount-pattern advisory (existing)
 │   ├─→ round-trip detection (existing)
 │   └─→ L2 token.exit_to_l1_*  ──→ L2 tx
 │       └─→ returns { l2TxHash }
 │
 2. UI persists pending withdraw to localStorage
 │
 ├─→ poll getL2BlockFinalised(l2TxHash) every 60s
 │   └─→ returns finalised + l2BlockNumber when rolled up to L1
 │
 3. UI flips row to "Ready to withdraw"; user clicks "Withdraw on L1"
 │
 ├─→ client.bridge.prepareL1Withdraw({ l2TxHash, l2BlockNumber, ... })
 │   ├─→ fetchOutboxProof(...) → siblingPath
 │   └─→ encode bridge.withdraw(...) calldata → { to, data }
 │
 └─→ MetaMask: walletClient.sendTransaction({ to, data })
     └─→ L1 receipt → mark withdraw "complete"; refresh L1 balance
```

## Error handling

| Failure | UI response |
|---|---|
| MetaMask not installed | DepositTab: inline banner with installation link, button to retry detection |
| MetaMask wrong chain | "Switch to Sepolia" button → `walletClient.switchChain(sepolia)` |
| Insufficient L1 token balance | Banner: "You need ≥ {amount} {symbol} on Sepolia. Get from Aave / Sepolia bridge." |
| Insufficient L1 ETH (gas) | Banner: "Need ≥ 0.005 ETH on Sepolia for gas. Get from sepoliafaucet.com." |
| User rejects MetaMask popup | Toast "Cancelled" — no state change |
| Bridge deposit reverts | Surface revert reason; mark pending claim as "failed" (clearable) |
| `getMessageReady` returns false after 30 min | Banner row: "Slower than expected. Aztec sequencer may be behind. Check faucet.quetzaldex.xyz/api/health." |
| Exit tx reverts | Surface reason; no withdraw persisted |
| Withdraw L1 tx reverts | Surface reason; withdraw stays "ready" so user can retry |
| Outbox proof not yet available (L2 block not finalised on L1) | "Wait ~10 min more" — auto-retry on next poll |

## Testing

- **Unit tests (SDK):**
  - `BridgeApi.deposit` happy path with a mocked viem `WalletClient`
  - `BridgeApi.getMessageReady` happy + not-ready paths against mocked node
  - `BridgeApi.prepareL1Withdraw` returns valid calldata for known inputs
  - `util/outbox-proof.ts` against a recorded fixture
- **Unit tests (frontend):**
  - `L1Provider` + `useL1Account` + `useL1Connect` render flow with wagmi's `mock` connector
  - `connect-button.tsx` state transitions
- **Component tests (Vitest + Testing Library):**
  - `DepositTab` happy flow with mocked SDK + L1 wallet
  - `ClaimTab` polling flow with `vi.useFakeTimers`
  - `ExitTab` flow with mocked SDK + outbox proof
- **Manual E2E:**
  - Documented in `aggregator/ops/RUNBOOK-bridge.md` (NEW): operator drips Sepolia USDC + ETH, runs full deposit→claim→exit→withdraw round-trip, captures every screenshot

## Configuration

Vite env vars (add to `frontend/.env.example`):

```
# Sepolia RPC for L1 reads + wagmi default chain.
VITE_L1_RPC_URL=https://sepolia.drpc.org

# L1 bridge contract addresses (sourced from quetzal.config.json:l1.*).
# Wagmi/viem read these at build time to compose contract calls.
VITE_L1_USDC_BRIDGE=0x219ffbb6a504fcd69ae80d1e70db699b48a9936b
VITE_L1_WETH_BRIDGE=0x3f5aab58fcef4da7d7de18dad88d83e5b97afe2d
VITE_L1_WBTC_BRIDGE=0x6ac87d986f6afcd6d13c51dd114b069ac4e5b5fd

# L1 token addresses (USDC / WETH / WBTC on Sepolia).
# Source: cross-reference with bridge.usdcToken() etc. once contracts are loaded.
VITE_L1_USDC_TOKEN=
VITE_L1_WETH_TOKEN=
VITE_L1_WBTC_TOKEN=
```

`VITE_L1_*_TOKEN` are queried via `bridge.usdcToken()` etc. on the deployed Sub-5b contracts; the implementer fills them in during Phase B from the on-chain lookup.

## Out of scope (deferred)

| Item | Where it lives |
|---|---|
| Relayer + Treasury fee for instant L1 withdraw | Sub-7d (production polish) |
| WalletConnect / Rainbow / Coinbase Wallet | Sub-7d |
| Mainnet network selection | Sub-7d |
| L1 token swap before deposit (Uniswap embed) | Out of scope; user sources tokens |
| Cross-chain message tracking dashboard | YAGNI for MVP; localStorage is enough |
| Withdraw history (past completed withdraws) | YAGNI; localStorage TTL of 30 days |

## Acceptance criteria

- [ ] `client.bridge.deposit(...)` succeeds end-to-end on testnet (no more `BridgeError("not implemented")`)
- [ ] MetaMask connect button visible in TopBar; click opens MetaMask; address visible after connect
- [ ] DepositTab full flow: connect L1 → approve → deposit → pending claim row appears
- [ ] ClaimTab polling: row updates from "Waiting" → "Ready" → claim succeeds → row removed
- [ ] ExitTab full flow: exit submits L2 tx → pending withdraw row appears → finalises → user clicks "Withdraw on L1" → MetaMask sign → row removed
- [ ] Round-trip detection + amount advisory still gate exit (existing Sub-6 features preserved)
- [ ] All error states render specific messages (not generic 500-pages)
- [ ] localStorage survives tab refresh; pending claims + withdraws restore on reload
- [ ] `pnpm -F @quetzal/frontend build` succeeds with wagmi + viem bundled
- [ ] `pnpm -F @quetzal/sdk test` + `pnpm -F @quetzal/frontend test` both green
- [ ] Manual E2E walkthrough documented in `aggregator/ops/RUNBOOK-bridge.md`
