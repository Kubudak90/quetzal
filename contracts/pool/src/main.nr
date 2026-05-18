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
            traits::{Deserialize, Packable, Serialize},
        },
        state_vars::{Owned, PrivateSet, PublicImmutable, PublicMutable},
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

    /// Public, mutable state of the pool. All five fields start at 0 (empty pool).
    /// `cum_fee_*_per_share` are scaled by `FEE_SCALE` and only ever move via clearing
    /// (Week 5b+); in Week 5 they remain 0.
    #[derive(Deserialize, Eq, Packable, Serialize)]
    pub struct PoolState {
        pub reserve_a: u128,
        pub reserve_b: u128,
        pub lp_supply: u128,
        pub cum_fee_a_per_share: u128,
        pub cum_fee_b_per_share: u128,
    }

    /// Private note representing one LP position.
    ///
    /// - `lp_share`: LP shares this position holds.
    /// - `cum_fee_*_per_share_at_deposit`: fee-counter snapshots taken at deposit; the
    ///   accrued-fee baseline for this position.
    /// - `nonce`: per-position random salt (identity / uniqueness).
    /// - `owner`: LP address (also the nullifier subject).
    #[derive(Deserialize, Eq, Packable, Serialize)]
    #[note]
    pub struct PositionNote {
        pub lp_share: u128,
        pub cum_fee_a_per_share_at_deposit: u128,
        pub cum_fee_b_per_share_at_deposit: u128,
        pub nonce: Field,
        pub owner: AztecAddress,
    }

    #[storage]
    struct Storage<Context> {
        positions: Owned<PrivateSet<PositionNote, Context>, Context>,
        pool_state: PublicMutable<PoolState, Context>,
        token_a_addr: PublicImmutable<AztecAddress, Context>,
        token_b_addr: PublicImmutable<AztecAddress, Context>,
    }

    /// Deploy-time initializer: records the two token addresses and opens an empty pool.
    #[external("public")]
    #[initializer]
    fn constructor(token_a: AztecAddress, token_b: AztecAddress) {
        self.storage.token_a_addr.initialize(token_a);
        self.storage.token_b_addr.initialize(token_b);
        self.storage.pool_state.write(PoolState {
            reserve_a: 0 as u128,
            reserve_b: 0 as u128,
            lp_supply: 0 as u128,
            cum_fee_a_per_share: 0 as u128,
            cum_fee_b_per_share: 0 as u128,
        });
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
    #[external("private")]
    fn deposit(
        amount_a: u128,
        amount_b: u128,
        hint: PoolState,
        nonce_a: Field,
        nonce_b: Field,
        position_nonce: Field,
    ) {
        assert(amount_a > 0 as u128, "amount_a must be positive");
        assert(amount_b > 0 as u128, "amount_b must be positive");
        let lp = self.msg_sender();

        let mut used_a = amount_a;
        let mut used_b = amount_b;
        let mut shares: u128 = 0 as u128;
        if hint.lp_supply == 0 as u128 {
            // First deposit sets the pool ratio; both maxima are used in full.
            shares = integer_sqrt(amount_a * amount_b);
            assert(shares > 0 as u128, "initial deposit too small");
        } else {
            let shares_from_a = amount_a * hint.lp_supply / hint.reserve_a;
            let shares_from_b = amount_b * hint.lp_supply / hint.reserve_b;
            if shares_from_a <= shares_from_b {
                shares = shares_from_a;
                used_a = amount_a;
                used_b = amount_a * hint.reserve_b / hint.reserve_a;
            } else {
                shares = shares_from_b;
                used_b = amount_b;
                used_a = amount_b * hint.reserve_a / hint.reserve_b;
            }
            assert(shares > 0 as u128, "deposit too small for any shares");
        }

        // Escrow exactly the used amounts: LP private balance -> pool PUBLIC balance.
        let token_a = self.storage.token_a_addr.read();
        let token_b = self.storage.token_b_addr.read();
        self.call(Token::at(token_a).transfer_private_to_public(lp, self.address, used_a, nonce_a));
        self.call(Token::at(token_b).transfer_private_to_public(lp, self.address, used_b, nonce_b));

        // Commit the private position note to the LP's set.
        let position = PositionNote {
            lp_share: shares,
            cum_fee_a_per_share_at_deposit: hint.cum_fee_a_per_share,
            cum_fee_b_per_share_at_deposit: hint.cum_fee_b_per_share,
            nonce: position_nonce,
            owner: lp,
        };
        self.storage.positions.at(lp).insert(position).deliver(MessageDelivery.ONCHAIN_CONSTRAINED);

        // Apply the reserve mutation publicly, validating the hint against live state.
        self.enqueue_self._apply_deposit(hint, used_a, used_b, shares);
    }

    /// Public callback: assert the deposit's hint still matches live state, then add
    /// the used amounts and minted shares to the pool. `only_self` - enqueued by
    /// `deposit` only.
    #[external("public")]
    #[only_self]
    fn _apply_deposit(hint: PoolState, used_a: u128, used_b: u128, shares: u128) {
        let actual = self.storage.pool_state.read();
        assert(actual == hint, "pool state changed; retry deposit");
        self.storage.pool_state.write(PoolState {
            reserve_a: actual.reserve_a + used_a,
            reserve_b: actual.reserve_b + used_b,
            lp_supply: actual.lp_supply + shares,
            cum_fee_a_per_share: actual.cum_fee_a_per_share,
            cum_fee_b_per_share: actual.cum_fee_b_per_share,
        });
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

    pub mod test;
}
