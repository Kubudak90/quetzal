# ZSwap-on-Aztec Week 5c — On-chain trusted clearing

**Status:** design
**Date:** 2026-05-19
**Parent spec:** `2026-05-14-zswap-aztec-mvp-design.md` (sub-project 1, MVP vertical slice)
**Predecessor:** `2026-05-19-zswap-aztec-week-05b-clearing-aggregator-design.md`

## 0. Where this sits

The clearing system decomposed (Week 5 spec) into 5a (LiquidityPool, done),
5b (off-chain aggregator, done), 5c (this), 5d. This slice puts clearing
**on-chain**, trusted: a configured authority submits the aggregator's
`ClearingResult` and the contract applies it. The Week-5d ZK circuit later
replaces that trust with a verified proof.

---

## 1. Goals (in scope)

- **`close_epoch_and_clear`** on `OrderbookContract` - an authority-gated public
  function that applies one epoch's clearing: the AMM net swap against the Pool,
  recording the per-order fills, and advancing the epoch.
- **`claim_fill`** on `OrderbookContract` - a private function: a maker whose
  order was filled nullifies their `OrderNote` and receives the output tokens.
- **Cross-contract wiring** - the Orderbook constructor gains `pool_addr` +
  `clearing_authority`; the Pool gains a one-shot `set_orderbook` and a gated
  `apply_clearing`.
- **`deploy-tokens.ts`** updated for the new deploy order and constructor args.
- A **`zswap claim`** CLI command.

## 2. Non-goals (deferred)

| Deferred | Target |
|---|---|
| ZK clearing circuit (replacing the `clearing_authority` trust) | Week 5d |
| Merkle settlement root (constant-size fill state) | Week 5d |
| A persisted `CLOSING` epoch state | Week 5d |
| Partial / remnant fills | not planned (the aggregator is full-fill) |
| An aggregator daemon / a `zswap clear` CLI command | a later slice |

Clearing is **trusted** this week: `close_epoch_and_clear` relays the
aggregator's numbers (fills, the net-swap amounts, the fee increments) without
verifying them; only the caller's identity (`clearing_authority`) and the epoch
deadline are checked. The decision to keep clearing on the `OrderbookContract`
(no separate `ClearingContract`) follows the Week-4 precedent for `close_epoch`
and the fact that `claim_fill` must live on the Orderbook regardless (only the
contract owning the `OrderNote` `PrivateSet` can nullify its notes).

---

## 3. Architecture

Two contracts participate. The Orderbook owns the `OrderNote`s and the escrowed
order inputs; the Pool owns the AMM reserves. Clearing is one
Orderbook->Pool call:

```
            close_epoch_and_clear (authority)        claim_fill (maker, private)
                      |                                       |
   OrderbookContract  |  -- Token.transfer_public_to_public -->|  pop OrderNote,
   (clearing logic,   |        (net input token)               |  Token.transfer_
    custody, fills) --+--> LiquidityPool.apply_clearing  <------+  public_to_private
                            (net output token back,               (output to maker)
                             pool_state update)
```

The Orderbook is the **sole token custodian** for orders: `submit_order` already
escrows every order's input into the Orderbook's pooled public balance, and the
cleared orders' output tokens remain in that same balance until claimed.

---

## 4. Cross-contract wiring and deployment

### 4.1 Orderbook constructor

The constructor gains two arguments:

```rust
#[external("public")]
#[initializer]
fn constructor(
    token_a: AztecAddress,
    token_b: AztecAddress,
    epoch_length: u32,
    pool_addr: AztecAddress,           // the LiquidityPool to swap the net flow through
    clearing_authority: AztecAddress,  // the only address allowed to call close_epoch_and_clear
)
```

`pool_addr` and `clearing_authority` are stored in new `PublicImmutable` storage
fields. (Week 4 removed a dead `clearing_addr`; this re-introduces two fields
that are now genuinely load-bearing.)

### 4.2 Pool: `set_orderbook` + the gate

The Pool is deployed before the Orderbook, so it cannot take the Orderbook
address at construction. It gains:

- `orderbook_addr: PublicMutable<AztecAddress>` storage, initialized to the zero
  address by the constructor.
- `set_orderbook(addr: AztecAddress)` - `#[external("public")]`, a one-shot
  setter: asserts the stored address is currently zero (settable exactly once),
  then writes `addr`. Called by the deployer immediately after the Orderbook is
  deployed. (Once-only, so it cannot be hijacked later.)
- `apply_clearing(...)` - `#[external("public")]`, asserts
  `msg_sender() == orderbook_addr`.

### 4.3 Deployment order

No circular dependency - only the Pool needs a post-deploy setter:

```
1. deploy Token tUSDC, Token tETH
2. deploy LiquidityPool(tUSDC, tETH)
3. deploy Orderbook(tUSDC, tETH, epoch_length, pool_addr = LiquidityPool, clearing_authority)
4. LiquidityPool.set_orderbook(Orderbook)
```

`deploy-tokens.ts` performs all four steps and records every address in
`zswap.config.json`. `clearing_authority` in tests/deploys is a test account
(the stand-in for the off-chain aggregator).

---

## 5. `close_epoch_and_clear`

### 5.1 Signature

```rust
#[external("public")]
fn close_epoch_and_clear(fills: BoundedVec<FillEntry, MAX_FILLS>, swap: ClearingSwap)
```

where:

```rust
/// One filled order: the aggregator's per-order payout.
pub struct FillEntry {
    pub order_nonce: Field,  // identity nonce of the filled OrderNote
    pub amount_out: u128,    // output tokens owed (token B for a buy, token A for a sell)
}

/// The aggregate net AMM swap for the epoch - everything the contract needs,
/// pre-computed by the aggregator and relayed verbatim (trusted slice). The
/// physical token moves and the Pool reserve-accounting deltas are passed
/// separately because the fee is withheld from reserves: the Pool physically
/// receives the full net input (`*_to_pool`) but only `reserve_*_add` of it is
/// reserve - the rest backs the fee counter.
pub struct ClearingSwap {
    pub a_to_pool: u128,    // token A the Orderbook physically sends to the Pool
    pub b_to_pool: u128,    // token B the Orderbook physically sends to the Pool
    pub a_from_pool: u128,  // token A the Pool physically returns to the Orderbook
    pub b_from_pool: u128,  // token B the Pool physically returns to the Orderbook
    pub reserve_a_add: u128,  // amount added to the Pool's reserve_a accounting
    pub reserve_a_sub: u128,  // amount subtracted from reserve_a
    pub reserve_b_add: u128,  // amount added to reserve_b
    pub reserve_b_sub: u128,  // amount subtracted from reserve_b
    pub fee_a_per_share_increment: u128,
    pub fee_b_per_share_increment: u128,
}
```

`MAX_FILLS = 128` (the epoch order cap). `FillEntry` / `ClearingSwap` are plain
`#[derive(Deserialize, Eq, Packable, Serialize)]` structs. For a net buy-heavy
epoch (`netA > 0`): `a_to_pool = netA`, `reserve_a_add = netA - feeTokenA`,
`b_from_pool = reserve_b_sub = outB`, and the token-B / `*_sub`-A fields are 0.
For a sell-heavy epoch the mirror holds. A zero-net / all-carryover epoch has all
ten fields 0.

### 5.2 Logic

```
1. assert msg_sender() == clearing_authority           ("not clearing authority")
2. read current_epoch; assert block >= closes_at_block ("epoch has not expired yet")
3. Net AMM swap (skip entirely if all four swap token amounts are 0 - a
   zero-net / all-carryover clearing):
   a. if swap.a_to_pool > 0:
        Token::at(token_a).transfer_public_to_public(self.address, pool_addr, swap.a_to_pool, 0)
      if swap.b_to_pool > 0:
        Token::at(token_b).transfer_public_to_public(self.address, pool_addr, swap.b_to_pool, 0)
   b. call LiquidityPool::at(pool_addr).apply_clearing(swap)   -- see section 7
4. Record fills: for each FillEntry e in `fills`:
     assert self.storage.fills.at(e.order_nonce).read() == 0   ("order already filled")
     self.storage.fills.at(e.order_nonce).write(e.amount_out)
   (amount_out is asserted > 0 by the aggregator; a 0 entry is rejected here too,
    so a recorded non-zero value unambiguously means "filled".)
5. Advance the epoch: write EpochState { epoch_id+1, OPEN, opened=block,
   closes=block+epoch_length } - identical to close_epoch.
```

The authority gate (step 1) and the epoch-deadline gate (step 2) are the only
checks. Step 3 moves the net imbalance; step 4 records who is owed what; step 5
opens the next epoch. The whole function is one atomic transaction - if
`apply_clearing` reverts (e.g. a stale swap that underflows pool reserves), the
token transfers and the epoch advance revert with it.

### 5.3 New storage on the Orderbook

```
fills: Map<Field, PublicMutable<u128, Context>, Context>   // order_nonce -> amount_out
pool_addr: PublicImmutable<AztecAddress, Context>
clearing_authority: PublicImmutable<AztecAddress, Context>
```

`fills` is keyed by `order_nonce`; an entry of `0` means "not filled". Entries
are written once by clearing and read once by `claim_fill`; they are never
cleared (the `OrderNote` nullifier, emitted by `claim_fill`, is the double-claim
guard, so a stale `fills` entry is harmless).

### 5.4 Why a direct `Map`, not a Merkle root

The MVP design records fills as a Merkle root for constant-size on-chain state.
For the trusted slice a direct `Map` (up to 128 `PublicMutable` writes per
clearing) is simpler and has no circuit dependency. The Merkle root is a Week-5d
concern - the clearing circuit will produce it. Gas scales linearly with filled
orders this week; acceptable for the MVP.

---

## 6. `claim_fill`

### 6.1 Signature

```rust
#[external("private")]
fn claim_fill(order_nonce: Field, nonce: Field)
```

`order_nonce` identifies the maker's filled `OrderNote`; `nonce` is the authwit
nonce for the inner token transfer.

### 6.2 Logic

```
1. maker = msg_sender()
2. Retrieve + nullify the maker's OrderNote matching `order_nonce` via pop_notes
   (NoteGetterOptions.select on OrderNote.nonce, set_limit(1)) - the cancel_order
   pattern. assert(notes.len() == 1, "order not found"); assert owner == maker.
3. Read the recorded fill. Because PublicMutable is not readable from private
   context, the lookup is deferred to a public callback (the _assert_epoch_open
   pattern): enqueue `_pay_claim(order_nonce, side, maker, nonce)`.
4. Build nothing else - the OrderNote is consumed; the payout happens in the
   callback.

_pay_claim (public, only_self):
   amount_out = self.storage.fills.at(order_nonce).read()
   assert(amount_out > 0, "order not filled")
   token = if side { token_a } else { token_b }   // a SELL (side=true) is owed
                                                   // token A; a BUY token B
   Token::at(token).transfer_public_to_private(self.address, maker, amount_out, nonce)
```

Note the token choice: a **buy** (`side == false`) paid token A and is owed
token B; a **sell** (`side == true`) paid token B and is owed token A. The
private half nullifies the note (only the owner can); the enqueued public half
reads `fills` and pays. The pattern mirrors `submit_order`/`cancel_order`:
private work + an enqueued public callback for the `PublicMutable` access.

`transfer_public_to_private`'s `from` is the Orderbook itself (a self-call), so
the authwit nonce passed to it MUST be `0` (the Week-3 finding). `claim_fill`'s
`nonce` parameter is therefore passed as `0` to the token call; it is kept in
the signature only for interface symmetry and may be dropped in the plan.

### 6.3 Failure modes

| Failure | Where |
|---|---|
| No `OrderNote` matches `order_nonce` | `pop_notes` returns empty -> assert in `claim_fill` |
| Caller is not the order's owner | per-owner `PrivateSet` yields no match; explicit owner assert |
| Order was never filled | `fills.at(order_nonce).read() == 0` -> assert in `_pay_claim` |
| Double claim | the `OrderNote` nullifier was already emitted -> the tx fails |

An unfilled resting order is untouched by clearing and by `claim_fill`; the
maker still `cancel_order`s it (escrow returned) or leaves it to a later epoch.

---

## 7. Pool: `apply_clearing`

```rust
#[external("public")]
fn apply_clearing(swap: ClearingSwap) {
    assert(self.msg_sender() == self.storage.orderbook_addr.read(), "not the orderbook");

    // The net input token was already transferred IN to the pool by the
    // Orderbook (step 3a of close_epoch_and_clear). Send the net output back.
    if swap.a_from_pool > 0 as u128 {
        self.call(Token::at(self.storage.token_a_addr.read()).transfer_public_to_public(
            self.address, self.storage.orderbook_addr.read(), swap.a_from_pool, 0));
    }
    if swap.b_from_pool > 0 as u128 {
        self.call(Token::at(self.storage.token_b_addr.read()).transfer_public_to_public(
            self.address, self.storage.orderbook_addr.read(), swap.b_from_pool, 0));
    }

    // Update the accounting: explicit reserve deltas + the fee-per-share counters.
    let s = self.storage.pool_state.read();
    self.storage.pool_state.write(PoolState {
        reserve_a: s.reserve_a + swap.reserve_a_add - swap.reserve_a_sub,
        reserve_b: s.reserve_b + swap.reserve_b_add - swap.reserve_b_sub,
        lp_supply: s.lp_supply,
        cum_fee_a_per_share: s.cum_fee_a_per_share + swap.fee_a_per_share_increment,
        cum_fee_b_per_share: s.cum_fee_b_per_share + swap.fee_b_per_share_increment,
    });
}
```

**Reserve update.** The fee is withheld from reserves (the Week-5b correctness
fact: clearing must NOT add the fee to `reserve_*`). The Orderbook hands the Pool
the reserve deltas pre-split into a non-negative `*_add` and `*_sub` (Noir has no
signed int), so the Pool re-derives nothing - it adds, subtracts, and writes.
The aggregator computes `newReserveA`/`newReserveB`; `reserve_a_add - reserve_a_sub
= newReserveA - oldReserveA` (and one of the pair is 0).

`apply_clearing` does NOT use the deposit/withdraw hint-validate pattern - it is
an authority path (only the Orderbook reaches it) and applying explicit deltas
composes correctly with any concurrent deposit/withdraw. Its one failure mode is
a `u128` underflow when a concurrent withdraw drained a reserve below `*_sub` -
a safe revert of the whole clearing tx (see section 8). `lp_supply` is carried
through unchanged (clearing never mints or burns LP shares).

---

## 8. Token custody and conservation

`submit_order` escrowed every resting order's input into the Orderbook's pooled
public balance. `close_epoch_and_clear` performs exactly one net swap with the
Pool. Afterwards the Orderbook's pooled balance equals:

```
(uncleared orders' escrow)  +  (cleared orders' owed output)
```

This reconciles exactly. With `netA > 0` (buy-heavy): the Orderbook sends `netA`
token A to the Pool and receives `outB` token B. Token A held after =
`before - netA`; the cleared sellers are owed `xTotal = sumAIn - netA` and the
uncleared escrow is `held_before_A - sumAIn`, summing to `held_before_A - netA`.
Token B after = `before + outB`; cleared buyers owed `yTotal = sumBIn + outB`,
uncleared `held_before_B - sumBIn`, summing to `held_before_B + outB`. Each
`claim_fill` withdraws one cleared order's output from this balance; the sum of
all `amount_out` equals `xTotal + yTotal` exactly (Week 5b distributes the
aggregate with the remainder to the last order).

**Known limitation (trusted slice).** A `deposit`/`withdraw` on the Pool
between the aggregator's snapshot and the on-chain `close_epoch_and_clear` can
make the reserve deltas stale; if a delta now underflows a reserve,
`apply_clearing` reverts and the whole clearing tx reverts atomically - no
state change, no fund loss. Recovery: the authority re-submits with fresh
numbers, or anyone calls the permissionless `close_epoch` for a zero-fill
advance. The Week-5d ZK proof plus a persisted `CLOSING` state (which would
freeze deposits/withdraws during clearing) remove this window.

---

## 9. CLI

One new command, `zswap claim`:

| Command | Flags | Action |
|---|---|---|
| `zswap claim` | `--nonce <field>` | calls `claim_fill(order_nonce, 0)` for the account's filled order; prints the claimed amount on success. |

Driving `close_epoch_and_clear` is the off-chain aggregator's job (a future
aggregator-daemon slice), so no `zswap clear` command this week - the
integration test drives `close_epoch_and_clear` directly. `zswap.config.json`
already carries every contract address; no new field beyond what section 4 adds
(`pool` is already recorded as of Week 5).

---

## 10. Repository delta after Week 5c

```
contracts/orderbook/src/main.nr   ~ constructor (+pool_addr, +clearing_authority);
                                    +fills/pool_addr/clearing_authority storage;
                                    +close_epoch_and_clear, +claim_fill, +_pay_claim;
                                    +FillEntry, +ClearingSwap types
contracts/orderbook/src/test.nr   ~ update deploy helper; + clearing/claim TXE tests
contracts/pool/src/main.nr        ~ +orderbook_addr storage, +set_orderbook,
                                    +apply_clearing
contracts/pool/src/test.nr        ~ + set_orderbook / apply_clearing TXE tests
tests/integration/clearing.test.ts + new: the full close_epoch_and_clear -> claim round trip
tests/integration/orderbook.test.ts ~ update Orderbook deploys for the new constructor
tests/integration/pool.test.ts     ~ (pool deploy unchanged; set_orderbook wiring as needed)
tests/integration/cli.test.ts      ~ update deploys; + zswap claim smoke case
cli/src/commands/claim.ts          + new
cli/src/index.ts                   ~ register claim
scripts/deploy-tokens.ts           ~ new deploy order + Orderbook constructor args
README.md                          ~ status line + CLI list + docs links
```

The Orderbook constructor change ripples to every Orderbook deploy site (the
TXE helper, three integration test files, `deploy-tokens.ts`) - sequenced as
the first plan task, as in Week 4.

## 11. Implementation phases (preview of the plan)

1. Pool: `orderbook_addr` storage + `set_orderbook` + `apply_clearing` (+ TXE tests).
2. Orderbook: constructor change (+`pool_addr`, +`clearing_authority`), the new
   storage, and update every deploy site; recompile + codegen.
3. Orderbook: `close_epoch_and_clear` + `FillEntry`/`ClearingSwap` types (+ TXE
   tests for the gates).
4. Orderbook: `claim_fill` + `_pay_claim` (+ TXE tests).
5. Integration: the full clear -> claim round trip (`clearing.test.ts`).
6. CLI `zswap claim` + `deploy-tokens.ts` + the CLI smoke case.
7. Final clean rebuild + smoke; README; milestone commit + tag `week-05c-onchain-clearing`.

## 12. Risks specific to Week 5c

- **The constructor / deploy-wiring change is broad.** Two contracts gain
  cross-references; every Orderbook deploy site changes. Phases 1-2 sequence it
  so later phases build on the wired contracts.
- **`apply_clearing` reserve-delta arithmetic.** The exact `ClearingSwap` field
  set (how the signed reserve deltas are passed) is finalised in the plan; the
  invariant is that the Pool only adds/subtracts pre-computed deltas and
  range-checks them. `u128` underflow on a stale delta is a safe revert.
- **`close_epoch_and_clear` argument size.** A `BoundedVec<FillEntry, 128>` plus
  `ClearingSwap` as public-function calldata is large but within limits; if it
  proves impractical, the plan falls back to a smaller `MAX_FILLS` (the epoch
  order cap can be lowered for the MVP).
- **TXE coverage.** As in Weeks 2-5, happy-path clearing/claim need real Token +
  Pool contracts; pure-TXE tests cover only the pre-cross-call gates. The full
  round trip is integration-tested.

## 13. Acceptance criteria

- `close_epoch_and_clear`, `claim_fill`, `_pay_claim`, and the Pool's
  `set_orderbook` / `apply_clearing` compile; `pnpm compile` / `pnpm codegen`
  succeed for all three contracts.
- All prior tests pass (updated for the constructor change); the new TXE tests
  and the `clearing.test.ts` round-trip pass.
- End-to-end on the dev stack: orders submitted, an epoch cleared by the
  authority, the Pool's reserves + `cum_fee_*` move as the aggregator computed,
  filled makers `claim_fill` and receive their output in their private balance,
  an unfilled order remains cancellable.
- `zswap claim` works against the dev stack.
- `git tag` shows `week-05c-onchain-clearing`.

## 14. Open questions deferred to implementation

- Whether `claim_fill` keeps the `nonce` parameter (passed as `0`) or drops it.
- Whether `close_epoch_and_clear` should also assert `fills.len() <= MAX_FILLS`
  explicitly or rely on the `BoundedVec` capacity.
- The exact `BoundedVec` / array spelling for the `fills` argument and whether a
  128-entry public-function argument compiles within Aztec v4.2.0 limits (a
  Week-5c risk, section 12) - the plan confirms it or lowers `MAX_FILLS`.
