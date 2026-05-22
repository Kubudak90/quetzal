use aztec::macros::aztec;

#[aztec]
pub contract AggregatorRegistry {
    use aztec::{
        macros::{
            functions::{external, initializer},
            storage::storage,
        },
        protocol::address::AztecAddress,
        state_vars::{Map, PublicImmutable, PublicMutable},
    };

    #[storage]
    struct Storage<Context> {
        bond_token: PublicImmutable<AztecAddress, Context>,
        bond_amount: PublicImmutable<u128, Context>,
        next_id: PublicMutable<u32, Context>,
        aggregator_id_by_addr: Map<AztecAddress, PublicMutable<u32, Context>, Context>,
        bonded_amount_by_addr: Map<AztecAddress, PublicMutable<u128, Context>, Context>,
        endpoint_hash_by_addr: Map<AztecAddress, PublicMutable<Field, Context>, Context>,
        registered_addrs: Map<u32, PublicMutable<AztecAddress, Context>, Context>,
    }

    #[external("public")]
    #[initializer]
    fn constructor(bond_token: AztecAddress, bond_amount: u128) {
        self.storage.bond_token.initialize(bond_token);
        self.storage.bond_amount.initialize(bond_amount);
        self.storage.next_id.write(1);
    }

    pub mod test;
}
