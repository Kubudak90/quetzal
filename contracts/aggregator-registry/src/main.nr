use aztec::macros::aztec;

#[aztec]
pub contract AggregatorRegistry {
    use aztec::{
        macros::{
            functions::{external, initializer, only_self},
            storage::storage,
        },
        protocol::address::AztecAddress,
        state_vars::{Map, PublicImmutable, PublicMutable},
    };

    use token::Token;

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

    // ============================ REGISTRATION ============================

    /// Register the caller as a bonded aggregator. Escrows `bond_amount` of
    /// the `bond_token` into the registry's public balance. Writes the four
    /// maps via an enqueued public callback. Reverts (in the callback) if
    /// the caller is already registered.
    ///
    /// # Arguments
    /// - `endpoint_url_hash`: poseidon2 hash of the operator's HTTPS reveal endpoint URL.
    /// - `nonce`: authwit nonce for the inner Token.transfer_private_to_public call.
    #[external("private")]
    fn register(endpoint_url_hash: Field, nonce: Field) {
        let caller = self.msg_sender();
        let bond_token = self.storage.bond_token.read();
        let bond_amount = self.storage.bond_amount.read();

        self.call(Token::at(bond_token).transfer_private_to_public(
            caller,
            self.address,
            bond_amount,
            nonce,
        ));

        self.enqueue_self._register_public(caller, endpoint_url_hash);
    }

    /// Public callback: allocate a new id and write the four maps. only_self.
    /// Reverts if caller is already registered.
    #[external("public")]
    #[only_self]
    fn _register_public(caller: AztecAddress, endpoint_url_hash: Field) {
        let existing = self.storage.aggregator_id_by_addr.at(caller).read();
        assert(existing == 0, "already registered");

        let id = self.storage.next_id.read();
        let bond_amount = self.storage.bond_amount.read();
        self.storage.aggregator_id_by_addr.at(caller).write(id);
        self.storage.bonded_amount_by_addr.at(caller).write(bond_amount);
        self.storage.endpoint_hash_by_addr.at(caller).write(endpoint_url_hash);
        self.storage.registered_addrs.at(id).write(caller);
        self.storage.next_id.write(id + 1);
    }

    /// Update only the endpoint hash for the calling aggregator. Bond is untouched.
    /// Reverts if caller is not currently registered.
    #[external("public")]
    fn update_endpoint(new_endpoint_url_hash: Field) {
        let caller = self.msg_sender();
        let bonded = self.storage.bonded_amount_by_addr.at(caller).read();
        assert(bonded > 0 as u128, "not registered");
        self.storage.endpoint_hash_by_addr.at(caller).write(new_endpoint_url_hash);
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
