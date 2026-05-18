# ZSwap-on-Aztec Week 4 — Epoch transitions

**Status:** design
**Date:** 2026-05-18
**Parent spec:** `2026-05-14-zswap-aztec-mvp-design.md` (sub-project 1, MVP vertical slice)
**Predecessor:** `2026-05-17-zswap-aztec-week-03-cancel-cli-design.md`

Week 3 completed the user-facing order lifecycle (`submit_order` / `cancel_order` /
the `zswap` CLI), but the epoch never advances: epoch 0 stays OPEN forever and
`closes_at_block` is written yet never read. Week 4 makes the epoch genuinely
cycle. It adds a `close_epoch` function that advances `current_epoch` to a fresh
epoch once the time window has expired, and tightens `submit_order` /
`cancel_order` to respect the epoch boundary.

Week 4 deliberately ships **no clearing**: `close_epoch` is a pure no-op advance.
Every resting order carries into the next epoch unchanged. The clearing circuit,
fills, and settlement arrive in Week 6-8.

---

## 1. Goals (in scope)

- **`close_epoch`** public function on `OrderbookContract` - advances `current_epoch`
  from epoch N to a fresh epoch N+1 when `block >= closes_at_block`. Permissionless,
  time-gated.
- **`EPOCH_LENGTH` becomes a constructor parameter** (`epoch_length: u32`), stored
  in `PublicImmutable` and read by `close_epoch`. Replaces the hardcoded `global`.
- **Expiry guard** - `_assert_epoch_open` additionally rejects when
  `block >= closes_at_block`, so `submit_order` / `cancel_order` stop accepting
  orders once the epoch's window has elapsed.
- **Dead-code removal** - the unused `clearing` constructor argument, the
  `clearing_addr` storage field, and the `get_clearing_addr` getter are removed
  (see section 3).
- **`zswap close-epoch`** CLI command.

## 2. Non-goals (deferred)

| Deferred | Target |
|---|---|
| `ClearingContract`, clearing circuit, proof verification | Week 6-8 |
| Order *filling* / partial fills / settlement notes & roots | Week 6-8 |
| A persisted `CLOSING` / `SETTLED` epoch state | Week 6-8 (clearing) |
| Permissioned / aggregator-gated epoch closing | sub-project 3 (permissionless aggregator) |

Week 4's `close_epoch` is a **pure no-op advance**: it rewrites `current_epoch`
and touches nothing else. The `orders` `PrivateSet` is never read or modified, so
every resting `OrderNote` automatically belongs to the new epoch (the MVP
standing-order model - `OrderNote` carries no `epoch_id`). The `EpochState.state`
field stays `u8` for forward-compatibility but in Week 4 is only ever written
`OPEN (0)`; `CLOSING (1)` / `SETTLED (2)` are never persisted because nothing
clears yet.

---

## 3. Constructor change and dead-code removal

### 3.1 Why `clearing_addr` goes away

`OrderbookContract` currently stores `clearing_addr: PublicImmutable<AztecAddress>`,
set from a `clearing` constructor argument, exposed via `get_clearing_addr`. It was
reserved for a future `ClearingContract` that would call a gated `_advance_epoch`
on the orderbook. Week 4's design decision is that epoch advancement lives **on the
orderbook itself** (`close_epoch`), and no separate `ClearingContract` is built this
week. The `clearing` argument, the field, and the getter are therefore dead - every
deploy passes a placeholder, and nothing reads it.

Week 4 already has to change the constructor signature (to add `epoch_length`), so
the dead code is removed in the same change rather than carried as a placeholder
through Weeks 4-5. When the real `ClearingContract` arrives (Week 6-8) it will wire
itself to the orderbook via a post-deploy setter, not a constructor argument: the
two contracts reference each other, so a constructor-arg dependency would be
circular.

### 3.2 New constructor

```rust
#[external("public")]
#[initializer]
fn constructor(token_a: AztecAddress, token_b: AztecAddress, epoch_length: u32) {
    self.storage.token_a_addr.initialize(token_a);
    self.storage.token_b_addr.initialize(token_b);
    self.storage.epoch_length.initialize(epoch_length);

    let block: u32 = self.context.block_number();
    self.storage.current_epoch.write(EpochState {
        epoch_id: 0,
        state: EPOCH_STATE_OPEN,
        opened_at_block: block,
        closes_at_block: block + epoch_length,
    });
}
```

### 3.3 Storage delta

```
- clearing_addr: PublicImmutable<AztecAddress, Context>   // removed
+ epoch_length:  PublicImmutable<u32, Context>            // added
```

`token_a_addr`, `token_b_addr`, `current_epoch`, `orders` are unchanged.

### 3.4 `EPOCH_LENGTH` global

The `global EPOCH_LENGTH: u32 = 100` is removed from the contract. Production
deploys (`deploy-tokens.ts`) pass `100` explicitly; tests deploy with a small
value so `close_epoch` is reachable without mining 100 blocks.

---

## 4. `close_epoch`

### 4.1 Signature and logic

```rust
/// Advance the orderbook to a fresh epoch once the current epoch's time window
/// has elapsed. Permissionless: anyone may call it, but it reverts unless the
/// current epoch has expired (`block >= closes_at_block`). It only advances a
/// counter - there is nothing to abuse - so permissionless triggering is purely
/// a liveness win (no dependency on a trusted aggregator).
///
/// Week 4 performs NO clearing: resting orders are untouched and carry into the
/// new epoch. Filling/settlement arrive with the clearing circuit (Week 6-8).
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
    });
}
```

### 4.2 Properties

- **`#[external("public")]`, directly callable** - not enqueued. It reads and
  writes `PublicMutable<EpochState>` from public context.
- **No caller gate** (no `#[only_self]`, no `clearing_addr` check). The only gate
  is the time check.
- **Touches only `current_epoch`.** The `orders` `PrivateSet` is not referenced.
- **Idempotent-ish across blocks:** calling `close_epoch` twice in quick
  succession - the second call sees the freshly-written `closes_at_block` (which
  is `block + epoch_length` in the future) and reverts with
  `"epoch has not expired yet"`. So a new epoch cannot be skipped.

### 4.3 State after a successful `close_epoch`

| Field | Before | After |
|---|---|---|
| `current_epoch.epoch_id` | `N` | `N + 1` |
| `current_epoch.state` | `0` (OPEN) | `0` (OPEN) |
| `current_epoch.opened_at_block` | (epoch N's open) | current block |
| `current_epoch.closes_at_block` | `<= current block` | current block + `epoch_length` |
| `orders` `PrivateSet` | M resting notes | M resting notes (unchanged) |

---

## 5. Expiry guard in `_assert_epoch_open`

`_assert_epoch_open` is the `#[only_self]` public callback enqueued by
`submit_order` and `cancel_order` (epoch state is `PublicMutable`, not readable
from private context, so the check is deferred to public execution). Week 4 adds
one assertion:

```rust
#[external("public")]
#[only_self]
fn _assert_epoch_open() {
    let epoch = self.storage.current_epoch.read();
    assert(epoch.state == EPOCH_STATE_OPEN, "epoch is not OPEN");
    let block: u32 = self.context.block_number();
    assert(block < epoch.closes_at_block, "epoch has expired; awaiting close_epoch");
}
```

Effect: `submit_order` / `cancel_order` succeed only while
`block < closes_at_block`. Once the window elapses they revert until someone
calls `close_epoch` and a fresh epoch opens. The `state == OPEN` assertion is
retained (forward-compat for Week 6-8, when clearing will persist non-OPEN
states); the new `block < closes_at_block` assertion is the one that bites in
Week 4.

Note this means a maker briefly cannot `cancel_order` during the expired-but-not-
yet-closed window. This is acceptable and self-healing: anyone (including the
maker) can call the permissionless `close_epoch` to immediately open a fresh
epoch, after which cancellation works again.

---

## 6. `zswap close-epoch` CLI command

A fourth CLI command so epoch advancement is reachable by users, not only tests.
It mirrors the existing `order` / `cancel` / `orders` commands:

- Registered in `cli/src/index.ts`; implemented in `cli/src/commands/close-epoch.ts`.
- Loads config, `openCli`, calls `orderbook.methods.close_epoch().send({ from })`.
- Reads back `get_epoch` and prints the new `epoch_id` and `closes_at_block`.
- Permissionless, so any `--account` index works.
- No flags beyond the global `--config` / `--account`.

On a not-yet-expired epoch the contract reverts; the command surfaces that as a
clear error (the `program.parseAsync` catch already prints `e.message`).

---

## 7. Test strategy

### 7.1 Noir TXE tests (`contracts/orderbook/src/test.nr`)

TXE can advance L2 block height cheaply (exact API - `env.advance_blocks` or
similar - is a small discovery step in the plan; the Week 3 tests already use
`TestEnvironment`).

| Test | What it verifies |
|---|---|
| `close_epoch_advances_to_next_epoch` | Deploy with `epoch_length = E`; advance block height to `>= closes_at_block`; `close_epoch`; `get_epoch` shows `epoch_id == 1`, `state == 0`, `closes_at_block == new_opened + E`. |
| `close_epoch_rejects_before_expiry` | Deploy; immediately `close_epoch` (block `< closes_at_block`) - reverts `"epoch has not expired yet"`. |
| `submit_order_rejects_after_expiry` | Deploy with small `epoch_length`; advance past `closes_at_block`; `submit_order` reverts `"epoch has expired; awaiting close_epoch"`. (Placeholder token addresses are fine: the enqueued `_assert_epoch_open` callback is what reverts; if its ordering relative to the Token cross-call makes this untestable in pure TXE, this assertion moves to integration - same fallback the Week 2/3 specs used.) |
| `constructor_stores_epoch_length` | Deploy with `epoch_length = E`; `get_epoch` shows `closes_at_block - opened_at_block == E`. |

The existing `constructor_records_contract_addresses` test is updated: it no
longer checks `get_clearing_addr` (removed); it checks `token_a_addr` /
`token_b_addr` only.

### 7.2 TypeScript integration tests (`tests/integration/orderbook.test.ts`)

A new `describe` block, deploying the orderbook with a small `epoch_length`
(e.g. `3`) so the expiry is reachable. Blocks are mined by sending transactions
(each tx mines a block); a small helper sends cheap no-op txs (or reuses
`submit_order` / token transfers) to advance height.

| Scenario | Setup -> Assertion |
|---|---|
| `close_epoch advances the epoch` | Deploy (`epoch_length = 3`). Mine past `closes_at_block`. `close_epoch`. Assert `get_epoch().epoch_id == 1` and a fresh `closes_at_block`. |
| `close_epoch reverts before expiry` | Deploy. Immediately `close_epoch` -> rejects `/epoch has not expired/i`. |
| `orders survive an epoch boundary` | Deploy. `submit_order`. Mine past expiry. `close_epoch`. Assert `get_orders` still lists the order and the orderbook's escrow is unchanged. |
| `submit_order is blocked in the expired window` | Deploy. Mine past `closes_at_block` without closing. `submit_order` -> rejects `/epoch has expired/i`. Then `close_epoch`; `submit_order` succeeds in the new epoch. |

### 7.3 CLI smoke (`tests/integration/cli.test.ts`)

Extend the existing smoke test (or add a case): after the order round-trip, mine
past expiry and run `zswap close-epoch`; assert stdout reports the incremented
`epoch_id`.

---

## 8. Repository delta after Week 4

```
contracts/orderbook/src/main.nr     ~  constructor (epoch_length param, drop clearing),
                                       storage (drop clearing_addr, add epoch_length),
                                       drop EPOCH_LENGTH global + get_clearing_addr getter,
                                       add close_epoch, expiry guard in _assert_epoch_open
contracts/orderbook/src/test.nr     ~  update constructor test; + ~4 close_epoch / guard tests
tests/integration/orderbook.test.ts +  epoch-transition describe block (4 tests)
tests/integration/cli.test.ts       ~  close-epoch smoke case
cli/src/commands/close-epoch.ts      +  new command
cli/src/index.ts                     ~  register close-epoch
scripts/deploy-tokens.ts             ~  pass epoch_length (100) to the Orderbook constructor
README.md                            ~  status line + CLI command list
```

## 9. Implementation phases (preview of the plan)

1. Constructor + storage change (`epoch_length` in, `clearing_addr` out); update the affected TXE test; recompile + codegen.
2. `close_epoch` + the `_assert_epoch_open` expiry guard; TXE tests.
3. Integration tests for epoch transitions.
4. `zswap close-epoch` CLI command + CLI smoke case.
5. `deploy-tokens.ts` passes `epoch_length`; final clean rebuild + smoke; README; milestone commit + tag `week-04-epoch-transitions`.

## 10. Risks specific to Week 4

- **Advancing L2 block height in tests.** TXE: the exact `TestEnvironment` API to
  mine/advance blocks needs confirmation (discovery step). Integration: blocks are
  mined per transaction, so a small `epoch_length` keeps the "mine past expiry"
  loop cheap; if per-tx mining is too slow or unpredictable, fall back to an even
  smaller `epoch_length` (e.g. `2`).
- **`submit_order_rejects_after_expiry` in pure TXE.** The expiry assertion lives
  in the enqueued `_assert_epoch_open` callback; if it cannot be exercised in TXE
  without a real Token deployed, it moves to integration coverage (documented
  fallback, consistent with Weeks 2-3).
- **Constructor signature churn.** Changing the constructor touches every deploy
  site (TXE helper, integration tests, `deploy-tokens.ts`). Low risk but broad;
  the plan sequences it as phase 1 so later phases build on the new signature.

## 11. Acceptance criteria

- `close_epoch`, the new constructor, and the expiry guard compile; `pnpm compile`
  and `pnpm codegen` succeed.
- All prior tests still pass (updated for the constructor change); the new
  `close_epoch` / expiry TXE tests and the 4 integration epoch-transition tests
  pass; the CLI smoke test (with the `close-epoch` case) passes.
- An epoch deployed with `epoch_length = E` can be advanced by `close_epoch` only
  after `block >= closes_at_block`, and `submit_order` is blocked in the
  expired-but-not-closed window - both verified on-chain.
- `zswap close-epoch` advances the epoch end-to-end against the dev stack.
- `git tag` shows `week-04-epoch-transitions`.

## 12. Open questions deferred to implementation

- The exact `TestEnvironment` API for advancing block height in TXE.
- Whether `submit_order_rejects_after_expiry` is a TXE or an integration test
  (depends on the discovery above).
- The cheapest way to mine blocks in the integration suite (dedicated no-op tx
  vs. reusing an existing call).
