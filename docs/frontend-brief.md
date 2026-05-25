# Quetzal Frontend — Brief for Claude Design / v0 / Magic Patterns

> Self-contained prompt for AI UI generation tools. Drop into Claude (claude.ai/new), v0.dev, Magic Patterns, Figma Make, or similar. The first 4 sections are the strict brief; the rest is reference.

---

## 1. What you're building

**Quetzal** — an MEV-resistant **dark-pool DEX** running on the **Aztec Network** (privacy-preserving L2). Open-source, port of Penumbra's Quetzal protocol.

A trader (maker) places **private orders** that are batched into per-epoch clearings. Order side/amount/limit-price are hidden on-chain; only the clearing result is public. The frontend lets makers:

- Connect a wallet (Aztec Wallet browser provider OR self-managed wallet pool)
- Place orders (single OR bulk with privacy decoys)
- Claim fills after epoch close
- Cancel open orders
- Bridge USDC/WETH/wBTC from Sepolia L1 to Aztec L2 and back
- See position history + balances

**This is a power-user trading UI**, not a casual swap interface. Optimize for clarity over flashiness. Privacy-first aesthetic.

## 2. Tech stack constraints (strict)

- **Framework**: Next.js 14+ App Router OR Vite + React 18. Pick one.
- **Styling**: Tailwind CSS + shadcn/ui components.
- **State**: React Query (TanStack Query) for SDK calls; Zustand for client-side wallet pool state.
- **Backend integration**: Imports from `@quetzal/sdk` workspace package. **All chain interaction goes through this SDK** — never raw aztec.js or viem in components.
- **Wallet**: `@quetzal/sdk`'s `WalletPool` class (HD-derived N children) OR `AztecWalletAdapter` (browser provider). Both supported; user picks at first launch.
- **TypeScript**: strict mode, 0 `any`.
- **No mock data**: wire every screen to real SDK calls. Loading + error states for each.

## 3. Visual direction

**Name origin**: "Quetzal" — the resplendent quetzal bird, sacred to Mesoamerican civilizations. Long iridescent tail feathers. Symbol of freedom/privacy.

**Palette** (dark-mode primary; light mode optional):
- Background: near-black `#0a0e0d` with a subtle warm undertone
- Surface (cards/modals): `#13181a`
- Quetzal green (primary action): `#0d9876` (rich, slightly desaturated emerald)
- Quetzal gold (highlights, "active" badges): `#c9a44b`
- Privacy purple (decoy / shielded indicators): `#7c5cff`
- Danger / advisory: `#d97757` (warm coral, not harsh red)
- Muted text: `#7a8682`
- Body text: `#e6ebe9`

**Typography**:
- UI: Inter (system fallback)
- Monospace (tx hashes, amounts): JetBrains Mono OR IBM Plex Mono
- Body sizing: 14-15px base, generous line-height

**Iconography**:
- Lucide-react for general UI
- Custom Quetzal feather glyph as logo (long curved tail, simple line art)
- Privacy indicators: small shield icons (filled = active, outlined = optional)

**Visual motifs (subtle, not kitsch)**:
- Quetzal tail feather as background watermark on landing/empty states
- Mesoamerican step-pattern as section dividers (1-2px thick, low opacity)
- "Privacy shimmer" — subtle gradient animation on private-state badges (encrypted note count, decoy markers)

**Spatial language**:
- Generous padding (cards ~24px internal)
- Border-radius: `8px` for buttons, `12px` for cards, `16px` for modals
- Subtle 1px border (`#1f2724`) on cards (no shadows in dark mode)
- Glass-morphism ONLY on the wallet connector modal

## 4. Pages + routes

| Route | Purpose |
|---|---|
| `/` | Landing — connect wallet, brief explainer, "Start Trading" CTA |
| `/trade` | Main trade screen (order placement, open orders, recent fills) |
| `/positions` | LP positions (Sub-2 concentrated liquidity buckets) |
| `/bridge` | L1↔L2 bridge (deposit + claim + scheduled exits) |
| `/wallet` | Wallet pool management (HD master setup, per-child balances, faucet helper) |
| `/history` | Order + bridge tx history (filterable by epoch, side, asset) |
| `/settings` | Network selector (alpha-testnet/sandbox/mainnet), privacy preferences, advanced (gas, RPC overrides) |

No admin/aggregator/governance UIs — those are out of scope for the maker frontend.

## 5. Key flows (detailed)

### 5.1 First-launch wallet setup

**Goal**: Get a maker from cold-start to "ready to trade" in <2 minutes.

Screen sequence:
1. **Landing card**: "Welcome to Quetzal. Private trading on Aztec." — single CTA: "Set up wallet"
2. **Wallet mode picker** (2 cards, side-by-side):
   - **Aztec Wallet** (browser provider) — "If you already have the Aztec Wallet browser extension. Click to connect."
   - **WalletPool** (HD pool) — "Self-managed N-wallet pool for high-throughput trading. Recommended for power users." (highlighted "Recommended" badge in Quetzal gold)
3. If WalletPool chosen:
   - **Master secret screen**: Generate fresh (recommended; show "Save this 64-char hex string to your password manager" warning) OR import existing
   - **Pool size slider**: 1-20 (default 3); show capacity preview ("≈ 54 simultaneous orders before stall")
   - **Network picker**: alpha-testnet (default for now), sandbox, mainnet
   - **"Initialize pool" button**: triggers `WalletPool.fromMaster()`, shows per-child address list once ready, links to faucet for each on testnet
4. **Faucet helper** (testnet only): "Each wallet needs fee-juice. Click to open faucet for: 0xa1b2... [Open]". Tracks faucet drip per child; greys out completed.
5. Land in `/trade` once ≥1 child funded.

### 5.2 Place order

Layout: 2-column on desktop, single-column on mobile.

**Left column (form)**:
- Pair selector (USDC/ETH default; Sub-4 also has USDC/BTC, ETH/BTC)
- **Side toggle** (Buy / Sell) — large pill, Quetzal green when active. Tooltip: "Buy = pay the canonical-low token, receive canonical-high. SDK auto-handles direction."
- Amount input with token dropdown
- Limit price input (placeholder: pool's current sqrt_p ± 5%)
- **Privacy panel** (collapsible, expanded by default for first 3 sessions):
  - **Decoys slider** (0-4): Show anonymity-set badge "1 real + N decoys" with privacy purple. Tooltip: "Decoys submit unfillable orders alongside yours so observers can't tell which is real."
  - **Round-amount advisory**: live-render if `classifyAmount` flags non-natural. Show "WARN: amount 1 USDC looks round (round_unit). Suggest 1.07 USDC →" with one-click "Apply" + override "Acknowledge & proceed" checkbox.
- **Submit button**: green, full-width. Shows pending state + tx hash on success.

**Right column (open orders)**:
- Table of maker's active orders: nonce (short), side, amount, limit, epoch, status (Open/Filled/Cancelled), [Claim] / [Cancel] action buttons
- "Cancel decoys" batch button at top (only enabled if pool has decoy nonces in `~/.quetzal/decoy-registry-*.json`)
- Auto-refresh every 10s via React Query

**Below**: recent fills (last 20) with TX explorer links

### 5.3 Bridge (deposit + claim + scheduled exits)

3-tab layout: **Deposit** / **Claim** / **Exit**.

**Deposit tab** (L1 → L2):
- Token selector (USDC/WETH/wBTC)
- Amount input + max button (reads L1 balance via SDK)
- Recipient: default = current maker wallet; "Send to..." advanced toggle
- **Privacy mode toggle**: Public (default) / Private. Tooltip explains: "Private deposits use a secret hash; only you can claim. Public deposits go directly to recipient."
- Submit → shows L1 tx + "Waiting for L1→L2 message (~4-15 min)" progress bar; auto-polls + transitions to "Ready to claim" when message lands

**Claim tab**:
- Lists pending deposits (read from local state + on-chain message index)
- Each row: amount, secret (truncated, copy button), age, [Claim] button
- One-click claim submits `client.bridge.claim` + shows resulting L2 tx

**Exit tab** (L2 → L1):
- Token selector + amount + L1 recipient
- **Multi-hop split** toggle (Sub-6a C3): "Split into N partial withdrawals" — slider 1-20, interval-days input 1-90
- **Round-amount advisory** (same as order placement): warn + ack
- **Round-trip risk advisory** (Sub-6a C2): if exit amount within 5% of a recent L1 deposit by same maker, show warning "This may link your L1 deposit to your L2 activity. Consider perturbing amount."
- Submit → for splitInto > 1, shows the schedule as a timeline of pending exits; user can `bridge tick` manually OR enable "Auto-tick" background job

**Below all tabs**: scheduled exits table (status: pending/submitted/done) with manual tick + auto-claim controls

### 5.4 Wallet pool view

Single-page dashboard:
- Header: "Pool: 3 wallets, 162 unfinalised-slot capacity"
- Per-child card grid (3-up on desktop): address (short, copy), fee-juice balance, aUSDC/aWETH/aWBTC balances, pending-tx count (X/18 bar — green<10, gold 10-15, coral 16-18), [Faucet] button (testnet) / [Self-fund] (mainnet)
- **Pool exhaustion banner** if all children saturated: "All wallets at capacity. Submissions paused. [Wait for finalization] or [Grow pool]"
- "Grow pool" expander: adjust N slider, "Add 2 more wallets" button (re-runs `fromMaster` with larger N; old child addresses preserved)
- Master secret: collapsed by default, "Show" reveals + "Export to clipboard" + warning banner

### 5.5 Order history + filters

- Filter row: epoch range (slider), side (buy/sell/all), token, status, decoy filter ("show real only" toggle)
- Table: epoch, time, side, amount, limit, fill price (if filled), status, tx links
- Export CSV button

## 6. SDK integration cheatsheet

All API surface from `@quetzal/sdk`:

```typescript
import { QuetzalClient, WalletPool } from "@quetzal/sdk";

// WalletPool path:
const pool = await WalletPool.fromMaster({
  masterSecret: "0x...",
  n: 3,
  network: "alpha-testnet",
});
const client = pool.next();  // round-robin

// Aztec Wallet path:
const client = await QuetzalClient.connect({
  network: "alpha-testnet",
  account: { type: "aztec-wallet", provider: window.aztec },
});

// Place order (path auto-canonicalized; SDK flips side if needed)
const r = await client.orders.placeOrder({
  side: "sell",                    // "buy" | "sell"
  amount: 1_234_567n,              // bigint base units (USDC = 6 dec)
  limitPrice: 5_000n,
  path: ["tUSDC", "tETH"],         // 2-hop or 3-hop token alias array
});

// Bulk with decoys (anonymity set, K=5 max)
const bulk = await client.orders.placeOrderBulk({
  side: "sell",
  amount: 1_234_567n,
  limitPrice: 5_000n,
  path: ["tUSDC", "tETH"],
  decoyCount: 4,                   // 0-4
});

// Claim a fill
await client.orders.claimFill({ nonce: r.nonce, epoch: r.epoch, filterDecoys: true });

// Cancel
await client.orders.cancelOrder({ nonce: r.nonce });

// Bridge deposit
const dep = await client.bridge.deposit({ token: "tUSDC", amount: 1_000_000n, isPrivate: true });

// Bridge claim (after L1->L2 wait)
await client.bridge.claim({ token: "tUSDC", amount: 1_000_000n, isPrivate: true, secret: dep.secret, messageIndex: dep.messageIndex });

// Bridge exit (single OR scheduled split)
await client.bridge.exit({
  token: "tUSDC",
  amount: 1_000_000n,
  l1Recipient: "0x...",
  splitInto: 3,                    // optional; >1 returns scheduledExits[] instead
  intervalDays: 7,
  ackRound: false,                 // user must explicitly ack round-amount warning
  ackDelay: false,                 // user must explicitly ack round-trip warning
});

// Bridge tick (processes scheduled exits)
await client.bridge.tick({ autoClaim: true });

// Reads (no tx)
const orders = await client.reads.getOrders();
const epoch = await client.reads.getCurrentEpoch();
const bal = await client.reads.getBalance("tUSDC");
const pools = await client.reads.getPools();

// Privacy helpers
import { classifyAmount, formatAdvisory } from "@quetzal/sdk/privacy/amount-heuristic";
const heuristic = classifyAmount(amount, 6);  // returns {classification, suggested}

import { isDecoy, listDecoys } from "@quetzal/sdk/privacy/decoy-registry";

// Errors (all extend QuetzalError)
import { OrderError, BridgeError, ConfigError } from "@quetzal/sdk";
try { ... } catch (e) {
  if (e instanceof BridgeError && e.code === "OUTBOX_PROOF_MISSING") { /* wait + retry */ }
}
```

## 7. Privacy UX considerations (must-have)

**Three transparent privacy mitigations** — surface UI controls, don't hide them:

1. **Decoy submission** (Sub-6a): the bulk-with-decoys flow ships in the order form's privacy panel. Default decoys=2; never silently submit 0 when user expects privacy. Always show the registry size after submit ("1 real + 2 decoys saved; cancel them after clearing").
2. **Round-amount advisory** (Sub-6a D2): live-render BEFORE the user clicks submit. Don't just throw on submit — let user adjust the amount inline.
3. **Bridge round-trip warning** (Sub-6a C2): show in bridge exit form. Include explainer modal: "Why does this matter? [link]".

**Visual privacy indicators throughout**:
- Encrypted notes shown with a small shield icon + "private" badge
- Public state (bridge tokens, pool reserves) shown with a clear "public" tag
- Decoy markers in history use privacy purple

## 8. Out of scope (don't build)

- Admin / governance UI
- Aggregator operator UI (separate codebase)
- Audit / monitoring dashboards (Prometheus already exists for ops)
- Mobile-first responsive (desktop-first; collapse gracefully but no mobile-native gestures)
- Multi-language i18n (English only for now; structure for easy add later)
- Hardware wallet integration (Aztec Wallet provider covers ledger/etc via its own UI)

## 9. Error handling

Every async operation gets:
- Loading state (skeleton OR spinner)
- Empty state (illustrated; brief explainer; CTA to fix)
- Error state with toast notification + retry button
- Success state with toast + "View on explorer" link

Error code → user message mapping (use SDK's `QuetzalError.code`):
- `EPOCH_CLOSED`: "Epoch closed before your order landed. Try again next epoch."
- `INVALID_PATH`: "Invalid trading pair. Check token addresses."
- `ESCROW_FAILED`: "Insufficient balance or escrow rejected. Check your wallet."
- `L2_TX_FAILED`: "Transaction failed on L2. Network may be congested; retry."
- `L1_CLAIM_NOT_READY`: "Bridge proof not yet available. Wait ~30 min and retry."
- `OUTBOX_PROOF_MISSING`: "L2→L1 message not yet finalized. Wait + retry."
- `MISSING_ENV`: "Wallet configuration missing. Re-run setup."
- `UNKNOWN_TOKEN`: "Unknown token alias. Check pool configuration."
- `WalletPoolExhausted`: "All N wallets at capacity. Wait for confirmations or grow the pool from /wallet."

## 10. First-launch onboarding (5-step tour)

Tooltips highlighting:
1. The wallet pool concept (link to /wallet for management)
2. The decoy slider on the order form (link to AUDIT T-13)
3. The round-amount advisory (link to AUDIT T-15)
4. The bridge round-trip warning (link to AUDIT T-15)
5. The epoch-clearing timeline ("Your order is matched at epoch close, every ~10 min on testnet")

## 11. Pages NOT to design (post-MVP)

- Dark pool real-time order book visualization (privacy-by-design — there IS no public order book; don't fake one)
- Live "MEV protection" gauge (gimmick; privacy IS the protection)
- Social features (follow, copy-trade, leaderboard)

## 12. Project repo (for context)

Repo: `quetzal` monorepo at `/Users/huseyinarslan/Desktop/aztec-project`
- `sdk/` — `@quetzal/sdk` package (target this from frontend)
- `cli/` — `@quetzal/cli` reference implementation (read-only; useful for understanding command shapes)
- `contracts/` — Noir contracts (orderbook, token, pool, treasury, aggregator-registry)
- `contracts-l1/` — Solidity bridge contracts (don't touch from frontend)
- `examples/01-place-order.ts`, `02-bridge-deposit.ts`, `03-bulk-with-decoys.ts` — working SDK examples to crib from
- `docs/frontend-quickstart.md` — engineering integration guide

---

## Generate

**Output**: a Next.js 14 App Router project (OR Vite + React) with the 7 routes listed in §4, all 5 key flows from §5 wired to real `@quetzal/sdk` calls, dark-mode-first with the §3 palette + typography, shadcn/ui components throughout, React Query for SDK calls, Zustand for wallet pool state. No mock data — assume the SDK works. Loading + error + empty states for every async operation. Inline tooltips + first-launch tour. Subtle Aztec/Quetzal visual motifs (feather watermark, step-pattern dividers) — restrained, not kitsch. Privacy-first language: every public-state field tagged, every private-state field shimmer-badged.

Use the SDK cheatsheet in §6 for the exact call signatures. Privacy UX in §7 is non-negotiable.
