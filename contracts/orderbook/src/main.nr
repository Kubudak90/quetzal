use aztec::macros::aztec;

#[aztec]
pub contract Orderbook {
    use aztec::{
        macros::{
            functions::{external, initializer},
            notes::note,
            storage::storage,
        },
        protocol::{
            address::AztecAddress,
            traits::{Deserialize, Packable, Serialize},
        },
        state_vars::{Owned, PrivateSet, PublicImmutable, PublicMutable},
    };

    /// Number of L2 blocks per epoch. Each freshly opened epoch closes
    /// `EPOCH_LENGTH` blocks after its opening block.
    global EPOCH_LENGTH: u32 = 100;

    /// Private note representing a single resting order on the orderbook.
    ///
    /// Fields:
    /// - `submitted_at_block`: L2 block number at which the order was submitted (used for time priority).
    /// - `side`: false = bid (buy base / pay quote), true = ask (sell base / receive quote).
    /// - `amount_in`: input amount the maker is offering (in the appropriate token's smallest unit).
    /// - `limit_price`: quote-per-base price scaled to 18 decimals (Q-format).
    /// - `nonce`: per-order random salt to make every note unique and unlinkable.
    /// - `owner`: address of the order's maker (also nullifier subject).
    #[derive(Deserialize, Eq, Packable, Serialize)]
    #[note]
    pub struct OrderNote {
        pub submitted_at_block: u32,
        pub side: bool,
        pub amount_in: u128,
        pub limit_price: u128,
        pub nonce: Field,
        pub owner: AztecAddress,
    }

    /// Public state of the current epoch.
    ///
    /// Fields:
    /// - `epoch_id`: monotonically increasing epoch counter (starts at 0).
    /// - `state`: epoch state machine value (0 = OPEN, future values reserved for SEALED / SETTLING / CLOSED).
    /// - `opened_at_block`: L2 block number at which this epoch was opened.
    /// - `closes_at_block`: L2 block number at/after which this epoch may transition out of OPEN.
    #[derive(Deserialize, Eq, Packable, Serialize)]
    pub struct EpochState {
        pub epoch_id: u32,
        pub state: u8,
        pub opened_at_block: u32,
        pub closes_at_block: u32,
    }

    #[storage]
    struct Storage<Context> {
        orders: Owned<PrivateSet<OrderNote, Context>, Context>,
        current_epoch: PublicMutable<EpochState, Context>,
        token_a_addr: PublicImmutable<AztecAddress, Context>,
        token_b_addr: PublicImmutable<AztecAddress, Context>,
        clearing_addr: PublicImmutable<AztecAddress, Context>,
    }

    /// Deploy-time initializer.
    ///
    /// - Records the three contract addresses that the orderbook will interact with
    ///   (the two tradable tokens and the off-chain clearing/auctioneer contract).
    /// - Opens epoch 0 at the current block, closing `EPOCH_LENGTH` blocks later.
    #[external("public")]
    #[initializer]
    fn constructor(token_a: AztecAddress, token_b: AztecAddress, clearing: AztecAddress) {
        self.storage.token_a_addr.initialize(token_a);
        self.storage.token_b_addr.initialize(token_b);
        self.storage.clearing_addr.initialize(clearing);

        let block: u32 = self.context.block_number();
        self.storage.current_epoch.write(EpochState {
            epoch_id: 0,
            state: 0,
            opened_at_block: block,
            closes_at_block: block + EPOCH_LENGTH,
        });
    }

    // ============================ UNCONSTRAINED GETTERS ============================
    // These utility functions exist so TXE tests (and off-chain callers) can read state
    // without requiring an on-chain transaction.

    #[external("utility")]
    unconstrained fn get_epoch() -> EpochState {
        self.storage.current_epoch.read()
    }

    #[external("utility")]
    unconstrained fn get_token_a_addr() -> AztecAddress {
        self.storage.token_a_addr.read()
    }

    #[external("utility")]
    unconstrained fn get_token_b_addr() -> AztecAddress {
        self.storage.token_b_addr.read()
    }

    #[external("utility")]
    unconstrained fn get_clearing_addr() -> AztecAddress {
        self.storage.clearing_addr.read()
    }

    pub mod test;
}
