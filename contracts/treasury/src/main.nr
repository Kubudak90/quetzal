use aztec::macros::aztec;

#[aztec]
pub contract Treasury {
    use aztec::{
        macros::{
            functions::{external, initializer, only_self},
            storage::storage,
        },
        protocol::address::AztecAddress,
        state_vars::{PublicImmutable, PublicMutable},
    };

    use token::Token;

    #[storage]
    struct Storage<Context> {
        bond_token: PublicImmutable<AztecAddress, Context>,
        orderbook_addr: PublicImmutable<AztecAddress, Context>,
        deployer: PublicImmutable<AztecAddress, Context>,
        /// Internal balance accounting. Increments on deposit and seed_public;
        /// decrements on pay_aggregator. Avoids the need to cross-contract read
        /// Token.balance_of_public (which returns a PublicStaticCall<...> shape
        /// that is awkward to plumb through env.execute_utility in TXE tests).
        tracked_balance: PublicMutable<u128, Context>,
    }

    #[external("public")]
    #[initializer]
    fn constructor(
        bond_token: AztecAddress,
        orderbook_addr: AztecAddress,
        deployer: AztecAddress,
    ) {
        self.storage.bond_token.initialize(bond_token);
        self.storage.orderbook_addr.initialize(orderbook_addr);
        self.storage.deployer.initialize(deployer);
        self.storage.tracked_balance.write(0 as u128);
    }

    /// Pay the clearing winner a flat fee. ONLY callable by the orderbook
    /// contract. Silently transfers min(amount, tracked_balance) -- never reverts
    /// on under-funded treasury, so a dry treasury does NOT block clearing.
    #[external("public")]
    fn pay_aggregator(winner: AztecAddress, amount: u128) {
        let caller = self.msg_sender();
        let orderbook = self.storage.orderbook_addr.read();
        assert(caller == orderbook, "only orderbook");

        let balance = self.storage.tracked_balance.read();
        let pay = if balance < amount { balance } else { amount };
        if pay > 0 as u128 {
            let bond_token = self.storage.bond_token.read();
            self.call(Token::at(bond_token).transfer_public_to_public(
                self.address,
                winner,
                pay,
                0,
            ));
            self.storage.tracked_balance.write(balance - pay);
        }
    }

    /// Top up the treasury by escrowing `amount` of bond_token from the caller's
    /// private balance to the treasury's public balance. Increments tracked_balance
    /// via the public callback.
    #[external("private")]
    fn deposit(amount: u128, nonce: Field) {
        let caller = self.msg_sender();
        let bond_token = self.storage.bond_token.read();
        self.call(Token::at(bond_token).transfer_private_to_public(
            caller,
            self.address,
            amount,
            nonce,
        ));
        self.enqueue_self._increment_tracked(amount);
    }

    /// Deploy-time helper to seed the treasury from the public balance of the
    /// deployer (e.g., scripts/deploy-tokens.ts mints to the treasury, then
    /// calls this to record the credit). Only the deployer can call. Tests use
    /// this in lieu of Token-authwit machinery.
    #[external("public")]
    fn seed_public(amount: u128) {
        let caller = self.msg_sender();
        let deployer = self.storage.deployer.read();
        assert(caller == deployer, "only deployer");
        // Caller has already minted `amount` of bond_token to this contract's
        // public balance via Token.mint_to_public (or equivalent); we just
        // update our tracked accounting.
        let prev = self.storage.tracked_balance.read();
        self.storage.tracked_balance.write(prev + amount);
    }

    /// Public callback for deposit. only_self.
    #[external("public")]
    #[only_self]
    fn _increment_tracked(amount: u128) {
        let prev = self.storage.tracked_balance.read();
        self.storage.tracked_balance.write(prev + amount);
    }

    #[external("utility")]
    unconstrained fn get_bond_token() -> AztecAddress {
        self.storage.bond_token.read()
    }

    #[external("utility")]
    unconstrained fn get_orderbook_addr() -> AztecAddress {
        self.storage.orderbook_addr.read()
    }

    #[external("utility")]
    unconstrained fn get_tracked_balance() -> u128 {
        self.storage.tracked_balance.read()
    }

    pub mod test;
}
