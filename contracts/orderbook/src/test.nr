// TXE tests for the Orderbook contract.
// Run with: pnpm test:noir

use crate::Orderbook::OrderNote;
use aztec::{
    note::note_interface::NoteHash,
    protocol::{
        address::AztecAddress,
        traits::{Deserialize, FromField, Serialize},
    },
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
