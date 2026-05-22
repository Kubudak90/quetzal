// TXE tests for AggregatorRegistry.
// Run with: pnpm test:noir

use crate::AggregatorRegistry;
use aztec::{
    protocol::{address::AztecAddress, traits::FromField},
    test::helpers::test_environment::TestEnvironment,
};

unconstrained fn deploy_registry(
    env: &mut TestEnvironment,
    deployer: AztecAddress,
    bond_token: AztecAddress,
    bond_amount: u128,
) -> AztecAddress {
    let init = AggregatorRegistry::interface().constructor(bond_token, bond_amount);
    env.deploy("AggregatorRegistry").with_public_initializer(deployer, init)
}

#[test]
unconstrained fn constructor_writes_immutables_and_initial_next_id() {
    let mut env = TestEnvironment::new();
    let deployer = env.create_light_account();
    let token = AztecAddress::from_field(0xCA1);
    let bond: u128 = 1_000_000_000;

    let registry = deploy_registry(&mut env, deployer, token, bond);

    let stored_token: AztecAddress =
        env.execute_utility(AggregatorRegistry::at(registry).get_bond_token());
    assert(stored_token == token, "bond_token mismatch");

    let stored_amount: u128 =
        env.execute_utility(AggregatorRegistry::at(registry).get_bond_amount());
    assert(stored_amount == bond, "bond_amount mismatch");

    // next_id starts at 1 (0 reserved sentinel); count returns next_id-1 = 0
    // when no aggregators are registered.
    let count: u32 =
        env.execute_utility(AggregatorRegistry::at(registry).get_aggregator_count());
    assert(count == 0, "fresh registry must report 0 aggregators");
}

#[test]
unconstrained fn r5_is_registered_false_for_unknown_addr() {
    let mut env = TestEnvironment::new();
    let deployer = env.create_light_account();
    let registry =
        deploy_registry(&mut env, deployer, AztecAddress::from_field(0xCA1), 1_000_000_000);

    let stranger = env.create_light_account();
    let registered: bool =
        env.execute_utility(AggregatorRegistry::at(registry).is_registered(stranger));
    assert(!registered, "stranger must not be registered");
}

// R1 (register happy-path) and R2 (double-register revert) cannot be exercised
// in TXE: both require minting tUSDC + wiring an authwit for the inner
// Token.transfer_private_to_public call inside register(). The orderbook
// contract's TXE tests follow the same convention (see contracts/orderbook/
// src/test.nr's submit_order tests, which only cover input-validation reverts
// that fire BEFORE any cross-contract Token call). Full happy-path R1/R2
// coverage lands in the Task 18 e2e (tests/integration/aggregator-race.test.ts).
