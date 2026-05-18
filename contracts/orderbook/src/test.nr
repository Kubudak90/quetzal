// TXE tests for the Orderbook contract.
// Run with: pnpm test:noir

use crate::Orderbook;
use crate::Orderbook::{EpochState, OrderNote};
use aztec::{
    note::note_interface::NoteHash,
    protocol::{
        address::AztecAddress,
        traits::{Deserialize, FromField, Serialize},
    },
    test::helpers::test_environment::TestEnvironment,
};

#[test]
unconstrained fn order_note_serialization_round_trip() {
    let note = OrderNote {
        submitted_at_block: 42,
        side: false,
        amount_in: 1_000_000_000,
        limit_price: 2_000_000_000_000_000_000,
        nonce: 0x1234567890abcdef,
        owner: AztecAddress::from_field(0xdeadbeef),
    };

    let bytes = note.serialize();
    let back = OrderNote::deserialize(bytes);

    assert(back.submitted_at_block == note.submitted_at_block, "submitted_at_block mismatch");
    assert(back.side == note.side, "side mismatch");
    assert(back.amount_in == note.amount_in, "amount_in mismatch");
    assert(back.limit_price == note.limit_price, "limit_price mismatch");
    assert(back.nonce == note.nonce, "nonce mismatch");
    assert(back.owner == note.owner, "owner mismatch");
}

#[test]
unconstrained fn order_note_different_nonce_different_hash() {
    // Two notes identical in every field except `nonce`.
    let base = OrderNote {
        submitted_at_block: 100,
        side: true,
        amount_in: 50,
        limit_price: 1_000_000_000_000_000_000,
        nonce: 0x1,
        owner: AztecAddress::from_field(0xa),
    };
    let other = OrderNote {
        submitted_at_block: 100,
        side: true,
        amount_in: 50,
        limit_price: 1_000_000_000_000_000_000,
        nonce: 0x2,
        owner: AztecAddress::from_field(0xa),
    };

    // Two notes that differ only in `nonce` must produce distinct note hashes for the same
    // (owner, storage_slot, randomness). This proves the nonce participates in identity.
    let owner = base.owner;
    let storage_slot: Field = 1;
    let randomness: Field = 7;

    let base_hash = base.compute_note_hash(owner, storage_slot, randomness);
    let other_hash = other.compute_note_hash(owner, storage_slot, randomness);

    assert(base_hash != other_hash, "same nonce-only delta should yield different hashes");

    // Sanity check: serialization must also differ across the nonce-only delta.
    let base_bytes = base.serialize();
    let other_bytes = other.serialize();
    let mut any_diff = false;
    for i in 0..base_bytes.len() {
        if base_bytes[i] != other_bytes[i] {
            any_diff = true;
        }
    }
    assert(any_diff, "serialize() must differ when only nonce differs");
}

// Helper: deploy a fresh Orderbook with the given token addresses and epoch length,
// returning the deployed address. The `deployer` light account pushes the public
// initializer.
unconstrained fn deploy_orderbook(
    env: &mut TestEnvironment,
    deployer: AztecAddress,
    token_a: AztecAddress,
    token_b: AztecAddress,
    epoch_length: u32,
) -> AztecAddress {
    let initializer_call = Orderbook::interface().constructor(token_a, token_b, epoch_length);
    env.deploy("Orderbook").with_public_initializer(deployer, initializer_call)
}

#[test]
unconstrained fn constructor_sets_initial_epoch_state() {
    let mut env = TestEnvironment::new();
    let deployer = env.create_light_account();

    // Use the deployer's address as a placeholder for token address arguments - this test
    // only cares about the epoch state, not which token addresses are stored.
    let orderbook = deploy_orderbook(&mut env, deployer, deployer, deployer, 100);

    let epoch: EpochState = env.execute_utility(Orderbook::at(orderbook).get_epoch());

    assert(epoch.epoch_id == 0, "initial epoch_id must be 0");
    assert(epoch.state == 0, "initial epoch state must be OPEN (0)");
    assert(
        epoch.closes_at_block == epoch.opened_at_block + 100,
        "epoch must close epoch_length blocks after it opened",
    );
}

// Input-validation negative tests for submit_order. We deliberately do NOT exercise the
// happy path here: that would require deploying the Token contract from inside the orderbook's
// TXE test, seeding a private balance, and wiring authwits, which is integration-test territory
// (Task 8). The two tests below are valid because the input-validation asserts fire BEFORE any
// cross-contract call, so we never actually need a Token at the placeholder address.

#[test(should_fail_with = "amount_in must be positive")]
unconstrained fn submit_order_rejects_amount_zero() {
    let mut env = TestEnvironment::new();
    let deployer = env.create_light_account();

    // Placeholder token addresses are fine: the assertion on amount_in fires before any
    // token-contract call is attempted.
    let orderbook = deploy_orderbook(&mut env, deployer, deployer, deployer, 100);

    let maker = env.create_light_account();

    // side=false (bid token A), amount_in=0 must revert with "amount_in must be positive".
    env.call_private(
        maker,
        Orderbook::at(orderbook).submit_order(false, 0 as u128, 1 as u128, 0, 0),
    );
}

#[test(should_fail_with = "limit_price must be positive")]
unconstrained fn submit_order_rejects_limit_price_zero() {
    let mut env = TestEnvironment::new();
    let deployer = env.create_light_account();

    let orderbook = deploy_orderbook(&mut env, deployer, deployer, deployer, 100);

    let maker = env.create_light_account();

    // amount_in=100 passes the first assert; limit_price=0 must trigger the second.
    env.call_private(
        maker,
        Orderbook::at(orderbook).submit_order(false, 100 as u128, 0 as u128, 0, 0),
    );
}

#[test]
unconstrained fn constructor_records_token_addrs_and_epoch_length() {
    let mut env = TestEnvironment::new();
    let deployer = env.create_light_account();

    // Two distinct placeholder addresses so the test catches an accidental token-arg swap.
    let token_a = env.create_light_account();
    let token_b = env.create_light_account();
    assert(token_a != token_b, "token_a and token_b must be distinct");

    let orderbook = deploy_orderbook(&mut env, deployer, token_a, token_b, 42);

    let stored_a: AztecAddress = env.execute_utility(Orderbook::at(orderbook).get_token_a_addr());
    let stored_b: AztecAddress = env.execute_utility(Orderbook::at(orderbook).get_token_b_addr());
    let stored_len: u32 = env.execute_utility(Orderbook::at(orderbook).get_epoch_length());

    assert(stored_a == token_a, "stored token_a must round-trip");
    assert(stored_b == token_b, "stored token_b must round-trip");
    assert(stored_len == 42, "stored epoch_length must round-trip");
}

// ============================ CANCEL ORDER + GET ORDERS ============================
// Only paths that fail BEFORE the cross-contract Token call can run in pure TXE.
// cancelling when no order exists fires "order not found" during note retrieval,
// before any token-contract call is attempted. get_orders on a fresh account is
// a pure utility getter with no cross-contract calls at all.

#[test(should_fail_with = "order not found")]
unconstrained fn cancel_order_rejects_unknown_nonce() {
    let mut env = TestEnvironment::new();
    let deployer = env.create_light_account();

    // Placeholder addresses are fine: the "order not found" assertion fires during note
    // retrieval, before any token-contract call is attempted.
    let orderbook = deploy_orderbook(&mut env, deployer, deployer, deployer, 100);

    let maker = env.create_light_account();

    // No orders were ever submitted, so cancelling any nonce must revert.
    env.call_private(maker, Orderbook::at(orderbook).cancel_order(0x1234, 0));
}

#[test]
unconstrained fn get_orders_empty_for_fresh_account() {
    let mut env = TestEnvironment::new();
    let deployer = env.create_light_account();

    let orderbook = deploy_orderbook(&mut env, deployer, deployer, deployer, 100);

    let owner = env.create_light_account();
    let orders = env.execute_utility(Orderbook::at(orderbook).get_orders(owner));

    assert(orders.len() == 0, "a fresh account must have no resting orders");
}
