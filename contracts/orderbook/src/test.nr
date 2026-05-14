// TXE tests for the Orderbook contract.
// Run with: pnpm test:noir

use crate::Orderbook;
use crate::Orderbook::{EpochState, OrderNote, EPOCH_LENGTH};
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

// Helper: deploy a fresh Orderbook with the given three contract-address args, returning the
// deployed address. The same `deployer` light account is used to push the public initializer.
unconstrained fn deploy_orderbook(
    env: &mut TestEnvironment,
    deployer: AztecAddress,
    token_a: AztecAddress,
    token_b: AztecAddress,
    clearing: AztecAddress,
) -> AztecAddress {
    let initializer_call = Orderbook::interface().constructor(token_a, token_b, clearing);
    env.deploy("Orderbook").with_public_initializer(deployer, initializer_call)
}

#[test]
unconstrained fn constructor_sets_initial_epoch_state() {
    let mut env = TestEnvironment::new();
    let deployer = env.create_light_account();

    // Use the deployer's address as a placeholder for all three address arguments - this test
    // only cares about the epoch state, not which token addresses are stored.
    let orderbook = deploy_orderbook(&mut env, deployer, deployer, deployer, deployer);

    let epoch: EpochState = env.execute_utility(Orderbook::at(orderbook).get_epoch());

    assert(epoch.epoch_id == 0, "initial epoch_id must be 0");
    assert(epoch.state == 0, "initial epoch state must be OPEN (0)");
    assert(
        epoch.closes_at_block == epoch.opened_at_block + EPOCH_LENGTH,
        "epoch must close EPOCH_LENGTH blocks after it opened",
    );
}

#[test]
unconstrained fn constructor_records_contract_addresses() {
    let mut env = TestEnvironment::new();
    let deployer = env.create_light_account();

    // Three distinct placeholder addresses derived from light accounts so the test catches any
    // accidental argument swap inside the constructor.
    let token_a = env.create_light_account();
    let token_b = env.create_light_account();
    let clearing = env.create_light_account();

    // Sanity precondition: ensure they are genuinely distinct before we go further.
    assert(token_a != token_b, "token_a and token_b must be distinct");
    assert(token_a != clearing, "token_a and clearing must be distinct");
    assert(token_b != clearing, "token_b and clearing must be distinct");

    let orderbook = deploy_orderbook(&mut env, deployer, token_a, token_b, clearing);

    let stored_a: AztecAddress = env.execute_utility(Orderbook::at(orderbook).get_token_a_addr());
    let stored_b: AztecAddress = env.execute_utility(Orderbook::at(orderbook).get_token_b_addr());
    let stored_clearing: AztecAddress =
        env.execute_utility(Orderbook::at(orderbook).get_clearing_addr());

    assert(stored_a == token_a, "stored token_a must round-trip");
    assert(stored_b == token_b, "stored token_b must round-trip");
    assert(stored_clearing == clearing, "stored clearing must round-trip");
}
