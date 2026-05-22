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

    // ============================ UNCONSTRAINED GETTERS ============================

    #[external("utility")]
    unconstrained fn get_bond_token() -> AztecAddress {
        self.storage.bond_token.read()
    }

    #[external("utility")]
    unconstrained fn get_bond_amount() -> u128 {
        self.storage.bond_amount.read()
    }

    /// Returns the highest-ever-allocated aggregator id (next_id - 1). May
    /// include holes where aggregators have unregistered; callers must skip
    /// zero-addressed slots when enumerating.
    #[external("utility")]
    unconstrained fn get_aggregator_count() -> u32 {
        let next = self.storage.next_id.read();
        if next == 0 { 0 } else { next - 1 }
    }

    /// True iff addr has a non-zero escrowed bond.
    #[external("utility")]
    unconstrained fn is_registered(addr: AztecAddress) -> bool {
        self.storage.bonded_amount_by_addr.at(addr).read() > 0 as u128
    }

    #[external("utility")]
    unconstrained fn get_bonded_amount(addr: AztecAddress) -> u128 {
        self.storage.bonded_amount_by_addr.at(addr).read()
    }

    #[external("utility")]
    unconstrained fn get_endpoint_hash(addr: AztecAddress) -> Field {
        self.storage.endpoint_hash_by_addr.at(addr).read()
    }

    /// Returns AztecAddress::from_field(0) when id is a hole (allocated but
    /// then unregistered).
    #[external("utility")]
    unconstrained fn get_aggregator_by_id(id: u32) -> AztecAddress {
        self.storage.registered_addrs.at(id).read()
    }

    pub mod test;
}
