// Shared types for the ZSwap clearing circuit. Matches:
// - contracts/pool/src/main.nr's ClearingSwap (10 u128 fields).
// - contracts/orderbook/src/main.nr's FillEntry (order_nonce + amount_out).
// - contracts/orderbook/src/main.nr's OrderNote (the per-order preimage).

pub global MAX_ORDERS_PER_EPOCH: u32 = 128;

/// Aggregator's per-order payout (public input to the circuit).
pub struct FillEntry {
    pub order_nonce: Field,
    pub amount_out: u128,
}

/// The net swap the orderbook applies to the LiquidityPool. 10 fields, matching the
/// contracts/pool/src/main.nr struct exactly.
pub struct ClearingSwap {
    pub a_to_pool:                 u128,
    pub b_to_pool:                 u128,
    pub a_from_pool:               u128,
    pub b_from_pool:               u128,
    pub reserve_a_add:             u128,
    pub reserve_a_sub:             u128,
    pub reserve_b_add:             u128,
    pub reserve_b_sub:             u128,
    pub fee_a_per_share_increment: u128,
    pub fee_b_per_share_increment: u128,
}

/// One submitted order's preimage; the private witness has [OrderPreimage; 128].
pub struct OrderPreimage {
    pub side:               bool,
    pub amount_in:          u128,
    pub limit_price:        u128,
    pub order_nonce:        Field,
    pub submitted_at_block: u32,
    pub owner:              Field,
}
