mod types;
mod binding;
mod pricing;
mod amm;
mod merkle;
mod buckets;
mod test;

use types::{
    BucketState, FillLeaf, OrderPreimagePath, PoolClearing,
    INVALID_POOL_ID, MAX_ACTIVE_BUCKETS_PER_EPOCH, MAX_ACTIVE_POOLS_PER_EPOCH,
    MAX_ORDERS_PER_EPOCH, NUM_BUCKETS,
};

// 2 * MAX_ORDERS_PER_EPOCH = 64. Spelled out as a literal because Noir 1.0-beta
// does not currently accept arithmetic on a `pub global` inside type positions.
global MAX_FILLS: u32 = 64;

fn main(
    // ===== Public inputs (~114 fields after flatten) =====
    // Sub-1 binding (4)
    order_acc:    pub Field,
    cancel_acc:   pub Field,
    order_count:  pub u32,
    cancel_count: pub u32,
    // Sub-1 5d-4 Merkle settlement root (1)
    fills_root:   pub Field,
    // Sub-4 active-pool count (1)
    active_pool_count:     pub u32,
    // Sub-4 per-pool clearings (3 * 36 = 108)
    active_pool_clearings: pub [PoolClearing; MAX_ACTIVE_POOLS_PER_EPOCH],

    // ===== Private witnesses =====
    orders:              [OrderPreimagePath; MAX_ORDERS_PER_EPOCH],
    cancelled_indices:   [u32;               MAX_ORDERS_PER_EPOCH],
    fills:               [FillLeaf;          64],
    fills_len:           u32,
    fill_to_order_index: [u32;               64],
    pool_bucket_states_before: [[BucketState; MAX_ACTIVE_BUCKETS_PER_EPOCH]; MAX_ACTIVE_POOLS_PER_EPOCH],
    pool_bucket_states_after:  [[BucketState; MAX_ACTIVE_BUCKETS_PER_EPOCH]; MAX_ACTIVE_POOLS_PER_EPOCH],
    pool_sqrt_p_before:        [u128;        MAX_ACTIVE_POOLS_PER_EPOCH],
    pool_token_pairs:          [[Field; 2];  MAX_ACTIVE_POOLS_PER_EPOCH],
) {
    // ========================================================================
    // A. Sub-1 binding (Sub-4 hash includes path words).
    // ========================================================================
    assert(order_count <= MAX_ORDERS_PER_EPOCH, "order_count exceeds cap");
    assert(cancel_count <= order_count, "cancel_count > order_count");
    assert(fills_len <= MAX_FILLS, "fills_len exceeds cap");
    assert(active_pool_count <= MAX_ACTIVE_POOLS_PER_EPOCH, "active_pool_count > cap");

    let replayed_order_acc = binding::replay_chain_with_path(orders, order_count);
    assert(replayed_order_acc == order_acc, "order_acc replay mismatch");
    let replayed_cancel_acc =
        binding::replay_cancel_chain_with_path(orders, cancelled_indices, cancel_count, order_count);
    assert(replayed_cancel_acc == cancel_acc, "cancel_acc replay mismatch");
    let is_cancelled = binding::derive_is_cancelled(cancelled_indices, cancel_count, order_count);

    // ========================================================================
    // B. Per-fill eligibility + per-hop payout + pool resolution.
    // ========================================================================
    for f in 0..64 {
        if (f as u32) < fills_len {
            let order_idx = fill_to_order_index[f];
            assert(order_idx < order_count, "fill_to_order_index >= order_count");

            // Scan-and-pick the order (constraint-safe dynamic index).
            let mut order_j: OrderPreimagePath = orders[0];
            for k in 0..MAX_ORDERS_PER_EPOCH {
                if (k as u32) == order_idx { order_j = orders[k]; }
            }

            // Filled order must not be cancelled.
            let mut j_is_cancelled: bool = false;
            for k in 0..MAX_ORDERS_PER_EPOCH {
                if (k as u32) == order_idx { j_is_cancelled = is_cancelled[k]; }
            }
            assert(!j_is_cancelled, "filled order was cancelled");

            // Nonce binding: fill must reference the order's nonce.
            assert(fills[f].order_nonce == order_j.order_nonce, "fill nonce mismatch");

            let hop = fills[f].hop_index;
            assert((hop == 0) | (hop == 1), "invalid hop_index");
            if order_j.path_len == 2 {
                assert(hop == 0, "1-hop order has no hop=1 fill");
            }

            // Derive the canonical (token_in, token_out) for this hop.
            let token_in: Field = if hop == 0 { order_j.path[0] } else { order_j.path[1] };
            let token_out: Field = if hop == 0 { order_j.path[1] } else { order_j.path[2] };

            // Find the active pool slot whose canonical pair matches this hop's (token_in, token_out).
            // Canonical ordering uses the bottom 128 bits of the Field as the comparison key;
            // the witness builder MUST produce `pool_token_pairs` using the same convention.
            // (Noir's bin-crate Field has no `<` operator, so we can't use the contract's full-Field compare here.)
            let (lo, hi) = if (token_in as u128) < (token_out as u128) {
                (token_in, token_out)
            } else {
                (token_out, token_in)
            };
            let mut pool_slot: u32 = INVALID_POOL_ID;
            for p in 0..MAX_ACTIVE_POOLS_PER_EPOCH {
                if (p as u32) < active_pool_count {
                    let pair = pool_token_pairs[p];
                    if (pair[0] == lo) & (pair[1] == hi) {
                        pool_slot = p as u32;
                    }
                }
            }
            assert(pool_slot != INVALID_POOL_ID, "fill's hop pair not in active pools");

            // Look up clearing_price for the resolved pool slot.
            let mut p_star: u128 = 0 as u128;
            for p in 0..MAX_ACTIVE_POOLS_PER_EPOCH {
                if (p as u32) == pool_slot { p_star = active_pool_clearings[p].clearing_price; }
            }

            // 1-hop eligibility check (2-hop composite handled in block C).
            if order_j.path_len == 2 {
                assert(pricing::eligible_with_p(order_j.side, order_j.limit_price, p_star),
                       "1-hop ineligible at P");
            }

            // amount_in for this hop:
            //   hop 0: order.amount_in
            //   hop 1: amount_out from the matching hop=0 fill of the same order.
            let mut amount_in_hop: u128 = if hop == 0 { order_j.amount_in } else { 0 as u128 };
            if hop == 1 {
                for g in 0..64 {
                    if (g as u32) < fills_len {
                        if (fills[g].order_nonce == fills[f].order_nonce) & (fills[g].hop_index == 0) {
                            amount_in_hop = fills[g].amount_out;
                        }
                    }
                }
            }

            let expected_out = pricing::payout_at_price(amount_in_hop, p_star, order_j.side);
            assert(fills[f].amount_out == expected_out, "fill amount_out != canonical payout");
            assert(fills[f].pool_id == pool_slot, "fill pool_id != resolved pool slot");
        }
    }

    // ========================================================================
    // B'. Sub-5a: 1-hop DoS resistance check.
    // Every eligible non-cancelled 1-hop order MUST appear in fills[].
    // 2-hop orders are handled by block C atomicity below; this restores
    // the Sub-1 sec 6.3 DoS guarantee that was inadvertently dropped in
    // Sub-4 D2's multi-pool generalization.
    // ========================================================================
    let mut is_filled: [bool; MAX_ORDERS_PER_EPOCH] = [false; MAX_ORDERS_PER_EPOCH];
    for f in 0..64 {
        if (f as u32) < fills_len {
            let oi = fill_to_order_index[f];
            for k in 0..MAX_ORDERS_PER_EPOCH {
                if (k as u32) == oi { is_filled[k] = true; }
            }
        }
    }

    for k in 0..MAX_ORDERS_PER_EPOCH {
        if (k as u32) < order_count {
            let order_k = orders[k];
            if (order_k.path_len == 2) & (!is_cancelled[k]) {
                let (lo, hi) = if (order_k.path[0] as u128) < (order_k.path[1] as u128) {
                    (order_k.path[0], order_k.path[1])
                } else {
                    (order_k.path[1], order_k.path[0])
                };
                let mut p_slot: u32 = INVALID_POOL_ID;
                for p in 0..MAX_ACTIVE_POOLS_PER_EPOCH {
                    if (p as u32) < active_pool_count {
                        let pair = pool_token_pairs[p];
                        if (pair[0] == lo) & (pair[1] == hi) { p_slot = p as u32; }
                    }
                }
                if p_slot != INVALID_POOL_ID {
                    let mut p_star: u128 = 0 as u128;
                    for p in 0..MAX_ACTIVE_POOLS_PER_EPOCH {
                        if (p as u32) == p_slot {
                            p_star = active_pool_clearings[p].clearing_price;
                        }
                    }
                    if pricing::eligible_with_p(order_k.side, order_k.limit_price, p_star) {
                        assert(is_filled[k], "eligible 1-hop order missing from fills (DoS)");
                    }
                }
                // If pool is inactive this epoch, the 1-hop order carries forward.
            }
        }
    }

    // ========================================================================
    // C. 2-hop composite eligibility + atomicity.
    // ========================================================================
    let mut hop_count_per_order: [u8; MAX_ORDERS_PER_EPOCH] = [0; MAX_ORDERS_PER_EPOCH];
    for f in 0..64 {
        if (f as u32) < fills_len {
            let oi = fill_to_order_index[f];
            for k in 0..MAX_ORDERS_PER_EPOCH {
                if (k as u32) == oi { hop_count_per_order[k] = hop_count_per_order[k] + 1; }
            }
        }
    }
    for k in 0..MAX_ORDERS_PER_EPOCH {
        if (k as u32) < order_count {
            let order_k = orders[k];
            if (order_k.path_len == 3) & (!is_cancelled[k]) {
                // Resolve hop0_pool + hop1_pool for this 2-hop order. Same u128-truncated
                // canonicalization convention as block B (see comment there).
                let (lo0, hi0) = if (order_k.path[0] as u128) < (order_k.path[1] as u128) {
                    (order_k.path[0], order_k.path[1])
                } else {
                    (order_k.path[1], order_k.path[0])
                };
                let (lo1, hi1) = if (order_k.path[1] as u128) < (order_k.path[2] as u128) {
                    (order_k.path[1], order_k.path[2])
                } else {
                    (order_k.path[2], order_k.path[1])
                };
                let mut p0_slot: u32 = INVALID_POOL_ID;
                let mut p1_slot: u32 = INVALID_POOL_ID;
                for p in 0..MAX_ACTIVE_POOLS_PER_EPOCH {
                    if (p as u32) < active_pool_count {
                        let pair = pool_token_pairs[p];
                        if (pair[0] == lo0) & (pair[1] == hi0) { p0_slot = p as u32; }
                        if (pair[0] == lo1) & (pair[1] == hi1) { p1_slot = p as u32; }
                    }
                }
                let both_pools_active = (p0_slot != INVALID_POOL_ID) & (p1_slot != INVALID_POOL_ID);
                if both_pools_active {
                    let mut p0_star: u128 = 0 as u128;
                    let mut p1_star: u128 = 0 as u128;
                    for p in 0..MAX_ACTIVE_POOLS_PER_EPOCH {
                        if (p as u32) == p0_slot { p0_star = active_pool_clearings[p].clearing_price; }
                        if (p as u32) == p1_slot { p1_star = active_pool_clearings[p].clearing_price; }
                    }
                    let composite = pricing::mul_div(p0_star, p1_star, pricing::SCALE);
                    if pricing::eligible_with_p(order_k.side, order_k.limit_price, composite) {
                        // Eligible 2-hop MUST have both legs filled.
                        assert(hop_count_per_order[k] == 2,
                               "eligible 2-hop order missing a leg");
                    } else {
                        // Ineligible 2-hop MUST have zero legs filled.
                        assert(hop_count_per_order[k] == 0, "ineligible 2-hop has a fill");
                    }
                } else {
                    // Pool inactive -> no legs allowed.
                    assert(hop_count_per_order[k] == 0, "2-hop on inactive pools has a fill");
                }
            }
        }
    }

    // ========================================================================
    // D. Per-pool Sub-2.5 bucket evolution.
    // ========================================================================
    for p in 0..MAX_ACTIVE_POOLS_PER_EPOCH {
        if (p as u32) < active_pool_count {
            let pc = active_pool_clearings[p];
            let mut sqrt_p_chain: u128 = pool_sqrt_p_before[p];
            for k in 0..MAX_ACTIVE_BUCKETS_PER_EPOCH {
                let d = pc.swap.active_bucket_deltas[k];
                if d.bucket_id < NUM_BUCKETS {
                    sqrt_p_chain = crate::buckets::assert_bucket_step(
                        pool_bucket_states_before[p][k],
                        pool_bucket_states_after[p][k],
                        d,
                        sqrt_p_chain,
                    );
                }
            }
            assert(sqrt_p_chain == pc.swap.current_sqrt_price_after,
                   "pool sqrt_p chain != current_sqrt_price_after");
        }
    }

    // ========================================================================
    // E. Merkle fills_root over hop-fill leaves (64-leaf tree).
    // ========================================================================
    let mut leaves: [Field; 64] = [0; 64];
    for i in 0..64 {
        if (i as u32) < fills_len {
            leaves[i] = crate::merkle::hop_fill_leaf(
                fills[i].order_nonce, fills[i].hop_index, fills[i].amount_out, fills[i].pool_id);
        } else {
            leaves[i] = crate::merkle::hop_fill_leaf(0 as Field, 0 as u8, 0 as u128, 0 as u32);
        }
    }
    let computed_root = crate::merkle::merkle_root_64(leaves);
    assert(computed_root == fills_root, "fills_root mismatch");
}
