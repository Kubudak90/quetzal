// Token -- generic reusable token contract.
// Brand (name, symbol, decimals) is passed as deploy-time constructor arguments.
// Compiled artifact: target/token-Token.json

pub mod test;

use aztec::macros::aztec;

#[aztec]
pub contract Token {
    // aztec library
    use aztec::{
        macros::{
            events::event,
            functions::{authorize_once, external, initializer, internal, only_self, view},
            storage::storage,
        },
        messages::message_delivery::MessageDelivery,
        protocol::{address::{AztecAddress, EthAddress}, traits::{FromField, ToField}},
        state_vars::{Map, Owned, PublicImmutable, PublicMutable, StateVariable},
    };
    // note library
    use uint_note::{PartialUintNote, UintNote};
    // compression library
    use compressed_string::FieldCompressedString;
    // private balance library
    use balance_set::BalanceSet;

    global INITIAL_TRANSFER_CALL_MAX_NOTES: u32 = 2;
    global RECURSIVE_TRANSFER_CALL_MAX_NOTES: u32 = 8;

    // Sub-5b: domain-separation tags for bridge flow content hashes.
    // Placeholder Field constants; Task C1 reconciles to canonical Aztec
    // poseidon2 / sha256_to_field hash values matching the L1 portal's
    // DataStructures.sol tags.
    global DEPOSIT_PUBLIC_TAG: Field =
        0x5a5759415053574152505f4445504f5349545f5055425f5630303100000001;
    global DEPOSIT_PRIVATE_TAG: Field =
        0x5a5759415053574152505f4445504f5349545f5052565f5630303100000002;
    global WITHDRAW_PUBLIC_TAG: Field =
        0x5a5759415053574152505f57495448445241575f5055425f56303031000003;
    global WITHDRAW_PRIVATE_TAG: Field =
        0x5a5759415053574152505f57495448445241575f5052565f56303031000004;

    // Sentinel address used in Transfer events to represent the private side of a balance change.
    global PRIVATE_ADDRESS_MAGIC_VALUE: AztecAddress =
        AztecAddress::from_field(0x1ea7e01501975545617c2e694d931cb576b691a4a867fed81ebd3264);

    #[event]
    struct Transfer {
        from: AztecAddress,
        to: AztecAddress,
        amount: u128,
    }

    #[storage]
    struct Storage<Context> {
        name: PublicImmutable<FieldCompressedString, Context>,
        symbol: PublicImmutable<FieldCompressedString, Context>,
        decimals: PublicImmutable<u8, Context>,
        private_balances: Owned<BalanceSet<Context>, Context>,
        total_supply: PublicMutable<u128, Context>,
        public_balances: Map<AztecAddress, PublicMutable<u128, Context>, Context>,
        minter: PublicImmutable<AztecAddress, Context>,
        // Sub-5b: bridge configuration. Set once at deploy; immutable.
        is_bridged: PublicImmutable<bool, Context>,
        portal_addr: PublicImmutable<EthAddress, Context>,
    }

    #[external("public")]
    #[initializer]
    fn constructor_with_initial_supply(
        name: str<31>,
        symbol: str<31>,
        decimals: u8,
        initial_supply: u128,
        to: AztecAddress,
    ) {
        self.storage.name.initialize(FieldCompressedString::from_string(name));
        self.storage.symbol.initialize(FieldCompressedString::from_string(symbol));
        self.storage.decimals.initialize(decimals);
        self.storage.is_bridged.initialize(false);
        self.storage.portal_addr.initialize(EthAddress::zero());

        self.internal._mint_to_public(to, initial_supply);
    }

    #[external("public")]
    #[initializer]
    fn constructor_with_minter(name: str<31>, symbol: str<31>, decimals: u8, minter: AztecAddress) {
        self.storage.name.initialize(FieldCompressedString::from_string(name));
        self.storage.symbol.initialize(FieldCompressedString::from_string(symbol));
        self.storage.decimals.initialize(decimals);
        self.storage.minter.initialize(minter);
        self.storage.is_bridged.initialize(false);
        self.storage.portal_addr.initialize(EthAddress::zero());
    }

    /// Sub-5b: bridge-mode constructor. Sets is_bridged=true + portal_addr.
    /// Admin mint paths (mint_to_public / mint_to_private) will revert in this mode.
    #[external("public")]
    #[initializer]
    fn constructor_with_minter_bridged(
        name: str<31>,
        symbol: str<31>,
        decimals: u8,
        minter: AztecAddress,
        portal_addr: EthAddress,
    ) {
        assert(portal_addr != EthAddress::zero(), "bridged token requires non-zero portal_addr");
        self.storage.name.initialize(FieldCompressedString::from_string(name));
        self.storage.symbol.initialize(FieldCompressedString::from_string(symbol));
        self.storage.decimals.initialize(decimals);
        self.storage.minter.initialize(minter);
        self.storage.is_bridged.initialize(true);
        self.storage.portal_addr.initialize(portal_addr);
    }

    // ============================== PRIVATE ==============================

    #[authorize_once("from", "_nonce")]
    #[external("private")]
    fn transfer_private_to_public(
        from: AztecAddress,
        to: AztecAddress,
        amount: u128,
        _nonce: Field,
    ) {
        self.internal._decrease_private_balance(from, amount, INITIAL_TRANSFER_CALL_MAX_NOTES);
        self.enqueue_self.increase_public_balance_internal(to, amount);
    }

    #[authorize_once("from", "_nonce")]
    #[external("private")]
    fn transfer_private_to_public_with_commitment(
        from: AztecAddress,
        to: AztecAddress,
        amount: u128,
        _nonce: Field,
    ) -> Field {
        self.internal._decrease_private_balance(from, amount, INITIAL_TRANSFER_CALL_MAX_NOTES);
        self.enqueue_self.increase_public_balance_internal(to, amount);

        let completer = self.msg_sender();
        let commitment = self.internal._initialize_transfer_commitment(to, completer);
        commitment.to_field()
    }

    #[authorize_once("from", "_nonce")]
    #[external("private")]
    fn transfer_private_to_private(
        from: AztecAddress,
        to: AztecAddress,
        amount: u128,
        _nonce: Field,
    ) {
        self.internal._decrease_private_balance(from, amount, INITIAL_TRANSFER_CALL_MAX_NOTES);
        self.internal._increase_private_balance(to, amount);
    }

    #[authorize_once("from", "_nonce")]
    #[external("private")]
    fn transfer_private_to_commitment(
        from: AztecAddress,
        commitment: Field,
        amount: u128,
        _nonce: Field,
    ) {
        self.internal._decrease_private_balance(from, amount, INITIAL_TRANSFER_CALL_MAX_NOTES);

        let completer = self.msg_sender();
        PartialUintNote::from_field(commitment).complete_from_private(
            self.context,
            completer,
            self.storage.private_balances.get_storage_slot(),
            amount,
        );
    }

    #[authorize_once("from", "_nonce")]
    #[external("private")]
    fn transfer_public_to_private(
        from: AztecAddress,
        to: AztecAddress,
        amount: u128,
        _nonce: Field,
    ) {
        self.enqueue_self.decrease_public_balance_internal(from, amount);
        self.internal._increase_private_balance(to, amount);
    }

    #[external("private")]
    fn initialize_transfer_commitment(to: AztecAddress, completer: AztecAddress) -> Field {
        let commitment = self.internal._initialize_transfer_commitment(to, completer);
        commitment.to_field()
    }

    #[external("private")]
    #[only_self]
    fn recurse_subtract_balance_internal(account: AztecAddress, amount: u128) -> u128 {
        self.internal._subtract_balance(account, amount, RECURSIVE_TRANSFER_CALL_MAX_NOTES)
    }

    // ============================== PUBLIC ===============================

    #[authorize_once("from", "_nonce")]
    #[external("public")]
    fn transfer_public_to_public(
        from: AztecAddress,
        to: AztecAddress,
        amount: u128,
        _nonce: Field,
    ) {
        self.internal._decrease_public_balance(from, amount);
        self.internal._increase_public_balance(to, amount);

        self.emit(Transfer { from, to, amount });
    }

    #[authorize_once("from", "_nonce")]
    #[external("public")]
    fn transfer_public_to_commitment(
        from: AztecAddress,
        commitment: Field,
        amount: u128,
        _nonce: Field,
    ) {
        self.internal._decrease_public_balance(from, amount);

        let completer = self.msg_sender();
        self.internal._increase_commitment_balance(
            PartialUintNote::from_field(commitment),
            completer,
            amount,
        );

        self.emit(Transfer { from, to: PRIVATE_ADDRESS_MAGIC_VALUE, amount });
    }

    #[external("public")]
    #[only_self]
    fn increase_public_balance_internal(to: AztecAddress, amount: u128) {
        self.internal._increase_public_balance(to, amount);
        self.emit(Transfer { from: PRIVATE_ADDRESS_MAGIC_VALUE, to, amount });
    }

    #[external("public")]
    #[only_self]
    fn decrease_public_balance_internal(from: AztecAddress, amount: u128) {
        self.internal._decrease_public_balance(from, amount);
        self.emit(Transfer { from, to: PRIVATE_ADDRESS_MAGIC_VALUE, amount });
    }

    // ============================ VIEW FUNCTIONS =========================

    #[external("public")]
    #[view]
    fn balance_of_public(owner: AztecAddress) -> u128 {
        self.storage.public_balances.at(owner).read()
    }

    #[external("public")]
    #[view]
    fn total_supply() -> u128 {
        self.storage.total_supply.read()
    }

    #[external("public")]
    #[view]
    fn name() -> FieldCompressedString {
        self.storage.name.read()
    }

    #[external("public")]
    #[view]
    fn symbol() -> FieldCompressedString {
        self.storage.symbol.read()
    }

    #[external("public")]
    #[view]
    fn decimals() -> u8 {
        self.storage.decimals.read()
    }

    #[external("public")]
    #[view]
    fn is_bridged() -> bool {
        self.storage.is_bridged.read()
    }

    #[external("public")]
    #[view]
    fn portal_addr() -> EthAddress {
        self.storage.portal_addr.read()
    }

    // ============================ UNCONSTRAINED ==========================

    #[external("utility")]
    unconstrained fn balance_of_private(owner: AztecAddress) -> u128 {
        self.storage.private_balances.at(owner).balance_of()
    }

    // =============================== MINTABLE ============================

    #[external("private")]
    fn mint_to_private(to: AztecAddress, amount: u128) {
        let bridged = self.storage.is_bridged.read();
        assert(!bridged, "bridged token: use claim_private via portal flow");
        _validate_minter(self.msg_sender(), self.storage.minter.read());
        self.internal._mint_to_private(to, amount);
    }

    #[external("public")]
    fn mint_to_public(to: AztecAddress, amount: u128) {
        let bridged = self.storage.is_bridged.read();
        assert(!bridged, "bridged token: use claim_public via portal flow");
        _validate_minter(self.msg_sender(), self.storage.minter.read());
        self.internal._mint_to_public(to, amount);
    }

    #[external("public")]
    fn mint_to_commitment(commitment: Field, amount: u128) {
        let bridged = self.storage.is_bridged.read();
        assert(!bridged, "bridged token: use claim_private via portal flow");
        let completer = self.msg_sender();
        _validate_minter(completer, self.storage.minter.read());
        self.internal._increase_total_supply(amount);
        self.internal._increase_commitment_balance(
            PartialUintNote::from_field(commitment),
            completer,
            amount,
        );

        self.emit(Transfer { from: AztecAddress::zero(), to: PRIVATE_ADDRESS_MAGIC_VALUE, amount });
    }

    #[external("public")]
    #[only_self]
    fn increase_total_supply_internal(amount: u128) {
        self.internal._increase_total_supply(amount);
        self.emit(Transfer { from: AztecAddress::zero(), to: PRIVATE_ADDRESS_MAGIC_VALUE, amount });
    }

    // =============================== BURNABLE ============================

    #[authorize_once("from", "_nonce")]
    #[external("private")]
    fn burn_private(from: AztecAddress, amount: u128, _nonce: Field) {
        self.internal._burn_private(from, amount);
    }

    #[authorize_once("from", "_nonce")]
    #[external("public")]
    fn burn_public(from: AztecAddress, amount: u128, _nonce: Field) {
        self.internal._burn_public(from, amount);
    }

    #[external("public")]
    #[only_self]
    fn decrease_total_supply_internal(amount: u128) {
        self.internal._decrease_total_supply(amount);
        self.emit(Transfer { from: PRIVATE_ADDRESS_MAGIC_VALUE, to: AztecAddress::zero(), amount });
    }

    // ============================ INTERNAL HELPERS ========================

    #[contract_library_method]
    fn _validate_minter(sender: AztecAddress, minter: AztecAddress) {
        assert(minter.eq(sender), "caller is not minter");
    }

    #[internal("private")]
    fn _decrease_private_balance(account: AztecAddress, amount: u128, max_notes: u32) {
        let change = self.internal._subtract_balance(account, amount, max_notes);
        self.storage.private_balances.at(account).add(change).deliver(
            MessageDelivery.ONCHAIN_CONSTRAINED,
        );
    }

    #[internal("private")]
    fn _increase_private_balance(to: AztecAddress, amount: u128) {
        self.storage.private_balances.at(to).add(amount).deliver(MessageDelivery.ONCHAIN_CONSTRAINED);
    }

    #[internal("public")]
    fn _increase_public_balance(to: AztecAddress, amount: u128) {
        let new_balance = self.storage.public_balances.at(to).read() + amount;
        self.storage.public_balances.at(to).write(new_balance);
    }

    #[internal("public")]
    fn _decrease_public_balance(from: AztecAddress, amount: u128) {
        let new_balance = self.storage.public_balances.at(from).read() - amount;
        self.storage.public_balances.at(from).write(new_balance);
    }

    #[internal("public")]
    fn _increase_commitment_balance(
        commitment: PartialUintNote,
        completer: AztecAddress,
        amount: u128,
    ) {
        commitment.complete(
            self.context,
            completer,
            self.storage.private_balances.get_storage_slot(),
            amount,
        );
    }

    #[internal("private")]
    fn _subtract_balance(account: AztecAddress, amount: u128, max_notes: u32) -> u128 {
        let subtracted = self.storage.private_balances.at(account).try_sub(amount, max_notes);
        if subtracted >= amount {
            subtracted - amount
        } else {
            assert(subtracted > 0, "Balance too low");
            let remaining = amount - subtracted;
            self.call_self.recurse_subtract_balance_internal(account, remaining)
        }
    }

    #[internal("public")]
    fn _increase_total_supply(amount: u128) {
        let new_supply = self.storage.total_supply.read() + amount;
        self.storage.total_supply.write(new_supply);
    }

    #[internal("public")]
    fn _decrease_total_supply(amount: u128) {
        let new_supply = self.storage.total_supply.read() - amount;
        self.storage.total_supply.write(new_supply);
    }

    #[internal("private")]
    fn _initialize_transfer_commitment(
        to: AztecAddress,
        completer: AztecAddress,
    ) -> PartialUintNote {
        let commitment = UintNote::partial(to, self.context, to, completer);
        commitment
    }

    #[internal("public")]
    fn _mint_to_public(to: AztecAddress, amount: u128) {
        self.internal._increase_public_balance(to, amount);
        self.internal._increase_total_supply(amount);
        self.emit(Transfer { from: AztecAddress::zero(), to, amount });
    }

    #[internal("private")]
    fn _mint_to_private(to: AztecAddress, amount: u128) {
        self.internal._increase_private_balance(to, amount);
        self.enqueue_self.increase_total_supply_internal(amount);
    }

    #[internal("public")]
    fn _burn_public(from: AztecAddress, amount: u128) {
        self.internal._decrease_public_balance(from, amount);
        self.internal._decrease_total_supply(amount);
        self.emit(Transfer { from, to: AztecAddress::zero(), amount });
    }

    #[internal("private")]
    fn _burn_private(from: AztecAddress, amount: u128) {
        self.internal._decrease_private_balance(from, amount, INITIAL_TRANSFER_CALL_MAX_NOTES);
        self.enqueue_self.decrease_total_supply_internal(amount);
    }
}
