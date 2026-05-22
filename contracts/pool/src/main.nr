use aztec::macros::aztec;

#[aztec]
pub contract LiquidityPool {
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
            traits::{Deserialize, FromField, Packable, Serialize},
        },
        state_vars::{Map, Owned, PrivateSet, PublicImmutable, PublicMutable},
        utils::comparison::Comparator,
    };

    use token::Token;

    /// Fixed-point scale for the MasterChef cumulative-fee-per-share counters.
    global FEE_SCALE: u128 = 1_000_000_000_000_000_000;

    /// Unconstrained hint: computes `floor(sqrt(x))` by binary search. Its result is
    /// NOT trusted - `integer_sqrt` constrains it.
    #[contract_library_method]
    unconstrained fn sqrt_hint(x: u128) -> u128 {
        if x < 2 as u128 {
            x
        } else {
            let mut lo: u128 = 1 as u128;
            let mut hi: u128 = x;
            // 128 iterations is enough to converge for any u128 input.
            for _ in 0..128 {
                if lo < hi {
                    let mid = lo + (hi - lo + 1 as u128) / 2 as u128;
                    // mid <= x / mid  is  mid*mid <= x  without overflowing.
                    if mid <= x / mid {
                        lo = mid;
                    } else {
                        hi = mid - 1 as u128;
                    }
                }
            }
            lo
        }
    }

    /// `floor(sqrt(x))`, constrained. Returns the largest `s` with `s*s <= x`.
    ///
    /// Verification avoids forming `(s+1)*(s+1)` (which can overflow u128 for the
    /// largest inputs): `x < (s+1)^2` is equivalent to `x - s*s <= 2*s`.
    #[contract_library_method]
    pub fn integer_sqrt(x: u128) -> u128 {
        // Safety: `s` is verified to be floor(sqrt(x)) by the two asserts below.
        let s = unsafe { sqrt_hint(x) };
        let sq = s * s;
        assert(sq <= x, "integer_sqrt: hint too large");
        assert(x - sq <= 2 as u128 * s, "integer_sqrt: hint too small");
        s
    }

    /// Sub-2: PoolState collapses to (reserves cache + current_sqrt_price).
    /// Per-bucket liquidity + cum_fee accounting moves into BucketState.
    #[derive(Deserialize, Eq, Packable, Serialize)]
    pub struct PoolState {
        pub reserve_a: u128,           // cached sum across buckets
        pub reserve_b: u128,           // cached sum across buckets
        pub current_sqrt_price: u128,  // global pool sqrt_P; drives bucket activation
    }

    /// Sub-2: per-bucket runtime state. 16 of these in storage as
    /// Map<u32, PublicMutable<BucketState>>.
    #[derive(Deserialize, Eq, Packable, Serialize)]
    pub struct BucketState {
        pub reserve_a: u128,
        pub reserve_b: u128,
        pub liquidity: u128,
        pub cum_fee_a_per_share: u128,
        pub cum_fee_b_per_share: u128,
    }

    /// Sub-2: number of buckets (deploy-time constant).
    pub global NUM_BUCKETS: u32 = 16;
    /// Sub-2: maximum buckets touched in a single clearing.
    pub global MAX_ACTIVE_BUCKETS_PER_EPOCH: u32 = 4;
    // FEE_SCALE already defined at line 29 (kept from Sub-1).

    /// Private note representing one LP position. Sub-2 adds `bucket_id`.
    #[derive(Deserialize, Eq, Packable, Serialize)]
    #[note]
    pub struct PositionNote {
        pub bucket_id: u32,
        pub lp_share: u128,
        pub cum_fee_a_per_share_at_deposit: u128,
        pub cum_fee_b_per_share_at_deposit: u128,
        pub nonce: Field,
        pub owner: AztecAddress,
    }

    /// Sub-2: sparse per-bucket delta the orderbook hands to apply_clearing.
    #[derive(Deserialize, Eq, Packable, Serialize)]
    pub struct BucketDelta {
        pub bucket_id: u32,
        pub reserve_a_add: u128,
        pub reserve_a_sub: u128,
        pub reserve_b_add: u128,
        pub reserve_b_sub: u128,
        pub cum_fee_a_per_share_increment: u128,
        pub cum_fee_b_per_share_increment: u128,
    }

    /// Sub-2: clearing swap relayed by the orderbook to the pool.
    /// Aggregate flows + sparse per-bucket deltas (MAX_ACTIVE_BUCKETS_PER_EPOCH=4).
    #[derive(Deserialize, Eq, Packable, Serialize)]
    pub struct ClearingSwap {
        pub a_to_pool: u128,
        pub b_to_pool: u128,
        pub a_from_pool: u128,
        pub b_from_pool: u128,
        pub active_bucket_deltas: [BucketDelta; 4],
        pub active_bucket_count: u32,
        pub current_sqrt_price_after: u128,
    }

    #[storage]
    struct Storage<Context> {
        positions: Owned<PrivateSet<PositionNote, Context>, Context>,
        pool_state: PublicMutable<PoolState, Context>,
        token_a_addr: PublicImmutable<AztecAddress, Context>,
        token_b_addr: PublicImmutable<AztecAddress, Context>,
        orderbook_addr: PublicMutable<AztecAddress, Context>,
        /// Sub-2: p_min and growth let us derive bucket bounds on demand
        /// (avoids storing a [BucketBounds; 16] PublicImmutable, which is
        /// awkward with aztec-nr 4.2.0's serialization).
        p_min_sqrt: PublicImmutable<u128, Context>,
        bucket_growth_num: PublicImmutable<u128, Context>,
        /// Sub-2: per-bucket state. Keyed by bucket_id in 0..NUM_BUCKETS.
        buckets: Map<u32, PublicMutable<BucketState, Context>, Context>,
    }

    /// Sub-2 deploy-time initializer.
    /// - p_min_sqrt: sqrt(P_min), 1e18-scaled (lower bound of bucket 0)
    /// - bucket_growth_num: per-bucket sqrt-multiplier, 1e18-scaled
    ///   (e.g., 1.5e18 = 1.5x sqrt growth, equivalent to 2.25x price growth per bucket)
    #[external("public")]
    #[initializer]
    fn constructor(
        token_a: AztecAddress,
        token_b: AztecAddress,
        p_min_sqrt: u128,
        bucket_growth_num: u128,
    ) {
        self.storage.token_a_addr.initialize(token_a);
        self.storage.token_b_addr.initialize(token_b);
        self.storage.p_min_sqrt.initialize(p_min_sqrt);
        self.storage.bucket_growth_num.initialize(bucket_growth_num);
        self.storage.pool_state.write(PoolState {
            reserve_a: 0 as u128,
            reserve_b: 0 as u128,
            current_sqrt_price: p_min_sqrt,
        });
        self.storage.orderbook_addr.write(AztecAddress::from_field(0));
        // bucket states default to all-zero (Map default).
    }

    // ============================ CLEARING WIRING ============================

    /// One-shot setter for the OrderbookContract address. The Pool is deployed
    /// before the Orderbook, so the address is wired in post-deploy. Settable
    /// exactly once (the stored value starts at the zero address), so it cannot
    /// be re-pointed later.
    #[external("public")]
    fn set_orderbook(orderbook: AztecAddress) {
        let current = self.storage.orderbook_addr.read();
        assert(current == AztecAddress::from_field(0), "orderbook already set");
        self.storage.orderbook_addr.write(orderbook);
    }

    /// Sub-2 apply_clearing. Rewritten in Task 10 to iterate BucketDelta[4].
    /// Stubbed during Task 7 storage migration; final logic in Task 10.
    #[external("public")]
    fn apply_clearing(_swap: ClearingSwap) {
        let orderbook = self.storage.orderbook_addr.read();
        assert(self.msg_sender() == orderbook, "not the orderbook");
        assert(false, "apply_clearing being rewritten in Task 10");
    }

    // ============================ DEPOSIT ============================

    /// Supply liquidity. `amount_a` / `amount_b` are the maxima the LP is willing to
    /// provide; the V2 ratio match uses only the proportional `used_a` / `used_b` and
    /// escrows exactly those (the unmatched remainder never leaves the LP's wallet).
    ///
    /// `hint` is the caller's snapshot of the live `PoolState`; the privately-computed
    /// shares are validated by `_apply_deposit`, which asserts the hint still matches
    /// the actual state at mine time.
    ///
    /// Note on overflow: the share-math products are plain `u128`. For the MVP's
    /// test-token amounts they never overflow; a pathologically large deposit would
    /// overflow and revert (a safe failure - no fund loss, no share inflation).
    /// Sub-2 deposit. Stubbed during Task 7 storage migration; rewritten with
    /// V3 math + refund pattern in Task 8. Uses real assertions on args so bb
    /// generates non-empty gates for VK computation.
    #[external("private")]
    fn deposit(
        bucket_id: u32,
        amount_a: u128, amount_b: u128,
        _hint_pool: PoolState, _hint_bucket: BucketState,
        _nonce_a: Field, _nonce_b: Field, _position_nonce: Field,
    ) {
        assert(bucket_id < NUM_BUCKETS, "deposit being rewritten in Task 8");
        assert(amount_a > 0 as u128 | amount_b > 0 as u128,
               "deposit being rewritten in Task 8");
    }

    // ============================ WITHDRAW ============================

    /// Sub-2 withdraw. Stubbed during Task 7 storage migration; rewritten with
    /// per-bucket fee accrual + underflow guards in Task 9. Uses real
    /// assertions for gate generation.
    #[external("private")]
    fn withdraw(
        position_nonce: Field,
        _hint_pool: PoolState,
        _hint_bucket: BucketState,
        _nonce_a: Field, _nonce_b: Field,
    ) {
        assert(position_nonce != 0, "withdraw being rewritten in Task 9");
    }

    // ============================ UNCONSTRAINED GETTERS ============================

    #[external("utility")]
    unconstrained fn get_pool_state() -> PoolState {
        self.storage.pool_state.read()
    }

    #[external("utility")]
    unconstrained fn get_token_a_addr() -> AztecAddress {
        self.storage.token_a_addr.read()
    }

    #[external("utility")]
    unconstrained fn get_token_b_addr() -> AztecAddress {
        self.storage.token_b_addr.read()
    }

    /// Resting LP positions owned by `owner` (up to MAX_NOTES_PER_PAGE, UNORDERED).
    /// `owner` is explicit because utility functions are simulated and only the owner's
    /// PXE can resolve the encrypted notes.
    #[external("utility")]
    unconstrained fn get_positions(owner: AztecAddress) -> BoundedVec<PositionNote, MAX_NOTES_PER_PAGE> {
        self.storage.positions.at(owner).view_notes(NoteViewerOptions::new())
    }

    pub mod buckets;
    pub mod test;
}
