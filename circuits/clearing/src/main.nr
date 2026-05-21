mod types;
mod binding;
mod pricing;
mod amm;
mod merkle;
mod test;

use types::{ClearingSwap, FillEntry, OrderPreimage, MAX_ORDERS_PER_EPOCH};

fn main(
    // Binding (public)
    order_acc: pub Field,
    cancel_acc: pub Field,
    order_count: pub u32,
    cancel_count: pub u32,

    // Pre-clearing pool snapshot (public)
    reserve_a: pub u128,
    reserve_b: pub u128,
    lp_supply: pub u128,

    // Aggregator's claimed clearing output (public)
    clearing_price: pub u128,
    fills: pub [FillEntry; MAX_ORDERS_PER_EPOCH],
    fills_len: pub u32,
    swap: pub ClearingSwap,

    // Witness (private)
    orders: [OrderPreimage; MAX_ORDERS_PER_EPOCH],
    cancelled_indices: [u32; MAX_ORDERS_PER_EPOCH],
    fill_to_order_index: [u32; MAX_ORDERS_PER_EPOCH],
) {
    assert(order_count <= MAX_ORDERS_PER_EPOCH, "order_count exceeds cap");
    assert(cancel_count <= order_count, "cancel_count > order_count");
    assert(fills_len <= MAX_ORDERS_PER_EPOCH, "fills_len exceeds cap");

    // Binding (sec 6.1): replay both chains.
    let replayed_order_acc = binding::replay_chain(orders, order_count);
    assert(replayed_order_acc == order_acc, "order_acc replay mismatch");

    let replayed_cancel_acc =
        binding::replay_cancel_chain(orders, cancelled_indices, cancel_count, order_count);
    assert(replayed_cancel_acc == cancel_acc, "cancel_acc replay mismatch");

    let is_cancelled = binding::derive_is_cancelled(cancelled_indices, cancel_count, order_count);

    // Per-fill eligibility + payout (sec 6.2). fill_to_order_index[i] maps fills[i]
    // to the orders[] slot it pays out.
    for i in 0..MAX_ORDERS_PER_EPOCH {
        if (i as u32) < fills_len {
            let j = fill_to_order_index[i];
            assert(j < order_count, "fill_to_order_index[i] >= order_count");
            // Scan-and-pick orders[j] (constraint-safe dynamic index pattern).
            let mut order_j = orders[0];
            for k in 0..MAX_ORDERS_PER_EPOCH {
                if (k as u32) == j {
                    order_j = orders[k];
                }
            }
            // is_cancelled[j] lookup (same pattern).
            let mut j_is_cancelled: bool = false;
            for k in 0..MAX_ORDERS_PER_EPOCH {
                if (k as u32) == j {
                    j_is_cancelled = is_cancelled[k];
                }
            }
            assert(!j_is_cancelled, "filled order was cancelled");
            assert(order_j.order_nonce == fills[i].order_nonce, "fill nonce mismatch");
            assert(pricing::eligible(order_j, clearing_price), "filled order ineligible at P*");
            let expected_out = pricing::payout(order_j, clearing_price);
            assert(fills[i].amount_out == expected_out, "fill amount_out != canonical payout");
        }
    }

    // DoS resistance (sec 6.3): every eligible non-cancelled order must be in fills.
    // Derive is_filled from fill_to_order_index[0..fills_len].
    let mut is_filled: [bool; MAX_ORDERS_PER_EPOCH] = [false; MAX_ORDERS_PER_EPOCH];
    for i in 0..MAX_ORDERS_PER_EPOCH {
        if (i as u32) < fills_len {
            let j = fill_to_order_index[i];
            // Scan-and-set, mirroring binding::derive_is_cancelled.
            for k in 0..MAX_ORDERS_PER_EPOCH {
                if (k as u32) == j {
                    is_filled[k] = true;
                }
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

    // Aggregate net-swap derivation (sec 6.4) over filled orders.
    let mut gross_buy_in_a: u128 = 0 as u128;
    let mut gross_sell_in_b: u128 = 0 as u128;
    let mut buyer_payouts_b: u128 = 0 as u128;
    let mut seller_payouts_a: u128 = 0 as u128;
    for i in 0..MAX_ORDERS_PER_EPOCH {
        if (i as u32) < fills_len {
            let j = fill_to_order_index[i];
            // Scan-and-pick orders[j].
            let mut order_j = orders[0];
            for k in 0..MAX_ORDERS_PER_EPOCH {
                if (k as u32) == j {
                    order_j = orders[k];
                }
            }
            if order_j.side {
                // sell: amount_in is token B; amount_out is token A
                gross_sell_in_b = gross_sell_in_b + order_j.amount_in;
                seller_payouts_a = seller_payouts_a + fills[i].amount_out;
            } else {
                // buy: amount_in is token A; amount_out is token B
                gross_buy_in_a = gross_buy_in_a + order_j.amount_in;
                buyer_payouts_b = buyer_payouts_b + fills[i].amount_out;
            }
        }
    }

    let gross_buy_out_b = pricing::mul_div(gross_buy_in_a, pricing::SCALE, clearing_price);
    let gross_sell_out_a = pricing::mul_div(gross_sell_in_b, clearing_price, pricing::SCALE);

    // fee_pool_* = gross - net_to_traders (the LP-bound withholding).
    let fee_pool_a = gross_sell_out_a - seller_payouts_a;
    let fee_pool_b = gross_buy_out_b - buyer_payouts_b;

    // ClearingSwap cross-check (sec 6.5).
    assert(swap.a_to_pool == pricing::saturating_sub(gross_buy_in_a, seller_payouts_a),
           "swap.a_to_pool mismatch");
    assert(swap.a_from_pool == pricing::saturating_sub(seller_payouts_a, gross_buy_in_a),
           "swap.a_from_pool mismatch");
    assert(swap.b_to_pool == pricing::saturating_sub(gross_sell_in_b, buyer_payouts_b),
           "swap.b_to_pool mismatch");
    assert(swap.b_from_pool == pricing::saturating_sub(buyer_payouts_b, gross_sell_in_b),
           "swap.b_from_pool mismatch");

    // Reserve-delta identity (all-positive rearrangement; sec 6.5.23/24):
    //   reserve_a_add + a_from_pool + fee_pool_a == reserve_a_sub + a_to_pool
    assert(
        swap.reserve_a_add + swap.a_from_pool + fee_pool_a
            == swap.reserve_a_sub + swap.a_to_pool,
        "reserve_a delta identity violated",
    );
    // For token B: b_to_pool is gross_sell_in_b - buyer_payouts_b; fee_pool_b is
    // the LP withholding in B. The reserve-side identity rearranged:
    //   reserve_b_add + b_from_pool + fee_pool_b == reserve_b_sub + b_to_pool
    assert(
        swap.reserve_b_add + swap.b_from_pool + fee_pool_b
            == swap.reserve_b_sub + swap.b_to_pool,
        "reserve_b delta identity violated",
    );

    // Fee-per-share derivation (floor).
    assert(swap.fee_a_per_share_increment == pricing::mul_div(fee_pool_a, pricing::SCALE, lp_supply),
           "fee_a_per_share_increment mismatch");
    assert(swap.fee_b_per_share_increment == pricing::mul_div(fee_pool_b, pricing::SCALE, lp_supply),
           "fee_b_per_share_increment mismatch");

    // AMM k-monotonicity (sec 6.6).
    let new_reserve_a = reserve_a + swap.reserve_a_add - swap.reserve_a_sub;
    let new_reserve_b = reserve_b + swap.reserve_b_add - swap.reserve_b_sub;
    amm::assert_k_monotonic(reserve_a, reserve_b, new_reserve_a, new_reserve_b);
}
