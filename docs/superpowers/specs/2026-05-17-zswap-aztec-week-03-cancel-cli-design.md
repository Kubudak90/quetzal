# Quetzal Week 3 — `cancel_order` + CLI scaffold

**Status:** design
**Date:** 2026-05-17
**Parent spec:** `2026-05-14-zswap-aztec-mvp-design.md` (sub-project 1, MVP vertical slice)
**Predecessor:** `2026-05-14-zswap-aztec-week-02-orderbook-design.md`

Week 2 shipped an `OrderbookContract` that can accept orders (`submit_order`) and
escrow the maker's tokens into the contract's public balance. It cannot cancel,
clear, or transition epochs. Week 3 completes the **user-facing order lifecycle**
that does not depend on clearing: cancelling a resting order and getting the
escrow back, plus a CLI to drive submission, cancellation, and order listing.

---

## 1. Goals (in scope)

- **`cancel_order` private function** on `OrderbookContract` — nullifies one
  resting `OrderNote` and returns the escrowed tokens to the maker's **private**
  balance.
- **`get_orders` utility getter** on `OrderbookContract` — lets an off-chain
  caller (the CLI) read the maker's resting orders, including their `nonce`s.
- **A new `cli/` workspace package** with three commands: `quetzal order`,
  `quetzal cancel`, `quetzal orders`.
- **`deploy-tokens.ts` change** — also writes a `quetzal.config.json` so the CLI
  works immediately after a deploy.

## 2. Non-goals (deferred)

| Deferred | Target |
|---|---|
| `EpochState OPEN → CLOSING → SETTLED` transitions, `_advance_epoch` gated fn | Week 4 (needs `ClearingContract`) |
| `ClearingContract`, clearing circuit, settlement notes, claim flow | Week 6–8 |
| Partial-fill remnant notes / carryover | clearing weeks |
| CLI `deposit` / `withdraw` / `claim` commands | later weeks |
| Aggregator reveal publishing from the CLI | Week 9 |
| `orders` pagination beyond `MAX_INPUT_NOTES` results | when the clearing cap (128) matters |

Week 3 still ships a **partial** Orderbook: a maker can submit, list, and cancel
orders, but the epoch never advances and no order is ever filled. Every resting
`OrderNote` is therefore a full standing order — `cancel_order` always returns
the full `amount_in`.

---

## 3. `cancel_order` — the new stateful private function

### 3.1 Signature

```rust
#[external("private")]
fn cancel_order(order_nonce: Field, nonce: Field) {
    // ...
}
```

- `order_nonce` — the note-identity nonce embedded in the target `OrderNote`
  (the same value passed as `order_nonce` to `submit_order`). It uniquely
  identifies which resting order to cancel.
- `nonce` — authwit nonce for the inner `Token.transfer_public_to_private`
  call. Distinct from `order_nonce`, mirroring `submit_order`'s two-nonce split.

### 3.2 Logic

```
1. maker = msg_sender().
2. Retrieve the maker's resting OrderNote whose `nonce` field == `order_nonce`,
   from self.storage.orders.at(maker). Exactly one note must match.
3. Assert note.owner == maker (defence-in-depth; the per-owner PrivateSet
   already scopes retrieval to the maker).
4. Read the escrowed token address from public-immutable storage, decided by
   note.side  (side == false -> token_a, side == true -> token_b — identical to
   submit_order's convention).
5. Remove the note from the PrivateSet. This emits the note's nullifier, so the
   order can never be cancelled twice or filled later.
6. Call Token.transfer_public_to_private(orderbook_addr, maker, note.amount_in,
   nonce) on the chosen token. This:
     a. Enqueues a public decrease of the orderbook's public balance by
        amount_in.
     b. Credits a fresh private balance note of amount_in to the maker.
   Because `from` == orderbook_addr == the calling contract, the Token's
   `authorize_once("from", _nonce)` guard is satisfied without an authwit.
7. Enqueue the existing `_assert_epoch_open()` only-self public callback, so the
   whole tx reverts if the epoch is no longer OPEN at mine time.
```

### 3.3 Escrow accounting after a successful `cancel_order`

`cancel_order` is the exact inverse of `submit_order` (§5.3 of the Week 2 spec):

| Where | Before | After |
|---|---|---|
| `orders` PrivateSet (maker's view) | N entries | N − 1 entries |
| `Orderbook_addr`'s `Token_X` public balance | `B_orderbook` | `B_orderbook − amount_in` |
| Maker's `Token_X` private balance | `B_maker` | `B_maker + amount_in` |
| Maker's PXE | (OrderNote present) | (OrderNote nullified) |

`Token_X` is `token_a` if `side == false`, `token_b` if `side == true`.
Accounting is implicit and needs no separate ledger: each valid `OrderNote`
corresponds to exactly `amount_in` escrowed by `submit_order`, so nullifying the
note and returning `amount_in` keeps the pooled escrow balanced.

### 3.4 Failure modes (all atomic — full tx reverts)

| Failure | Where it surfaces |
|---|---|
| No resting `OrderNote` matches `order_nonce` | note retrieval finds zero notes → assertion fails |
| Caller is not the order's owner | maker's per-owner `PrivateSet` yields no match; explicit `owner` assert as backstop |
| Epoch no longer OPEN | enqueued `_assert_epoch_open()` callback |
| Orderbook public balance < `amount_in` (should be impossible) | inside `Token.transfer_public_to_private` |
| Double-cancel of the same order | nullifier already emitted → second tx fails |

### 3.5 What `cancel_order` does NOT do in Week 3

- **No partial cancel.** Cancellation is all-or-nothing; an order is removed in
  full or not at all. Partial amounts are not a concept until clearing.
- **No `CLOSING`-state cancel.** Cancel is gated to `OPEN`. The MVP design
  forbids cancelling mid-clearing so users cannot race the clearing tx. With no
  epoch transitions in Week 3 the epoch is always OPEN, but the gate is wired
  now so the invariant holds once Week 4 lands transitions.

---

## 4. Escrow return mechanism

The escrow sits in the Orderbook's **public** balance; the return must land in
the maker's **private** balance. The vendored Token already exposes the exact
primitive:

```rust
#[authorize_once("from", "_nonce")]
#[external("private")]
fn transfer_public_to_private(from, to, amount, _nonce)
```

It is itself a private function that enqueues the public-balance decrease and
credits a private balance note to `to`. The Orderbook calls it with
`from = self.address`; since the Orderbook is also the caller, `msg_sender`
equals `from` and `authorize_once` passes with no authwit. This is the precise
mirror of `submit_order`, which used `transfer_private_to_public(maker,
self.address, amount_in, nonce)`. No manual partial-note / commitment handling
is needed in the Orderbook.

---

## 5. `get_orders` utility getter

To make `cancel_order` usable, the CLI must show the maker their resting orders
and the `nonce` of each. Week 3 adds one unconstrained getter:

```rust
#[external("utility")]
unconstrained fn get_orders(owner: AztecAddress) -> BoundedVec<OrderNote, MAX_INPUT_NOTES>
```

- Takes `owner` explicitly rather than relying on `msg_sender` — utility
  functions are simulated and only the owner's PXE holds the (encrypted) notes,
  so the simulation run by that PXE resolves them.
- Returns up to `MAX_INPUT_NOTES` (= 8) resting `OrderNote`s — sufficient for
  Week 3 test scenarios. Pagination is deferred (see §2).
- This mirrors the four read-only getters Week 2 already added (`get_epoch`,
  `get_token_a_addr`, …).

---

## 6. CLI package

### 6.1 Package layout

A new pnpm workspace member at `cli/`:

```
cli/
  package.json        # name "@quetzal/cli", bin "zswap" -> dist/index.js or tsx entry
  tsconfig.json
  src/
    index.ts          # commander setup, registers the three subcommands
    config.ts         # load/validate quetzal.config.json
    wallet.ts         # node client + EmbeddedWallet + account selection
    commands/
      order.ts
      cancel.ts
      orders.ts
```

Dependencies: `commander`, `@aztec/aztec.js`, `@aztec/wallets`, `tsx` (dev). The
generated `Token`/`Orderbook` bindings under `tests/integration/generated/` are
imported directly (same as `deploy-tokens.ts`).

### 6.2 Config

The CLI reads `quetzal.config.json` from the working directory (overridable with
`--config <path>`):

```json
{
  "nodeUrl": "http://localhost:8080",
  "tUSDC": "0x...",
  "tETH": "0x...",
  "orderbook": "0x...",
  "admin": "0x..."
}
```

`deploy-tokens.ts` is changed to **write** this file (in addition to printing
the JSON to stdout) so the CLI works immediately after a deploy. The file is
git-ignored (it holds environment-specific addresses).

### 6.3 Wallet / account selection

The CLI uses the local-network test accounts, identical to the integration
tests: `createAztecNodeClient` + `waitForNode`, `EmbeddedWallet.create`,
`registerInitialLocalNetworkAccountsInWallet`. A global `--account <index>`
flag (default `0`) chooses which test account acts as the maker. Real wallet
key management is out of scope until the UI sub-project.

### 6.4 Commands

| Command | Flags | Action |
|---|---|---|
| `quetzal order` | `--side <buy\|sell>`, `--amount <n>`, `--limit <price>`, `--account <i>` | Computes fresh `nonce` + `order_nonce`, calls `submit_order`. `buy` → `side=false`, `sell` → `side=true`. Prints the resulting `order_nonce` so the maker can cancel later. |
| `quetzal cancel` | `--nonce <field>`, `--account <i>` | Calls `cancel_order(order_nonce, nonce)` with a fresh authwit `nonce`. Prints the returned amount. |
| `quetzal orders` | `--account <i>` | Calls the `get_orders` utility getter for the account's address; prints a table of resting orders (`order_nonce`, side, `amount_in`, `limit_price`, `submitted_at_block`). |

`--amount` and `--limit` are parsed as integers in the token's smallest unit
(no decimal-scaling convenience in Week 3 — that is UI-layer polish).

---

## 7. Test strategy

### 7.1 Noir TXE tests (`contracts/orderbook/src/test.nr`)

| Test | What it verifies |
|---|---|
| `cancel_order_removes_note` | After submit + cancel, the maker's `orders` set is empty and `get_orders` returns zero entries. |
| `cancel_order_rejects_unknown_nonce` | `cancel_order` with an `order_nonce` that matches no resting note reverts. |
| `cancel_order_rejects_non_owner` | A second account cancelling the maker's order reverts. |
| `cancel_order_rejects_when_not_open` | TXE sets `EpochState.state` ≠ OPEN via direct storage write; `cancel_order` reverts. |
| `get_orders_returns_resting_orders` | After two submits, `get_orders(owner)` returns both notes with the expected fields. |

Cross-contract Token deploy in TXE follows the Week 2 decision: attempt it for
the escrow-return assertion; fall back to integration coverage if flaky.

### 7.2 TypeScript integration tests (`tests/integration/orderbook.test.ts`)

Run against the live dev stack:

| Scenario | Setup → Assertion |
|---|---|
| `submit then cancel restores private balance` | Mint 1000 tUSDC to Alice. `submit_order(side=false, amount_in=100)`. Cancel it. Assert: Alice's private tUSDC = 1000 again; Orderbook public tUSDC = 0; Alice's PXE has no `OrderNote`. |
| `cancel returns the correct token on the ask side` | Alice submits `side=true` with tETH. Cancel. Assert tETH (not tUSDC) balance restored. |
| `cancel of one of two orders leaves the other` | Alice submits two orders, cancels one. Assert: one `OrderNote` remains; Orderbook public balance reflects only the surviving order. |
| `double cancel fails` | Submit, cancel, cancel again → second cancel tx rejected; balances unchanged after the first cancel. |
| `non-owner cannot cancel` | Bob attempts to cancel Alice's order → rejected. |

### 7.3 CLI smoke test (`tests/integration/cli.test.ts`)

Drives the CLI as a child process against the dev stack: `quetzal order` →
`quetzal orders` (asserts the new order is listed with a `nonce`) → `quetzal cancel`
(using that nonce) → `quetzal orders` (asserts the list is now empty).

---

## 8. Repository delta after Week 3

```
contracts/orderbook/src/main.nr     +  cancel_order, get_orders
contracts/orderbook/src/test.nr     +  5 TXE tests
cli/                                +  new workspace package (package.json, src/**)
pnpm-workspace.yaml                 ~  add cli/ to the workspace
scripts/deploy-tokens.ts            ~  also writes quetzal.config.json
tests/integration/orderbook.test.ts +  5 cancel integration tests
tests/integration/cli.test.ts       +  CLI smoke test
.gitignore                          ~  add quetzal.config.json
README.md                           ~  status line + CLI quickstart
```

## 9. Implementation phases (preview of the plan)

1. `cancel_order` + `get_orders` on `OrderbookContract` (+ recompile, codegen).
2. TXE tests for cancel and `get_orders`.
3. Cancel integration tests.
4. `cli/` workspace package scaffold (config, wallet, commander entry).
5. `order` / `cancel` / `orders` commands.
6. `deploy-tokens.ts` writes `quetzal.config.json`; CLI smoke test.
7. Final clean rebuild + smoke; README; milestone commit + tag.

## 10. Risks specific to Week 3

- **PrivateSet note-retrieval API.** The exact v4.2.0 API to fetch a single note
  by a field selector and to `remove` it (`get_notes` / `pop_notes` +
  `NoteGetterOptions`) needs confirmation against the aztec-nr source. Phase 1
  carries a short discovery step, the way Week 2 Task 5 handled novel API.
- **Utility getter returning `BoundedVec` of notes.** Returning a variable-count
  collection of notes from an `unconstrained` utility function is unverified in
  v4.2.0. Fallback: a fixed-arity getter or a per-nonce `get_order(nonce)`
  lookup, with the CLI iterating.
- **CLI as a workspace package.** First non-test TypeScript package in the repo;
  the workspace / build wiring is new surface but low-risk.

## 11. Acceptance criteria

- `cancel_order` and `get_orders` compile; `pnpm compile` and `pnpm codegen`
  succeed for both contracts.
- All Week 2 TXE + integration tests still pass; the 5 new cancel TXE tests, 5
  new cancel integration tests, and the CLI smoke test pass.
- `quetzal order`, `quetzal orders`, `quetzal cancel` work end-to-end against the dev
  stack after `deploy-tokens.ts` has written `quetzal.config.json`.
- A submitted order can be cancelled and the maker's **private** balance is
  fully restored — verified on-chain, not just by the absence of a note.

## 12. Open questions deferred to implementation

- Exact `NoteGetterOptions` selector syntax for matching `OrderNote.nonce`.
- Whether `get_orders` returns `BoundedVec<OrderNote, 8>` or a fixed array.
- CLI output formatting (plain table vs. JSON `--json` flag) — cosmetic, decide
  during command implementation.
