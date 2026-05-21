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
        state_vars::{Map, Owned, PrivateSet, PublicImmutable, PublicMutable},
        utils::comparison::Comparator,
    };

    use token::Token;
    use pool::LiquidityPool;
    use aztec::protocol::{hash::poseidon2_hash, traits::ToField};

    /// Maximum number of input notes for note-sweeping flows. Unused by `cancel_order`
    /// (which selects a single note by nonce via `set_limit(1)`); reserved for the
    /// clearing circuit (Week 6+) which will sweep many resting notes at once.
    pub global MAX_INPUT_NOTES: u32 = 8;

    /// Maximum orders submitted per epoch (also the cap on fills in one clearing).
    pub global MAX_ORDERS_PER_EPOCH: u32 = 32;

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
    /// - `state`: epoch state machine value (0 = OPEN; 1 = CLOSING, 2 = SETTLED reserved for the clearing circuit, Week 6+).
    /// - `opened_at_block`: L2 block number at which this epoch was opened.
    /// - `closes_at_block`: L2 block number at/after which this epoch may transition out of OPEN.
    /// - `order_acc`: running-hash chain of submitted-order commitments (Poseidon2). Starts at 0; folded
    ///   per submit by `_append_order` (Week 5d-1). Bound by the Week 5d-2 clearing circuit.
    /// - `cancel_acc`: running-hash chain of cancelled-order commitments (Poseidon2). Starts at 0; folded
    ///   per cancel by `_append_cancel` (Week 5d-1).
    /// - `order_count`: count of `submit_order` successes this epoch (monotonic; capped at MAX_ORDERS_PER_EPOCH).
    /// - `cancel_count`: count of `cancel_order` successes this epoch (monotonic; <= order_count).
    #[derive(Deserialize, Eq, Packable, Serialize)]
    pub struct EpochState {
        pub epoch_id: u32,
        pub state: u8,
        pub opened_at_block: u32,
        pub closes_at_block: u32,
        pub order_acc: Field,
        pub cancel_acc: Field,
        pub order_count: u32,
        pub cancel_count: u32,
    }

    /// One filled order in a clearing - the aggregator's per-order payout.
    #[derive(Deserialize, Eq, Packable, Serialize)]
    pub struct FillEntry {
        pub order_nonce: Field,
        pub amount_out: u128,
    }

    /// Mirror of the Week 5d-4 clearing circuit's ClearingPublic. Field order
    /// MUST match circuits/clearing/src/main.nr's fn main pub parameter declaration
    /// (order_acc, cancel_acc, order_count, cancel_count, reserve_a, reserve_b,
    /// lp_supply, clearing_price, fills_root, swap). Reorder requires matching
    /// reorder in flatten_clearing_public.
    #[derive(Deserialize, Eq, Packable, Serialize)]
    pub struct ClearingPublic {
        pub order_acc:      Field,
        pub cancel_acc:     Field,
        pub order_count:    u32,
        pub cancel_count:   u32,
        pub reserve_a:      u128,
        pub reserve_b:      u128,
        pub lp_supply:      u128,
        pub clearing_price: u128,
        pub fills_root:     Field,
        pub swap:           LiquidityPool::ClearingSwap,
    }

    #[storage]
    struct Storage<Context> {
        orders: Owned<PrivateSet<OrderNote, Context>, Context>,
        current_epoch: PublicMutable<EpochState, Context>,
        token_a_addr: PublicImmutable<AztecAddress, Context>,
        token_b_addr: PublicImmutable<AztecAddress, Context>,
        epoch_length: PublicImmutable<u32, Context>,
        pool_addr: PublicImmutable<AztecAddress, Context>,
        /// Hash of the clearing-circuit VK. Initialised at deploy and immutable.
        /// The full VK is provided as calldata to close_epoch_and_clear_verified.
        clearing_vk_hash: PublicImmutable<Field, Context>,
        /// Week 5d-4: per-epoch Merkle settlement root over the 32-leaf fills array.
        /// `_apply_verified_clearing` writes one slot per clearing; claim_fill reads
        /// it back to verify a maker-supplied inclusion proof.
        fills_root: Map<u32, PublicMutable<Field, Context>, Context>,
    }

    /// Deploy-time initializer.
    ///
    /// - Records the two tradable token addresses.
    /// - Records `pool_addr` (the LiquidityPool the net clearing flow swaps through)
    ///   and `clearing_vk_hash` (the VK hash that binds this orderbook to one specific
    ///   clearing circuit; the full VK is provided as calldata at clearing time).
    /// - Stores `epoch_length`; opens epoch 0.
    #[external("public")]
    #[initializer]
    fn constructor(
        token_a: AztecAddress,
        token_b: AztecAddress,
        epoch_length: u32,
        pool_addr: AztecAddress,
        clearing_vk_hash: Field,
    ) {
        self.storage.token_a_addr.initialize(token_a);
        self.storage.token_b_addr.initialize(token_b);
        self.storage.epoch_length.initialize(epoch_length);
        self.storage.pool_addr.initialize(pool_addr);
        self.storage.clearing_vk_hash.initialize(clearing_vk_hash);

        let block: u32 = self.context.block_number();
        self.storage.current_epoch.write(EpochState {
            epoch_id: 0,
            state: EPOCH_STATE_OPEN,
            opened_at_block: block,
            closes_at_block: block + epoch_length,
            order_acc: 0,
            cancel_acc: 0,
            order_count: 0,
            cancel_count: 0,
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

        // Per-order commitment bound to the full OrderNote field set (the Week 5d-2 clearing
        // circuit will reproduce this from its private order list). `order_nonce` is a random
        // Field, so c_i is hiding: side/amount/limit cannot be recovered from c_i.
        let c_i: Field = poseidon2_hash(
            [
                maker.to_field(),
                if side { 1 } else { 0 },
                amount_in as Field,
                limit_price as Field,
                order_nonce,
                submitted_at_block as Field,
            ],
        );

        // Defer to public execution: epoch-open check first (clean revert message if the
        // epoch has advanced), then the accumulator append (also revertible on capacity).
        // Both callbacks run atomically with this private body; any failure reverts escrow
        // and the OrderNote together.
        self.enqueue_self._assert_epoch_open();
        self.enqueue_self._append_order(c_i);
    }

    /// Public callback used by `submit_order` / `cancel_order` to enforce that the
    /// current epoch is OPEN *and* its time window has not elapsed. `only_self`
    /// ensures the callback can only be invoked by this contract via `enqueue_self`.
    #[external("public")]
    #[only_self]
    fn _assert_epoch_open() {
        let epoch = self.storage.current_epoch.read();
        assert(epoch.state == EPOCH_STATE_OPEN, "epoch is not OPEN");
        let block: u32 = self.context.block_number();
        assert(block < epoch.closes_at_block, "epoch has expired; awaiting close_epoch");
    }

    /// Public callback used by `submit_order` to fold an order commitment into the
    /// epoch's `order_acc` running-hash chain and to enforce the per-epoch cap.
    /// `only_self` keeps this callable only via this contract's `enqueue_self`.
    ///
    /// Capacity revert message is the user-visible signal that 32 orders have been
    /// submitted in the current epoch. The whole tx (including the escrow and the
    /// `OrderNote` insertion) reverts because all callbacks share atomicity with
    /// the private body that enqueued them.
    #[external("public")]
    #[only_self]
    fn _append_order(c_i: Field) {
        let mut epoch = self.storage.current_epoch.read();
        assert(
            epoch.order_count < MAX_ORDERS_PER_EPOCH,
            "epoch order capacity reached",
        );
        epoch.order_acc = poseidon2_hash([epoch.order_acc, c_i]);
        epoch.order_count = epoch.order_count + 1;
        self.storage.current_epoch.write(epoch);
    }

    /// Public callback used by `cancel_order` to fold a cancelled-order commitment
    /// into the epoch's `cancel_acc` running-hash chain. `only_self`.
    ///
    /// No cap check: `cancel_count` only advances when a real `OrderNote` was popped
    /// in `cancel_order`, and `OrderNote` insertion is capped to MAX_ORDERS_PER_EPOCH
    /// by `_append_order`, so `cancel_count <= order_count <= MAX_ORDERS_PER_EPOCH`
    /// holds inherently.
    #[external("public")]
    #[only_self]
    fn _append_cancel(c_i: Field) {
        let mut epoch = self.storage.current_epoch.read();
        epoch.cancel_acc = poseidon2_hash([epoch.cancel_acc, c_i]);
        epoch.cancel_count = epoch.cancel_count + 1;
        self.storage.current_epoch.write(epoch);
    }

    // ============================ EPOCH TRANSITIONS ============================

    /// Advance the orderbook to a fresh epoch once the current epoch's time window
    /// has elapsed.
    ///
    /// Permissionless and time-gated: anyone may call it, but it reverts unless the
    /// current epoch has expired (`block >= closes_at_block`). It only advances a
    /// counter - there is nothing to abuse - so permissionless triggering is purely
    /// a liveness win (no dependency on a trusted aggregator).
    ///
    /// Week 4 performs NO clearing: the `orders` PrivateSet is untouched, so every
    /// resting order carries into the new epoch. Filling/settlement arrive with the
    /// clearing circuit (Week 6+).
    #[external("public")]
    fn close_epoch() {
        let current = self.storage.current_epoch.read();
        let block: u32 = self.context.block_number();
        assert(block >= current.closes_at_block, "epoch has not expired yet");

        let epoch_length = self.storage.epoch_length.read();
        self.storage.current_epoch.write(EpochState {
            epoch_id: current.epoch_id + 1,
            state: EPOCH_STATE_OPEN,
            opened_at_block: block,
            closes_at_block: block + epoch_length,
            order_acc: 0,
            cancel_acc: 0,
            order_count: 0,
            cancel_count: 0,
        });
    }

    /// Flatten a ClearingPublic to the [Field; 19] vector the recursive verifier
    /// expects. Slot order matches circuits/clearing/src/main.nr's fn main pub
    /// parameter declaration order: 8 scalars, then fills_root, then the 10 swap
    /// fields. ANY reorder on the circuit side requires the matching reorder here.
    #[contract_library_method]
    fn flatten_clearing_public(p: ClearingPublic) -> [Field; 19] {
        let mut out: [Field; 19] = [0 as Field; 19];
        out[0] = p.order_acc;
        out[1] = p.cancel_acc;
        out[2] = p.order_count as Field;
        out[3] = p.cancel_count as Field;
        out[4] = p.reserve_a as Field;
        out[5] = p.reserve_b as Field;
        out[6] = p.lp_supply as Field;
        out[7] = p.clearing_price as Field;
        out[8] = p.fills_root;
        out[9]  = p.swap.a_to_pool as Field;
        out[10] = p.swap.b_to_pool as Field;
        out[11] = p.swap.a_from_pool as Field;
        out[12] = p.swap.b_from_pool as Field;
        out[13] = p.swap.reserve_a_add as Field;
        out[14] = p.swap.reserve_a_sub as Field;
        out[15] = p.swap.reserve_b_add as Field;
        out[16] = p.swap.reserve_b_sub as Field;
        out[17] = p.swap.fee_a_per_share_increment as Field;
        out[18] = p.swap.fee_b_per_share_increment as Field;
        out
    }

    // ============================ CLEARING ============================

    /// Apply one epoch's clearing on-chain, gated by a recursive verify of the
    /// Week 5d-2 clearing circuit's proof. The replacement for the W5c
    /// `close_epoch_and_clear`: no authority gate, no trust -- anyone holding
    /// `(public_inputs, proof, vk)` for the current epoch may advance it.
    ///
    /// The full verification key is passed as a calldata arg because Aztec's
    /// MAX_PUBLIC_DATA_UPDATE_REQUESTS_PER_TX (~63) makes storing 127 Field
    /// slots in a single constructor tx infeasible. The contract anchors trust
    /// via `clearing_vk_hash` (stored at deploy): `std::verify_proof_with_type`
    /// takes both `vk` and `vk_hash`, and Honk's internal vk-vs-hash binding
    /// enforces that the supplied `vk` matches `vk_hash`. A mismatched vk
    /// produces a hash that fails this internal check (revert).
    ///
    /// Flow:
    /// 1. Flatten public_inputs to the [Field; 19] vector matching the prover's view.
    /// 2. `std::verify_proof_with_type(vk, proof, flat, vk_hash, 1)` -- recursive verify.
    /// 3. Enqueue `_apply_verified_clearing` which under public-state guards verifies
    ///    freshness (binding inputs match the current epoch's accumulators), runs the
    ///    net AMM swap + stores fills_root + advances the epoch.
    ///
    /// Replay protection is automatic: an old proof's order_acc cannot match the
    /// post-clearing epoch's reset acc (=0).
    #[external("private")]
    fn close_epoch_and_clear_verified(
        public_inputs: ClearingPublic,
        proof: [Field; 456],
        vk: [Field; 127],
    ) {
        let vk_hash = self.storage.clearing_vk_hash.read();
        // 1 = Honk proof type per Aztec/bb conventions.
        // Honk proofs embed public inputs in the proof bytes (IVC IO); the
        // public_inputs argument must be empty -- passing a non-empty array
        // causes bb to abort with "unexpected non-empty public_inputs in HN constraint".
        std::verify_proof_with_type(vk, proof, [], vk_hash, 1);
        self.enqueue_self._apply_verified_clearing(public_inputs);
    }

    /// Public callback: run the net AMM swap, store the per-epoch fills root,
    /// and advance the epoch. only_self ensures only the matching
    /// close_epoch_and_clear_verified private call can invoke it.
    #[external("public")]
    #[only_self]
    fn _apply_verified_clearing(public_inputs: ClearingPublic) {
        let current = self.storage.current_epoch.read();
        let block: u32 = self.context.block_number();
        assert(block >= current.closes_at_block, "epoch has not expired yet");

        // Freshness: bind to the CURRENT epoch's accumulators. Replay rejects here.
        assert(public_inputs.order_acc == current.order_acc, "order_acc mismatch");
        assert(public_inputs.cancel_acc == current.cancel_acc, "cancel_acc mismatch");
        assert(public_inputs.order_count == current.order_count, "order_count mismatch");
        assert(public_inputs.cancel_count == current.cancel_count, "cancel_count mismatch");

        // Net AMM swap (identical to the W5c/5d-3 flow).
        let pool = self.storage.pool_addr.read();
        let swap = public_inputs.swap;
        if swap.a_to_pool > 0 as u128 {
            self.call(Token::at(self.storage.token_a_addr.read()).transfer_public_to_public(
                self.address, pool, swap.a_to_pool, 0,
            ));
        }
        if swap.b_to_pool > 0 as u128 {
            self.call(Token::at(self.storage.token_b_addr.read()).transfer_public_to_public(
                self.address, pool, swap.b_to_pool, 0,
            ));
        }
        self.call(LiquidityPool::at(pool).apply_clearing(swap));

        // Week 5d-4: single storage write -- the per-epoch Merkle settlement root.
        // claim_fill reads this back at claim time via _assert_fill_root.
        self.storage.fills_root.at(current.epoch_id).write(public_inputs.fills_root);

        // Advance the epoch (accumulator fields reset to 0).
        let epoch_length = self.storage.epoch_length.read();
        self.storage.current_epoch.write(EpochState {
            epoch_id: current.epoch_id + 1,
            state: EPOCH_STATE_OPEN,
            opened_at_block: block,
            closes_at_block: block + epoch_length,
            order_acc:   0,
            cancel_acc:  0,
            order_count: 0,
            cancel_count: 0,
        });
    }

    // ============================ CLAIM FILL ============================

    /// claim_fill rewrite lands in Task 8. Body intentionally stubbed.
    #[external("private")]
    fn claim_fill(_order_nonce: Field, _claimed_amount_out: u128) {
        // claim_fill rewrite lands in Task 8. Body intentionally stubbed.
        assert(false, "claim_fill is being rewritten in Task 8");
    }

    // ============================ ORDER CANCELLATION ============================

    /// Cancel a resting order and return its escrow to the maker's PRIVATE balance.
    ///
    /// Cancellation is rejected once an order has been filled by a clearing - a
    /// filled order must be redeemed via `claim_fill` instead.
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

        // Recompute the same per-order commitment submit_order folded into order_acc.
        // The popped OrderNote carries every preimage field, so this matches the original
        // c_i exactly. Equality with the submit-side c_i is what makes the submit-cancel
        // invariant (IT4) hold.
        let c_i: Field = poseidon2_hash(
            [
                maker.to_field(),
                if order.side { 1 } else { 0 },
                order.amount_in as Field,
                order.limit_price as Field,
                order.nonce,
                order.submitted_at_block as Field,
            ],
        );

        // Gate cancellation to OPEN, then fold into cancel_acc, all BEFORE the
        // escrow-return public call. The 5c _assert_not_filled guard is dropped in
        // 5d-4: cancel-after-fill is now blocked at the token-contract level --
        // _apply_verified_clearing moves filled amount_in to the pool, leaving the
        // orderbook's public balance short, so the transfer_public_to_private call
        // underflows and the whole tx (including the OrderNote nullification + the
        // cancel_acc fold) atomically reverts. See specs/2026-05-21-...-design.md sec 6.5.
        self.enqueue_self._assert_epoch_open();
        self.enqueue_self._append_cancel(c_i);

        // Return the escrow: orderbook PUBLIC balance -> maker PRIVATE balance.
        self.call(Token::at(token_addr).transfer_public_to_private(
            self.address,
            maker,
            order.amount_in,
            nonce,
        ));
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
    unconstrained fn get_epoch_length() -> u32 {
        self.storage.epoch_length.read()
    }

    #[external("utility")]
    unconstrained fn get_pool_addr() -> AztecAddress {
        self.storage.pool_addr.read()
    }

    /// Exposes the embedded clearing-circuit VK hash.
    #[external("utility")]
    unconstrained fn get_clearing_vk_hash() -> Field {
        self.storage.clearing_vk_hash.read()
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
