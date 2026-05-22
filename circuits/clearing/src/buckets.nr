//! Sub-2: V3 math primitives shared between the clearing circuit and (with
//! a parallel duplicate in contracts/pool/src/buckets.nr) the pool contract +
//! JS aggregator in aggregator/src/buckets.ts.
//!
//! All values are u128 in 1e18-scaled Q-format. Square roots are pre-computed
//! by the caller (the circuit / pool stores sqrt_P, not P, to keep arithmetic
//! linear in the V3 swap formulas).

use crate::pricing::{mul_div, SCALE};
use crate::types::{BucketBounds, BucketDelta, BucketState};

/// Result of a deposit's liquidity math: (l_used, used_a, used_b).
pub struct DepositMath {
    pub l_used: u128,
    pub used_a: u128,
    pub used_b: u128,
}

/// In-range deposit math: sqrt_lower < sqrt_p < sqrt_upper.
/// L_used = min(L_a, L_b) where:
///   L_a = x_a * (sqrt_p * sqrt_upper / SCALE) / (sqrt_upper - sqrt_p)
///   L_b = x_b * SCALE / (sqrt_p - sqrt_lower)
/// used_a, used_b recomputed from L_used to leave a clean residual for refund.
pub fn compute_deposit_in_range(
    x_a: u128,
    x_b: u128,
    sqrt_p: u128,
    sqrt_lower: u128,
    sqrt_upper: u128,
) -> DepositMath {
    // sqrt_p * sqrt_upper might overflow u128 -- use mul_div for safety.
    let sqrt_p_x_upper = mul_div(sqrt_p, sqrt_upper, SCALE);
    let span_upper = sqrt_upper - sqrt_p;
    let span_lower = sqrt_p - sqrt_lower;

    let l_a = mul_div(x_a, sqrt_p_x_upper, span_upper);
    let l_b = mul_div(x_b, SCALE, span_lower);
    let l_used = if l_a < l_b { l_a } else { l_b };

    let used_a = mul_div(l_used, span_upper, sqrt_p_x_upper);
    let used_b = mul_div(l_used, span_lower, SCALE);

    DepositMath { l_used, used_a, used_b }
}

/// Below-range deposit math: sqrt_p <= sqrt_lower. Bucket holds only token A.
/// L_used = x_a * (sqrt_upper * sqrt_lower / SCALE) / (sqrt_upper - sqrt_lower)
pub fn compute_deposit_below_range(
    x_a: u128,
    sqrt_lower: u128,
    sqrt_upper: u128,
) -> DepositMath {
    let sqrt_lower_x_upper = mul_div(sqrt_lower, sqrt_upper, SCALE);
    let span = sqrt_upper - sqrt_lower;
    let l_used = mul_div(x_a, sqrt_lower_x_upper, span);
    DepositMath { l_used, used_a: x_a, used_b: 0 as u128 }
}

/// Above-range deposit math: sqrt_p >= sqrt_upper. Bucket holds only token B.
/// L_used = x_b * SCALE / (sqrt_upper - sqrt_lower)
pub fn compute_deposit_above_range(
    x_b: u128,
    sqrt_lower: u128,
    sqrt_upper: u128,
) -> DepositMath {
    let span = sqrt_upper - sqrt_lower;
    let l_used = mul_div(x_b, SCALE, span);
    DepositMath { l_used, used_a: 0 as u128, used_b: x_b }
}

/// Dispatch on sqrt_p vs bucket bounds. The caller must already have escrowed
/// x_a + x_b; the returned used_a/used_b indicate what to keep and the
/// difference is the refund.
pub fn compute_deposit(
    x_a: u128,
    x_b: u128,
    sqrt_p: u128,
    bounds: BucketBounds,
) -> DepositMath {
    if sqrt_p <= bounds.sqrt_lower {
        compute_deposit_below_range(x_a, bounds.sqrt_lower, bounds.sqrt_upper)
    } else if sqrt_p >= bounds.sqrt_upper {
        compute_deposit_above_range(x_b, bounds.sqrt_lower, bounds.sqrt_upper)
    } else {
        compute_deposit_in_range(x_a, x_b, sqrt_p, bounds.sqrt_lower, bounds.sqrt_upper)
    }
}

/// Maximum amount of token A that can be added before sqrt_p reaches
/// sqrt_upper (the swap leaves this bucket going UP). Used by the aggregator
/// to determine bucket-boundary crossings during clearing.
pub fn max_a_in_to_upper(state: BucketState, bounds: BucketBounds, sqrt_p: u128) -> u128 {
    // max_a = liquidity * (sqrt_upper - sqrt_p) / (sqrt_p * sqrt_upper / SCALE)
    let span = bounds.sqrt_upper - sqrt_p;
    let denom = mul_div(sqrt_p, bounds.sqrt_upper, SCALE);
    mul_div(state.liquidity, span, denom)
}

/// Maximum amount of token B that can be added before sqrt_p reaches
/// sqrt_lower (the swap leaves this bucket going DOWN).
pub fn max_b_in_to_lower(state: BucketState, bounds: BucketBounds, sqrt_p: u128) -> u128 {
    // max_b = liquidity * (sqrt_p - sqrt_lower) / SCALE
    let span = sqrt_p - bounds.sqrt_lower;
    mul_div(state.liquidity, span, SCALE)
}

/// Sub-2.5: V3 swap-step math.
pub fn next_sqrt_p_up(L: u128, sqrt_p: u128, delta_b: u128) -> u128 {
    sqrt_p + mul_div(delta_b, SCALE, L)
}

pub fn next_sqrt_p_down(L: u128, sqrt_p: u128, delta_a: u128) -> u128 {
    // Avoid overflow: factor out SCALE from numerator and denominator.
    // sqrt_p * L * SCALE / (L * SCALE + delta_a * sqrt_p)
    //   = sqrt_p * L / (L + delta_a * sqrt_p / SCALE)
    let denom = L + mul_div(delta_a, sqrt_p, SCALE);
    mul_div(sqrt_p, L, denom)
}

/// Pool moved UP: sqrt_p_new >= sqrt_p. Violations panic via u128 underflow.
pub fn swap_step_out_a(L: u128, sqrt_p: u128, sqrt_p_new: u128) -> u128 {
    let denom = mul_div(sqrt_p, sqrt_p_new, SCALE);
    mul_div(L, sqrt_p_new - sqrt_p, denom)
}

/// Pool moved DOWN: sqrt_p_new <= sqrt_p. Violations panic via u128 underflow.
pub fn swap_step_out_b(L: u128, sqrt_p: u128, sqrt_p_new: u128) -> u128 {
    mul_div(L, sqrt_p - sqrt_p_new, SCALE)
}

/// Sub-2.5: assert that a single bucket's pre + post state are consistent
/// with the BucketDelta and chain through sqrt_p. Returns sqrt_p_out so the
/// caller can chain across multiple active buckets.
///
/// Direction is inferred from the delta:
///   reserve_b_add > 0 (and reserve_a_sub > 0) => UP (B in, A out)
///   reserve_a_add > 0 (and reserve_b_sub > 0) => DOWN (A in, B out)
///   both zero on each side => no-op slot, skip
pub fn assert_bucket_step(
    before: BucketState,
    after: BucketState,
    delta: BucketDelta,
    sqrt_p_in: u128,
) -> u128 {
    // Reserves consistent with delta.
    assert(after.reserve_a == before.reserve_a + delta.reserve_a_add - delta.reserve_a_sub,
           "bucket reserve_a delta mismatch");
    assert(after.reserve_b == before.reserve_b + delta.reserve_b_add - delta.reserve_b_sub,
           "bucket reserve_b delta mismatch");
    // Liquidity preserved across swap (no add/withdraw inside a clearing).
    assert(after.liquidity == before.liquidity, "bucket liquidity changed during swap");

    // Fee cum_*_per_share consistent with cum_fee_*_per_share_increment.
    assert(after.cum_fee_a_per_share == before.cum_fee_a_per_share + delta.cum_fee_a_per_share_increment,
           "bucket cum_fee_a mismatch");
    assert(after.cum_fee_b_per_share == before.cum_fee_b_per_share + delta.cum_fee_b_per_share_increment,
           "bucket cum_fee_b mismatch");

    // sqrt_p out = sqrt_p_in updated per the V3 formula matching the delta.
    let mut sqrt_p_out = sqrt_p_in;
    if delta.reserve_b_add > 0 as u128 {
        // UP: B in by reserve_b_add (after-fee amount; matches aggregator)
        sqrt_p_out = next_sqrt_p_up(before.liquidity, sqrt_p_in, delta.reserve_b_add);
        let expected_out_a = swap_step_out_a(before.liquidity, sqrt_p_in, sqrt_p_out);
        // Allow 1-unit dust (rounding).
        let dust = if expected_out_a >= delta.reserve_a_sub {
            expected_out_a - delta.reserve_a_sub
        } else {
            delta.reserve_a_sub - expected_out_a
        };
        assert(dust <= 1 as u128, "bucket out_a deviates from V3 formula");
    } else if delta.reserve_a_add > 0 as u128 {
        sqrt_p_out = next_sqrt_p_down(before.liquidity, sqrt_p_in, delta.reserve_a_add);
        let expected_out_b = swap_step_out_b(before.liquidity, sqrt_p_in, sqrt_p_out);
        let dust = if expected_out_b >= delta.reserve_b_sub {
            expected_out_b - delta.reserve_b_sub
        } else {
            delta.reserve_b_sub - expected_out_b
        };
        assert(dust <= 1 as u128, "bucket out_b deviates from V3 formula");
    }
    sqrt_p_out
}
