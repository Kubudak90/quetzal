# ZSwap-on-Aztec Week 5 — LiquidityPoolContract

**Status:** design
**Date:** 2026-05-18
**Parent spec:** `2026-05-14-zswap-aztec-mvp-design.md` (sub-project 1, MVP vertical slice)
**Predecessor:** `2026-05-18-zswap-aztec-week-04-epoch-transitions-design.md`

## 0. Where this sits

"ClearingContract + clearing circuit" from the roadmap is not a single week. The
remaining MVP clearing system decomposes into four slices, each with its own
brainstorm -> spec -> plan cycle:

- **5a (this spec) - LiquidityPoolContract:** the constant-product AMM pool with
  private LP positions. `deposit` / `withdraw`, public reserves, the fee-accrual
  machinery. The prerequisite for clearing (clearing swaps net order flow against
  this pool).
- **5b - off-chain aggregator + trusted clearing:** the TypeScript aggregator
  computes the uniform clearing price; a `ClearingContract` applies it (initially
  trusted, no ZK proof).
- **5c - Noir clearing circuit:** replaces trust with proof verification - Merkle
  commitment/settlement trees, FIFO fairness, AMM correctness, remnant notes.
- **5d - SettlementNote claim flow:** encrypted settlement logs, `claim_settlement`,
  nullifiers.

This spec covers 5a only.

---

## 1. Goals (in scope)

- A new `contracts/pool/` Noir contract `LiquidityPool` - the constant-product AMM
  for the single tUSDC/tETH pair.
- **`deposit`** - a private function: an LP supplies token A and token B, receives
  a private `PositionNote` representing their LP share.
- **`withdraw`** - a private function: an LP burns a `PositionNote` and reclaims
  principal (plus accrued fees - 0 until clearing exists) to their private balance.
- Private `PositionNote`s in a `PrivateSet`; public `PoolState` (reserves, LP
  supply, cumulative per-share fee counters).
- Utility getters: `get_pool_state`, `get_positions`, `get_token_a_addr`,
  `get_token_b_addr`.
- CLI commands `zswap deposit`, `zswap withdraw`, `zswap positions`.
- `deploy-tokens.ts` also deploys `LiquidityPool` and records it in
  `zswap.config.json`.

## 2. Non-goals (deferred)

| Deferred | Target |
|---|---|
| Order clearing / swaps against the pool | Week 5b-5c |
| Non-zero fee accrual (`cum_fee_*_per_share` actually moving) | Week 5b+ (clearing collects swap fees) |
| Partial withdraw | not planned - withdraw is all-or-nothing |
| `ClearingContract`, settlement, claim | Week 5b-5d |

Week 5 ships a **standalone** pool: liquidity goes in and comes back out, but no
trading happens against it. The fee-accrual code path is fully wired and executed,
but `cum_fee_a_per_share` / `cum_fee_b_per_share` remain 0 (nothing bumps them), so
`withdraw` returns principal only. This is intentional - the machinery is in place
for Week 5b+ to activate.

---

## 3. Contract structure

`contracts/pool/` is a new pnpm-workspace Noir contract, structured like
`contracts/orderbook/`:

```
contracts/pool/
  Nargo.toml         # package "pool", type "contract"; deps: aztec v4.2.0, token (path)
  src/
    main.nr          # the LiquidityPool contract
    test.nr          # TXE tests (pub mod test;)
```

`Nargo.toml` mirrors `contracts/orderbook/Nargo.toml`: `aztec` git dep at tag
`v4.2.0`, and `token = { path = "../token" }`.

## 4. Storage and types

### 4.1 `PoolState`

A single `PublicMutable<PoolState>` holding all mutable public pool state, so a
deposit/withdraw reads and writes it as one unit (mirrors the orderbook's
`EpochState`):

```rust
#[derive(Deserialize, Eq, Packable, Serialize)]
pub struct PoolState {
    pub reserve_a: u128,            // total token A held by the pool
    pub reserve_b: u128,            // total token B held by the pool
    pub lp_supply: u128,            // total LP shares issued
    pub cum_fee_a_per_share: u128,  // MasterChef cumulative fee-per-share, token A, scaled 1e18
    pub cum_fee_b_per_share: u128,  // ditto, token B
}
```

All five fields start at 0 (empty pool). `cum_fee_*_per_share` are scaled by 1e18
and only ever change via clearing (Week 5b+); in Week 5 they stay 0.

### 4.2 `PositionNote`

```rust
#[derive(Deserialize, Eq, Packable, Serialize)]
#[note]
pub struct PositionNote {
    pub lp_share: u128,                          // LP shares this position holds
    pub cum_fee_a_per_share_at_deposit: u128,    // cum_fee_a_per_share snapshot at deposit
    pub cum_fee_b_per_share_at_deposit: u128,    // ditto, token B
    pub nonce: Field,                            // per-position random salt (identity / uniqueness)
    pub owner: AztecAddress,                     // LP address (nullifier subject)
}
```

The MVP's `deposit_epoch` field is **dropped**: the cum-fee snapshot is itself the
accrual boundary, and the pool has no epoch of its own (epochs are an orderbook
concept). Re-add later only if a concrete need appears.

### 4.3 Storage layout

```rust
#[storage]
struct Storage<Context> {
    positions: Owned<PrivateSet<PositionNote, Context>, Context>,
    pool_state: PublicMutable<PoolState, Context>,
    token_a_addr: PublicImmutable<AztecAddress, Context>,
    token_b_addr: PublicImmutable<AztecAddress, Context>,
}
```

Positions are **private** (per-owner `PrivateSet`, mirroring the orderbook's
`orders`) - visible only to the owner's wallet, per the project's
privacy-maximalism rule. `PoolState` is **public** - observers see aggregate TVL
and LP supply move, but never which address deposited or what fraction they hold.

### 4.4 Constructor

```rust
#[external("public")]
#[initializer]
fn constructor(token_a: AztecAddress, token_b: AztecAddress) {
    self.storage.token_a_addr.initialize(token_a);
    self.storage.token_b_addr.initialize(token_b);
    self.storage.pool_state.write(PoolState {
        reserve_a: 0, reserve_b: 0, lp_supply: 0,
        cum_fee_a_per_share: 0, cum_fee_b_per_share: 0,
    });
}
```

---

## 5. The hint-and-validate pattern

The share math needs the live public pool state (`reserve_a`, `reserve_b`,
`lp_supply`, and the cum-fee counters), but the `PositionNote` is private and must
be constructed in private context - and **`PublicMutable` is not readable from a
private context in Aztec v4.2.0** (the same constraint that forces the orderbook's
deferred `_assert_epoch_open`). The MVP §9 pseudocode's `total_reserve_a.read_public()`
inside a `#[private]` function does not compile against the real API.

Resolution - **optimistic hint + public validation**:

1. The caller (CLI / PXE) reads the live `PoolState` via the `get_pool_state`
   utility getter and passes its five fields as arguments to `deposit` / `withdraw`.
2. The private function does all arithmetic on the **hinted** values, escrows /
   returns tokens, and builds / nullifies the `PositionNote`.
3. The private function enqueues a public callback that reads the **actual**
   `PoolState`, **asserts every field equals the hint**, then applies the reserve /
   supply mutation. If a concurrent deposit/withdraw changed the pool between the
   caller's read and the transaction being mined, the assertion fails and the whole
   transaction reverts; the caller retries with a fresh hint.

This is optimistic concurrency: correctness is guaranteed by the public-side
equality assertion (if `actual == hint`, the privately-computed shares/payout are
correct, because they are a pure function of the hint). Concurrent liquidity
operations on the same pool serialize - acceptable for the MVP's throughput. The
pattern is the same shape as the orderbook's `_assert_epoch_open`, generalised from
"assert a property" to "assert the witnessed state".

### 5.1 Hint struct

To keep signatures readable, the five hinted `PoolState` fields are passed as a
plain `PoolState` value (the type already exists and is `Serialize`):

```
deposit(amount_a, amount_b, hint: PoolState, nonce_a, nonce_b, position_nonce)
withdraw(position_nonce, hint: PoolState, nonce_a, nonce_b)
```

---

## 6. `deposit`

### 6.1 Signature

```rust
#[external("private")]
fn deposit(
    amount_a: u128,        // max token A the LP is willing to supply
    amount_b: u128,        // max token B the LP is willing to supply
    hint: PoolState,       // caller-supplied snapshot of live pool state
    nonce_a: Field,        // authwit nonce for the token A escrow call
    nonce_b: Field,        // authwit nonce for the token B escrow call
    position_nonce: Field, // identity nonce for the new PositionNote
)
```

### 6.2 Share math (computed privately, on `hint`)

```
if hint.lp_supply == 0:
    # First deposit sets the pool ratio. Both maxes are used in full.
    used_a = amount_a
    used_b = amount_b
    shares = integer_sqrt(amount_a as Field * amount_b as Field)   # as u128
    assert(shares > 0, "initial deposit too small")
else:
    # Ratio-match: take the side that yields fewer shares; use only the
    # proportional amount of the other side (escrow-only-used == refund).
    shares_from_a = amount_a * hint.lp_supply / hint.reserve_a
    shares_from_b = amount_b * hint.lp_supply / hint.reserve_b
    if shares_from_a <= shares_from_b:
        shares = shares_from_a
        used_a = amount_a
        used_b = amount_a * hint.reserve_b / hint.reserve_a   # matching B
    else:
        shares = shares_from_b
        used_b = amount_b
        used_a = amount_b * hint.reserve_a / hint.reserve_b   # matching A
    assert(shares > 0, "deposit too small for any shares")
assert(used_a <= amount_a, "used_a exceeds amount_a")
assert(used_b <= amount_b, "used_b exceeds amount_b")
```

`used_a`/`used_b` never exceed the caller's maxes, so escrowing exactly `used_*`
is the refund mechanism: the unmatched remainder simply never leaves the LP's
wallet. The V2 ratio-matching (`min` of the two share computations) is preserved
exactly.

### 6.3 Flow

```
1. Compute used_a, used_b, shares as in 6.2.
2. Escrow: Token.transfer_private_to_public(maker, pool, used_a, nonce_a) on token A,
   and the same for used_b on token B. (used_a / used_b may be 0 only when an input
   amount is 0; deposit asserts amount_a > 0 and amount_b > 0 up front, and the
   ratio math keeps used_* > 0 for a non-degenerate pool.)
3. Build PositionNote { lp_share: shares,
                        cum_fee_a_per_share_at_deposit: hint.cum_fee_a_per_share,
                        cum_fee_b_per_share_at_deposit: hint.cum_fee_b_per_share,
                        nonce: position_nonce, owner: maker }
   and insert into positions.at(maker), ONCHAIN_CONSTRAINED delivery.
4. Enqueue _apply_deposit(hint, used_a, used_b, shares).
```

### 6.4 `_apply_deposit` (public, only-self)

```rust
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

`PoolState` derives `Eq`, so `actual == hint` is a single struct comparison.

### 6.5 Input validation

`deposit` asserts `amount_a > 0` and `amount_b > 0` before any other work (mirrors
`submit_order`'s up-front guards), so degenerate deposits fail fast.

---

## 7. `withdraw`

### 7.1 Signature

```rust
#[external("private")]
fn withdraw(
    position_nonce: Field, // identity nonce of the PositionNote to burn
    hint: PoolState,       // caller-supplied snapshot of live pool state
    nonce_a: Field,        // authwit nonce for the token A return call
    nonce_b: Field,        // authwit nonce for the token B return call
)
```

### 7.2 Flow

```
1. maker = msg_sender().
2. Retrieve + nullify the maker's PositionNote matching `position_nonce` via
   pop_notes (NoteGetterOptions.select on PositionNote.nonce, set_limit(1)) -
   exactly the cancel_order pattern. assert(notes.len() == 1, "position not found").
3. assert(position.owner == maker, "not position owner").
4. Compute payouts from the hint:
     principal_a = position.lp_share * hint.reserve_a / hint.lp_supply
     principal_b = position.lp_share * hint.reserve_b / hint.lp_supply
     fees_a = position.lp_share
              * (hint.cum_fee_a_per_share - position.cum_fee_a_per_share_at_deposit)
              / 1_000_000_000_000_000_000
     fees_b = ... (same, token B)
     payout_a = principal_a + fees_a
     payout_b = principal_b + fees_b
   (In Week 5 cum_fee_* are 0 and the deposit snapshot is 0, so fees_* == 0.)
5. Return escrow: Token.transfer_public_to_private(pool, maker, payout_a, nonce_a)
   on token A, and the same for payout_b on token B. As in Week 3, `from` is the
   pool contract itself (a self-call), so the authwit nonce MUST be 0.
6. Enqueue _apply_withdraw(hint, payout_a, payout_b, position.lp_share).
```

`hint.lp_supply` is the divisor in step 4; `withdraw` asserts `hint.lp_supply > 0`
before dividing (a position cannot exist when supply is 0, but the assert makes
the precondition explicit and avoids a division-by-zero).

### 7.3 `_apply_withdraw` (public, only-self)

```rust
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

Withdraw is **all-or-nothing**: the whole `PositionNote` is nullified and the whole
share is paid out. To retain partial liquidity, an LP deposits again.

### 7.4 Authwit-nonce note

`transfer_public_to_private` is `#[authorize_once("from","_nonce")]`. The pool is
`from` and also the caller, so the guard passes only with nonce `0` (the Week-3
`cancel_order` finding). `withdraw` therefore ignores the caller-supplied
`nonce_a`/`nonce_b` for these calls and passes literal `0`... see Open Questions:
the signature keeps `nonce_a`/`nonce_b` only for symmetry with `deposit`; the
implementation passes `0`. (Alternatively the parameters are dropped - decided in
the plan.)

---

## 8. Integer square root

The initial deposit needs `integer_sqrt(amount_a * amount_b)`. The product of two
`u128` values overflows `u128`, so it is formed in `Field` (254-bit; realistic
token amounts keep the product well under 2^254). `integer_sqrt` returns the
largest `s` with `s*s <= x`.

Implementation: an unconstrained hint plus a constrained check.

```
let s = unsafe { sqrt_hint(x) };          // unconstrained: compute floor(sqrt(x))
assert(s * s <= x);                        // s is not too large
assert(x < (s + 1) * (s + 1));             // s is not too small
```

Overflow care: `(s+1)*(s+1)` is computed in `Field`, where it cannot overflow for
any `s` derived from a `u128`-bounded product. The result is range-checked back
into `u128`. The exact Noir spelling (the `unsafe`/`unconstrained` hint function,
`Field` multiplication, the cast back to `u128`) is a discovery step in the plan.

---

## 9. Getters

```rust
#[external("utility")] unconstrained fn get_pool_state() -> PoolState { ... }
#[external("utility")] unconstrained fn get_token_a_addr() -> AztecAddress { ... }
#[external("utility")] unconstrained fn get_token_b_addr() -> AztecAddress { ... }
#[external("utility")] unconstrained fn get_positions(owner: AztecAddress)
    -> BoundedVec<PositionNote, MAX_NOTES_PER_PAGE> { ... }
```

`get_positions` mirrors the orderbook's `get_orders`: it takes `owner` explicitly
(utility functions are simulated and only the owner's PXE can resolve the encrypted
notes), uses `view_notes(NoteViewerOptions::new())`, and returns results UNORDERED.

---

## 10. CLI

Three new commands in `cli/src/commands/`, registered in `cli/src/index.ts`,
following the established command pattern (`loadConfig` + `openCli`,
`optsWithGlobals`, `try/finally ctx.stop()`, cross-package import of the generated
`LiquidityPool` binding). Every command first calls `get_pool_state` to obtain the
hint, then the contract method.

| Command | Flags | Action |
|---|---|---|
| `zswap deposit` | `--amount-a <n>`, `--amount-b <n>` | reads pool state, calls `deposit`; prints the new `position_nonce`. |
| `zswap withdraw` | `--nonce <field>` | reads pool state, calls `withdraw(position_nonce, hint, 0, 0)`. |
| `zswap positions` | (none) | calls `get_positions`; prints each position's `nonce`, `lp_share`, fee snapshots. |

`openCli` (in `cli/src/wallet.ts`) must additionally register the `LiquidityPool`
contract with the PXE - extend its contract-registration loop with the pool
address + artifact (the same `node.getContract` + `wallet.registerContract` it
already does for the orderbook and the two tokens).

`zswap.config.json` gains a `pool` field.

## 11. deploy-tokens.ts

After deploying the two tokens and the orderbook, also deploy `LiquidityPool`
(constructor args: the two token addresses) and add `pool: <address>` to the JSON
written to `zswap.config.json` and printed to stdout.

## 12. Test strategy

### 12.1 Noir TXE tests (`contracts/pool/src/test.nr`)

| Test | Verifies |
|---|---|
| `position_note_serialization_round_trip` | A `PositionNote` serializes/deserializes to equal fields. |
| `constructor_initializes_empty_pool` | After deploy: `PoolState` all-zero; token addrs round-trip. |
| `integer_sqrt_is_correct` | `integer_sqrt(x)` satisfies `s*s <= x < (s+1)*(s+1)` for several `x` (0, 1, perfect squares, non-squares, large values). |
| `deposit_rejects_zero_amount` | `deposit` with `amount_a == 0` (or `amount_b == 0`) reverts before any cross-contract call. |
| `withdraw_rejects_unknown_nonce` | `withdraw` for a nonce with no matching note reverts `"position not found"` (fires before the Token call). |
| `get_positions_empty_for_fresh_account` | `get_positions` on a fresh account returns an empty `BoundedVec`. |

Happy-path `deposit`/`withdraw` need a real Token deployed and seeded - integration
territory (the Week 2-4 fallback). If TXE cross-contract Token deployment proves
cheap, a happy-path TXE test may be added opportunistically; otherwise §12.2 covers it.

### 12.2 TypeScript integration tests (`tests/integration/pool.test.ts`)

A new test file, run against the live dev stack.

| Scenario | Setup -> Assertion |
|---|---|
| `first deposit sets reserves and mints sqrt(a*b) shares` | Deploy Token x2 + Pool. Mint to Alice. Alice `deposit(amount_a, amount_b, hint=zero)`. Assert pool public balances == amounts; `get_pool_state` reserves == amounts, `lp_supply == floor(sqrt(a*b))`; Alice's `get_positions` shows one note with that `lp_share`. |
| `second LP at the pool ratio gets proportional shares` | After Alice's deposit, Bob deposits at the same ratio. Assert Bob's `lp_share == bob_a * supply / reserve_a`; `lp_supply` and reserves grew correctly. |
| `off-ratio deposit escrows only the used amount` | Bob deposits with one side over-supplied. Assert the pool took only `used_b` (the matched amount), Bob's wallet kept the remainder, shares match the limiting side. |
| `withdraw returns principal and nullifies the position` | Alice `withdraw`s her position. Assert her private token balances are restored to (approximately) her deposit; `get_positions` now empty; `get_pool_state` reserves/`lp_supply` reduced. |
| `two LPs withdraw proportional principal` | Alice and Bob both deposit, both withdraw; assert each gets back their proportional share of reserves. |
| `withdraw of an unknown nonce is rejected` | `withdraw` with a bogus nonce rejects. |

### 12.3 CLI smoke (`tests/integration/cli.test.ts`)

Extend the smoke test (or add a case): `deposit -> positions` (the new position is
listed with a nonce) `-> withdraw -> positions` (now empty).

---

## 13. Repository delta after Week 5

```
contracts/pool/                       +  new Noir contract package (Nargo.toml, src/main.nr, src/test.nr)
pnpm-workspace.yaml                   ~  (already globs contracts via scripts; confirm pool is built)
scripts/compile-all.sh / codegen.sh   ~  already loop over contracts/*/ - pool picked up automatically
cli/src/commands/deposit.ts           +  new
cli/src/commands/withdraw.ts          +  new
cli/src/commands/positions.ts         +  new
cli/src/index.ts                      ~  register the three commands
cli/src/wallet.ts                     ~  register the LiquidityPool contract with the PXE
scripts/deploy-tokens.ts              ~  deploy LiquidityPool, add `pool` to zswap.config.json
tests/integration/pool.test.ts        +  new integration suite
tests/integration/cli.test.ts         ~  deposit/withdraw/positions smoke case
README.md                             ~  status line + CLI command list + docs links
```

## 14. Implementation phases (preview of the plan)

1. `contracts/pool/` scaffold: `Nargo.toml`, `PoolState` + `PositionNote` types,
   storage, constructor; compiles; codegen.
2. `integer_sqrt` helper + its TXE test.
3. `deposit` + `_apply_deposit` + input-validation TXE tests.
4. `withdraw` + `_apply_withdraw` + the getters + remaining TXE tests.
5. Integration tests (`pool.test.ts`).
6. CLI commands + `wallet.ts` registration + `deploy-tokens.ts` + CLI smoke.
7. Final clean rebuild + smoke; README; milestone commit + tag `week-05-liquidity-pool`.

## 15. Risks specific to Week 5

- **Integer `sqrt` in Noir.** The unconstrained-hint + constrained-check idiom and
  the `Field` arithmetic / `u128` casts need confirming against the v4.2.0 API
  (discovery step in the plan).
- **`u128` arithmetic and overflow.** `amount * lp_supply` and `lp_share * reserve`
  can exceed `u128`. Where a product can overflow, compute in `Field` and
  range-check the quotient back to `u128`. The plan must call this out per
  expression.
- **Optimistic-concurrency reverts.** Two liquidity ops on the same pool in flight
  -> the second's hint is stale -> revert. Acceptable for the MVP; integration
  tests run sequentially (`--test-concurrency=1`) so they will not spuriously hit
  this, but the CLI user may and the error message must be clear.
- **Cross-contract escrow in TXE.** As in Weeks 2-4, happy-path deposit/withdraw
  are integration-tested; pure-TXE tests cover only pre-cross-call paths.

## 16. Acceptance criteria

- `LiquidityPool` compiles; `pnpm compile` and `pnpm codegen` succeed for all three
  contracts.
- All prior tests still pass; the new pool TXE tests, the `pool.test.ts`
  integration suite, and the CLI smoke case pass.
- A first deposit mints `floor(sqrt(a*b))` shares; a proportional second deposit
  mints proportional shares; an off-ratio deposit escrows only the matched amount;
  `withdraw` returns principal and nullifies the position - all verified on-chain.
- `zswap deposit` / `withdraw` / `positions` work end-to-end against the dev stack.
- `git tag` shows `week-05-liquidity-pool`.

## 17. Open questions deferred to implementation

- Whether `withdraw` keeps the `nonce_a`/`nonce_b` parameters (passed as `0`) for
  signature symmetry with `deposit`, or drops them. Lean: drop them - they are
  always `0` and unused; `deposit` genuinely needs its nonces because the escrow is
  a `transfer_private_to_public` where `from` is the LP (not a self-call). Final
  call in the plan.
- The exact Noir spelling of the unconstrained `sqrt` hint and `Field`<->`u128`
  conversions.
- Whether any happy-path `deposit`/`withdraw` TXE test is feasible (cross-contract
  Token deploy in TXE) or all happy-path coverage stays in `pool.test.ts`.
