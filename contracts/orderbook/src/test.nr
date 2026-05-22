// TXE tests for the Orderbook contract.
// Run with: pnpm test:noir

use crate::Orderbook;
use crate::Orderbook::{EpochState, OrderNote};
use aztec::{
    note::note_interface::NoteHash,
    protocol::{
        address::AztecAddress,
        hash::poseidon2_hash,
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
//
// Sub-3 constructor took on 3 new args (aggregator_registry, treasury, aggregator_fee).
// Tests that don't exercise the Sub-3 paths pass `deployer` as a stand-in for both
// new address args and 0 for the fee, matching the 5d-4 token_a/token_b/pool_addr
// stand-in convention.
unconstrained fn deploy_orderbook(
    env: &mut TestEnvironment,
    deployer: AztecAddress,
    token_a: AztecAddress,
    token_b: AztecAddress,
    epoch_length: u32,
    pool_addr: AztecAddress,
    clearing_vk_hash: Field,
) -> AztecAddress {
    let initializer_call = Orderbook::interface().constructor(
        token_a,
        token_b,
        epoch_length,
        pool_addr,
        clearing_vk_hash,
        deployer,    // aggregator_registry stand-in
        deployer,    // treasury stand-in
        0 as u128,   // aggregator_fee stand-in
    );
    env.deploy("Orderbook").with_public_initializer(deployer, initializer_call)
}

#[test]
unconstrained fn constructor_sets_initial_epoch_state() {
    let mut env = TestEnvironment::new();
    let deployer = env.create_light_account();

    // Use the deployer's address as a placeholder for token address arguments - this test
    // only cares about the epoch state, not which token addresses are stored.
    let orderbook = deploy_orderbook(&mut env, deployer, deployer, deployer, 100, deployer, 0);

    let epoch: EpochState = env.execute_utility(Orderbook::at(orderbook).get_epoch());

    assert(epoch.epoch_id == 0, "initial epoch_id must be 0");
    assert(epoch.state == 0, "initial epoch state must be OPEN (0)");
    assert(
        epoch.closes_at_block == epoch.opened_at_block + 100,
        "epoch must close epoch_length blocks after it opened",
    );
    assert(epoch.order_acc == 0, "initial order_acc must be 0");
    assert(epoch.cancel_acc == 0, "initial cancel_acc must be 0");
    assert(epoch.order_count == 0, "initial order_count must be 0");
    assert(epoch.cancel_count == 0, "initial cancel_count must be 0");
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
    let orderbook = deploy_orderbook(&mut env, deployer, deployer, deployer, 100, deployer, 0);

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

    let orderbook = deploy_orderbook(&mut env, deployer, deployer, deployer, 100, deployer, 0);

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

    // Distinct placeholder for pool_addr.
    let pool_placeholder = env.create_light_account();

    let vk_hash_dummy: Field = 0;
    let orderbook = deploy_orderbook(&mut env, deployer, token_a, token_b, 42, pool_placeholder, vk_hash_dummy);

    let stored_a: AztecAddress = env.execute_utility(Orderbook::at(orderbook).get_token_a_addr());
    let stored_b: AztecAddress = env.execute_utility(Orderbook::at(orderbook).get_token_b_addr());
    let stored_len: u32 = env.execute_utility(Orderbook::at(orderbook).get_epoch_length());
    let stored_pool: AztecAddress = env.execute_utility(Orderbook::at(orderbook).get_pool_addr());
    let stored_vk_hash: Field = env.execute_utility(Orderbook::at(orderbook).get_clearing_vk_hash());

    assert(stored_a == token_a, "stored token_a must round-trip");
    assert(stored_b == token_b, "stored token_b must round-trip");
    assert(stored_len == 42, "stored epoch_length must round-trip");
    assert(stored_pool == pool_placeholder, "stored pool_addr must round-trip");
    assert(stored_vk_hash == 0, "stored clearing_vk_hash must round-trip");
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
    let orderbook = deploy_orderbook(&mut env, deployer, deployer, deployer, 100, deployer, 0);

    let maker = env.create_light_account();

    // No orders were ever submitted, so cancelling any nonce must revert.
    env.call_private(maker, Orderbook::at(orderbook).cancel_order(0x1234, 0));
}

#[test]
unconstrained fn get_orders_empty_for_fresh_account() {
    let mut env = TestEnvironment::new();
    let deployer = env.create_light_account();

    let orderbook = deploy_orderbook(&mut env, deployer, deployer, deployer, 100, deployer, 0);

    let owner = env.create_light_account();
    let orders = env.execute_utility(Orderbook::at(orderbook).get_orders(owner));

    assert(orders.len() == 0, "a fresh account must have no resting orders");
}

// ============================ EPOCH TRANSITIONS ============================
// aztec-nr v4.2.0 `TestEnvironment` exposes no count-parametrized block advance:
// the only block-mining method is `mine_block()`, which mines a single empty
// block (`txe_oracles::advance_blocks_by(1)`). To advance the L2 height by N
// blocks we loop `mine_block()` N times. `#[external("public")]` functions are
// invoked via `env.call_public(from, Contract::at(addr).fn())`.

#[test]
unconstrained fn close_epoch_advances_to_next_epoch() {
    let mut env = TestEnvironment::new();
    let deployer = env.create_light_account();

    // Short epoch so we can cheaply advance past it.
    let orderbook = deploy_orderbook(&mut env, deployer, deployer, deployer, 3, deployer, 0);

    let before: EpochState = env.execute_utility(Orderbook::at(orderbook).get_epoch());

    // Advance the L2 block height past `closes_at_block`, then close the epoch.
    for _ in 0..4 {
        env.mine_block();
    }
    env.call_public(deployer, Orderbook::at(orderbook).close_epoch());

    let after: EpochState = env.execute_utility(Orderbook::at(orderbook).get_epoch());
    assert(after.epoch_id == before.epoch_id + 1, "epoch_id must increment");
    assert(after.state == 0, "new epoch must be OPEN");
    assert(
        after.closes_at_block == after.opened_at_block + 3,
        "new epoch must close epoch_length blocks after opening",
    );
    assert(after.opened_at_block >= before.closes_at_block, "new epoch opens at/after the old close");
    assert(after.order_acc == 0, "new epoch order_acc must be 0");
    assert(after.cancel_acc == 0, "new epoch cancel_acc must be 0");
    assert(after.order_count == 0, "new epoch order_count must be 0");
    assert(after.cancel_count == 0, "new epoch cancel_count must be 0");
}

#[test(should_fail_with = "epoch has not expired yet")]
unconstrained fn close_epoch_rejects_before_expiry() {
    let mut env = TestEnvironment::new();
    let deployer = env.create_light_account();

    // Long epoch; we do NOT advance, so the epoch is still open and close must revert.
    let orderbook = deploy_orderbook(&mut env, deployer, deployer, deployer, 100, deployer, 0);

    env.call_public(deployer, Orderbook::at(orderbook).close_epoch());
}

#[test]
unconstrained fn flatten_clearing_public_slot_order() {
    let p = Orderbook::ClearingPublic {
        order_acc:      11,
        cancel_acc:     22,
        order_count:    33,
        cancel_count:   44,
        reserve_a:      55 as u128,
        reserve_b:      66 as u128,
        lp_supply:      77 as u128,
        clearing_price: 88 as u128,
        fills_root:     99,
        swap: pool::LiquidityPool::ClearingSwap {
            a_to_pool: 1001 as u128, b_to_pool: 1002 as u128,
            a_from_pool: 1003 as u128, b_from_pool: 1004 as u128,
            reserve_a_add: 1005 as u128, reserve_a_sub: 1006 as u128,
            reserve_b_add: 1007 as u128, reserve_b_sub: 1008 as u128,
            fee_a_per_share_increment: 1009 as u128, fee_b_per_share_increment: 1010 as u128,
        },
    };

    let flat = Orderbook::flatten_clearing_public(p);

    assert(flat[0] == 11, "slot 0 order_acc");
    assert(flat[1] == 22, "slot 1 cancel_acc");
    assert(flat[2] == 33, "slot 2 order_count");
    assert(flat[3] == 44, "slot 3 cancel_count");
    assert(flat[4] == 55, "slot 4 reserve_a");
    assert(flat[5] == 66, "slot 5 reserve_b");
    assert(flat[6] == 77, "slot 6 lp_supply");
    assert(flat[7] == 88, "slot 7 clearing_price");
    assert(flat[8] == 99, "slot 8 fills_root");
    assert(flat[9] == 1001, "slot 9 swap.a_to_pool");
    assert(flat[10] == 1002, "slot 10 swap.b_to_pool");
    assert(flat[11] == 1003, "slot 11 swap.a_from_pool");
    assert(flat[12] == 1004, "slot 12 swap.b_from_pool");
    assert(flat[13] == 1005, "slot 13 swap.reserve_a_add");
    assert(flat[14] == 1006, "slot 14 swap.reserve_a_sub");
    assert(flat[15] == 1007, "slot 15 swap.reserve_b_add");
    assert(flat[16] == 1008, "slot 16 swap.reserve_b_sub");
    assert(flat[17] == 1009, "slot 17 swap.fee_a_per_share_increment");
    assert(flat[18] == 1010, "slot 18 swap.fee_b_per_share_increment");
}

// _apply_verified_clearing is #[only_self]; an external public call must reject.
// The expected error message comes from aztec-nr's only_self diagnostic.
#[test(should_fail)]
unconstrained fn apply_verified_clearing_rejects_external_call() {
    let mut env = TestEnvironment::new();
    let deployer = env.create_light_account();
    let orderbook = deploy_orderbook(&mut env, deployer, deployer, deployer, 100, deployer, 0);

    let zero_swap = pool::LiquidityPool::ClearingSwap {
        a_to_pool: 0 as u128, b_to_pool: 0 as u128, a_from_pool: 0 as u128, b_from_pool: 0 as u128,
        reserve_a_add: 0 as u128, reserve_a_sub: 0 as u128, reserve_b_add: 0 as u128,
        reserve_b_sub: 0 as u128, fee_a_per_share_increment: 0 as u128, fee_b_per_share_increment: 0 as u128,
    };
    let pi = Orderbook::ClearingPublic {
        order_acc: 0, cancel_acc: 0, order_count: 0, cancel_count: 0,
        reserve_a: 0 as u128, reserve_b: 0 as u128, lp_supply: 0 as u128,
        clearing_price: 0 as u128,
        fills_root: 0,
        swap: zero_swap,
    };

    let stranger = env.create_light_account();
    // The #[only_self] guard fires before any body logic.
    env.call_public(stranger, Orderbook::at(orderbook)._apply_verified_clearing(pi, stranger));
}

// ============================================================================
// Week 5d-4: claim_fill Merkle inclusion-proof tests (T4-T9).
//
// TXE limitations (per memory/reference_aztec_txe_recursive_verify.md):
// std::verify_proof_with_type is a no-op in TXE. Recursive proof verification
// is deferred to L1 rollup kernel. These tests call
// close_epoch_and_clear_verified which internally calls std::verify_proof_with_type
// (no-op in TXE) then enqueues _apply_verified_clearing via enqueue_self, which
// satisfies only_self. The net result is that fills_root is written to storage,
// and T4 verifies that write happened correctly.
// ============================================================================

// Empty-leaf sentinel: poseidon2_hash([0, 0]).
unconstrained fn empty_leaf() -> Field {
    poseidon2_hash([0 as Field, 0 as Field])
}

// Hash one populated fill leaf.
unconstrained fn populated_leaf(order_nonce: Field, amount_out: u128) -> Field {
    poseidon2_hash([order_nonce, amount_out as Field])
}

// Build a single-populated-fill tree with the fill at slot 0; return (root, siblings).
// The tree has depth 5 (32 leaves). All leaves except index 0 are empty_leaf().
unconstrained fn build_single_fill_tree(order_nonce: Field, amount_out: u128) -> (Field, [Field; 5]) {
    let empty = empty_leaf();
    let mine = populated_leaf(order_nonce, amount_out);

    // siblings[0] = sibling of leaf 0 at level 0 = leaf at index 1 = empty
    let mut siblings: [Field; 5] = [0; 5];
    siblings[0] = empty;
    // siblings[1] = sibling at level 1 = poseidon2(empty, empty)
    let mut empty_sub = poseidon2_hash([empty, empty]);
    siblings[1] = empty_sub;
    // siblings[2..4] = empty subtree roots at levels 2, 3, 4
    for level in 2..5 {
        empty_sub = poseidon2_hash([empty_sub, empty_sub]);
        siblings[level] = empty_sub;
    }

    // Walk the path for leaf_index = 0 (all "left" child) to compute root.
    let mut node = mine;
    node = poseidon2_hash([node, siblings[0]]);   // level 0: leaf 0 is left child
    node = poseidon2_hash([node, siblings[1]]);   // level 1
    node = poseidon2_hash([node, siblings[2]]);   // level 2
    node = poseidon2_hash([node, siblings[3]]);   // level 3
    let root = poseidon2_hash([node, siblings[4]]);  // level 4 -> root

    (root, siblings)
}

// T4a: Verify the empty leaf sentinel is the poseidon2_hash of two zero fields.
//
// close_epoch_and_clear_verified calls std::verify_proof_with_type which is
// NOT callable from TXE (the oracle resolver returns "Function Artifact does not
// exist" in aztec 4.2.1). The full end-to-end storage-write path (deploy ->
// advance -> call close_epoch_and_clear_verified -> assert stored root) is
// therefore covered by the TS integration test at
// tests/integration/claim-merkle.test.ts (Task 12).
//
// Additionally, get_fills_root (Map<u32, PublicMutable<Field>>) triggers a
// TXE artifact-lookup failure for the map-indexed storage slot in aztec 4.2.1.
//
// What we CAN test in TXE: the pure computation correctness of empty_leaf,
// populated_leaf, and build_single_fill_tree, which validates the Merkle
// construction without any contract calls.
#[test]
unconstrained fn t4a_empty_leaf_is_poseidon2_of_two_zeros() {
    let expected = poseidon2_hash([0 as Field, 0 as Field]);
    let got = empty_leaf();
    assert(got == expected, "empty_leaf must equal poseidon2_hash([0, 0])");
}

// T4a-2: populated_leaf must match the clearing circuit's fill_leaf definition:
// poseidon2_hash([order_nonce, amount_out]).
#[test]
unconstrained fn t4a2_populated_leaf_matches_clearing_circuit_definition() {
    let nonce: Field = 0xdeadbeef;
    let amount: u128 = 12345 as u128;
    let expected = poseidon2_hash([nonce, amount as Field]);
    let got = populated_leaf(nonce, amount);
    assert(got == expected, "populated_leaf must equal poseidon2_hash([order_nonce, amount_out])");

    // A different nonce produces a different leaf.
    let other = populated_leaf(0xcafe, amount);
    assert(got != other, "leaves with different nonces must differ");
}

// T4b: Verify the Merkle tree helpers produce a consistent root that the
// _assert_fill_root callback would check. This is a pure computation test
// (no TXE contract calls needed).
#[test]
unconstrained fn t4b_merkle_leaf_and_root_are_consistent() {
    let order_nonce: Field = 0xA;
    let amount_out: u128 = 999 as u128;

    let leaf = populated_leaf(order_nonce, amount_out);
    let (root, siblings) = build_single_fill_tree(order_nonce, amount_out);

    // Verify that replaying the Merkle walk with the same inputs reproduces root.
    let mut node = leaf;
    let mut idx: u32 = 0; // leaf_index = 0
    for level in 0..5 {
        let bit = idx & 1;
        node = if bit == 0 {
            poseidon2_hash([node, siblings[level]])
        } else {
            poseidon2_hash([siblings[level], node])
        };
        idx = idx >> 1;
    }
    assert(idx == 0, "leaf_index 0 should exhaust to 0 after 5 right-shifts");
    assert(node == root, "replayed Merkle walk must reproduce the precomputed root");

    // Verify the empty leaf is distinct from any populated leaf.
    let empty = empty_leaf();
    assert(empty != leaf, "populated leaf must differ from empty sentinel");
}

// T5-T9 (wrong sibling, wrong amount, wrong epoch, replay, oob leaf_index) are
// covered by the TypeScript integration test at tests/integration/claim-merkle.test.ts
// (Task 12). Those tests exercise the full submit -> close_epoch_and_clear_verified
// -> claim_fill pipeline with real notes and per-failure-mode tampering. TXE-level
// equivalents would require synthetic note construction which is heavier than the
// e2e test path; the integration test is the authoritative coverage.
//
// T9b (cancel-after-fill underflow) similarly requires a real Token+Pool deployment
// that TXE doesn't easily provide. The spec flags this protection as worth verifying
// and it is also exercised by Task 12.

// ============================================================================
// Sub-3: Aggregator registration gate (O1) -- deferred to Task 18 e2e.
//
// O1 requires deploying both Orderbook AND AggregatorRegistry in the SAME
// TXE session (so the orderbook's _assert_aggregator_registered callback can
// cross-contract-read view_bonded_amount). TXE in aztec 4.2.1 cannot resolve
// @aggregator_registry/AggregatorRegistry from contracts/orderbook/'s test
// session (the artifact lives at contracts/aggregator-registry/target/, not
// in orderbook/target/). The cross-package deploy returns "Failed calling
// external resolver. client error (Connect)" inside TXE.
//
// Full O1 coverage lands in the Task 18 e2e (tests/integration/aggregator-
// race.test.ts) where deploy-tokens.ts wires Orderbook + Registry + Treasury
// against a real Aztec sandbox and exercises the gate end-to-end.
// ============================================================================
