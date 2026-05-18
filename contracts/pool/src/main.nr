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
