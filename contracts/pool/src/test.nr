// TXE tests for the LiquidityPool contract (Sub-2: concentrated liquidity).
// Run with: pnpm test:noir
//
// Sub-1 tests (V2 deposit/withdraw happy paths) are dropped -- they depended on
// the old flat-pool PoolState shape. Sub-2 happy-path tests need real Token
// deployment for escrow + authwit machinery (cross-package limitation per
// Sub-3 R1 deferral pattern); those land in tests/integration/concentrated-lp
// .test.ts (Task 21 dormant scaffold).

use crate::LiquidityPool;
use crate::LiquidityPool::{integer_sqrt, PoolState, PositionNote};
use crate::LiquidityPool::buckets::{
    compute_deposit_in_range, compute_deposit_below_range, compute_deposit_above_range,
};
use aztec::{
    protocol::{
        address::AztecAddress,
        traits::{Deserialize, FromField, Serialize},
    },
    test::helpers::test_environment::TestEnvironment,
};

// Standard bucket test fixture.
global TEST_SQRT_LOWER: u128 = 1_000_000_000_000_000_000;
global TEST_SQRT_UPPER: u128 = 1_224_744_871_391_589_049;
global TEST_SQRT_P: u128     = 1_118_033_988_749_894_848;
global TEST_P_MIN_SQRT: u128 = 100_000_000_000_000_000;     // sqrt(0.01)
global TEST_GROWTH_NUM: u128 = 1_500_000_000_000_000_000;   // 1.5e18

unconstrained fn deploy_pool(
    env: &mut TestEnvironment,
    deployer: AztecAddress,
    token_a: AztecAddress,
    token_b: AztecAddress,
) -> AztecAddress {
    let initializer_call = LiquidityPool::interface().constructor(
        token_a, token_b, TEST_P_MIN_SQRT, TEST_GROWTH_NUM,
    );
    env.deploy("LiquidityPool").with_public_initializer(deployer, initializer_call)
}

// Pool-side V3 math parity tests (mirror circuits/clearing/src/test.nr's b1-b5).
// These exercise the pool's `buckets.nr` duplicate of the V3 primitives.

#[test]
unconstrained fn pool_b1_compute_deposit_in_range_basic() {
    let m = compute_deposit_in_range(
        1_000_000_000 as u128, 1_000_000_000 as u128,
        TEST_SQRT_P, TEST_SQRT_LOWER, TEST_SQRT_UPPER,
    );
    assert(m.l_used > 0 as u128, "in_range mints positive L");
    assert(m.used_a <= 1_000_000_000 as u128, "used_a never exceeds x_a");
    assert(m.used_b <= 1_000_000_000 as u128, "used_b never exceeds x_b");
}

#[test]
unconstrained fn pool_b3_compute_deposit_below_range() {
    let m = compute_deposit_below_range(1_000_000_000 as u128, TEST_SQRT_LOWER, TEST_SQRT_UPPER);
    assert(m.used_a == 1_000_000_000 as u128, "all A consumed below range");
    assert(m.used_b == 0 as u128, "no B consumed below range");
    assert(m.l_used > 0 as u128, "L minted");
}

#[test]
unconstrained fn pool_b4_compute_deposit_above_range() {
    let m = compute_deposit_above_range(1_000_000_000 as u128, TEST_SQRT_LOWER, TEST_SQRT_UPPER);
    assert(m.used_a == 0 as u128, "no A consumed above range");
    assert(m.used_b == 1_000_000_000 as u128, "all B consumed above range");
    assert(m.l_used > 0 as u128, "L minted");
}

#[test]
unconstrained fn position_note_serialization_round_trip() {
    let note = PositionNote {
        bucket_id: 5,
        lp_share: 1_000_000,
        cum_fee_a_per_share_at_deposit: 7,
        cum_fee_b_per_share_at_deposit: 9,
        nonce: 0x1234567890abcdef,
        owner: AztecAddress::from_field(0xdeadbeef),
    };
    let bytes = note.serialize();
    let back = PositionNote::deserialize(bytes);
    assert(back.bucket_id == note.bucket_id, "bucket_id mismatch");
    assert(back.lp_share == note.lp_share, "lp_share mismatch");
    assert(back.nonce == note.nonce, "nonce mismatch");
}

#[test]
unconstrained fn constructor_initializes_pool_state() {
    let mut env = TestEnvironment::new();
    let deployer = env.create_light_account();
    let pool = deploy_pool(&mut env, deployer, deployer, deployer);

    let state: PoolState =
        env.execute_utility(LiquidityPool::at(pool).get_pool_state());
    assert(state.reserve_a == 0 as u128, "reserve_a starts at 0");
    assert(state.reserve_b == 0 as u128, "reserve_b starts at 0");
    assert(state.current_sqrt_price == TEST_P_MIN_SQRT, "sqrt_p starts at p_min_sqrt");
}

#[test]
unconstrained fn integer_sqrt_basic() {
    // Sub-1 integer_sqrt helper is still used by some paths; sanity check.
    assert(integer_sqrt(0 as u128) == 0 as u128, "sqrt(0)==0");
    assert(integer_sqrt(1 as u128) == 1 as u128, "sqrt(1)==1");
    assert(integer_sqrt(4 as u128) == 2 as u128, "sqrt(4)==2");
    assert(integer_sqrt(10 as u128) == 3 as u128, "floor(sqrt(10))==3");
}
