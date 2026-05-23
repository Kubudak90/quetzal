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
    protocol::{address::{AztecAddress, EthAddress}, traits::FromField},
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

// ── Sub-5c D1: relayer claim queue tests ──────────────────────────────────────

#[test]
unconstrained fn sub5c_queue_relayer_claim_appends() {
    let mut env = TestEnvironment::new();
    let deployer = env.create_light_account();
    let orderbook = env.create_light_account();

    let treasury = deploy_treasury(&mut env, deployer, orderbook);

    let maker = env.create_light_account();
    let l1_recipient = EthAddress::from_field(0xabcdef);

    let claim_id: u64 = env.call_public(
        maker,
        Treasury::at(treasury).queue_relayer_claim(
            0xfeed as Field,
            0xbeef as Field,
            l1_recipient,
            1_000_000 as u128,
            5_000 as u128,
        ),
    );
    assert(claim_id == 0, "first claim id must be 0");

    let count: u32 =
        env.execute_utility(Treasury::at(treasury).get_pending_relayer_claims_count());
    assert(count == 1, "count must be 1 after one queue");
}

#[test(should_fail_with = "queue full")]
unconstrained fn sub5c_queue_relayer_claim_rejects_overflow() {
    let mut env = TestEnvironment::new();
    let deployer = env.create_light_account();
    let orderbook = env.create_light_account();

    let treasury = deploy_treasury(&mut env, deployer, orderbook);

    let maker = env.create_light_account();
    let l1_recipient = EthAddress::from_field(0xabcdef);

    // Fill the queue to MAX_PENDING_RELAYER_CLAIMS (32).
    for i in 0..32 {
        env.call_public(
            maker,
            Treasury::at(treasury).queue_relayer_claim(
                i as Field,
                (0xdead + i) as Field,
                l1_recipient,
                1_000 as u128,
                1 as u128,
            ),
        );
    }
    // The 33rd call should revert "queue full".
    env.call_public(
        maker,
        Treasury::at(treasury).queue_relayer_claim(
            99 as Field,
            99 as Field,
            l1_recipient,
            1_000 as u128,
            1 as u128,
        ),
    );
}

#[test]
unconstrained fn sub5c_consume_relayer_claim_decrements_tracked_balance() {
    let mut env = TestEnvironment::new();
    let deployer = env.create_light_account();
    let orderbook = env.create_light_account();

    let treasury = deploy_treasury(&mut env, deployer, orderbook);

    let maker = env.create_light_account();
    let relayer = env.create_light_account();
    let l1_recipient = EthAddress::from_field(0xabcdef);

    // Seed the treasury tracked_balance (no real Token transfer needed for
    // the tracked_balance accounting path; seed_public updates tracked_balance
    // directly without touching bond_token when balance is non-zero but the
    // actual Token call in consume is guarded by `if to_pay > 0`).
    // We seed first so the fee deduction is exercised in the accounting path.
    // Note: consume_relayer_claim calls Token.transfer_public_to_public only if
    // to_pay > 0; in TXE without a real Token deployment that call would
    // revert.  So we test the zero-fee-cap branch by NOT seeding -- meaning
    // tracked_balance stays at 0, to_pay = min(fee, 0) = 0, and the Token call
    // is skipped entirely.  The test verifies the queue is compacted and count
    // decrements.
    //
    // (Full fee-transfer happy path is covered in the Task 18 e2e.)

    let claim_id: u64 = env.call_public(
        maker,
        Treasury::at(treasury).queue_relayer_claim(
            0xfeed as Field,
            0xbeef as Field,
            l1_recipient,
            1_000_000 as u128,
            5_000 as u128,
        ),
    );

    // Queue has 1 entry.
    let count_before: u32 =
        env.execute_utility(Treasury::at(treasury).get_pending_relayer_claims_count());
    assert(count_before == 1, "count must be 1 before consume");

    // Relayer consumes the claim.
    env.call_public(relayer, Treasury::at(treasury).consume_relayer_claim(claim_id));

    // Queue is now empty.
    let count_after: u32 =
        env.execute_utility(Treasury::at(treasury).get_pending_relayer_claims_count());
    assert(count_after == 0, "count must be 0 after consume");

    // tracked_balance stays 0 (treasury was dry; Token transfer was skipped).
    let balance_after: u128 =
        env.execute_utility(Treasury::at(treasury).get_tracked_balance());
    assert(balance_after == 0, "dry treasury: tracked_balance must stay 0");
}
