mod types;
mod binding;
mod pricing;
mod amm;
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

    // Silence "unused" for inputs not consumed yet (Tasks 8-9 will use them).
    let _ = reserve_a;
    let _ = reserve_b;
    let _ = lp_supply;
    let _ = swap;
}
