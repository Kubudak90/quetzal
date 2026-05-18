// TXE tests for the LiquidityPool contract.
// Run with: pnpm test:noir

use crate::LiquidityPool;
use crate::LiquidityPool::{PoolState, PositionNote};
use aztec::{
    protocol::{
        address::AztecAddress,
        traits::{Deserialize, FromField, Serialize},
    },
    test::helpers::test_environment::TestEnvironment,
};

// Helper: deploy a fresh LiquidityPool with the given token addresses, returning the
// deployed address. The `deployer` light account pushes the public initializer.
unconstrained fn deploy_pool(
    env: &mut TestEnvironment,
    deployer: AztecAddress,
    token_a: AztecAddress,
    token_b: AztecAddress,
) -> AztecAddress {
    let initializer_call = LiquidityPool::interface().constructor(token_a, token_b);
    env.deploy("LiquidityPool").with_public_initializer(deployer, initializer_call)
}

#[test]
unconstrained fn position_note_serialization_round_trip() {
    let note = PositionNote {
        lp_share: 1_000_000,
        cum_fee_a_per_share_at_deposit: 7,
        cum_fee_b_per_share_at_deposit: 9,
        nonce: 0x1234567890abcdef,
        owner: AztecAddress::from_field(0xdeadbeef),
    };

    let bytes = note.serialize();
    let back = PositionNote::deserialize(bytes);

    assert(back.lp_share == note.lp_share, "lp_share mismatch");
    assert(
        back.cum_fee_a_per_share_at_deposit == note.cum_fee_a_per_share_at_deposit,
        "cum_fee_a mismatch",
    );
    assert(
        back.cum_fee_b_per_share_at_deposit == note.cum_fee_b_per_share_at_deposit,
        "cum_fee_b mismatch",
    );
    assert(back.nonce == note.nonce, "nonce mismatch");
    assert(back.owner == note.owner, "owner mismatch");
}

#[test]
unconstrained fn constructor_initializes_empty_pool() {
    let mut env = TestEnvironment::new();
    let deployer = env.create_light_account();
    let token_a = env.create_light_account();
    let token_b = env.create_light_account();
    assert(token_a != token_b, "token_a and token_b must be distinct");

    let pool = deploy_pool(&mut env, deployer, token_a, token_b);

    let state: PoolState = env.execute_utility(LiquidityPool::at(pool).get_pool_state());
    assert(state.reserve_a == 0, "reserve_a must start 0");
    assert(state.reserve_b == 0, "reserve_b must start 0");
    assert(state.lp_supply == 0, "lp_supply must start 0");
    assert(state.cum_fee_a_per_share == 0, "cum_fee_a must start 0");
    assert(state.cum_fee_b_per_share == 0, "cum_fee_b must start 0");

    let stored_a: AztecAddress = env.execute_utility(LiquidityPool::at(pool).get_token_a_addr());
    let stored_b: AztecAddress = env.execute_utility(LiquidityPool::at(pool).get_token_b_addr());
    assert(stored_a == token_a, "stored token_a must round-trip");
    assert(stored_b == token_b, "stored token_b must round-trip");
}

#[test]
unconstrained fn get_positions_empty_for_fresh_account() {
    let mut env = TestEnvironment::new();
    let deployer = env.create_light_account();
    let pool = deploy_pool(&mut env, deployer, deployer, deployer);

    let owner = env.create_light_account();
    let positions = env.execute_utility(LiquidityPool::at(pool).get_positions(owner));
    assert(positions.len() == 0, "a fresh account must have no positions");
}
