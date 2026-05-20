//! Fixed-point arithmetic + payout/eligibility primitives for clearing.

pub global SCALE: u128 = 1_000_000_000_000_000_000;   // 1e18, matches aggregator's fixed-point
pub global FEE_NUM: u128 = 30;                         // 30 bps numerator
pub global FEE_DEN: u128 = 10_000;                     // 30 bps denominator

// 2^64, used to split u128 values into hi/lo u64 halves.
global TWO_POW_64: u128 = 18_446_744_073_709_551_616; // 2^64

/// (x * y) / z with floor rounding.
///
/// The product x*y can reach ~2^188 when x or y is near 1e18 (~2^60), which
/// overflows u128. We compute it via a 256-bit intermediate represented as a
/// pair of u128 (hi, lo) using long multiplication over u64 limbs, then do
/// long division by z.
///
/// Spec s6.7 fallback: Field `/` in Noir is modular inverse, not integer floor
/// division, so we use the u64 hi/lo limb approach throughout.
///
/// Caller must ensure z >= 1 and that the true quotient fits in u128.
pub fn mul_div(x: u128, y: u128, z: u128) -> u128 {
    assert(z != 0 as u128, "mul_div: divide by zero");

    // Split x and y into 64-bit halves: x = x_hi * 2^64 + x_lo
    let x_lo: u128 = x % TWO_POW_64;
    let x_hi: u128 = x / TWO_POW_64;
    let y_lo: u128 = y % TWO_POW_64;
    let y_hi: u128 = y / TWO_POW_64;

    // Compute 256-bit product p = x * y = (x_hi * 2^64 + x_lo) * (y_hi * 2^64 + y_lo)
    //   = x_hi*y_hi * 2^128  +  (x_hi*y_lo + x_lo*y_hi) * 2^64  +  x_lo*y_lo
    //
    // Each partial product fits in u128 because each factor is < 2^64.
    let p0: u128 = x_lo * y_lo;                    // bits [0..127]
    let p1: u128 = x_lo * y_hi;                    // bits [64..191]
    let p2: u128 = x_hi * y_lo;                    // bits [64..191]
    let p3: u128 = x_hi * y_hi;                    // bits [128..255]

    // Accumulate into (lo128, hi128) -- a pair of u128 representing a 256-bit value
    // where the full product = hi128 * 2^128 + lo128.

    // lo128 starts with p0, then add p1<<64 and p2<<64
    let lo128: u128 = p0 + (p1 % TWO_POW_64) * TWO_POW_64 + (p2 % TWO_POW_64) * TWO_POW_64;

    // carries from lo128 into hi128
    // lo128 = p0 + (p1_lo + p2_lo)*2^64; extract carry
    // We compute carry step by step to avoid overflow (each add could overflow u128).
    let lo_a: u128 = p0;
    let p1_lo_shifted = (p1 % TWO_POW_64) * TWO_POW_64;
    let lo_b = lo_a + p1_lo_shifted;
    let carry_ab: u128 = if lo_b < lo_a { 1 } else { 0 };
    let p2_lo_shifted = (p2 % TWO_POW_64) * TWO_POW_64;
    let lo_c = lo_b + p2_lo_shifted;
    let carry_bc: u128 = if lo_c < lo_b { 1 } else { 0 };

    // Unused: lo128 value is lo_c; we don't actually need lo128 directly below.
    // hi128 accumulates the high parts.
    let hi128: u128 = p3 + p1 / TWO_POW_64 + p2 / TWO_POW_64 + carry_ab + carry_bc;

    // Now divide the 256-bit number (hi128 * 2^128 + lo_c) by z using long division.
    // We do two passes: first reduce hi128 mod z (getting a remainder < z that fits
    // in a u128), then combine with lo_c for the final division.
    //
    // Pass 1: quotient_hi = hi128 / z,  rem1 = hi128 % z
    let quot_hi: u128 = hi128 / z;
    let rem1: u128 = hi128 % z;
    // (This contributes quot_hi * 2^128 to the final quotient, but since the caller
    //  guarantees the true quotient fits in u128, quot_hi must be 0.)
    assert(quot_hi == 0 as u128, "mul_div: intermediate overflow");

    // Pass 2: divide (rem1 * 2^128 + lo_c) by z.
    // rem1 < z <= 2^128, so rem1 * 2^128 can be huge. We do the 128-bit long division
    // by splitting lo_c into two 64-bit halves and doing two digit-by-digit steps,
    // using rem1 as the running remainder.
    //
    // Step 2a: bring in the high 64 bits of lo_c.
    let lo_c_hi: u128 = lo_c / TWO_POW_64;
    let lo_c_lo: u128 = lo_c % TWO_POW_64;

    // Dividend for step 2a = rem1 * 2^64 + lo_c_hi
    // = concatenation of rem1 (high) and lo_c_hi (low 64 bits).
    // We need (rem1 * 2^64 + lo_c_hi) / z and mod z.
    // rem1 < z, so rem1 * 2^64 < z * 2^64.  The quotient of this step fits in 64 bits.
    //
    // Use the standard multi-word division step:
    //   q2a = (rem1 * 2^64 + lo_c_hi) / z
    //   r2a = (rem1 * 2^64 + lo_c_hi) % z
    //
    // If z fits in 64 bits, rem1 * 2^64 fits in u128 safely:
    //   rem1 < z < 2^64 => rem1 * 2^64 < 2^128 (fine)
    // If z >= 2^64, then rem1 < z, so rem1 <= z-1 < 2^128.  We need
    //   rem1 * 2^64 which can overflow u128 if rem1 >= 2^64.
    //   But in that case the dividend > 2^128 and we can't compute it directly.
    //
    // For our use case: z is at most ~2e18 < 2^61, so z < 2^64 always. That means
    // rem1 < z < 2^64 too, and rem1 * 2^64 < 2^128 -- safe.
    //
    // (If future callers use z >= 2^64, this will assert below.)
    assert(z < TWO_POW_64, "mul_div: z must be < 2^64 for this implementation");

    let dividend_2a: u128 = rem1 * TWO_POW_64 + lo_c_hi;
    let q2a: u128 = dividend_2a / z;
    let r2a: u128 = dividend_2a % z;

    // Step 2b: bring in the low 64 bits of lo_c.
    let dividend_2b: u128 = r2a * TWO_POW_64 + lo_c_lo;
    let q2b: u128 = dividend_2b / z;
    // r2b = dividend_2b % z  (the final remainder, which we discard for floor)

    // Final quotient = q2a * 2^64 + q2b
    q2a * TWO_POW_64 + q2b
}
