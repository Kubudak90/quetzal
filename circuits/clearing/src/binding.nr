//! Binding constraints (spec sec 6.1): chain replay + is_cancelled derivation.
//! Matches the on-chain submit_order / cancel_order c_i computation exactly
//! (Week 5d-1 IT4 invariant).
//!
//! Note on poseidon2 import: the clearing circuit is a plain `bin` crate with no
//! aztec-nr dependency. `aztec::protocol::hash::poseidon2_hash` in the orderbook
//! contract is itself a thin wrapper around `poseidon::poseidon2::Poseidon2::hash`
//! (from noir-lang/poseidon v0.3.0), so using the same underlying function here
//! produces identical hashes.

use crate::types::{OrderPreimage, MAX_ORDERS_PER_EPOCH};

/// Per-order commitment, exactly the formula submit_order / cancel_order use.
/// Input order: owner, side(0/1), amount_in, limit_price, order_nonce, submitted_at_block.
pub fn c_i(order: OrderPreimage) -> Field {
    let side_field: Field = if order.side { 1 } else { 0 };
    poseidon::poseidon2::Poseidon2::hash(
        [
            order.owner,
            side_field,
            order.amount_in as Field,
            order.limit_price as Field,
            order.order_nonce,
            order.submitted_at_block as Field,
        ],
        6,
    )
}

/// Fold orders[0..count].c_i into a running-hash chain. acc starts at 0.
pub fn replay_chain(
    orders: [OrderPreimage; MAX_ORDERS_PER_EPOCH],
    count: u32,
) -> Field {
    let mut acc: Field = 0;
    for i in 0..MAX_ORDERS_PER_EPOCH {
        if (i as u32) < count {
            acc = poseidon::poseidon2::Poseidon2::hash([acc, c_i(orders[i])], 2);
        }
    }
    acc
}

/// Replay the cancel_acc chain. cancelled_indices[j] (for j < cancel_count) is
/// the submission index of the j-th cancelled order; orders[cancelled_indices[j]]
/// provides the preimage to fold.
pub fn replay_cancel_chain(
    orders: [OrderPreimage; MAX_ORDERS_PER_EPOCH],
    cancelled_indices: [u32; MAX_ORDERS_PER_EPOCH],
    cancel_count: u32,
    order_count: u32,
) -> Field {
    let mut acc: Field = 0;
    for j in 0..MAX_ORDERS_PER_EPOCH {
        if (j as u32) < cancel_count {
            let idx = cancelled_indices[j];
            assert(idx < order_count, "cancelled_indices[j] out of bounds");
            // Scan-and-pick: constraint-safe guarded fixed-loop that selects
            // orders[idx] by equality (Noir 1.0-beta dynamic indexing).
            let mut selected = orders[0];
            for k in 0..MAX_ORDERS_PER_EPOCH {
                if (k as u32) == idx {
                    selected = orders[k];
                }
            }
            acc = poseidon::poseidon2::Poseidon2::hash([acc, c_i(selected)], 2);
        }
    }
    acc
}

/// Derive the is_cancelled mask. For each j in 0..cancel_count, mark
/// is_cancelled[cancelled_indices[j]] = true.
pub fn derive_is_cancelled(
    cancelled_indices: [u32; MAX_ORDERS_PER_EPOCH],
    cancel_count: u32,
    order_count: u32,
) -> [bool; MAX_ORDERS_PER_EPOCH] {
    let mut is_cancelled: [bool; MAX_ORDERS_PER_EPOCH] = [false; MAX_ORDERS_PER_EPOCH];
    for j in 0..MAX_ORDERS_PER_EPOCH {
        if (j as u32) < cancel_count {
            let idx = cancelled_indices[j];
            assert(idx < order_count, "derive_is_cancelled: idx out of bounds");
            // Fixed-loop scan-and-set (O(N^2) at N=128 = 16384 ops).
            for k in 0..MAX_ORDERS_PER_EPOCH {
                if (k as u32) == idx {
                    is_cancelled[k] = true;
                }
            }
        }
    }
    is_cancelled
}
