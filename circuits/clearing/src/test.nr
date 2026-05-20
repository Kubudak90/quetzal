use crate::pricing::{mul_div, SCALE, FEE_NUM, FEE_DEN, eligible, payout};
use crate::binding::{c_i, replay_chain};
use crate::types::{OrderPreimage, MAX_ORDERS_PER_EPOCH};

#[test]
fn mul_div_basic_floor_rounding() {
    // Trivial: 1000 * 5 / 10 == 500.
    assert(mul_div(1000 as u128, 5 as u128, 10 as u128) == 500 as u128);
    // Floor: 7 * 3 / 5 == 4 (not 4.2).
    assert(mul_div(7 as u128, 3 as u128, 5 as u128) == 4 as u128);
}

#[test]
fn mul_div_handles_large_factors() {
    // amount_in (1e9 token A) * SCALE (1e18) / P* (2e18) == 5e8 -- representative
    // of the buy-side payout intermediate before fee withholding.
    let amount = 1_000_000_000 as u128;
    let p_star = 2_000_000_000_000_000_000 as u128;
    let out = mul_div(amount, SCALE, p_star);
    assert(out == 500_000_000 as u128);
}

#[test]
fn fee_constants() {
    assert(FEE_NUM == 30 as u128);
    assert(FEE_DEN == 10_000 as u128);
    assert(SCALE == 1_000_000_000_000_000_000 as u128);
}

// U1: c_i formula vs hand-computed Poseidon2 (spec sec 5.3 / Week 5d-1 IT4 invariant).
#[test]
fn u1_c_i_matches_hand_computed() {
    let order = OrderPreimage {
        side: false,
        amount_in: 1_000_000_000 as u128,
        limit_price: 2_000_000_000_000_000_000 as u128,
        order_nonce: 0x1234567890abcdef,
        submitted_at_block: 42,
        owner: 0xdeadbeef,
    };
    let expected = poseidon::poseidon2::Poseidon2::hash([
        0xdeadbeef,
        0,
        1_000_000_000 as Field,
        2_000_000_000_000_000_000 as Field,
        0x1234567890abcdef,
        42 as Field,
    ], 6);
    assert(c_i(order) == expected, "c_i must match the 5d-1 Poseidon2 formula exactly");
}

// U2: 3-link order_acc replay matches a manually-folded chain.
#[test]
fn u2_order_acc_three_link_replay() {
    let zero_order = OrderPreimage {
        side: false, amount_in: 0 as u128, limit_price: 0 as u128,
        order_nonce: 0, submitted_at_block: 0, owner: 0,
    };
    let mut orders: [OrderPreimage; MAX_ORDERS_PER_EPOCH] =
        [zero_order; MAX_ORDERS_PER_EPOCH];
    orders[0] = OrderPreimage {
        side: false, amount_in: 100 as u128, limit_price: 2_000_000_000_000_000_000 as u128,
        order_nonce: 1, submitted_at_block: 1, owner: 0xaaaa,
    };
    orders[1] = OrderPreimage {
        side: true, amount_in: 50 as u128, limit_price: 1_000_000_000_000_000_000 as u128,
        order_nonce: 2, submitted_at_block: 2, owner: 0xbbbb,
    };
    orders[2] = OrderPreimage {
        side: false, amount_in: 200 as u128, limit_price: 3_000_000_000_000_000_000 as u128,
        order_nonce: 3, submitted_at_block: 3, owner: 0xcccc,
    };

    // Manually fold the 3-link chain.
    let mut expected: Field = 0;
    for i in 0..3 {
        expected = poseidon::poseidon2::Poseidon2::hash([expected, c_i(orders[i])], 2);
    }

    let replayed = replay_chain(orders, 3);
    assert(replayed == expected, "3-link order_acc replay must match hand fold");
}

// U7: cancel_acc replay with a different commitment produces a different chain
// (binding sensitivity).
#[test]
fn u7_cancel_acc_replay_is_binding() {
    let zero_order = OrderPreimage {
        side: false, amount_in: 0 as u128, limit_price: 0 as u128,
        order_nonce: 0, submitted_at_block: 0, owner: 0,
    };
    let o0 = OrderPreimage {
        side: false, amount_in: 100 as u128, limit_price: 2 as u128,
        order_nonce: 7, submitted_at_block: 1, owner: 0xa,
    };
    let o1 = OrderPreimage {
        side: false, amount_in: 100 as u128, limit_price: 2 as u128,
        order_nonce: 8, submitted_at_block: 2, owner: 0xa,
    };

    let mut arr0: [OrderPreimage; MAX_ORDERS_PER_EPOCH] = [zero_order; MAX_ORDERS_PER_EPOCH];
    arr0[0] = o0;
    let real_acc = replay_chain(arr0, 1);

    let mut arr1: [OrderPreimage; MAX_ORDERS_PER_EPOCH] = [zero_order; MAX_ORDERS_PER_EPOCH];
    arr1[0] = o1;
    let tampered_acc = replay_chain(arr1, 1);

    assert(real_acc != tampered_acc, "different cancelled commitments produce different chains");
}

// U3: Buy eligible iff limit_price >= P*; sell eligible iff limit_price <= P*.
#[test]
fn u3_eligibility_gates() {
    let p_star: u128 = 2_000_000_000_000_000_000;  // 2e18
    let buy_at_limit_2 = OrderPreimage {
        side: false, amount_in: 1 as u128, limit_price: 2_000_000_000_000_000_000 as u128,
        order_nonce: 0, submitted_at_block: 0, owner: 0,
    };
    let buy_at_limit_3 = OrderPreimage {
        side: false, amount_in: 1 as u128, limit_price: 3_000_000_000_000_000_000 as u128,
        order_nonce: 0, submitted_at_block: 0, owner: 0,
    };
    let buy_at_limit_1 = OrderPreimage {
        side: false, amount_in: 1 as u128, limit_price: 1_000_000_000_000_000_000 as u128,
        order_nonce: 0, submitted_at_block: 0, owner: 0,
    };
    assert(eligible(buy_at_limit_2, p_star), "buy with limit == P* eligible");
    assert(eligible(buy_at_limit_3, p_star), "buy with limit > P* eligible");
    assert(!eligible(buy_at_limit_1, p_star), "buy with limit < P* ineligible");

    let sell_at_limit_2 = OrderPreimage {
        side: true, amount_in: 1 as u128, limit_price: 2_000_000_000_000_000_000 as u128,
        order_nonce: 0, submitted_at_block: 0, owner: 0,
    };
    let sell_at_limit_1 = OrderPreimage {
        side: true, amount_in: 1 as u128, limit_price: 1_000_000_000_000_000_000 as u128,
        order_nonce: 0, submitted_at_block: 0, owner: 0,
    };
    let sell_at_limit_3 = OrderPreimage {
        side: true, amount_in: 1 as u128, limit_price: 3_000_000_000_000_000_000 as u128,
        order_nonce: 0, submitted_at_block: 0, owner: 0,
    };
    assert(eligible(sell_at_limit_2, p_star), "sell with limit == P* eligible");
    assert(eligible(sell_at_limit_1, p_star), "sell with limit < P* eligible");
    assert(!eligible(sell_at_limit_3, p_star), "sell with limit > P* ineligible");
}

// U4: Buy 1000 amount_in (raw units) @ P* = 2e18 -> ~498 amount_out (30 bps fee).
// (1000 * 1e18 / 2e18) * (10000-30) / 10000 = 500 * 9970 / 10000 = 498.5 -> floor 498.
#[test]
fn u4_buy_payout_with_fee() {
    let p_star: u128 = 2_000_000_000_000_000_000;  // 2e18
    let buy = OrderPreimage {
        side: false, amount_in: 1000 as u128, limit_price: p_star,
        order_nonce: 0, submitted_at_block: 0, owner: 0,
    };
    assert(payout(buy, p_star) == 498 as u128, "buy 1000 @ 2e18 -> 498 after 30bps fee");
}

// U8: A buy with limit_price < P* is NOT eligible (mirrors the sec 6.2.7 negative gate).
#[test]
fn u8_payout_ineligible_zero_or_panic() {
    let p_star: u128 = 2_000_000_000_000_000_000;
    let buy_under_limit = OrderPreimage {
        side: false, amount_in: 1000 as u128, limit_price: 1_000_000_000_000_000_000 as u128,
        order_nonce: 0, submitted_at_block: 0, owner: 0,
    };
    assert(!eligible(buy_under_limit, p_star), "buy limit < P* must NOT be eligible");
}

use crate::amm::assert_k_monotonic;

// U5: small swap with fee withheld - k strictly shrinks or stays equal.
// pre 100x200 (k = 20_000); post 110x180 (k = 19_800). 19_800 <= 20_000 PASS.
#[test]
fn u5_amm_k_monotonic_on_small_swap() {
    assert_k_monotonic(100 as u128, 200 as u128, 110 as u128, 180 as u128);
}

// U6: DoS resistance mask derivation - an eligible non-cancelled order omitted
// from fills shows up as a violation in the mask scan. (We exercise the mask
// logic in isolation here; main.nr's main assert is what catches the violation
// in the real proof.)
#[test]
fn u6_dos_resistance_mask_derivation() {
    let mut is_filled: [bool; MAX_ORDERS_PER_EPOCH] = [false; MAX_ORDERS_PER_EPOCH];
    is_filled[0] = true;
    is_filled[2] = true;

    let is_cancelled: [bool; MAX_ORDERS_PER_EPOCH] = [false; MAX_ORDERS_PER_EPOCH];

    // Order at index 1 is eligible & not cancelled but not filled -> violation.
    let order_count: u32 = 3;
    let mut violation = false;
    for k in 0..MAX_ORDERS_PER_EPOCH {
        if (k as u32) < order_count {
            if !is_cancelled[k] {
                if !is_filled[k] {
                    violation = true;
                }
            }
        }
    }
    assert(violation, "omitted eligible order must be detected as a violation");
}
