use aztec::macros::aztec;

#[aztec]
pub contract Orderbook {
    use aztec::{
        macros::{
            functions::{external, initializer, only_self},
            notes::note,
            storage::storage,
        },
        messages::message_delivery::MessageDelivery,
        note::{
            constants::MAX_NOTES_PER_PAGE,
            note_getter_options::NoteGetterOptions,
            note_interface::NoteProperties,
            note_viewer_options::NoteViewerOptions,
        },
        protocol::{
            address::AztecAddress,
            traits::{Deserialize, Packable, Serialize},
        },
        state_vars::{Owned, PrivateSet, PublicImmutable, PublicMutable},
        utils::comparison::Comparator,
    };

    use token::Token;

    /// Number of L2 blocks per epoch. Each freshly opened epoch closes
    /// `EPOCH_LENGTH` blocks after its opening block.
    global EPOCH_LENGTH: u32 = 100;

    /// Maximum number of input notes for note-sweeping flows. Unused by `cancel_order`
    /// (which selects a single note by nonce via `set_limit(1)`); reserved for the
    /// clearing circuit (Week 6+) which will sweep many resting notes at once.
    pub global MAX_INPUT_NOTES: u32 = 8;

    /// Epoch state machine value indicating the epoch is OPEN and accepting new orders.
    global EPOCH_STATE_OPEN: u8 = 0;

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

    // ============================ ORDER SUBMISSION ============================

    /// Submit a new private order to the orderbook.
    ///
    /// Flow:
    /// 1. Validate inputs (`amount_in > 0`, `limit_price > 0`).
    /// 2. Read the input token address from public-immutable storage (decided by `side`).
    /// 3. Escrow the maker's tokens by calling `Token.transfer_private_to_public`, moving
    ///    `amount_in` of the input token from the maker's private balance into the orderbook
    ///    contract's PUBLIC balance. This contract becomes the custodian until the order is
    ///    cancelled (Week 3) or cleared (Week 6+).
    /// 4. Commit an encrypted `OrderNote` to the maker's private set so they can prove ownership
    ///    later (for cancellation / clearing).
    /// 5. Enqueue a public callback to assert the epoch is still OPEN at the time the tx is mined.
    ///    Epoch state lives in a `PublicMutable`, which is not directly readable from private
    ///    context in Aztec v4.2.0, so the check is deferred to public execution.
    ///
    /// # Arguments
    /// - `side`: `false` = bid (deposit token A), `true` = ask (deposit token B).
    /// - `amount_in`: amount of the input token to escrow (must be > 0).
    /// - `limit_price`: quote-per-base price scaled to 18 decimals (must be > 0).
    /// - `nonce`: authwit nonce for the inner `Token.transfer_private_to_public` call.
    /// - `order_nonce`: per-order random salt embedded into the `OrderNote` for uniqueness.
    ///
    /// The `nonce` and `order_nonce` are intentionally distinct so the authwit nonce cannot
    /// collide with the note-identity nonce.
    #[external("private")]
    fn submit_order(
        side: bool,
        amount_in: u128,
        limit_price: u128,
        nonce: Field,
        order_nonce: Field,
    ) {
        assert(amount_in > 0 as u128, "amount_in must be positive");
        assert(limit_price > 0 as u128, "limit_price must be positive");

        let maker = self.msg_sender();

        // PublicImmutable can be read from a private context (it is initialized once at deploy
        // time and the value is therefore historically fixed). PublicMutable cannot, hence the
        // epoch check is deferred to the enqueued public callback below.
        let token_addr: AztecAddress = if side {
            self.storage.token_b_addr.read()
        } else {
            self.storage.token_a_addr.read()
        };

        // Escrow: drain the maker's private balance, credit the orderbook's PUBLIC balance.
        // This is a private->private call (transfer_private_to_public is itself a private
        // function on Token that internally enqueues a public balance increase).
        self.call(Token::at(token_addr).transfer_private_to_public(
            maker,
            self.address,
            amount_in,
            nonce,
        ));

        // Build the OrderNote and insert it into the maker's private set, with on-chain
        // constrained encrypted delivery so the maker is guaranteed to discover and decrypt it.
        let submitted_at_block: u32 = self.context.get_anchor_block_header().block_number();
        let order = OrderNote {
            submitted_at_block,
            side,
            amount_in,
            limit_price,
            nonce: order_nonce,
            owner: maker,
        };
        self.storage.orders.at(maker).insert(order).deliver(MessageDelivery.ONCHAIN_CONSTRAINED);

        // Defer the OPEN-state check to public execution (PublicMutable is not readable from
        // private context). This callback runs atomically with the rest of the tx: if the
        // epoch has already advanced past OPEN at mine time, the whole tx (escrow + note
        // emission) reverts.
        self.enqueue_self._assert_epoch_open();
    }

    /// Public callback used by `submit_order` to enforce that the current epoch state is OPEN.
    /// `only_self` ensures the callback can only be invoked by this contract via `enqueue_self`.
    #[external("public")]
    #[only_self]
    fn _assert_epoch_open() {
        let epoch = self.storage.current_epoch.read();
        assert(epoch.state == EPOCH_STATE_OPEN, "epoch is not OPEN");
    }

    // ============================ ORDER CANCELLATION ============================

    /// Cancel a resting order and return its escrow to the maker's PRIVATE balance.
    ///
    /// Flow:
    /// 1. Retrieve (and nullify) the caller's `OrderNote` whose identity nonce equals
    ///    `order_nonce`. Exactly one note must match.
    /// 2. Read the escrowed token address from public-immutable storage, decided by the
    ///    note's `side` (false -> token A, true -> token B) - mirrors the same
    ///    side->token mapping as `submit_order` (symmetric, using `order.side`).
    /// 3. Call `Token.transfer_public_to_private` to move `amount_in` of that token from
    ///    the orderbook's PUBLIC balance back into the maker's PRIVATE balance. Because
    ///    `from` is this contract and this contract is the caller, the Token's
    ///    `authorize_once("from", _nonce)` guard passes without an authwit.
    /// 4. Enqueue the `_assert_epoch_open` callback so the whole tx reverts if the epoch
    ///    is no longer OPEN at mine time.
    ///
    /// # Arguments
    /// - `order_nonce`: the per-order identity nonce embedded in the target `OrderNote`
    ///   (the same value passed as `order_nonce` to `submit_order`).
    /// - `nonce`: authwit nonce for the inner `Token.transfer_public_to_private` call.
    #[external("private")]
    fn cancel_order(order_nonce: Field, nonce: Field) {
        let maker = self.msg_sender();

        // Retrieve + nullify the maker's resting order matching `order_nonce`. `pop_notes`
        // both reads and nullifies in one constrained call, so a cancelled order can never
        // be cancelled (or cleared) twice.
        // `order_nonce` is a per-order unique salt, so at most one note can ever match
        // the selector. `set_limit(1)` only bounds the query; the
        // `assert(notes.len() == 1, ...)` below is what enforces "exactly one".
        let options = NoteGetterOptions::new().select(
            OrderNote::properties().nonce,
            Comparator.EQ,
            order_nonce,
        ).set_limit(1);
        let notes = self.storage.orders.at(maker).pop_notes(options);
        assert(notes.len() == 1, "order not found");
        let order = notes.get(0);

        // Defence-in-depth: the per-owner PrivateSet already scopes retrieval to `maker`.
        assert(order.owner == maker, "not order owner");

        let token_addr: AztecAddress = if order.side {
            self.storage.token_b_addr.read()
        } else {
            self.storage.token_a_addr.read()
        };

        // Return the escrow: orderbook PUBLIC balance -> maker PRIVATE balance.
        self.call(Token::at(token_addr).transfer_public_to_private(
            self.address,
            maker,
            order.amount_in,
            nonce,
        ));

        // Gate cancellation to the OPEN epoch state: the MVP design forbids cancelling
        // mid-clearing so makers cannot race the clearing tx (an MEV-resistance property).
        // PublicMutable is not readable from private context, so the check is deferred to
        // this enqueued public callback, atomic with the rest of the tx.
        self.enqueue_self._assert_epoch_open();
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

    /// Return the resting orders owned by `owner` (up to MAX_NOTES_PER_PAGE). `owner` is
    /// passed explicitly rather than read from `msg_sender` because utility functions are
    /// simulated, and only the owner's PXE holds the encrypted notes to resolve.
    ///
    /// Note: in aztec-nr v4.2.0 a `PrivateSet` in a `UtilityContext` exposes only
    /// `view_notes(NoteViewerOptions)` (there is no `get_notes` on the utility context),
    /// and `view_notes` is bounded by `MAX_NOTES_PER_PAGE` (= 10), not `MAX_INPUT_NOTES`.
    ///
    /// The returned orders are UNORDERED: they are NOT sorted by `submitted_at_block`
    /// (or any other field). Callers must not assume any particular ordering and should
    /// sort themselves if order matters.
    #[external("utility")]
    unconstrained fn get_orders(owner: AztecAddress) -> BoundedVec<OrderNote, MAX_NOTES_PER_PAGE> {
        self.storage.orders.at(owner).view_notes(NoteViewerOptions::new())
    }

    pub mod test;
}
