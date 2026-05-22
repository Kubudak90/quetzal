// TXE tests for Treasury.
// Run with: pnpm test:noir
//
// TXE limitation: env.deploy("@token/Token") resolves to the CURRENT crate's
// target/ folder, so Treasury TXE tests cannot deploy a real Token. We test
// only the assertion paths that fire BEFORE any Token call (only_orderbook,
// only_deployer, pay_aggregator zero-amount no-op). Full happy-path coverage
// (T1 full pay, T2 silent partial with real Token, T4 deposit) is deferred to
// the Task 18 e2e where deploy-tokens.ts wires real Token + Treasury together.

use crate::Treasury;
use aztec::{
    protocol::{address::AztecAddress, traits::FromField},
    test::helpers::test_environment::TestEnvironment,
};

// Deploy Treasury with sentinel addresses for bond_token, orderbook_addr.
unconstrained fn deploy_treasury(
    env: &mut TestEnvironment,
    deployer: AztecAddress,
    orderbook_addr: AztecAddress,
) -> AztecAddress {
    let token_sentinel = AztecAddress::from_field(0xCA1);
    let treasury_init = Treasury::interface().constructor(token_sentinel, orderbook_addr, deployer);
    env.deploy("Treasury").with_public_initializer(deployer, treasury_init)
}

#[test]
unconstrained fn constructor_sets_immutables_and_zero_balance() {
    let mut env = TestEnvironment::new();
    let deployer = env.create_light_account();
    let orderbook = env.create_light_account();

    let treasury = deploy_treasury(&mut env, deployer, orderbook);

    let stored_orderbook: AztecAddress =
        env.execute_utility(Treasury::at(treasury).get_orderbook_addr());
    assert(stored_orderbook == orderbook, "orderbook_addr mismatch");

    let tracked: u128 =
        env.execute_utility(Treasury::at(treasury).get_tracked_balance());
    assert(tracked == 0 as u128, "fresh treasury must report tracked_balance=0");
}

#[test(should_fail_with = "only orderbook")]
unconstrained fn t3_pay_aggregator_rejects_non_orderbook_caller() {
    let mut env = TestEnvironment::new();
    let deployer = env.create_light_account();
    let orderbook = env.create_light_account();
    let stranger = env.create_light_account();
    let winner = env.create_light_account();

    let treasury = deploy_treasury(&mut env, deployer, orderbook);

    env.call_public(stranger, Treasury::at(treasury).pay_aggregator(winner, 500_000));
}

#[test]
unconstrained fn t1b_pay_aggregator_zero_amount_is_noop() {
    // Edge case: if aggregator_fee is configured as 0, pay_aggregator must
    // succeed without making any Token call (the inner `if pay > 0` guard
    // skips the Token cross-contract call entirely). Token is not deployed
    // in this TXE test; the path under test never touches it.
    let mut env = TestEnvironment::new();
    let deployer = env.create_light_account();
    let orderbook = env.create_light_account();
    let winner = env.create_light_account();

    let treasury = deploy_treasury(&mut env, deployer, orderbook);

    env.call_public(orderbook, Treasury::at(treasury).pay_aggregator(winner, 0 as u128));

    let tracked_after: u128 =
        env.execute_utility(Treasury::at(treasury).get_tracked_balance());
    assert(tracked_after == 0, "tracked_balance unchanged on zero pay");
}

#[test(should_fail_with = "only deployer")]
unconstrained fn t4_seed_public_rejects_non_deployer() {
    let mut env = TestEnvironment::new();
    let deployer = env.create_light_account();
    let orderbook = env.create_light_account();
    let stranger = env.create_light_account();

    let treasury = deploy_treasury(&mut env, deployer, orderbook);

    env.call_public(stranger, Treasury::at(treasury).seed_public(100));
}

#[test]
unconstrained fn seed_public_increments_tracked_balance_for_deployer() {
    let mut env = TestEnvironment::new();
    let deployer = env.create_light_account();
    let orderbook = env.create_light_account();

    let treasury = deploy_treasury(&mut env, deployer, orderbook);

    env.call_public(deployer, Treasury::at(treasury).seed_public(123_456));
    let tracked: u128 =
        env.execute_utility(Treasury::at(treasury).get_tracked_balance());
    assert(tracked == 123_456, "seed_public must increment tracked_balance");

    // Second seed adds.
    env.call_public(deployer, Treasury::at(treasury).seed_public(1_000));
    let tracked2: u128 =
        env.execute_utility(Treasury::at(treasury).get_tracked_balance());
    assert(tracked2 == 124_456, "tracked_balance accumulates across seeds");
}
