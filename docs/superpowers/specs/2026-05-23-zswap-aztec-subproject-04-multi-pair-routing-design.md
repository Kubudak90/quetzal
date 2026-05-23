# Sub-project 4: Multi-Pair Routing (Single Orderbook + N Pools, 2-Hop Max)

**Status:** Design
**Date:** 2026-05-23
**Parent project:** [Quetzal](2026-05-14-zswap-aztec-mvp-design.md) — sub-project 4 of 6
**Predecessor specs:**
- [Sub-1 / Sub-2.5 trustless clearing](2026-05-22-zswap-aztec-subproject-02-5-circuit-integration-design.md)
- [Sub-3 permissionless aggregator](2026-05-22-zswap-aztec-subproject-03-dar-permissionless-aggregator-design.md)
- [Sub-2 concentrated liquidity LP-side](2026-05-22-zswap-aztec-subproject-02-concentrated-liquidity-design.md)

## Goal

Generalize Quetzal from a single-pair frequent-batch-auction (tUSDC/tETH) to multi-pair with explicit 2-hop maker-specified routing. A maker submitting a `tUSDC -> tBTC` intent via the bridge token tETH executes both legs atomically in one clearing epoch, with each leg pricing through its own per-pair clearing price discovery (Sub-1) and concentrated-liquidity pool (Sub-2.5).

## Non-Goals

- 3+ hop routing (recipe for gate-count explosion; documented Sub-5+ follow-up).
- Aggregator-decided routing (preserves Sub-3 trust model — aggregator is DoS-resistance, not route morality).
- Circuit-computed optimal route across all pools (gate-prohibitive).
- Triangular-arbitrage-free composite clearing (`P12 × P23 == P13` simultaneous solve). MVP uses independent per-pair P* + composite product for 2-hop eligibility.
- Privacy-preserving route hints (dummy 1-hop orders to obscure 2-hop intent; per-clearing pool activity leaks statistical info about which paths ran — out of scope MVP).
- Cross-pool liquidity rebalancing.
- Dynamic pool addition without Orderbook redeploy.
- Sub-3 4-deploy circular-dep wart resolution (gated on Sub-5 deterministic-address fix; Sub-4 testnet validation inherits the same wart).

## Section 1 — Architecture + Topology

**Single Orderbook + N Pools** (N≤4 MVP, MAX_ACTIVE_POOLS_PER_EPOCH=3):

- The Orderbook generalizes from one fixed tUSDC/tETH pair to a registry of pools. New storage:
  - `Map<u32, AztecAddress> pools` — pool_id → Pool contract address
  - `Map<u32, (AztecAddress, AztecAddress)> pool_tokens` — pool_id → (token_a, token_b), canonical lexicographic order (token_a < token_b as Field)
- Pool contract (Sub-2.5 16-bucket concentrated AMM) is **unchanged**. Orderbook calls `pool.set_orderbook(orderbook_addr)` on each pool at registration time; each pool stores ONE Orderbook authority.
- Maker submissions go to the **single Orderbook address**; the OrderNote carries the explicit `path` privately.
- `AggregatorRegistry` + `Treasury` (Sub-3) carry over unchanged — fees still pay per-clearing, regardless of how many pools were touched.

**MVP triangle topology (3 pools):** tUSDC/tETH, tUSDC/tBTC, tETH/tBTC. Bridge tokens for 2-hop:
- `tUSDC -> tBTC` via tETH or via no-bridge (direct USDC/BTC pool exists, so 1-hop preferred)
- `tUSDC -> tETH` direct (1-hop)
- `tETH -> tBTC` direct (1-hop)
- 2-hop only meaningful if direct pair is illiquid or maker explicitly prefers the route

The Orderbook constructor takes a `Vec<(token_a, token_b, pool_addr)>` deploy-time list and writes the maps in one tx. Pool addresses cannot change after deploy (PublicImmutable maps).

## Section 2 — OrderNote + Private Routing

OrderNote grows from Sub-1's 6 fields to 9:

```rust
#[note]
pub struct OrderNote {
    pub submitted_at_block: u32,
    pub side: bool,                  // false=bid (input is path[0]), true=ask (input is path[last])
    pub amount_in: u128,             // amount of path[0]
    pub limit_price: u128,           // path[last] per path[0], Q-format 1e18 — composite when path_len=3
    pub nonce: Field,
    pub owner: AztecAddress,
    // ===== Sub-4 NEW =====
    pub path_len: u8,                // exactly 2 or exactly 3
    pub path: [AztecAddress; 3],     // path[0..path_len]; if path_len==2, path[2]=AztecAddress.ZERO
}
```

**What stays private:** path, amount_in, limit_price, owner. The note is encrypted; only the maker (and at clearing time, the winning aggregator) can decrypt. Submit-time, the public observer sees only "an order was appended" via the `order_acc` chain hash (Sub-1's binding mechanism).

**What becomes public at clearing:** aggregate per-pool flows. Observers learn "this epoch, pool X had Δa flow, pool Y had Δb flow." They do NOT learn which orders contributed.

**Statistical leak (documented limitation):** if only pools X and Y are active but not the X-Y direct pool, an observer can infer "someone is doing a 2-hop via the bridge token." Sub-5+ mitigation: dummy 1-hop fills inserted by the aggregator to obscure pool activity patterns. For MVP, this leak is accepted and documented.

**Path direction semantics:** Sub-4 simplifies Sub-1's bid/ask vs. base/quote framing. `path` is read left-to-right as the **flow direction**: the maker escrows `amount_in` of `path[0]` at submit and receives the per-leg payouts in `path[1]` then `path[last]`. The `side` field is **retained as a flag for Sub-1 compatibility but is fully derivable from `path[0]` and `path[last]`** when the canonical token ordering is consulted (path[0] < path[last] => bid in the canonical pair-direction; reverse otherwise). The CLI sets `side` correctly at submit; the circuit re-derives the same value and asserts agreement.

**Submit-time validation:**
```rust
assert(path_len == 2 | path_len == 3, "path_len must be 2 or 3");
assert(path[0] != path[1], "path[0] == path[1]");
if path_len == 3 {
    assert(path[1] != path[2], "path[1] == path[2]");
    assert(path[0] != path[2], "path[0] == path[2]");
}
// Side flag must agree with path direction in canonical order:
//   path[0] is the input token, path[path_len-1] is the output token.
//   side == false (bid): canonical(path[0]) < canonical(path[last])
//   side == true  (ask): canonical(path[0]) > canonical(path[last])
// where canonical(addr) is the Field-value ordering used in pool_tokens.
```

**Composite eligibility:** circuit computes
```
composite_p_star = if path_len == 2 {
    pool_p_star[hop_0_pool_idx]
} else {
    mul_div(pool_p_star[hop_0_pool_idx], pool_p_star[hop_1_pool_idx], SCALE)
};
assert(eligible_at(order, composite_p_star));
```

## Section 3 — Per-Pair Clearing + Composite Pricing

**Aggregator flow:**

```
computeClearingMultiPair(orders, pools):
  1. Bucket orders by intended pool touch:
     - 1-hop orders to exactly one pool
     - 2-hop orders contribute to two pools (one entry per leg)
  2. Initial per-pool clearings (Sub-1.findClearingPrice + computeClearing):
     - Each pool's batch = 1-hop orders + the relevant leg of 2-hop orders
     - Output: P*_i, fills_i, BucketDelta[4]_i per pool
  3. Composite eligibility pass for 2-hop orders:
     - composite_p = P*_hop0 * P*_hop1 / SCALE
     - If maker's limit_price doesn't cross composite_p, mark BOTH legs ineligible
  4. Re-cleat affected pools (a 2-hop drop changes the input side of one or both pools):
     - Fixed-point iteration, MAX_ITERS=8
     - If non-convergent: epoch SKIPPED (return cleared=false; all orders carry forward)
  5. Emit per-pool BucketDelta + per-fill hop_index entries
```

**Order fan-out:** a 2-hop order produces TWO fills in the clearing output:
- `Fill(order_nonce, hop=0, amount_out_in_token_path[1], pool_id_hop_0)`
- `Fill(order_nonce, hop=1, amount_out_in_token_path[2], pool_id_hop_1)`

Both fills share the same `order_nonce`. The maker claims each via `claim_fill --hop 0` and `claim_fill --hop 1` (or combined).

**Atomicity:** if either leg fails to fill (e.g., insufficient liquidity in hop_1's pool), the aggregator drops BOTH legs of that order from the batch. Circuit enforces this via cross-leg fully-filled check (Section 4.C).

**Intermediate token escrow:** during clearing, the Orderbook holds path[1] tokens between hop_0 and hop_1 in its PUBLIC balance. Net effect: maker escrows path[0], receives path[last]; Orderbook is transient custodian of the bridge token. Both happen in one `_apply_verified_clearing` callback, so no partial state visible.

**ClearingPublic expansion (Sub-4 shape, ~114 fields):**

```
[0-3]   order_acc, cancel_acc, order_count, cancel_count   (Sub-1 binding)
[4]     fills_root                                          (Sub-1 5d-4 Merkle; expanded leaf format)
[5]     active_pool_count                                   (1..MAX_ACTIVE_POOLS_PER_EPOCH=3)
[6..N]  active_pool_clearings[0..MAX_ACTIVE_POOLS_PER_EPOCH]
        Each PoolClearing is 36 fields:
          [0]    pool_id                       (u32)
          [1]    clearing_price                (u128)
          [2-5]  a_to_pool/b_to_pool/a_from_pool/b_from_pool (4 × u128)
          [6]    current_sqrt_price_after      (u128)
          [7]    active_bucket_count           (u32)
          [8-35] active_bucket_deltas[4] × 7   (28 × u128) — Sub-2.5 carryover
```

Total: 6 + 3 × 36 = **114 fields**. Padding sentinel for unused pool slots: `pool_id = 0xFFFFFFFF`.

**Fills_root leaf format:** `poseidon2([order_nonce, hop_index, amount_out, pool_id])`. Tree size 2 × MAX_ORDERS_PER_EPOCH = 64 leaves (each 2-hop order contributes 2 leaves). `EMPTY_ROOT` must be recomputed for the 64-leaf tree shape; it differs from Sub-1's 32-leaf root.

## Section 4 — Circuit Shape + Assertion Topology

**fn main signature:**

```rust
fn main(
    // ===== Public inputs (~114 fields) =====
    order_acc:    pub Field,
    cancel_acc:   pub Field,
    order_count:  pub u32,
    cancel_count: pub u32,
    fills_root:   pub Field,
    active_pool_count:     pub u32,
    active_pool_clearings: pub [PoolClearing; MAX_ACTIVE_POOLS_PER_EPOCH],

    // ===== Private witnesses =====
    orders:              [OrderPreimage; MAX_ORDERS_PER_EPOCH],
    cancelled_indices:   [u32;            MAX_ORDERS_PER_EPOCH],
    fills:               [FillLeaf;       2 * MAX_ORDERS_PER_EPOCH],
    fills_len:           u32,
    fill_to_order_index: [u32;            2 * MAX_ORDERS_PER_EPOCH],
    fill_hop_index:      [u8;             2 * MAX_ORDERS_PER_EPOCH],
    pool_bucket_states_before: [[BucketState; MAX_ACTIVE_BUCKETS_PER_EPOCH]; MAX_ACTIVE_POOLS_PER_EPOCH],
    pool_bucket_states_after:  [[BucketState; MAX_ACTIVE_BUCKETS_PER_EPOCH]; MAX_ACTIVE_POOLS_PER_EPOCH],
    pool_sqrt_p_before:        [u128;       MAX_ACTIVE_POOLS_PER_EPOCH],
    pool_token_pairs:          [[Field; 2]; MAX_ACTIVE_POOLS_PER_EPOCH],
)
```

**Assertion blocks:**

### A. Sub-1 binding + per-fill eligibility (expanded for 2-hop)

For each fill `f in 0..fills_len`:
1. Look up `order = orders[fill_to_order_index[f]]`, `hop = fill_hop_index[f]`.
2. `assert(hop == 0 | hop == 1)`; if `order.path_len == 2` then `assert(hop == 0)`.
3. Derive `(token_in, token_out)` from `order.path` and `hop`.
4. Find `pool_idx` such that `pool_token_pairs[pool_idx] == canonical(token_in, token_out)`; assert `pool_idx < active_pool_count`.
5. Compute eligibility:
   - 1-hop: `assert(eligible(order, active_pool_clearings[pool_idx].clearing_price))`
   - 2-hop: compute `composite_p = mul_div(P_hop0, P_hop1, SCALE)`; `assert(eligible(order, composite_p))`
6. Compute expected per-leg `amount_out` using each leg's per-pool clearing price; `assert(fills[f].amount_out == expected)`.

### B. Per-pool aggregate + Sub-2.5 bucket verification (loop over active pools)

For each `p in 0..MAX_ACTIVE_POOLS_PER_EPOCH` with `p < active_pool_count`:
1. Aggregate gross_buy_in_a, gross_sell_in_b, payouts from fills filtered by pool_id.
2. Assert `active_pool_clearings[p]` flow scalars match (`a_to_pool == sat_sub(gross_buy_in_a, seller_payouts_a)`, etc. — Sub-1 sec 6.5).
3. Per-bucket loop using `assert_bucket_step` (Sub-2.5 carryover); sqrt_p chain endpoint matches `current_sqrt_price_after`.
4. Cross-bucket sum equality: per-bucket reserve deltas sum to pool aggregate flows.

### C. 2-hop atomicity (Sub-4 NEW)

Build `two_hop_orders_filled: [bool; MAX_ORDERS_PER_EPOCH]` by scanning `fill_to_order_index` + `fill_hop_index`. For each order `k`:
```rust
if orders[k].path_len == 3 && !is_cancelled[k] {
    if composite_eligible(orders[k], P_hop_0, P_hop_1) {
        assert(two_hop_orders_filled[k] == true,
            "eligible 2-hop order has missing leg fill");
    }
}
```

### D. Merkle fills_root (Sub-1 5d-4 carryover, expanded leaf)

Build 64 leaves; for `i in 0..2*MAX_ORDERS_PER_EPOCH`:
- If `i < fills_len`: `leaves[i] = poseidon2([fills[i].order_nonce, fills[i].hop_index, fills[i].amount_out, fills[i].pool_id])`
- Else: `leaves[i] = poseidon2([0, 0, 0, 0])` (empty sentinel; constant)
`computed_root = merkle_root_64(leaves)`; assert `computed_root == fills_root`.

### Gate-budget projection

3 pools × ~85K gates (Sub-2.5 baseline) + ~30K Sub-4 routing logic + ~15K expanded Merkle = **~280-300K gates total**. Bridge hypothesis must be re-validated empirically against a non-trivial fixture. If `bb prove` exceeds dev-box RAM (~12GB) or testnet ClientIVC budget, MAX_ACTIVE_POOLS_PER_EPOCH falls back to 2 (saving ~85K gates) at the cost of one less active pool per clearing.

## Section 5 — Aggregator, Edge Cases, Testing, Phasing

### Aggregator API

```typescript
// aggregator/src/clearing.ts NEW
export interface ClearingResultMultiPair extends ClearingResultV2 {
  perPoolClearings: PoolClearing[];   // one per active pool, in canonical order
  fills: HopFill[];                   // each fill annotated with hop_index + pool_id
}
export function computeClearingMultiPair(args: {
  orders: ClearingOrder[];
  pools: Map<number, PoolWithBuckets>;
}): ClearingResultMultiPair;
```

### Witness builder

`aggregator/src/witness.ts::buildClearingWitness` extends Sub-2.5's 42-field emission to ~114-field multi-pool form. New args: `perPoolClearings[]`, `poolTokenPairs[]`. Padding pool slots use `pool_id = 0xFFFFFFFF` sentinel + zero-filled fields.

### Edge cases

| Scenario | Behavior |
|---|---|
| 2-hop composite eligible, both legs cross | Both fills produced; atomicity OK |
| 2-hop composite eligible, leg_1 has insufficient pool liquidity | Aggregator drops both legs; order remains resting |
| 2-hop composite ineligible (limit_price too tight) | Circuit `eligible(composite)` returns false; both legs absent ✓ |
| Order references a pool not in `pool_tokens` map | Submit-time `path` validation rejects (pool lookup fails) |
| Same path in canonical reverse (path[0]>path[1] etc.) | CLI auto-canonicalizes during submit; circuit reads canonical form |
| All pools stale (no orders cross any pool) | active_pool_count = 0; empty clearing; epoch advances |
| Aggregator fixed-point doesn't converge after MAX_ITERS=8 | cleared=false; orders carry forward |
| Pool not yet deployed but referenced in order | submit_order assertion: `pools.at(pool_id)` returns ZERO → revert |
| Maker submits 4th pool path but MAX_ACTIVE_POOLS_PER_EPOCH=3 | If 4 different pools have orders, lowest-priority pool is skipped this epoch; its orders carry forward |

### Privacy implications

- Public sees: which pools were active this epoch + per-pool aggregate flow + per-pool new sqrt_p. NOT individual order paths.
- Statistical leak: pool activity pattern hints at 2-hop direction. Sub-5+ dummy-order mitigation documented.
- Composite trust: circuit recomputes composite_p from per-pool prices; aggregator cannot fake composite values.

### CLI additions

```bash
# Existing order command extended with --path
quetzal order --side buy --amount 1000000000 --limit 50000000000000000000 \
            --path tUSDC,tETH,tBTC

# 1-hop unchanged
quetzal order --side buy --amount 1000000000 --limit 2000000000000000000 \
            --path tUSDC,tETH

# Pool registry inspection
quetzal pools

# Per-hop claim_fill
quetzal claim --nonce <order-nonce> --hop 0    # claim first leg
quetzal claim --nonce <order-nonce> --hop 1    # claim second leg
quetzal claim --nonce <order-nonce> --all      # convenience: claim both legs in one tx
```

### Testing strategy

1. **Noir TXE** (`circuits/clearing/src/test.nr`):
   - M1: 1-hop only batch (Sub-1 regression — must pass with new circuit shape)
   - M2: 2-hop happy path (composite eligible, both legs cross)
   - M3: 2-hop ineligible composite (circuit rejects)
   - M4: 2-hop atomicity violation (only one leg filled → circuit asserts)
   - M5: 3-pool simultaneous active (max scale stress test)

2. **JS aggregator** (`aggregator/test/`):
   - R1-R8: multi-pool fixed-point convergence + composite parity + Merkle leaf format
   - Witness emission: ~114-field Prover.toml header assertions
   - 64-leaf EMPTY_ROOT new constant pinned in JS + Noir

3. **Local e2e** (`tests/integration/multi-pair.test.ts`):
   - 3 makers, 3 pools, mix of 1-hop and 2-hop orders
   - Verify claim_fill --hop 0 and --hop 1 both retrieve correct amounts

4. **Testnet (deferred):** Sub-4 testnet validation cannot complete `close_epoch_and_clear_verified` because the Sub-3 4-deploy circular-dep wart persists. Sub-4 testnet validation **gated on Sub-5 deterministic-address fix**. The off-chain pipeline (deploy + register + submit + epoch wait + bb prove) can still validate up to that gate.

### Phasing (15-17 tasks across 6 phases)

- **Phase A (3 tasks):** OrderNote `path_len` + `path[3]` extension + submit_order validation + CLI `--path` option
- **Phase B (4 tasks):** Orderbook multi-pool storage (`Map<u32, AztecAddress>` for pools and pool_tokens) + canonical token ordering helper + deploy script multi-pool list + Sub-3 4-deploy dance generalized
- **Phase C (4 tasks):** Aggregator `computeClearingMultiPair` + composite eligibility + fixed-point iteration + witness builder ~114 field emission
- **Phase D (3 tasks):** Circuit `fn main` multi-pool rewrite + per-pool bucket loop + 2-hop atomicity assertion + 64-leaf Merkle update
- **Phase E (2 tasks):** claim_fill `--hop` option + CLI `quetzal pools` + integration test scaffolds
- **Phase F (2 tasks):** bb prove against new circuit + bridge constants re-verification + local e2e + memory note

Estimated effort: ~3-4 weeks.

## Success Criteria

1. **No regression on 1-hop:** all Sub-1/Sub-2.5/Sub-3 carryover tests pass on the new multi-pool circuit shape.
2. **2-hop happy path:** a triangle clearing (3 makers, 3 pools, mix of 1-hop and 2-hop orders) clears in one epoch; `claim_fill --hop 0` and `claim_fill --hop 1` retrieve correct amounts for the 2-hop maker.
3. **Atomicity:** a 2-hop order whose hop_1 cannot fill (insufficient pool_1 liquidity at the composite price) has BOTH legs absent from `fills`; circuit asserts this.
4. **bb prove succeeds** against the new ~114-field circuit; new `vk_hash` captured + deploy script picks it up. Bridge constants (456-field proof + 127-field VK) either re-confirmed empirically or new values documented.
5. **Privacy maintained:** public observer learns aggregate per-pool flow but not individual order paths.

## Open Questions / Known Risks

- **Gate budget:** ~300K projected gates may push `bb prove` near dev-box memory limits and testnet ClientIVC walltime. Fallback: MAX_ACTIVE_POOLS_PER_EPOCH=2.
- **Aggregator convergence:** fixed-point iteration over per-pool clearings with 2-hop dropouts may not converge for adversarial input mixes. MAX_ITERS=8 with epoch-skip on failure documented.
- **Sub-3 wart persistence:** Sub-4 testnet validation inherits the 4-deploy circular-dep gate. End-to-end testnet success requires Sub-5 deterministic-address fix.
- **Statistical privacy leak:** which pools are active each epoch leaks 2-hop direction info. Dummy-order mitigation deferred to Sub-5+.
