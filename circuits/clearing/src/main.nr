mod types;
mod binding;
mod pricing;
mod amm;
mod merkle;
mod buckets;
mod test;

use types::{
    BucketDelta, BucketState, FillEntry, OrderPreimage,
    MAX_ACTIVE_BUCKETS_PER_EPOCH, MAX_ORDERS_PER_EPOCH, NUM_BUCKETS,
};

fn main(
    // ===== Public inputs (42 fields total; matches contracts/orderbook
    //       flatten_clearing_public + Sub-2.5 design Section 3) =====
    // [0-3] Binding (Sub-1 carryover)
    order_acc:    pub Field,
    cancel_acc:   pub Field,
    order_count:  pub u32,
    cancel_count: pub u32,
    // [4-6] Pre-clearing aggregate pool snapshot
    reserve_a:        pub u128,
    reserve_b:        pub u128,
    clearing_price:   pub u128,
    // [7] Sub-1 5d-4 Merkle settlement root
    fills_root: pub Field,
    // [8-11] Aggregate flows
    a_to_pool:   pub u128,
    b_to_pool:   pub u128,
    a_from_pool: pub u128,
    b_from_pool: pub u128,
    // [12-13] Pool sqrt-p chain endpoint + active bucket count
    current_sqrt_price_after: pub u128,
    active_bucket_count:      pub u32,
    // [14-41] Sparse per-bucket deltas
    active_bucket_deltas: pub [BucketDelta; MAX_ACTIVE_BUCKETS_PER_EPOCH],

    // ===== Private witnesses =====
    // Sub-1 carryover
    orders:              [OrderPreimage; MAX_ORDERS_PER_EPOCH],
    cancelled_indices:   [u32;            MAX_ORDERS_PER_EPOCH],
    fills:               [FillEntry;      MAX_ORDERS_PER_EPOCH],
    fills_len:           u32,
    fill_to_order_index: [u32;            MAX_ORDERS_PER_EPOCH],
    // Sub-2.5 NEW
    bucket_states_before: [BucketState; MAX_ACTIVE_BUCKETS_PER_EPOCH],
    bucket_states_after:  [BucketState; MAX_ACTIVE_BUCKETS_PER_EPOCH],
    pool_sqrt_p_before:   u128,
) {
    // ============ Sub-1 carryover: binding + per-fill + DoS + Merkle ============
    assert(order_count <= MAX_ORDERS_PER_EPOCH, "order_count exceeds cap");
    assert(cancel_count <= order_count, "cancel_count > order_count");
    assert(fills_len <= MAX_ORDERS_PER_EPOCH, "fills_len exceeds cap");

    let replayed_order_acc = binding::replay_chain(orders, order_count);
    assert(replayed_order_acc == order_acc, "order_acc replay mismatch");
    let replayed_cancel_acc =
        binding::replay_cancel_chain(orders, cancelled_indices, cancel_count, order_count);
    assert(replayed_cancel_acc == cancel_acc, "cancel_acc replay mismatch");
    let is_cancelled = binding::derive_is_cancelled(cancelled_indices, cancel_count, order_count);

    for i in 0..MAX_ORDERS_PER_EPOCH {
        if (i as u32) < fills_len {
            let j = fill_to_order_index[i];
            assert(j < order_count, "fill_to_order_index[i] >= order_count");
            let mut order_j = orders[0];
            for k in 0..MAX_ORDERS_PER_EPOCH {
                if (k as u32) == j { order_j = orders[k]; }
            }
            let mut j_is_cancelled: bool = false;
            for k in 0..MAX_ORDERS_PER_EPOCH {
                if (k as u32) == j { j_is_cancelled = is_cancelled[k]; }
            }
            assert(!j_is_cancelled, "filled order was cancelled");
            assert(order_j.order_nonce == fills[i].order_nonce, "fill nonce mismatch");
            assert(pricing::eligible(order_j, clearing_price), "filled order ineligible at P*");
            let expected_out = pricing::payout(order_j, clearing_price);
            assert(fills[i].amount_out == expected_out, "fill amount_out != canonical payout");
        }
    }

    let mut is_filled: [bool; MAX_ORDERS_PER_EPOCH] = [false; MAX_ORDERS_PER_EPOCH];
    for i in 0..MAX_ORDERS_PER_EPOCH {
        if (i as u32) < fills_len {
            let j = fill_to_order_index[i];
            for k in 0..MAX_ORDERS_PER_EPOCH {
                if (k as u32) == j { is_filled[k] = true; }
            }
        }
    }
    for k in 0..MAX_ORDERS_PER_EPOCH {
        if (k as u32) < order_count {
            if !is_cancelled[k] {
                if pricing::eligible(orders[k], clearing_price) {
                    assert(is_filled[k], "eligible non-cancelled order missing from fills");
                }
            }
        }
    }

    // Aggregate gross-flow derivation (Sub-1 sec 6.4 + 6.5).
    let mut gross_buy_in_a: u128 = 0 as u128;
    let mut gross_sell_in_b: u128 = 0 as u128;
    let mut buyer_payouts_b: u128 = 0 as u128;
    let mut seller_payouts_a: u128 = 0 as u128;
    for i in 0..MAX_ORDERS_PER_EPOCH {
        if (i as u32) < fills_len {
            let j = fill_to_order_index[i];
            let mut order_j = orders[0];
            for k in 0..MAX_ORDERS_PER_EPOCH {
                if (k as u32) == j { order_j = orders[k]; }
            }
            if order_j.side {
                gross_sell_in_b = gross_sell_in_b + order_j.amount_in;
                seller_payouts_a = seller_payouts_a + fills[i].amount_out;
            } else {
                gross_buy_in_a = gross_buy_in_a + order_j.amount_in;
                buyer_payouts_b = buyer_payouts_b + fills[i].amount_out;
            }
        }
    }
    // Aggregate flows = orderbook net flow vs pool.
    assert(a_to_pool == pricing::saturating_sub(gross_buy_in_a, seller_payouts_a),
           "a_to_pool mismatch");
    assert(a_from_pool == pricing::saturating_sub(seller_payouts_a, gross_buy_in_a),
           "a_from_pool mismatch");
    assert(b_to_pool == pricing::saturating_sub(gross_sell_in_b, buyer_payouts_b),
           "b_to_pool mismatch");
    assert(b_from_pool == pricing::saturating_sub(buyer_payouts_b, gross_sell_in_b),
           "b_from_pool mismatch");

    // ============ Sub-2.5 NEW: per-bucket assertions + cross-bucket sum ============
    let mut total_a_in: u128 = 0 as u128;
    let mut total_a_out: u128 = 0 as u128;
    let mut total_b_in: u128 = 0 as u128;
    let mut total_b_out: u128 = 0 as u128;
    let mut counted_active: u32 = 0;
    let mut sqrt_p_chain: u128 = pool_sqrt_p_before;

    for k in 0..MAX_ACTIVE_BUCKETS_PER_EPOCH {
        let delta = active_bucket_deltas[k];
        // Any bucket_id beyond NUM_BUCKETS is a padding slot to be skipped.
        if delta.bucket_id < NUM_BUCKETS {
            sqrt_p_chain = crate::buckets::assert_bucket_step(
                bucket_states_before[k],
                bucket_states_after[k],
                delta,
                sqrt_p_chain,
            );
            total_a_in  = total_a_in  + delta.reserve_a_add;
            total_a_out = total_a_out + delta.reserve_a_sub;
            total_b_in  = total_b_in  + delta.reserve_b_add;
            total_b_out = total_b_out + delta.reserve_b_sub;
            counted_active = counted_active + 1;
        }
    }
    assert(counted_active == active_bucket_count, "active_bucket_count mismatch with delta scan");

    // Cross-bucket flow sum equality.
    assert(total_a_in + a_from_pool == total_a_out + a_to_pool,
           "cross-bucket A sum mismatch with orderbook aggregate");
    assert(total_b_in + b_from_pool == total_b_out + b_to_pool,
           "cross-bucket B sum mismatch with orderbook aggregate");

    // Pool sqrt-p chain endpoint matches public input.
    assert(sqrt_p_chain == current_sqrt_price_after,
           "pool sqrt_p chain doesn't end at current_sqrt_price_after");

    // ============ Sub-1 carryover: Merkle fills_root ============
    let mut leaves: [Field; MAX_ORDERS_PER_EPOCH] = [0; MAX_ORDERS_PER_EPOCH];
    for i in 0..MAX_ORDERS_PER_EPOCH {
        if (i as u32) < fills_len {
            leaves[i] = crate::merkle::fill_leaf(fills[i].order_nonce, fills[i].amount_out);
        } else {
            leaves[i] = crate::merkle::fill_leaf(0 as Field, 0 as u128);
        }
    }
    let computed_root = crate::merkle::merkle_root_32(leaves);
    assert(computed_root == fills_root, "fills_root mismatch with internal fills");
}
