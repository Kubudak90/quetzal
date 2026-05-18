# ZSwap-on-Aztec — Week 5: LiquidityPoolContract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `LiquidityPool`, a constant-product AMM Noir contract with private LP positions — `deposit` / `withdraw`, public reserves, the (inert until clearing) fee-accrual machinery — plus `zswap deposit` / `withdraw` / `positions` CLI commands.

**Architecture:** A new `contracts/pool/` Noir contract. Private functions cannot read `PublicMutable`, so `deposit`/`withdraw` take the live `PoolState` as a caller-supplied `hint`, do all arithmetic on it privately, and enqueue a public callback that asserts the hint equals the actual state before applying the reserve mutation (optimistic concurrency). LP-share math is Uniswap-V2: `sqrt(a·b)` initial, `min`-of-sides subsequent, with the unmatched remainder simply never escrowed.

**Tech Stack:** Noir / aztec-nr v4.2.0, Aztec 4.2.1, TypeScript (Node 22), `commander`, `node:test` + `tsx`, pnpm workspaces.

**Spec:** `docs/superpowers/specs/2026-05-18-zswap-aztec-week-05-liquidity-pool-design.md`

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `contracts/pool/Nargo.toml` | Noir package manifest for the pool contract | Create |
| `contracts/pool/src/main.nr` | The `LiquidityPool` contract | Create |
| `contracts/pool/src/test.nr` | TXE tests | Create |
| `cli/src/commands/deposit.ts` | `zswap deposit` | Create |
| `cli/src/commands/withdraw.ts` | `zswap withdraw` | Create |
| `cli/src/commands/positions.ts` | `zswap positions` | Create |
| `cli/src/index.ts` | Register the three commands | Modify |
| `cli/src/wallet.ts` | Register the `LiquidityPool` contract with the PXE | Modify |
| `cli/src/config.ts` | Add `pool` to `ZswapConfig` | Modify |
| `scripts/deploy-tokens.ts` | Deploy `LiquidityPool`, add `pool` to config | Modify |
| `tests/integration/pool.test.ts` | Pool integration suite | Create |
| `tests/integration/cli.test.ts` | `deposit`/`withdraw`/`positions` smoke case | Modify |
| `README.md` | Status line + CLI list + docs links | Modify |

`scripts/compile-all.sh` and `scripts/codegen.sh` already loop over `contracts/*/`, so the new `contracts/pool/` is compiled and codegen'd automatically — no script change. `pnpm-workspace.yaml` lists JS packages only; Noir contracts are not pnpm packages, so it needs no change. The codegen output for the `LiquidityPool` contract is `tests/integration/generated/LiquidityPool.ts`, exporting `LiquidityPoolContract`.

## Pre-flight

- [ ] Confirm `git status` is clean and `git tag -l | grep week-04` shows `week-04-epoch-transitions`.
- [ ] Confirm Docker is running (`docker info`).
- [ ] Read `contracts/orderbook/src/main.nr` — the pool mirrors its structure (imports, `#[aztec]` contract, `PrivateSet`/`PublicMutable`/`PublicImmutable` storage, `enqueue_self` callbacks, `pop_notes` for note retrieval, `#[external("utility")]` getters).

---

## Task 1: `contracts/pool/` scaffold — types, storage, constructor, getters

**Dispatch with model: sonnet.**

**Files:**
- Create: `contracts/pool/Nargo.toml`, `contracts/pool/src/main.nr`, `contracts/pool/src/test.nr`

- [ ] **Step 1: `contracts/pool/Nargo.toml`**

```toml
[package]
name = "pool"
type = "contract"
authors = [""]
compiler_version = ">=1.0.0"

[dependencies]
aztec = { git = "https://github.com/AztecProtocol/aztec-packages", tag = "v4.2.0", directory = "noir-projects/aztec-nr/aztec" }
token = { path = "../token" }
```

- [ ] **Step 2: `contracts/pool/src/main.nr` — scaffold**

Create the file with the contract shell: imports (copied from `contracts/orderbook/src/main.nr`'s `use aztec::{ ... }` block, which already imports everything needed — `NoteGetterOptions`, `NoteProperties`, `NoteViewerOptions`, `Comparator`, `MAX_NOTES_PER_PAGE`, the state-var types, `MessageDelivery`), the two types, storage, constructor, and the four getters. `deposit`/`withdraw`/`integer_sqrt` are added in later tasks.

```rust
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
```

Note: `FEE_SCALE`, `only_self`, `Comparator`, `NoteGetterOptions`, `NoteProperties`, `MessageDelivery`, `Token` are imported now but only used by the functions added in Tasks 2-4. Noir does not error on unused imports, but if it warns, leave them — the later tasks consume them. If the compiler hard-errors on a genuinely unused import in this task, comment that one import line with `// used by Task N` and uncomment it there.

- [ ] **Step 3: `contracts/pool/src/test.nr` — scaffold + 3 tests**

```rust
// TXE tests for the LiquidityPool contract.
// Run with: pnpm test:noir

use crate::LiquidityPool;
use crate::LiquidityPool::{PoolState, PositionNote};
use aztec::{
    protocol::{
        address::AztecAddress,
        traits::{Deserialize, Serialize},
    },
    test::helpers::test_environment::TestEnvironment,
};

// Helper: deploy a fresh LiquidityPool with the given token addresses, returning the
// deployed address. The `deployer` light account pushes the public initializer.
unconstrained fn deploy_pool(
    env: &mut TestEnvironment,
    deployer: AztecAddress,
    token_a: AztecAddress,
    token_b: AztecAddress,
) -> AztecAddress {
    let initializer_call = LiquidityPool::interface().constructor(token_a, token_b);
    env.deploy("LiquidityPool").with_public_initializer(deployer, initializer_call)
}

#[test]
unconstrained fn position_note_serialization_round_trip() {
    let note = PositionNote {
        lp_share: 1_000_000,
        cum_fee_a_per_share_at_deposit: 7,
        cum_fee_b_per_share_at_deposit: 9,
        nonce: 0x1234567890abcdef,
        owner: AztecAddress::from_field(0xdeadbeef),
    };

    let bytes = note.serialize();
    let back = PositionNote::deserialize(bytes);

    assert(back.lp_share == note.lp_share, "lp_share mismatch");
    assert(
        back.cum_fee_a_per_share_at_deposit == note.cum_fee_a_per_share_at_deposit,
        "cum_fee_a mismatch",
    );
    assert(
        back.cum_fee_b_per_share_at_deposit == note.cum_fee_b_per_share_at_deposit,
        "cum_fee_b mismatch",
    );
    assert(back.nonce == note.nonce, "nonce mismatch");
    assert(back.owner == note.owner, "owner mismatch");
}

#[test]
unconstrained fn constructor_initializes_empty_pool() {
    let mut env = TestEnvironment::new();
    let deployer = env.create_light_account();
    let token_a = env.create_light_account();
    let token_b = env.create_light_account();
    assert(token_a != token_b, "token_a and token_b must be distinct");

    let pool = deploy_pool(&mut env, deployer, token_a, token_b);

    let state: PoolState = env.execute_utility(LiquidityPool::at(pool).get_pool_state());
    assert(state.reserve_a == 0, "reserve_a must start 0");
    assert(state.reserve_b == 0, "reserve_b must start 0");
    assert(state.lp_supply == 0, "lp_supply must start 0");
    assert(state.cum_fee_a_per_share == 0, "cum_fee_a must start 0");
    assert(state.cum_fee_b_per_share == 0, "cum_fee_b must start 0");

    let stored_a: AztecAddress = env.execute_utility(LiquidityPool::at(pool).get_token_a_addr());
    let stored_b: AztecAddress = env.execute_utility(LiquidityPool::at(pool).get_token_b_addr());
    assert(stored_a == token_a, "stored token_a must round-trip");
    assert(stored_b == token_b, "stored token_b must round-trip");
}

#[test]
unconstrained fn get_positions_empty_for_fresh_account() {
    let mut env = TestEnvironment::new();
    let deployer = env.create_light_account();
    let pool = deploy_pool(&mut env, deployer, deployer, deployer);

    let owner = env.create_light_account();
    let positions = env.execute_utility(LiquidityPool::at(pool).get_positions(owner));
    assert(positions.len() == 0, "a fresh account must have no positions");
}
```

- [ ] **Step 4: Compile, codegen, run TXE tests**

```bash
pnpm compile
pnpm codegen
pnpm test:noir
```

Expected:
- compile: `All contracts compiled.` (now three contracts: token, orderbook, pool).
- codegen: `LiquidityPool.ts` appears among the generated files.
- `pnpm test:noir`: `[pool] 3 tests passed`, plus the unchanged `[orderbook] 10 tests passed` and `[token] 4 tests passed`.

- [ ] **Step 5: Commit**

```bash
git add contracts/pool/
git commit -m "feat(pool): LiquidityPool scaffold — types, storage, constructor, getters"
```

---

## Task 2: `integer_sqrt` helper

**Dispatch with model: opus** — circuit-safe integer arithmetic with an unconstrained hint is novel surface.

**Files:**
- Modify: `contracts/pool/src/main.nr`, `contracts/pool/src/test.nr`

- [ ] **Step 1: API discovery — unconstrained hints in Noir/aztec v4.2.0**

`integer_sqrt` computes `floor(sqrt(x))` via an unconstrained hint verified by constraints. Confirm the v4.2.0 spelling:
- How a constrained function calls an `unconstrained fn` — expected: `// Safety: <reason>` comment then `unsafe { hint_fn(x) }`.
- That `unconstrained fn` may contain a bounded `for` loop.
- `u128` division is integer (floor) division in Noir (it is — confirm).

Check the aztec-nr / Noir v4.2.0 docs or existing contracts. The code below is the expected shape; adjust the `unsafe`/`unconstrained` spelling to what v4.2.0 requires. The compile + the TXE test in Step 3 are the source of truth.

- [ ] **Step 2: `main.nr` — add `integer_sqrt` and its hint**

Insert at the contract-module level, after the `FEE_SCALE` global and before the `PoolState` struct:

```rust
    /// Unconstrained hint: computes `floor(sqrt(x))` by binary search. Its result is
    /// NOT trusted — `integer_sqrt` constrains it.
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
    pub fn integer_sqrt(x: u128) -> u128 {
        // Safety: `s` is verified to be floor(sqrt(x)) by the two asserts below.
        let s = unsafe { sqrt_hint(x) };
        let sq = s * s;
        assert(sq <= x, "integer_sqrt: hint too large");
        assert(x - sq <= 2 as u128 * s, "integer_sqrt: hint too small");
        s
    }
```

- [ ] **Step 3: `test.nr` — add the `integer_sqrt` test**

Add to the imports at the top of `test.nr`: change `use crate::LiquidityPool::{PoolState, PositionNote};` to `use crate::LiquidityPool::{integer_sqrt, PoolState, PositionNote};`.

Append this test:

```rust
#[test]
unconstrained fn integer_sqrt_is_correct() {
    // Exact squares.
    assert(integer_sqrt(0 as u128) == 0 as u128, "sqrt(0)");
    assert(integer_sqrt(1 as u128) == 1 as u128, "sqrt(1)");
    assert(integer_sqrt(4 as u128) == 2 as u128, "sqrt(4)");
    assert(integer_sqrt(144 as u128) == 12 as u128, "sqrt(144)");
    assert(integer_sqrt(1_000_000 as u128) == 1_000 as u128, "sqrt(1e6)");

    // Non-squares: floor.
    assert(integer_sqrt(2 as u128) == 1 as u128, "sqrt(2) floors to 1");
    assert(integer_sqrt(3 as u128) == 1 as u128, "sqrt(3) floors to 1");
    assert(integer_sqrt(8 as u128) == 2 as u128, "sqrt(8) floors to 2");
    assert(integer_sqrt(143 as u128) == 11 as u128, "sqrt(143) floors to 11");

    // Large value: 10^24 = (10^12)^2.
    let big: u128 = 1_000_000_000_000_000_000_000_000;
    assert(integer_sqrt(big) == 1_000_000_000_000 as u128, "sqrt(1e24)");
}
```

- [ ] **Step 4: Compile + run TXE tests**

```bash
pnpm compile
pnpm test:noir
```

Expected: `[pool] 4 tests passed` (the 3 from Task 1 + `integer_sqrt_is_correct`), `[orderbook] 10`, `[token] 4`.

- [ ] **Step 5: Commit**

```bash
git add contracts/pool/src/main.nr contracts/pool/src/test.nr
git commit -m "feat(pool): constrained integer_sqrt helper"
```

---

## Task 3: `deposit` + `_apply_deposit`

**Dispatch with model: opus** — the V2 share math and the hint-validate flow need care.

**Files:**
- Modify: `contracts/pool/src/main.nr`, `contracts/pool/src/test.nr`

- [ ] **Step 1: `main.nr` — add `deposit` and `_apply_deposit`**

Insert after `integer_sqrt` and before the `// === UNCONSTRAINED GETTERS ===` section:

```rust
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
    /// overflow and revert (a safe failure — no fund loss, no share inflation).
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
    /// the used amounts and minted shares to the pool. `only_self` — enqueued by
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
```

- [ ] **Step 2: Compile**

Run: `pnpm compile`
Expected: `All contracts compiled.`

- [ ] **Step 3: `test.nr` — add deposit input-validation tests**

Only the pre-cross-call asserts run in pure TXE (a real Token is not deployed in the pool's TXE harness — the Week 2-4 constraint). Happy-path deposit is integration-tested in Task 5.

`deposit` needs a `PoolState` argument; add a small zero-state helper and two negative tests. Append to `test.nr`:

```rust
// A zeroed PoolState, usable as the `hint` for first-deposit / negative tests.
unconstrained fn zero_pool_state() -> PoolState {
    PoolState {
        reserve_a: 0 as u128,
        reserve_b: 0 as u128,
        lp_supply: 0 as u128,
        cum_fee_a_per_share: 0 as u128,
        cum_fee_b_per_share: 0 as u128,
    }
}

#[test(should_fail_with = "amount_a must be positive")]
unconstrained fn deposit_rejects_zero_amount_a() {
    let mut env = TestEnvironment::new();
    let deployer = env.create_light_account();
    let pool = deploy_pool(&mut env, deployer, deployer, deployer);
    let lp = env.create_light_account();

    // amount_a = 0 must revert before any token-contract call.
    env.call_private(
        lp,
        LiquidityPool::at(pool).deposit(0 as u128, 100 as u128, zero_pool_state(), 0, 0, 0),
    );
}

#[test(should_fail_with = "amount_b must be positive")]
unconstrained fn deposit_rejects_zero_amount_b() {
    let mut env = TestEnvironment::new();
    let deployer = env.create_light_account();
    let pool = deploy_pool(&mut env, deployer, deployer, deployer);
    let lp = env.create_light_account();

    // amount_a passes; amount_b = 0 must revert.
    env.call_private(
        lp,
        LiquidityPool::at(pool).deposit(100 as u128, 0 as u128, zero_pool_state(), 0, 0, 0),
    );
}
```

- [ ] **Step 4: Run TXE tests**

Run: `pnpm test:noir`
Expected: `[pool] 6 tests passed` (4 + 2 new), `[orderbook] 10`, `[token] 4`.

- [ ] **Step 5: Commit**

```bash
git add contracts/pool/src/main.nr contracts/pool/src/test.nr
git commit -m "feat(pool): deposit with V2 share math + hint-validated reserve update"
```

---

## Task 4: `withdraw` + `_apply_withdraw`

**Dispatch with model: sonnet** — `withdraw` mirrors `deposit` (Task 3) and `cancel_order`.

**Files:**
- Modify: `contracts/pool/src/main.nr`, `contracts/pool/src/test.nr`

- [ ] **Step 1: `main.nr` — add `withdraw` and `_apply_withdraw`**

Insert after `_apply_deposit` and before the `// === UNCONSTRAINED GETTERS ===` section. `withdraw` takes no authwit nonces: its token calls are `transfer_public_to_private` with `from = self.address` (a self-call), and the `authorize_once` guard requires the nonce to be `0` in that case — so `withdraw` passes literal `0` and exposes no nonce parameter.

```rust
    // ============================ WITHDRAW ============================

    /// Burn an LP position and reclaim principal (+ accrued fees) to the LP's PRIVATE
    /// balance. All-or-nothing: the whole `PositionNote` is nullified.
    ///
    /// `hint` is the caller's snapshot of the live `PoolState`; `_apply_withdraw`
    /// asserts it still matches at mine time. In Week 5 `cum_fee_*` are 0, so the fee
    /// terms are 0 and the payout is principal only.
    #[external("private")]
    fn withdraw(position_nonce: Field, hint: PoolState) {
        let lp = self.msg_sender();
        assert(hint.lp_supply > 0 as u128, "pool is empty");

        // Retrieve + nullify the LP's position note matching `position_nonce`.
        let options = NoteGetterOptions::new().select(
            PositionNote::properties().nonce,
            Comparator.EQ,
            position_nonce,
        ).set_limit(1);
        let notes = self.storage.positions.at(lp).pop_notes(options);
        assert(notes.len() == 1, "position not found");
        let position = notes.get(0);
        assert(position.owner == lp, "not position owner");

        // Principal is the position's pro-rata slice of reserves; fees are the
        // MasterChef delta since deposit (0 in Week 5).
        let principal_a = position.lp_share * hint.reserve_a / hint.lp_supply;
        let principal_b = position.lp_share * hint.reserve_b / hint.lp_supply;
        let fees_a =
            position.lp_share * (hint.cum_fee_a_per_share - position.cum_fee_a_per_share_at_deposit)
            / FEE_SCALE;
        let fees_b =
            position.lp_share * (hint.cum_fee_b_per_share - position.cum_fee_b_per_share_at_deposit)
            / FEE_SCALE;
        let payout_a = principal_a + fees_a;
        let payout_b = principal_b + fees_b;

        // Return the escrow: pool PUBLIC balance -> LP PRIVATE balance. `from` is this
        // contract (a self-call), so the authwit nonce MUST be 0.
        let token_a = self.storage.token_a_addr.read();
        let token_b = self.storage.token_b_addr.read();
        self.call(Token::at(token_a).transfer_public_to_private(self.address, lp, payout_a, 0));
        self.call(Token::at(token_b).transfer_public_to_private(self.address, lp, payout_b, 0));

        self.enqueue_self._apply_withdraw(hint, payout_a, payout_b, position.lp_share);
    }

    /// Public callback: assert the withdraw's hint still matches live state, then
    /// subtract the payouts and burned shares from the pool. `only_self`.
    #[external("public")]
    #[only_self]
    fn _apply_withdraw(hint: PoolState, payout_a: u128, payout_b: u128, shares: u128) {
        let actual = self.storage.pool_state.read();
        assert(actual == hint, "pool state changed; retry withdraw");
        self.storage.pool_state.write(PoolState {
            reserve_a: actual.reserve_a - payout_a,
            reserve_b: actual.reserve_b - payout_b,
            lp_supply: actual.lp_supply - shares,
            cum_fee_a_per_share: actual.cum_fee_a_per_share,
            cum_fee_b_per_share: actual.cum_fee_b_per_share,
        });
    }
```

- [ ] **Step 2: Compile**

Run: `pnpm compile`
Expected: `All contracts compiled.`

- [ ] **Step 3: `test.nr` — add the withdraw negative test**

`withdraw` with a nonce matching no position reverts at note retrieval, before any Token call — TXE-safe. Append:

```rust
#[test(should_fail_with = "position not found")]
unconstrained fn withdraw_rejects_unknown_nonce() {
    let mut env = TestEnvironment::new();
    let deployer = env.create_light_account();
    let pool = deploy_pool(&mut env, deployer, deployer, deployer);
    let lp = env.create_light_account();

    // A non-empty hint passes the "pool is empty" guard; no position exists, so the
    // "position not found" assertion fires during note retrieval.
    let hint = PoolState {
        reserve_a: 100 as u128,
        reserve_b: 100 as u128,
        lp_supply: 100 as u128,
        cum_fee_a_per_share: 0 as u128,
        cum_fee_b_per_share: 0 as u128,
    };
    env.call_private(lp, LiquidityPool::at(pool).withdraw(0x9999, hint));
}
```

- [ ] **Step 4: Run TXE tests**

Run: `pnpm test:noir`
Expected: `[pool] 7 tests passed` (6 + 1 new), `[orderbook] 10`, `[token] 4`.

- [ ] **Step 5: Commit**

```bash
git add contracts/pool/src/main.nr contracts/pool/src/test.nr
git commit -m "feat(pool): withdraw — burn position, return principal + fees"
```

---

## Task 5: Pool integration tests

**Dispatch with model: sonnet.**

**Files:**
- Create: `tests/integration/pool.test.ts`

- [ ] **Step 1: Regenerate bindings**

Run: `pnpm codegen`
Expected: `LiquidityPool.ts` present in `tests/integration/generated/`.

- [ ] **Step 2: Create `tests/integration/pool.test.ts`**

A new suite against the live dev stack. It mirrors `tests/integration/orderbook.test.ts`'s shape (helpers `readPrivateBalance` / `readPublicBalance` / `randomField`, `connectToSandbox`, `getTestWallets`). `deposit` takes the live pool state as a `hint` — read it via `get_pool_state().simulate(...)` and pass `sim.result`.

```ts
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import type { AztecAddress } from "@aztec/aztec.js/addresses";
import type { AztecNode } from "@aztec/aztec.js/node";
import type { EmbeddedWallet } from "@aztec/wallets/embedded";

import { connectToSandbox } from "./helpers/sandbox.js";
import { getTestWallets } from "./helpers/wallets.js";
import { TokenContract } from "./generated/Token.js";
import { LiquidityPoolContract } from "./generated/LiquidityPool.js";

const TUSDC_DECIMALS = 6;
const ONE_TUSDC = 10n ** BigInt(TUSDC_DECIMALS);
const TETH_DECIMALS = 18;
const ONE_TETH = 10n ** BigInt(TETH_DECIMALS);

// Mints. Alice and Bob each get generous balances of both tokens.
const MINT_USDC = 1_000_000n * ONE_TUSDC;
const MINT_ETH = 1_000n * ONE_TETH;

function randomField(): bigint {
  const buf = new Uint8Array(31);
  webcrypto.getRandomValues(buf);
  let n = 0n;
  for (const byte of buf) n = (n << 8n) | BigInt(byte);
  return n;
}

interface PoolState {
  reserve_a: bigint;
  reserve_b: bigint;
  lp_supply: bigint;
  cum_fee_a_per_share: bigint;
  cum_fee_b_per_share: bigint;
}

// `get_pool_state` returns a Noir struct; the ABI decoder yields a plain object,
// `.simulate()` wraps it in { result }.
async function readPoolState(pool: LiquidityPoolContract, from: AztecAddress): Promise<PoolState> {
  const sim = await pool.methods.get_pool_state().simulate({ from });
  const r = (sim as { result: Record<string, bigint | number> }).result;
  return {
    reserve_a: BigInt(r.reserve_a),
    reserve_b: BigInt(r.reserve_b),
    lp_supply: BigInt(r.lp_supply),
    cum_fee_a_per_share: BigInt(r.cum_fee_a_per_share),
    cum_fee_b_per_share: BigInt(r.cum_fee_b_per_share),
  };
}

async function readPrivateBalance(token: TokenContract, owner: AztecAddress): Promise<bigint> {
  const sim = await token.methods.balance_of_private(owner).simulate({ from: owner });
  return BigInt(sim.result as bigint | number);
}

async function readPublicBalance(
  token: TokenContract, owner: AztecAddress, from: AztecAddress,
): Promise<bigint> {
  const sim = await token.methods.balance_of_public(owner).simulate({ from });
  return BigInt(sim.result as bigint | number);
}

// Integer sqrt over bigint — the expected initial-share value.
function bigintSqrt(x: bigint): bigint {
  if (x < 2n) return x;
  let lo = 1n, hi = x;
  while (lo < hi) {
    const mid = lo + (hi - lo + 1n) / 2n;
    if (mid * mid <= x) lo = mid;
    else hi = mid - 1n;
  }
  return lo;
}

describe("pool (live integration)", () => {
  let node: AztecNode;
  let wallet: EmbeddedWallet;
  let admin: AztecAddress;
  let alice: AztecAddress;
  let bob: AztecAddress;
  let tUSDC: TokenContract;
  let tETH: TokenContract;
  let pool: LiquidityPoolContract;

  before(async () => {
    node = await connectToSandbox();
    const env = await getTestWallets(node, 3);
    wallet = env.wallet;
    admin = env.accounts[0]!;
    alice = env.accounts[1]!;
    bob = env.accounts[2]!;

    const dU = await TokenContract.deployWithOpts(
      { wallet, method: "constructor_with_minter" },
      "tUSDC".padEnd(31, "\0"), "tUSDC".padEnd(31, "\0"), TUSDC_DECIMALS, admin,
    ).send({ from: admin });
    tUSDC = dU.contract;

    const dE = await TokenContract.deployWithOpts(
      { wallet, method: "constructor_with_minter" },
      "tETH".padEnd(31, "\0"), "tETH".padEnd(31, "\0"), TETH_DECIMALS, admin,
    ).send({ from: admin });
    tETH = dE.contract;

    const dP = await LiquidityPoolContract.deploy(
      wallet, tUSDC.address, tETH.address,
    ).send({ from: admin });
    pool = dP.contract;

    for (const who of [alice, bob]) {
      await tUSDC.methods.mint_to_private(who, MINT_USDC).send({ from: admin });
      await tETH.methods.mint_to_private(who, MINT_ETH).send({ from: admin });
    }
  });

  after(async () => {
    const stop = (wallet as unknown as { stop?: () => Promise<void> }).stop;
    if (typeof stop === "function") await stop.call(wallet);
  });

  // Deposit amounts. The pool ratio is fixed by Alice's first deposit at 100k:1.
  const ALICE_A = 100_000n * ONE_TUSDC;
  const ALICE_B = 1n * ONE_TETH;

  it("first deposit sets reserves and mints sqrt(a*b) shares", { timeout: 600_000 }, async () => {
    const hint = await readPoolState(pool, admin);
    assert.equal(hint.lp_supply, 0n, "precondition: empty pool");

    await pool.methods
      .deposit(ALICE_A, ALICE_B, hint, randomField(), randomField(), randomField())
      .send({ from: alice });

    const state = await readPoolState(pool, admin);
    assert.equal(state.reserve_a, ALICE_A, "reserve_a == alice's token A");
    assert.equal(state.reserve_b, ALICE_B, "reserve_b == alice's token B");
    assert.equal(state.lp_supply, bigintSqrt(ALICE_A * ALICE_B), "lp_supply == floor(sqrt(a*b))");
    assert.equal(
      await readPublicBalance(tUSDC, pool.address, admin), ALICE_A,
      "pool holds alice's token A",
    );
  });

  it("second LP at the pool ratio gets proportional shares", { timeout: 600_000 }, async () => {
    const hint = await readPoolState(pool, admin);
    // Bob deposits at exactly the current ratio: half of each reserve.
    const bobA = hint.reserve_a / 2n;
    const bobB = hint.reserve_b / 2n;
    const expectedShares = bobA * hint.lp_supply / hint.reserve_a;

    await pool.methods
      .deposit(bobA, bobB, hint, randomField(), randomField(), randomField())
      .send({ from: bob });

    const state = await readPoolState(pool, admin);
    assert.equal(state.lp_supply, hint.lp_supply + expectedShares, "lp_supply grew proportionally");
    assert.equal(state.reserve_a, hint.reserve_a + bobA, "reserve_a grew by bob's A");
    assert.equal(state.reserve_b, hint.reserve_b + bobB, "reserve_b grew by bob's B");
  });

  it("off-ratio deposit escrows only the matched amount", { timeout: 600_000 }, async () => {
    const hint = await readPoolState(pool, admin);
    // Bob offers token A matching 1/10 of reserve_a, but DOUBLE the matching token B.
    const bobA = hint.reserve_a / 10n;
    const matchedB = bobA * hint.reserve_b / hint.reserve_a;
    const bobB = matchedB * 2n;

    const bobUsdcBefore = await readPrivateBalance(tUSDC, bob);
    const bobEthBefore = await readPrivateBalance(tETH, bob);

    await pool.methods
      .deposit(bobA, bobB, hint, randomField(), randomField(), randomField())
      .send({ from: bob });

    const bobUsdcAfter = await readPrivateBalance(tUSDC, bob);
    const bobEthAfter = await readPrivateBalance(tETH, bob);
    // token A is the limiting side -> all of bobA used; token B -> only matchedB used.
    assert.equal(bobUsdcBefore - bobUsdcAfter, bobA, "all of bob's offered token A is used");
    assert.equal(bobEthBefore - bobEthAfter, matchedB, "only the matched token B is used");
  });

  it("withdraw returns principal and nullifies the position", { timeout: 600_000 }, async () => {
    // Fresh deposit by alice with a known nonce, then withdraw it.
    const depHint = await readPoolState(pool, admin);
    const posNonce = randomField();
    const depA = 10_000n * ONE_TUSDC;
    const depB = depA * depHint.reserve_b / depHint.reserve_a;

    const usdcBefore = await readPrivateBalance(tUSDC, alice);
    await pool.methods
      .deposit(depA, depB, depHint, randomField(), randomField(), posNonce)
      .send({ from: alice });

    const wHint = await readPoolState(pool, admin);
    await pool.methods.withdraw(posNonce, wHint).send({ from: alice });

    const usdcAfter = await readPrivateBalance(tUSDC, alice);
    // Alice gets back ~her principal (V2 rounding may lose a few base units).
    const delta = usdcBefore > usdcAfter ? usdcBefore - usdcAfter : usdcAfter - usdcBefore;
    assert.ok(delta <= 10n, `alice's token A is restored within rounding dust (delta=${delta})`);

    const positions = await pool.methods.get_positions(alice).simulate({ from: alice });
    const bv = (positions as { result: { storage: { nonce: bigint }[]; len: bigint } }).result;
    const nonces = bv.storage.slice(0, Number(bv.len)).map((p) => BigInt(p.nonce));
    assert.ok(!nonces.includes(posNonce), "the withdrawn position is gone");
  });

  it("withdraw of an unknown nonce is rejected", { timeout: 600_000 }, async () => {
    const hint = await readPoolState(pool, admin);
    await assert.rejects(
      pool.methods.withdraw(randomField(), hint).send({ from: alice }),
      /position not found/i,
      "withdrawing a non-existent position must revert",
    );
  });
});
```

- [ ] **Step 3: Run the integration suite**

Start the dev stack in another terminal: `bash scripts/dev.sh` (wait until `http://localhost:8080/status` answers).

Run: `pnpm test`
Expected: `pass 22` — the 17 prior integration tests plus the 5 new pool tests. `fail 0`.

Stop the dev stack: `bash scripts/dev.sh --down`.

- [ ] **Step 4: Commit**

```bash
git add tests/integration/pool.test.ts
git commit -m "test(pool): deposit/withdraw integration tests"
```

---

## Task 6: CLI commands + config + deploy script

**Dispatch with model: sonnet.**

**Files:**
- Create: `cli/src/commands/deposit.ts`, `cli/src/commands/withdraw.ts`, `cli/src/commands/positions.ts`
- Modify: `cli/src/index.ts`, `cli/src/wallet.ts`, `cli/src/config.ts`, `scripts/deploy-tokens.ts`, `tests/integration/cli.test.ts`

- [ ] **Step 1: `cli/src/config.ts` — add `pool` to the config type**

In `ZswapConfig`, add a `pool: string` field, and add `"pool"` to the `REQUIRED` array. The interface becomes:

```ts
export interface ZswapConfig {
  nodeUrl: string;
  tUSDC: string;
  tETH: string;
  orderbook: string;
  pool: string;
  admin: string;
}

const REQUIRED: (keyof ZswapConfig)[] = ["nodeUrl", "tUSDC", "tETH", "orderbook", "pool", "admin"];
```

- [ ] **Step 2: `cli/src/wallet.ts` — register the pool contract**

`openCli` registers each deployed contract with the fresh PXE. Add the import and a fourth entry to the registration loop. Add near the other generated-binding import:

```ts
import { LiquidityPoolContract } from "../../tests/integration/generated/LiquidityPool.js";
```

Change the `contracts` array (currently `[config.orderbook, "orderbook"], [config.tUSDC, "tUSDC"], [config.tETH, "tETH"]`) to also include the pool, and extend the label union and the artifact selection:

```ts
  const contracts: [string, "orderbook" | "pool" | "tUSDC" | "tETH"][] = [
    [config.orderbook, "orderbook"],
    [config.pool, "pool"],
    [config.tUSDC, "tUSDC"],
    [config.tETH, "tETH"],
  ];
  for (const [addr, label] of contracts) {
    const instance = await node.getContract(AztecAddress.fromString(addr));
    if (!instance) {
      throw new Error(`${label} contract not found on-chain at ${addr} — is the config stale?`);
    }
    let artifact;
    if (label === "orderbook") artifact = OrderbookContract.artifact;
    else if (label === "pool") artifact = LiquidityPoolContract.artifact;
    else artifact = TokenContract.artifact;
    await wallet.registerContract(instance, artifact);
  }
```

- [ ] **Step 3: `cli/src/commands/deposit.ts`**

```ts
import type { Command } from "commander";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { LiquidityPoolContract } from "../../../tests/integration/generated/LiquidityPool.js";
import { loadConfig } from "../config.js";
import { openCli } from "../wallet.js";
import { randomField } from "../field.js";

export function registerDeposit(program: Command): void {
  program
    .command("deposit")
    .description("supply liquidity to the pool")
    .requiredOption("--amount-a <n>", "max token A to supply (smallest unit)")
    .requiredOption("--amount-b <n>", "max token B to supply (smallest unit)")
    .action(async (_opts, cmd: Command) => {
      const opts = cmd.optsWithGlobals();
      const amountA = BigInt(opts.amountA);
      const amountB = BigInt(opts.amountB);

      const config = loadConfig(opts.config);
      const ctx = await openCli(config, Number(opts.account));
      try {
        const pool = await LiquidityPoolContract.at(
          AztecAddress.fromString(config.pool),
          ctx.wallet,
        );
        const sim = await pool.methods.get_pool_state().simulate({ from: ctx.account });
        const hint = (sim as { result: unknown }).result;

        const positionNonce = randomField();
        await pool.methods
          .deposit(amountA, amountB, hint, randomField(), randomField(), positionNonce)
          .send({ from: ctx.account });

        console.log(`liquidity deposited (max A ${amountA}, max B ${amountB})`);
        console.log(`position nonce: 0x${positionNonce.toString(16)}`);
        console.log(`withdraw later with: zswap withdraw --nonce 0x${positionNonce.toString(16)}`);
      } finally {
        await ctx.stop();
      }
    });
}
```

- [ ] **Step 4: `cli/src/commands/withdraw.ts`**

```ts
import type { Command } from "commander";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { LiquidityPoolContract } from "../../../tests/integration/generated/LiquidityPool.js";
import { loadConfig } from "../config.js";
import { openCli } from "../wallet.js";
import { parseField } from "../field.js";

export function registerWithdraw(program: Command): void {
  program
    .command("withdraw")
    .description("burn an LP position and reclaim its liquidity")
    .requiredOption("--nonce <field>", "position nonce (from `zswap deposit` / `zswap positions`)")
    .action(async (_opts, cmd: Command) => {
      const opts = cmd.optsWithGlobals();
      const positionNonce = parseField(String(opts.nonce));

      const config = loadConfig(opts.config);
      const ctx = await openCli(config, Number(opts.account));
      try {
        const pool = await LiquidityPoolContract.at(
          AztecAddress.fromString(config.pool),
          ctx.wallet,
        );
        const sim = await pool.methods.get_pool_state().simulate({ from: ctx.account });
        const hint = (sim as { result: unknown }).result;

        await pool.methods.withdraw(positionNonce, hint).send({ from: ctx.account });
        console.log(`position 0x${positionNonce.toString(16)} withdrawn; liquidity returned`);
      } finally {
        await ctx.stop();
      }
    });
}
```

- [ ] **Step 5: `cli/src/commands/positions.ts`**

```ts
import type { Command } from "commander";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { LiquidityPoolContract } from "../../../tests/integration/generated/LiquidityPool.js";
import { loadConfig } from "../config.js";
import { openCli } from "../wallet.js";

interface PositionRow {
  nonce: bigint;
  lp_share: bigint;
  cum_fee_a_per_share_at_deposit: bigint;
  cum_fee_b_per_share_at_deposit: bigint;
}

// `get_positions` returns a Noir BoundedVec<PositionNote, 10> -> { storage, len }.
function normalise(result: unknown): PositionRow[] {
  const bv = result as { storage: unknown[]; len: bigint | number };
  const len = Number(bv.len);
  return bv.storage.slice(0, len).map((o) => {
    const r = o as Record<string, bigint | number>;
    return {
      nonce: BigInt(r.nonce),
      lp_share: BigInt(r.lp_share),
      cum_fee_a_per_share_at_deposit: BigInt(r.cum_fee_a_per_share_at_deposit),
      cum_fee_b_per_share_at_deposit: BigInt(r.cum_fee_b_per_share_at_deposit),
    };
  });
}

export function registerPositions(program: Command): void {
  program
    .command("positions")
    .description("list the account's LP positions")
    .action(async (_opts, cmd: Command) => {
      const opts = cmd.optsWithGlobals();
      const config = loadConfig(opts.config);
      const ctx = await openCli(config, Number(opts.account));
      try {
        const pool = await LiquidityPoolContract.at(
          AztecAddress.fromString(config.pool),
          ctx.wallet,
        );
        const sim = await pool.methods.get_positions(ctx.account).simulate({ from: ctx.account });
        const rows = normalise((sim as { result: unknown }).result);

        if (rows.length === 0) {
          console.log("no LP positions");
          return;
        }
        console.log(`LP positions for account ${opts.account}:`);
        for (const r of rows) {
          console.log(`  nonce=0x${r.nonce.toString(16)}  lp_share=${r.lp_share}`);
        }
      } finally {
        await ctx.stop();
      }
    });
}
```

- [ ] **Step 6: `cli/src/index.ts` — register the three commands**

Add the imports alongside the others:

```ts
import { registerDeposit } from "./commands/deposit.js";
import { registerWithdraw } from "./commands/withdraw.js";
import { registerPositions } from "./commands/positions.js";
```

And register them after `registerCloseEpoch(program)`:

```ts
registerDeposit(program);
registerWithdraw(program);
registerPositions(program);
```

- [ ] **Step 7: `scripts/deploy-tokens.ts` — deploy the pool**

Add the import alongside the `OrderbookContract` import:

```ts
import { LiquidityPoolContract } from "../tests/integration/generated/LiquidityPool.js";
```

After the Orderbook deploy (the `deployedOB` block), add the pool deploy:

```ts
  const deployedPool = await LiquidityPoolContract.deploy(
    wallet,
    tokenA.contract.address,
    tokenB.contract.address,
  ).send({ from: admin });
```

Add `pool` to the `result` object (between `orderbook` and `admin`):

```ts
    orderbook: deployedOB.contract.address.toString(),
    pool: deployedPool.contract.address.toString(),
    admin: admin.toString(),
```

- [ ] **Step 8: Typecheck the CLI**

Run: `pnpm --filter @zswap/cli typecheck`
Expected: no errors.

- [ ] **Step 9: `tests/integration/cli.test.ts` — add a pool smoke case**

The smoke test's `before` deploys Token×2 + Orderbook and writes a config. It must now also deploy the pool and put `pool` in the config, and mint both tokens to `admin` so `deposit` has balance.

Add the import:

```ts
import { LiquidityPoolContract } from "./generated/LiquidityPool.js";
```

Add a `pool` describe-scoped variable: `let pool: LiquidityPoolContract;`.

In `before`, after the orderbook deploy, add the pool deploy and a tETH mint to admin (the round-trip already mints tUSDC; the pool needs both):

```ts
    const dP = await LiquidityPoolContract.deploy(
      wallet, tUSDC.address, tETH.address,
    ).send({ from: admin });
    pool = dP.contract;

    await tETH.methods.mint_to_private(admin, MINT).send({ from: admin });
```

Add `pool: pool.address.toString(),` to the object written to `CONFIG_PATH` (between `orderbook` and `admin`).

Add this test case inside the `describe`, after the `close-epoch` case:

```ts
  it("deposit -> positions -> withdraw round-trip", { timeout: 600_000 }, async () => {
    const depositOut = zswap(
      "deposit", "--amount-a", (1000n * 10n ** 6n).toString(), "--amount-b", (10n ** 18n).toString(),
    );
    const nonceMatch = depositOut.match(/position nonce:\s*(0x[0-9a-fA-F]+)/);
    assert.ok(nonceMatch, `\`zswap deposit\` should print a position nonce; got:\n${depositOut}`);
    const nonce = nonceMatch![1]!;

    const listed = zswap("positions");
    assert.match(listed, new RegExp(nonce, "i"), "the new position must appear in `zswap positions`");

    const withdrawOut = zswap("withdraw", "--nonce", nonce);
    assert.match(withdrawOut, /withdrawn/i, "`zswap withdraw` should confirm the withdrawal");

    const afterList = zswap("positions");
    assert.match(afterList, /no LP positions/i, "positions must be empty after withdraw");
  });
```

- [ ] **Step 10: Run the integration suite**

Start the dev stack (`bash scripts/dev.sh`), wait until ready.

Run: `pnpm test`
Expected: `pass 23` — 22 from Task 5 plus the new pool CLI smoke case. `fail 0`.

Stop the dev stack: `bash scripts/dev.sh --down`.

- [ ] **Step 11: Commit**

```bash
git add cli/src/commands/deposit.ts cli/src/commands/withdraw.ts cli/src/commands/positions.ts cli/src/index.ts cli/src/wallet.ts cli/src/config.ts scripts/deploy-tokens.ts tests/integration/cli.test.ts
git commit -m "feat(cli): zswap deposit/withdraw/positions + pool in deploy script"
```

---

## Task 7: Final clean rebuild + Week 5 milestone

**Dispatch with model: sonnet.**

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Clean rebuild from scratch**

```bash
rm -rf node_modules contracts/*/target tests/integration/generated tests/node_modules cli/node_modules codegenCache.json zswap.config.json
pnpm install
pnpm compile
pnpm codegen
pnpm test:noir
```

Expected:
- compile: `All contracts compiled.`
- codegen: `Token.ts`, `Orderbook.ts`, `LiquidityPool.ts` generated.
- `pnpm test:noir`: `[pool] 7 tests passed`, `[orderbook] 10 tests passed`, `[token] 4 tests passed`.

- [ ] **Step 2: Integration smoke**

Start `bash scripts/dev.sh` in another terminal; wait until ready.

```bash
pnpm test
pnpm tsx scripts/deploy-tokens.ts
```

Expected:
- `pnpm test`: `pass 23`, `fail 0`.
- `deploy-tokens.ts`: prints JSON with `nodeUrl`/`tUSDC`/`tETH`/`orderbook`/`pool`/`admin`; `zswap.config.json` written with all six fields.

Stop the dev stack: `bash scripts/dev.sh --down`.

- [ ] **Step 3: Update README**

In `README.md`, replace the `**Status:**` line with:

```
**Status:** Week 5 complete. `LiquidityPool` is live: LPs `deposit` / `withdraw` against a constant-product AMM with private positions; reserves are public, positions are private. 23 integration tests + 21 TXE tests green. Week 5b adds the off-chain clearing aggregator.
```

In the `## Quickstart` CLI block, add after the `close-epoch` line:

```
pnpm --filter @zswap/cli zswap deposit --amount-a 1000000000 --amount-b 1000000000000000000
pnpm --filter @zswap/cli zswap positions
pnpm --filter @zswap/cli zswap withdraw --nonce <position-nonce-from-above>
```

In the `## Documentation` section, add:

```
- [Week 5 Liquidity Pool Design](docs/superpowers/specs/2026-05-18-zswap-aztec-week-05-liquidity-pool-design.md)
- [Week 5 Implementation Plan](docs/superpowers/plans/2026-05-18-zswap-aztec-week-05-liquidity-pool.md)
```

- [ ] **Step 4: Milestone commit and tag**

```bash
git add README.md
git commit -m "docs: mark Week 5 (liquidity pool) complete"
git tag week-05-liquidity-pool
git tag -l | grep week-05
```

Expected: `week-05-liquidity-pool`.

---

## Definition of Done for Week 5

- `LiquidityPool` compiles; `pnpm compile` and `pnpm codegen` succeed for all three contracts.
- All prior tests still pass; the 7 pool TXE tests, the 5 `pool.test.ts` integration tests, and the pool CLI smoke case pass — `21` TXE tests total (7 pool + 10 orderbook + 4 token), `23` integration tests.
- A first deposit mints `floor(sqrt(a*b))` shares; a proportional deposit mints proportional shares; an off-ratio deposit escrows only the matched amount; `withdraw` returns principal and nullifies the position — all verified on-chain.
- `zswap deposit` / `withdraw` / `positions` work end-to-end against the dev stack.
- `git tag` shows `week-05-liquidity-pool`.

## Hand-off to Week 5b

The pool exists but nothing trades against it, so `cum_fee_*_per_share` stay 0. Week 5b introduces the off-chain clearing aggregator and a (trusted, no-ZK) `ClearingContract` that nets epoch orders, swaps the net flow through this pool's constant-product curve, and bumps the cumulative fee counters — at which point `withdraw`'s fee terms become non-zero.

## Risk Notes

- **Integer `sqrt` (Task 2).** The unconstrained-hint + constrained-check idiom and the `unsafe`/`unconstrained` spelling must be confirmed against Noir/aztec-nr v4.2.0 — Task 2 Step 1 is a mandatory discovery step.
- **`u128` overflow in share math (Tasks 3-4).** Products like `amount_a * lp_supply` are plain `u128`; for the MVP's test-token amounts they never overflow, and a pathological deposit overflows and reverts (a safe failure). This is intentional and documented in the contract comments — do not "fix" it with wider arithmetic unless a test actually overflows.
- **Optimistic-concurrency reverts.** Two liquidity ops with the same stale `hint` — the second's `_apply_*` assertion fails and the tx reverts. Integration tests run sequentially (`--test-concurrency=1`) and each reads a fresh hint, so they will not hit this; the CLI user might, and the revert message ("pool state changed; retry ...") is the intended UX.
- **`get_pool_state` / `get_positions` ABI shape (Tasks 5-6).** A Noir struct decodes to a plain object and a `BoundedVec` to `{ storage, len }`; `.simulate()` wraps the value in `{ result }`. The integration test and CLI both unwrap `sim.result` — if codegen produces a different shape, adjust the unwrap (same pattern as the Week 3 `get_orders` handling).
- **`deposit` passing the `hint` object through.** `deposit`'s third argument is the raw `sim.result` from `get_pool_state`. The generated binding expects a `PoolState`-shaped object; passing the decoder's output straight back should round-trip, but if the binding rejects it, construct an explicit `{ reserve_a, reserve_b, lp_supply, cum_fee_a_per_share, cum_fee_b_per_share }` object with `BigInt` fields.
