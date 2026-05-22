//! Sub-2: V3 math primitives shared between the clearing circuit and (with
//! a parallel duplicate in contracts/pool/src/buckets.nr) the pool contract +
//! JS aggregator in aggregator/src/buckets.ts.
//!
//! All values are u128 in 1e18-scaled Q-format. Square roots are pre-computed
//! by the caller (the circuit / pool stores sqrt_P, not P, to keep arithmetic
//! linear in the V3 swap formulas).

use crate::pricing::{mul_div, SCALE};
use crate::types::{BucketBounds, BucketState};

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
