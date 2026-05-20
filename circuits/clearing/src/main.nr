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
    // Tasks 4-9 fill this in; this is just a compile target for Tasks 1-3.
    assert(order_count <= MAX_ORDERS_PER_EPOCH);
    assert(cancel_count <= order_count);
    assert(fills_len <= MAX_ORDERS_PER_EPOCH);
    // Touch every input so the compiler doesn't warn about unused params.
    let _ = order_acc;
    let _ = cancel_acc;
    let _ = reserve_a;
    let _ = reserve_b;
    let _ = lp_supply;
    let _ = clearing_price;
    let _ = fills;
    let _ = swap;
    let _ = orders;
    let _ = cancelled_indices;
    let _ = fill_to_order_index;
}
