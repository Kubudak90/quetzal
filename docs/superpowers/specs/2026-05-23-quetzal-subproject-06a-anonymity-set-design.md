# Sub-project 6a: Anonymity Set (Privacy Mitigations)

**Status:** Design
**Date:** 2026-05-23
**Parent project:** [Quetzal](2026-05-14-zswap-aztec-mvp-design.md) — sub-project 6 (decomposed into 6a / 6b / 6c).
**Predecessor specs:**
- [Sub-4 Multi-Pair Routing](2026-05-23-zswap-aztec-subproject-04-multi-pair-routing-design.md) — SHIPPED. Carried forward issue #5 (deposit↔claim temporal linkage) which Sub-6a closes.
- [Sub-5c Production Infrastructure](2026-05-23-zswap-aztec-subproject-05c-production-infra-design.md) — SHIPPED. Sub-6a starts post-Sub-5c.

## Goal

Close Sub-4's carry-forward #5 (statistical privacy leak from deposit↔claim temporal linkage) plus two adjacent privacy-leak vectors — bridge round-trip detection on L1 and amount-pattern fingerprinting — via a three-component anonymity-set mitigation. Component A (dummy orders) fattens the per-order anonymity set in clearing batches by letting makers submit K dummy orders alongside each real order; component B (bridge round-trip CLI advisory) flags suspicious deposit↔withdraw correlations on L1 and offers staggered multi-hop exits; component C (amount-pattern warning) detects round-number trades and prompts makers to add noise. After Sub-6a ships, observers see batch clearings + L1 traces that are quantitatively harder to attribute to individual makers, even when on-chain transaction graph analysis is applied.

## Non-Goals

- **Routing privacy** (Sub-4's hop-choice fingerprinting #2 + aggregator metadata #6) — deferred to Sub-6b. Sub-6a does not add decoy hops or rotate aggregators.
- **PXE workaround** (Aztec's ≈20-unfinalized-submits-per-wallet cap #5 from the original Sub-6 brainstorm) — deferred to Sub-6c. Sub-6a uses bulk-submit to fit K=8 decoys into 1 PXE slot; this works within the cap but does not extend the cap itself.
- **Heavy bridge round-trip mitigation** — no fixed-denomination buckets (Tornado-light) or shielded pool (Tornado-cash style). Sub-6a's bridge component is pure CLI advisory; future projects can layer heavier mitigations on top.
- **Aggregator-side dummy injection** — aggregator never inserts decoys autonomously. Decoy generation stays maker-side opt-in to preserve Sub-3's minimal-trust model.
- **Frontend / web dApp** — Sub-7. The privacy slider UX (`--decoys N`, `--split-into N`) lives in CLI in Sub-6a; web exposure is later.
- **Decoy gas subsidization** — Treasury does not pay for decoy gas. Sub-6b candidate.
- **Statistical analytics hardening against blockchain forensics firms** (Chainalysis / TRM / Elliptic). Sub-6a raises the cost of attribution but does not claim full unlinkability. Higher-grade mitigations are Sub-6b/6c+.
- **Cross-chain bridges to non-Ethereum L1s** — explicit never (privacy-maximalist Quetzal is Aztec-on-Ethereum only).

## Section 1 — Architecture + Component Map

Sub-6a partitions into three independent components:

```
┌──────────────────────────────────────────────────────────────┐
│ Sub-6a — Anonymity Set (3 components)                        │
├──────────────────────────────────────────────────────────────┤
│ A. Dummy orders (anonymity set fattening)                    │
│    - OrderNote shape: unchanged (Sub-4)                      │
│    - Dummy = order with unfillable limit_price (u128::MAX    │
│      for sell-a direction; minimal value for sell-b)         │
│    - PXE-side: maker marks which orders are decoys (private  │
│      flag in maker-local registry; never on-ledger)          │
│    - Circuit: handles dummies naturally via amount_out=0     │
│      branch (no circuit changes needed)                      │
│    - New Orderbook external: submit_order_bulk(orders[9])    │
│      to fit K+1 orders in 1 PXE tagging slot                 │
│    - CLI: `quetzal order ... --decoys N` (0≤N≤8, default 3)  │
│    - Anonymity set per real order = K+1                      │
│                                                              │
│ B. Bridge round-trip CLI advisory                            │
│    - Pre-exit check: query L1 deposit history; warn if any   │
│      deposit < 7 days ago with amount ±5% of exit            │
│    - --ack-delay flag to acknowledge + bypass                │
│    - --split-into N --interval-days D: schedule N partial    │
│      exits with ±20% amount noise + interval stagger         │
│    - bridge tick subcommand: scheduler trigger               │
│    - State: ~/.quetzal/bridge-state.json                     │
│    - No contract changes; pure CLI                           │
│                                                              │
│ C. Amount-pattern warning                                    │
│    - CLI heuristic on order/bridge amounts                   │
│    - Round-threshold detector ($100/$1k/$10k/$100k/$1M +     │
│      0.5x/2x/5x multiples; ±1% tolerance)                    │
│    - Warns + requires --ack-round to proceed                 │
│    - Applies to: submit_order, bridge deposit, bridge exit   │
│    - No contract changes; pure CLI                           │
└──────────────────────────────────────────────────────────────┘
```

**Total:** ~22 tasks across 7 phases (A-G), ~8-10 weeks. Heaviest work in A (circuit + contract); B + C are pure CLI.

**Per-component effort:**

| Component | New code area | Approx lines | Tasks |
|---|---|---|---|
| A (dummy orders) | Orderbook.nr + circuits + cli/orders + tests | ~1500 | ~12 |
| B (bridge advisory) | cli/bridge-* + bridge-state.json + tests | ~600 | ~5 |
| C (amount-pattern) | cli/amount-heuristic.ts + tests | ~150 | ~3 |
| Spec + audit-prep + close | docs + memory + AUDIT.md update | ~150 | ~2 |

Components can run partially in parallel: A blocks B + C (decoy registry shape is shared dependency); B + C are independent of each other.

## Section 2 — Dummy Orders Technical Detail (Component A)

### Order shape — unchanged from Sub-4

```rust
// contracts/orderbook/src/main.nr — OrderNote (Sub-4 baseline)
struct OrderNote {
    owner: AztecAddress,
    nonce: Field,
    pair_id: u32,
    direction: bool,            // a→b or b→a
    amount_in: u128,
    limit_price: u128,          // ← dummy: unfillable value
    epoch: u32,
    hop_path: [u32; 2],
}
```

**Unfillable price selection** (direction-dependent):
- `direction = sell-a` (giving token A for B): `limit_price = u128::MAX` (demand absurdly high B per A; pool sqrt_price_current << this → no fill)
- `direction = sell-b`: `limit_price = 1` (demand absurdly cheap A per B; pool sqrt_price_current >> this → no fill)

No fixed "decoy sentinel" value — observers can't learn "u128::MAX = decoy" because both directions and a continuum of unfillable prices are valid.

### PXE-side decoy marking — maker-local registry

```typescript
// cli/src/orders/decoy-registry.ts (NEW)
interface DecoyRegistry {
  [orderNonce: string]: boolean;   // key: 0x-prefixed Field hex
}

// Persisted at: ~/.quetzal/decoy-registry-<wallet-addr>.json
// Read on claim-fill to filter decoys (no point submitting tx for a known-zero fill)
// Read on cancel-decoys for batch cancellation
```

The registry is **strictly maker-local + offline**. Aztec ledger, aggregator, observers never see it. Quetzal's privacy model treats real-vs-decoy knowledge as the maker's PXE secret.

### CLI flow

```bash
quetzal order \
  --pair USDC/ETH \
  --amount 1000000 \              # 1 USDC
  --direction sell-a \
  --limit-price 2500 \            # real order's fillable price
  --decoys 3                      # 3 dummy orders accompany the real one
```

Internal sequence:
1. Generate 3 dummy `OrderNote`s with `limit_price = u128::MAX` (since sell-a), each with a fresh random `nonce`
2. Real order's nonce + decoys' nonces collected into `[OrderNote; 9]` array (4 used slots, 5 unused — `amount_in = 0` marker)
3. Single `submit_order_bulk` tx submitted (1 PXE tagging slot)
4. `~/.quetzal/decoy-registry-<addr>.json` updated: `real_nonce → false`, 3 `dummy_nonces → true`
5. CLI returns the 4 nonces; default `cancel-decoys --epoch N` later auto-refunds the 3 dummy escrows

### Orderbook contract — `submit_order_bulk`

Existing `submit_order` is per-tx single order. New bulk variant:

```rust
global MAX_ORDERS_PER_BULK: u32 = 9;   // 1 real + 8 max decoys

#[external("private")]
fn submit_order_bulk(orders: [OrderNote; MAX_ORDERS_PER_BULK]) {
    for i in 0..MAX_ORDERS_PER_BULK {
        let order = orders[i];
        // amount_in = 0 marks an unused slot (allows maker to send K < MAX)
        if order.amount_in > 0 {
            self._submit_one_order(order);  // reuses existing per-order helper
        }
    }
}
```

**PXE tagging cap throughput:** without bulk, K=8 decoys = 9 separate submit_order txs = 9 tagging slots; with bulk, 1 tx = 1 slot. Per memory `aztec-pxe-tagging-window` (≈20 cap), this enables ~2 logical trades-in-flight with K=8, vs <0.5 trades without bulk.

**Trade-off:** bulk-submit's private circuit gate count scales ~9x (9 note insertions + 9 nullifiers + 9 escrow transfers). Estimate ~200-250K gates (clearing circuit baseline 281K). Sub-6a Phase A measures + commits the actual figure.

If gate count exceeds +25% of baseline, Phase A's A5 task downsizes `MAX_ORDERS_PER_BULK` to 5 (1 real + 4 decoys max). Sub-6a's success criteria account for this fallback.

### Per-maker rate limit at clearing batch level

Clearing circuit retains `MAX_ORDERS_PER_EPOCH = 64` (Sub-4). A maker using `--decoys 8` consumes 9 slots; 7 such makers fill the epoch; an 8th maker overflows into the next epoch. This is acceptable: privacy-conscious makers self-throttle via slot competition.

## Section 3 — Circuit + Clearing Math Impact

### Circuit behavior — unchanged from Sub-4

`circuits/clearing/src/main.nr`'s per-order loop already handles `fill_amount = 0` naturally via the existing limit-price check:

```rust
// (Sub-4 baseline, no Sub-6a change)
for each order in epoch.orders[0..64]:
    fill_amount = compute_fill_for_order(order, pool_state)  // V3 multi-bucket swap-step
    // dummies have unfillable limit_price → fill_amount = 0 naturally
    hop_fill = HopFill {
        order_nonce: order.nonce,
        hop_index: 0,
        amount_out: fill_amount,
        pool_id: order.hop_path[0],
        leaf_index: i,
    }
    insert hop_fill into 64-leaf merkle tree
```

**Zero circuit modification.** Dummies produce zero-fill leaves identical to legitimately-unfillable real orders (e.g., a maker who set a too-aggressive limit price).

### Public observer view

```
Sub-5a baseline (no dummies):
  Epoch 100: 16 orders → 16 hop_fills (8 fills, 8 zero-fills for unfillable reals)
  Observer attribution: ~16 maker addresses → 8 effective fills

Sub-6a (with K=3 default):
  Epoch 100: 16 makers × (1 real + 3 decoys) = 64 orders → 64 hop_fills (8 fills, 56 zero-fills)
  Observer attribution: 16 maker addresses (same), 56 zero-fills, anonymity 1/4 per real fill
```

**Anonymity set per real order = K + 1.** Default K=3 → attribution accuracy drops from 1 to 1/4. K=8 → 1/9. Effect compounds across epochs: a maker doing 10 trades over 30 epochs with K=3 each presents 40 nonces to observers, only 10 of which are real.

### Decoy escrow + cancellation

Dummies escrow the same amount as the real order (uniform amount_in across all 9 slots; only limit_price varies). Two reasons:
1. **Pattern hiding**: if dummies were 1-wei minimal, observers learn "small amount_in → dummy" pattern. Uniform amount destroys this.
2. **CLI flow simplicity**: maker sets `--amount N` once; CLI applies N to all bulk slots.

After epoch closes:
- **Real order**: `claim_fill --nonce <real_nonce>` retrieves fill (if any); standard Sub-5a flow.
- **Decoys**: `claim_fill` on a decoy nonce would succeed but transfer 0 (the maker's escrow stays locked). CLI auto-filters decoy nonces via `decoy-registry` lookup; no tx submitted.
- **Refund decoys**: `cancel-decoys --epoch <N>` batch-submits `cancel_order` for each decoy in that epoch's registry slice (uses Sub-5a's `Z_CANCEL_TAG` nullifier).

```bash
# Maker workflow after epoch closes
quetzal claim-fill --nonce <auto-discovered>      # auto-filters decoys
quetzal cancel-decoys --epoch 100                  # refunds 3 decoy escrows
```

### New private circuit — `submit_order_bulk` vk_hash

The bulk-submit private function is a **separate circuit** from clearing. Its vk_hash is independent of clearing's (current `2aae33dd4ea01690` from Sub-5a). Phase A measures + commits the new bulk-submit vk_hash; clearing circuit untouched.

## Section 4 — Bridge Round-Trip Advisory (B) + Amount-Pattern Warning (C)

### Component B — Bridge round-trip CLI advisory

Three CLI mechanisms, all pure-frontend (zero contract change):

#### B.1 — Pre-exit delay check

On `quetzal bridge exit`, CLI queries L1 for the maker's recent `DepositInitiated` events:

```bash
quetzal bridge exit --token aWETH --amount 100000000000000000 --l1-recipient 0xRecipient
```

Sequence:
1. Query L1 (Etherscan API with key OR direct `getLogs` via `L1_RPC_URL` fallback): all `DepositInitiated(sender=maker_address)` events from last 7 days
2. For each: compute USD-equivalent amount via Chainlink price feed; compare to current exit's USD value
3. If any matching deposit (within ±5%, within window) → emit warning + exit 1 unless `--ack-delay`

Warning output cites the deposit timestamp, amount, and explicit mitigation list (wait ≥14 days, use --split-into, --ack-delay to bypass).

**Heuristic configuration:**
- Window: 7 days (configurable via `QUETZAL_DEPOSIT_WINDOW_DAYS` env)
- Amount tolerance: ±5% (configurable via `QUETZAL_DEPOSIT_TOLERANCE_PCT` env)
- Cross-token price source: Chainlink mainnet/Sepolia aggregator (read-only; no contract dep)

#### B.2 — Multi-hop split

```bash
quetzal bridge exit \
  --token aWETH --amount 100000000000000000 --l1-recipient 0xRecipient \
  --split-into 5 --interval-days 3
```

CLI:
1. Compute 5 amounts: `total / N` ± 20% noise (preserves total within ±0.5% via running-average correction on last entry)
2. Compute 5 timestamps: `now`, `now + 3d`, `now + 6d`, `now + 9d`, `now + 12d`
3. Write schedule to `~/.quetzal/bridge-state.json`
4. Run first exit immediately (`exit_to_l1_public` on L2)
5. Schedule notifies maker; maker runs `quetzal bridge tick` periodically (or sets cron) to submit subsequent exits as windows open

```json
// ~/.quetzal/bridge-state.json schema
{
  "scheduled_exits": [
    {
      "id": "ex_2026052301_a8f3",
      "token": "aWETH",
      "amount": "21043571928364182",
      "l1_recipient": "0xRecipient...",
      "submit_after_unix": 1748131200,
      "status": "pending | submitted | l1_claimable | done",
      "l2_tx_hash": "0x..." | null
    }
  ]
}
```

`bridge tick` walks the schedule, submits ready exits, updates statuses. `bridge status` shows the schedule + per-exit progress.

#### B.3 — Auto-claim option

`bridge tick --auto-claim` extends the tick loop to also submit L1 `withdraw` (or `withdrawPrivate`) once the L2→L1 epoch settles. Without `--auto-claim`, maker manually runs `bridge claim-l1` per id.

### Component C — Amount-pattern warning

CLI heuristic detects round amounts (in token native units, scaled by decimals):

```typescript
// cli/src/amount-heuristic.ts (NEW)
const ROUND_THRESHOLDS = [100n, 1_000n, 10_000n, 100_000n, 1_000_000n];
const MULTIPLIERS = [0.5, 1, 2, 5];
const TOLERANCE_PCT = 1;

function isRoundAmount(amount: bigint, decimals: number): boolean {
  const scaled = Number(amount) / Math.pow(10, decimals);
  for (const threshold of ROUND_THRESHOLDS) {
    for (const mult of MULTIPLIERS) {
      const target = Number(threshold) * mult;
      if (Math.abs(scaled - target) / target <= TOLERANCE_PCT / 100) return true;
    }
  }
  return false;
}
```

Triggered on:
- `quetzal order --amount N` (submit_order amount_in)
- `quetzal bridge deposit --amount N`
- `quetzal bridge exit --amount N`

Warning includes the matched threshold and suggested non-round alternatives (e.g., "10.07 ETH, 9.94 ETH").

`--ack-round` opts out for the current invocation. No persistence.

## Section 5 — Phasing, Success Criteria, Out-of-Scope, Dependencies

### Phasing (~22 tasks across 7 phases, ~8-10 weeks)

| Phase | Tasks | Duration | Mainnet impact |
|---|---|---|---|
| **A — Orderbook bulk submit + dummy support** | A1: Orderbook.nr `submit_order_bulk(orders: [OrderNote; 9])` external; A2: TXE tests for bulk submit (K=0/1/3/8 cases + revert paths); A3: gas + gate-count measurement vs Sub-5a baseline; A4: per-slot escrow accounting; A5: spec carry-forward decision on MAX_ORDERS_PER_BULK (downsize to 5 if gate-count > +25%) | ~3 weeks | ✅ Required before mainnet privacy-grade open |
| **B — Decoy registry + CLI integration** | B1: `cli/src/decoy-registry.ts` JSON store keyed by maker wallet; B2: `quetzal order --decoys N` bulk-submit flow + registry write; B3: `claim-fill --filter-decoys` auto-skip + `cancel-decoys --epoch <N>` batch-cancel; B4: 3 integration tests (decoy round-trip) | ~2 weeks | ✅ |
| **C — Bridge round-trip advisory** | C1: `cli/src/bridge-history.ts` L1 deposit query (Etherscan API + RPC fallback); C2: `bridge exit` pre-check + 7-day window warning + `--ack-delay`; C3: `bridge exit --split-into N --interval-days D` schedule writer + state schema; C4: `bridge tick` + `bridge status` + `--auto-claim`; C5: 4 integration tests | ~2 weeks | ⚠️ Strongly recommended; advisory only — no contract change |
| **D — Amount-pattern warning** | D1: `cli/src/amount-heuristic.ts` round-threshold detector + decimals scaling; D2: integration into order + bridge action paths + `--ack-round`; D3: 5 unit tests (edge cases, multipliers, weird decimals like wBTC 8) | ~1 week | ⚠️ Weak signal but cheap to ship |
| **E — Integration + e2e** | E1: scaffold `tests/integration/sub6-anonymity-e2e.test.ts` (skip:true DORMANT, same shape as Sub-5b F1; 2 scenarios documented); E2: scaffold `scripts/testnet-sub6-anonymity.ts` 8-step runner | ~3-4 days | — operator follow-up shape |
| **F — Audit-prep update** | F1: `contracts-l1/AUDIT.md` Threat-Model T-13..T-15 (decoy ZK soundness, bulk-submit reentrancy, escrow leak on cancel-decoys); F2: re-run Slither → `contracts-l1/audit/slither-<date>.txt` | ~2-3 days | ✅ Required before audit re-engagement |
| **G — Close** | G1: memory note `project_subproject6a_complete.md` + MEMORY.md + README CODE-COMPLETE block + sub6a-runbook section (or inline into sub5c-runbook) | ~1 day | — |

### Success criteria

1. **Bulk submit**: `submit_order_bulk` with 1 real + 8 decoys fits in 1 PXE tagging slot; new private circuit gate count ≤350K (Sub-5a clearing baseline 281K, accept ~+25% for the bulk circuit). If exceeded, A5 downsizes MAX to 5.
2. **Decoy clearing**: 9-order submission produces 9 hop_fill leaves in the settlement root (8 zero-fill, 1 nonzero); observer cannot identify the real one without the maker's `decoy-registry`.
3. **CLI decoy UX**: `quetzal order --decoys 3` returns 4 nonces; `cancel-decoys --epoch N` refunds 3 escrows in a batch; `claim-fill --filter-decoys` auto-skips dummies (no failed tx submitted).
4. **Bridge advisory**: `bridge exit` aborts with exit-code-1 + warning when last deposit < 7 days ago + same-amount ±5%; `--ack-delay` bypasses; `--split-into 5 --interval-days 3` schedules 5 staggered exits with ±20% noise.
5. **Amount heuristic**: `order --amount 10000000` (1.0 USDC) warns; `order --amount 10473928` (1.047 USDC) does not.
6. **Audit-ready**: AUDIT.md gains 3 new T-rows (T-13..T-15); Slither re-run committed; Foundry test count growth proportional to new test additions (no regression).
7. **Documentation**: sub5c-runbook (or new sub6a-runbook) gains a "Maker privacy guide" section covering `--decoys`, `--split-into`, and amount-pattern best practices.

### Out-of-scope (Sub-6b, Sub-6c, Sub-7+)

- **Sub-6b — Routing privacy**: trade-direction fingerprinting (#2 from original Sub-6 brainstorm), aggregator rotation/threshold (#6). Adds decoy-hop logic to clearing circuit + Sub-3 rotation policy.
- **Sub-6c — PXE workaround**: per-deposit rotating wallets (#5). Builds wallet-rotation infra so the ≈20 PXE cap becomes per-batch concern, not per-maker lifetime.
- **Sub-7 — Frontend**: web dApp with wallet + PXE integration + decoy-aware UX. Frontend exposes `--decoys` etc. as a user-facing privacy slider.
- **Heavy bridge round-trip**: fixed-denomination buckets ($1k/$10k/$100k pools) or full Tornado-style shielded pool. Sub-6a's Light option was chosen; Medium/Heavy variants are Sub-6b candidates (Heavy may be its own Sub-8).
- **Aggregator-side dummy injection** — explicit no (Sub-3 trust model).
- **Statistical analysis hardening** for blockchain analytics firms (Chainalysis, TRM, Elliptic). Sub-6b/6c or separate Sub-8 territory.
- **Decoy gas subsidization** via Treasury — privacy-as-public-good economic argument; Sub-6b candidate.

### Dependencies

- **Sub-5a SHIPPED** (HEAD `5285f36` pre-rebrand → `c274474` post-rebrand) — Sub-6a's decoy registry consumes Sub-5a's per-hop nullifier scheme (`Z_HOP_CLAIM_TAG` + `Z_CANCEL_TAG`); no Sub-5a contract changes needed.
- **Sub-5c SHIPPED** (commit `c274474`, audit tag `sub5c-audit-snapshot` at `2747700`) — Sub-6a starts post-Sub-5c so all 31 Foundry tests + 8 Noir TXE tests remain green as baseline.
- **Aztec PXE tagging window ≈20** (memory `aztec-pxe-tagging-window`) — `submit_order_bulk` is the key engineering decision enabling K=8 within the cap.
- **Sub-3 Treasury + AggregatorRegistry** — unchanged; decoys don't queue relayer claims (decoys never exit via withdraw flow).
- **Etherscan API access (optional, RPC fallback)** — Component B's L1 deposit history. CLI falls back to `getLogs` via `L1_RPC_URL` without an Etherscan key.
- **bb prove ClientIVC** — new `submit_order_bulk` private circuit produces a new vk_hash; F2 task captures + commits the value (mirrors Sub-5a's vk_hash pinning).

### Parallel execution opportunities

- **C + D** (bridge advisory + amount-pattern) are pure-CLI, no Noir/Solidity. A 2-person team can begin C/D in parallel with A/B (Noir + circuit).
- **F (audit-prep)** depends on A + B landing.
- **E (e2e scaffold)** depends on A + B + C + D landing.

Single-engineer subagent-driven execution → sequential A → B → C → D → E → F → G.
