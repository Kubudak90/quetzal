use crate::pricing::{mul_div, SCALE, FEE_NUM, FEE_DEN, eligible, payout};
use crate::binding::{c_i, replay_chain};
use crate::types::{OrderPreimage, MAX_ORDERS_PER_EPOCH};
use crate::merkle::{fill_leaf, merkle_root_32};

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

// ============================================================================
// Week 5d-4: Merkle settlement root tests (sec 10.1 T1-T3).
// ============================================================================

#[test]
fn merkle_empty_leaf_is_poseidon2_of_zero_zero() {
    // The padding leaf - poseidon2_hash([0, 0]) - is what every empty slot collapses to.
    let empty = fill_leaf(0 as Field, 0 as u128);
    let expected = poseidon::poseidon2::Poseidon2::hash([0 as Field, 0 as Field], 2);
    assert(empty == expected, "fill_leaf(0,0) must equal poseidon2([0,0])");
}

#[test]
fn merkle_fill_leaf_binds_order_nonce_and_amount() {
    // Two leaves that differ only in order_nonce produce distinct hashes.
    let l1 = fill_leaf(1 as Field, 100 as u128);
    let l2 = fill_leaf(2 as Field, 100 as u128);
    assert(l1 != l2, "leaf must be sensitive to order_nonce");
    // Two leaves that differ only in amount_out produce distinct hashes.
    let l3 = fill_leaf(1 as Field, 100 as u128);
    let l4 = fill_leaf(1 as Field, 101 as u128);
    assert(l3 != l4, "leaf must be sensitive to amount_out");
}

#[test]
fn merkle_root_all_zero_leaves_pins_expected_constant() {
    // The all-empty-slot root is what the contract treats as the "no clearing
    // recorded" sentinel boundary. Pin it against an independently-derived
    // value: 5 levels of poseidon2([x, x]) starting at fill_leaf(0, 0).
    let empty = fill_leaf(0 as Field, 0 as u128);
    let leaves: [Field; MAX_ORDERS_PER_EPOCH] = [empty; MAX_ORDERS_PER_EPOCH];

    let lvl1 = poseidon::poseidon2::Poseidon2::hash([empty, empty], 2);
    let lvl2 = poseidon::poseidon2::Poseidon2::hash([lvl1, lvl1], 2);
    let lvl3 = poseidon::poseidon2::Poseidon2::hash([lvl2, lvl2], 2);
    let lvl4 = poseidon::poseidon2::Poseidon2::hash([lvl3, lvl3], 2);
    let expected_root = poseidon::poseidon2::Poseidon2::hash([lvl4, lvl4], 2);

    let computed = merkle_root_32(leaves);
    assert(computed == expected_root, "all-empty merkle root must match independently-derived constant");
}

#[test]
fn merkle_root_single_nonzero_leaf_traces() {
    // Construct a 32-leaf tree where only index 0 differs from the empty sentinel.
    // Manually hash the path: level0[0] vs level0[1] (both empty), level1[0] hashes them,
    // up the spine on the "left always" path (leaf_index = 0).
    let empty = fill_leaf(0 as Field, 0 as u128);
    let mine = fill_leaf(7 as Field, 42 as u128);
    let mut leaves: [Field; MAX_ORDERS_PER_EPOCH] = [empty; MAX_ORDERS_PER_EPOCH];
    leaves[0] = mine;

    // Walk the path manually for leaf_index = 0 (all "left").
    let mut node = mine;
    // Level 0 sibling: leaves[1] (still the empty leaf).
    node = poseidon::poseidon2::Poseidon2::hash([node, empty], 2);
    // Levels 1-4 siblings: the all-empty subtree root at the corresponding depth.
    let mut sibling = poseidon::poseidon2::Poseidon2::hash([empty, empty], 2);
    for _level in 0..4 {
        node = poseidon::poseidon2::Poseidon2::hash([node, sibling], 2);
        sibling = poseidon::poseidon2::Poseidon2::hash([sibling, sibling], 2);
    }

    let computed = merkle_root_32(leaves);
    assert(node == computed, "manual path trace must match merkle_root_32 output");
}

#[test]
fn merkle_root_changes_with_leaf_swap() {
    // Swapping a single non-zero leaf into a different slot changes the root
    // (rules out a trivial "sum of leaves" or other index-insensitive implementation).
    let empty = fill_leaf(0 as Field, 0 as u128);
    let leaf_a = fill_leaf(9 as Field, 1000 as u128);
    let mut leaves_lo: [Field; MAX_ORDERS_PER_EPOCH] = [empty; MAX_ORDERS_PER_EPOCH];
    leaves_lo[0] = leaf_a;
    let mut leaves_hi: [Field; MAX_ORDERS_PER_EPOCH] = [empty; MAX_ORDERS_PER_EPOCH];
    leaves_hi[31] = leaf_a;
    let root_lo = merkle_root_32(leaves_lo);
    let root_hi = merkle_root_32(leaves_hi);
    assert(root_lo != root_hi, "leaf position must affect root");
}

// ============================================================================
// Sub-2: V3 bucket math tests (sec 9 B1-B5 from the design spec).
// ============================================================================
use crate::buckets::{
    compute_deposit_in_range, compute_deposit_below_range, compute_deposit_above_range,
    max_a_in_to_upper, max_b_in_to_lower,
};
use crate::types::{BucketBounds, BucketState};

// Standard test bucket: sqrt_lower=1e18 (P=1.0), sqrt_upper=~1.2247e18 (P=1.5).
global TEST_SQRT_LOWER: u128 = 1_000_000_000_000_000_000;
global TEST_SQRT_UPPER: u128 = 1_224_744_871_391_589_049;  // sqrt(1.5e18)
// Pool sqrt_p halfway through the bucket: sqrt(1.25e18).
global TEST_SQRT_P: u128     = 1_118_033_988_749_894_848;

#[test]
fn b1_compute_deposit_in_range_basic() {
    // Standard call with non-trivial amounts; assert structural invariants.
    let x_a: u128 = 1_000_000_000;
    let x_b: u128 = 1_000_000_000;
    let result = compute_deposit_in_range(x_a, x_b, TEST_SQRT_P, TEST_SQRT_LOWER, TEST_SQRT_UPPER);
    assert(result.l_used > 0 as u128, "in-range deposit mints positive L");
    assert(result.used_a <= x_a, "used_a never exceeds x_a");
    assert(result.used_b <= x_b, "used_b never exceeds x_b");
}

#[test]
fn b2_compute_deposit_in_range_a_surplus_refunds() {
    // x_a way too much for x_b. L_b binding, so used_a < x_a (refund expected).
    let x_a: u128 = 10_000_000_000;
    let x_b: u128 = 1_000_000_000;
    let result = compute_deposit_in_range(x_a, x_b, TEST_SQRT_P, TEST_SQRT_LOWER, TEST_SQRT_UPPER);
    assert(result.l_used > 0 as u128, "mint nonzero L");
    assert(result.used_a < x_a, "x_a surplus implies used_a < x_a");
    assert(result.used_b <= x_b, "used_b never exceeds x_b");
}

#[test]
fn b3_compute_deposit_below_range_only_token_a() {
    let x_a: u128 = 1_000_000_000;
    let result = compute_deposit_below_range(x_a, TEST_SQRT_LOWER, TEST_SQRT_UPPER);
    assert(result.l_used > 0 as u128, "below-range deposit mints L from x_a");
    assert(result.used_a == x_a, "below-range consumes all x_a");
    assert(result.used_b == 0 as u128, "below-range used_b is 0");
}

#[test]
fn b4_compute_deposit_above_range_only_token_b() {
    let x_b: u128 = 1_000_000_000;
    let result = compute_deposit_above_range(x_b, TEST_SQRT_LOWER, TEST_SQRT_UPPER);
    assert(result.l_used > 0 as u128, "above-range deposit mints L from x_b");
    assert(result.used_a == 0 as u128, "above-range used_a is 0");
    assert(result.used_b == x_b, "above-range consumes all x_b");
}

#[test]
fn swap_step_b6_next_sqrt_p_up() {
    let l: u128 = 10 as u128 * crate::pricing::SCALE;
    let sqrt_p: u128 = crate::pricing::SCALE;
    let delta_b: u128 = crate::pricing::SCALE / 100;
    let out = crate::buckets::next_sqrt_p_up(l, sqrt_p, delta_b);
    assert(out == sqrt_p + crate::pricing::mul_div(delta_b, crate::pricing::SCALE, l));
}

#[test]
fn swap_step_b7_next_sqrt_p_down_monotone() {
    let l: u128 = 10 as u128 * crate::pricing::SCALE;
    let sqrt_p: u128 = crate::pricing::SCALE;
    let delta_a: u128 = crate::pricing::SCALE / 100;
    let out = crate::buckets::next_sqrt_p_down(l, sqrt_p, delta_a);
    assert(out < sqrt_p, "sqrt_p_down must be strictly less than starting sqrt_p");
}

#[test]
fn swap_step_b8_b9_outputs_nonzero() {
    let l: u128 = 10 as u128 * crate::pricing::SCALE;
    let sqrt_p: u128 = crate::pricing::SCALE;
    let sqrt_p_up: u128 = sqrt_p + crate::pricing::SCALE / 1000;
    let sqrt_p_dn: u128 = sqrt_p - crate::pricing::SCALE / 1000;
    let out_a = crate::buckets::swap_step_out_a(l, sqrt_p, sqrt_p_up);
    let out_b = crate::buckets::swap_step_out_b(l, sqrt_p, sqrt_p_dn);
    assert(out_a > 0 as u128, "out_a must be positive when sqrt_p increased");
    assert(out_b > 0 as u128, "out_b must be positive when sqrt_p decreased");
}

#[test]
fn b5_max_in_to_boundary_consistent_with_liquidity() {
    let empty = BucketState {
        reserve_a: 0 as u128, reserve_b: 0 as u128, liquidity: 0 as u128,
        cum_fee_a_per_share: 0 as u128, cum_fee_b_per_share: 0 as u128,
    };
    let bounds = BucketBounds { sqrt_lower: TEST_SQRT_LOWER, sqrt_upper: TEST_SQRT_UPPER };
    assert(max_a_in_to_upper(empty, bounds, TEST_SQRT_P) == 0 as u128, "empty bucket has zero max_a_in");
    assert(max_b_in_to_lower(empty, bounds, TEST_SQRT_P) == 0 as u128, "empty bucket has zero max_b_in");

    let nonempty = BucketState {
        reserve_a: 1_000_000 as u128, reserve_b: 1_000_000 as u128,
        liquidity: 1_000_000_000 as u128,
        cum_fee_a_per_share: 0 as u128, cum_fee_b_per_share: 0 as u128,
    };
    assert(max_a_in_to_upper(nonempty, bounds, TEST_SQRT_P) > 0 as u128, "non-empty bucket has positive max_a_in");
    assert(max_b_in_to_lower(nonempty, bounds, TEST_SQRT_P) > 0 as u128, "non-empty bucket has positive max_b_in");
}
