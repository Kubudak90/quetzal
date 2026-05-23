# Week 5d-1: Epoch Order Accumulator — Design

**Status:** approved
**Sub-project:** Week 5d (trustless clearing via ZK proof), slice 1 of 4

---

## 1. Goal

Make every order submitted and every order cancelled during an epoch verifiable from on-chain state alone, so the future clearing circuit (Week 5d-2) can prove "I cleared exactly this epoch's order set" against on-chain commitments. This week ships **contract-side accumulators only** — no circuit, no recursive verification, no aggregator changes.

## 2. Background

Week 5c shipped on-chain trusted clearing: the `clearing_authority` calls `close_epoch_and_clear(fills, swap)` and the contract relays the result without re-deriving it. Two trust gaps remain for Week 5d to close:

1. **Clearing correctness** — given an order set, are the fills/swap a correct auction output? (Week 5d-2: Noir clearing circuit.)
2. **Order-set authenticity** — are the orders the circuit cleared *actually* the orders submitted this epoch? (Week 5d-1: this spec.)

Gap 2 cannot be solved at clearing time because orders are private notes; the contract cannot enumerate them. The solution is to commit to each order's content at *submission* time, in public storage the circuit can bind to.

## 3. Scope

**In scope:**
- `EpochState` gains four fields: `order_acc`, `cancel_acc`, `order_count`, `cancel_count`.
- `submit_order` computes a per-order commitment and appends it to `order_acc` (via a new public callback).
- `cancel_order` recomputes the same commitment from the popped `OrderNote` and appends it to `cancel_acc` (via a new public callback).
- Epoch lifecycle: `close_epoch`, `close_epoch_and_clear`, and the constructor reset all four fields to identity.
- Capacity: `MAX_FILLS = 128` is renamed to `MAX_ORDERS_PER_EPOCH = 128` (one canonical constant); `submit_order` rejects past the cap.
- TXE tests covering accumulator updates, cancellation, capacity, the submit/cancel commitment-equality invariant, and epoch reset.

**Out of scope (deferred):**
- The Noir clearing circuit and its proof generation (Week 5d-2).
- Recursive verification inside the Orderbook contract; the `CLOSING` epoch state (Week 5d-3).
- Merkle settlement root / inclusion-proof claims (Week 5d-4).
- Aggregator changes — `clearing.ts`, `clearing.test.ts`, the `@quetzal/aggregator` package are untouched.
- CLI changes, integration tests against a live stack.

## 4. Data Model

### 4.1 Order commitment

Computed in **private** context (in both `submit_order` and `cancel_order`):

```
c_i = poseidon2([
    owner_field,         // AztecAddress → Field
    side as Field,       // false=0, true=1
    amount_in as Field,
    limit_price as Field,
    order_nonce,         // Field; per-order random salt
    submitted_at_block as Field,
])
```

Properties:

- **Binds the full `OrderNote` field set.** The clearing circuit may consume any subset of these; binding all of them gives the circuit freedom and prevents the prover from substituting any field.
- **Hiding.** `order_nonce` is a random Field salt; given `c_i` an observer cannot recover `side`, `amount_in`, or `limit_price` (Poseidon2 with one high-entropy preimage component is preimage-resistant).
- **Deterministic across submit/cancel.** `OrderNote` carries every preimage field, so `cancel_order` recomputes the identical `c_i` from the popped note.

### 4.2 `EpochState` extension

```noir
pub struct EpochState {
    pub epoch_id:        u32,
    pub state:           u8,
    pub opened_at_block: u32,
    pub closes_at_block: u32,
    // ↓ new in 5d-1
    pub order_acc:       Field,
    pub cancel_acc:      Field,
    pub order_count:     u32,
    pub cancel_count:    u32,
}
```

- `order_acc` — running-hash chain of submitted-order commitments: `acc' = poseidon2([acc, c_i])`.
- `cancel_acc` — running-hash chain of cancelled-order commitments: same formula.
- `order_count` — number of `submit_order` successes this epoch (monotonic, capped at 128).
- `cancel_count` — number of `cancel_order` successes this epoch (monotonic, ≤ `order_count`).
- Empty-chain identity = `0`. First append: `poseidon2([0, c₁])`.
- Cancellation does **not** decrement `order_count`. The cleared set is the multiset difference (submitted − cancelled), computed inside the future circuit.

### 4.3 Constants

```noir
pub global MAX_ORDERS_PER_EPOCH: u32 = 128;  // renamed from MAX_FILLS
```

`close_epoch_and_clear`'s `BoundedVec<FillEntry, MAX_FILLS>` and per-fill loop are retargeted to `MAX_ORDERS_PER_EPOCH`. One constant; the conceptual identity is "max orders per epoch = max fills per epoch."

## 5. `submit_order` Flow

Lines added to the existing flow (the rest is unchanged):

```
1. Validate amount_in > 0, limit_price > 0  [unchanged]
2. Escrow: Token.transfer_private_to_public  [unchanged]
3. Insert OrderNote into the maker's PrivateSet  [unchanged]
4. Compute c_i = poseidon2([...])   ← NEW
5. enqueue_self._assert_epoch_open()  [unchanged]
6. enqueue_self._append_order(c_i)   ← NEW
```

The block number used in `c_i` is the same value written to `OrderNote.submitted_at_block` (already computed at step 3 via `get_anchor_block_header().block_number()`).

### 5.1 `_append_order` callback

```noir
#[external("public")]
#[only_self]
fn _append_order(c_i: Field) {
    let mut epoch = self.storage.current_epoch.read();
    assert(
        epoch.order_count < MAX_ORDERS_PER_EPOCH,
        "epoch order capacity reached",
    );
    epoch.order_acc   = poseidon2([epoch.order_acc, c_i]);
    epoch.order_count = epoch.order_count + 1;
    self.storage.current_epoch.write(epoch);
}
```

`_assert_epoch_open` (existing) and `_append_order` (new) execute in enqueue order during the public phase of the same tx. If either reverts, the tx — including escrow and `OrderNote` insertion — reverts atomically. `_append_order` does not duplicate the epoch-state check; the preceding `_assert_epoch_open` already enforces it.

## 6. `cancel_order` Flow

Lines added to the existing flow (the rest is unchanged):

```
1. Pop OrderNote, owner check  [unchanged]
2. Read token addr by note.side  [unchanged]
3. Compute c_i from the popped note   ← NEW
4. enqueue_self._assert_epoch_open()       [unchanged]
5. enqueue_self._assert_not_filled(...)    [unchanged — Week 5c guard]
6. enqueue_self._append_cancel(c_i)        ← NEW
7. Token.transfer_public_to_private (escrow return)  [unchanged]
```

The new `_append_cancel` enqueue sits **before** the escrow-return call — the Week 5c ordering pattern. Guards run first; if any reverts, `cancel_acc` is not mutated and the escrow is not returned.

### 6.1 `_append_cancel` callback

```noir
#[external("public")]
#[only_self]
fn _append_cancel(c_i: Field) {
    let mut epoch = self.storage.current_epoch.read();
    epoch.cancel_acc   = poseidon2([epoch.cancel_acc, c_i]);
    epoch.cancel_count = epoch.cancel_count + 1;
    self.storage.current_epoch.write(epoch);
}
```

No cap check: since `cancel_count` only advances when a real `OrderNote` is popped (and `OrderNote` insertion is itself capped at 128 via `_append_order`), `cancel_count ≤ order_count ≤ 128` is inherent.

## 7. Epoch Lifecycle

The constructor and both close paths write a fresh `EpochState`. Each writes the four new fields as identity:

```noir
EpochState {
    epoch_id:        next_id,
    state:           EPOCH_STATE_OPEN,
    opened_at_block: block,
    closes_at_block: block + epoch_length,
    order_acc:       0,
    cancel_acc:      0,
    order_count:     0,
    cancel_count:    0,
}
```

Touched call sites: `constructor`, `close_epoch`, `close_epoch_and_clear`.

## 8. Privacy & Security

**What becomes public per submission:** one hiding commitment `c_i` (passed as the public argument of `_append_order`), and the post-update `order_acc` / `order_count` in `EpochState`. The same applies for cancellation via `cancel_acc` / `cancel_count`. Order *contents* (side, amount, limit) remain private — preimage-resistance of Poseidon2 under a random `order_nonce` salt is the hiding argument.

**Public batch cardinality.** `order_count` reveals the number of orders per epoch. This matches Penumbra's batch-auction privacy model (batch cardinality is public; per-order detail is private) and is consistent with the project's privacy-maximalism principle: the minimum unavoidable leak.

**Binding (forward-looking).** Running-hash binding is cryptographic: an attacker cannot present two distinct order multisets with matching `order_acc` chains without finding a Poseidon2 collision. Order-dependent chaining means the circuit must replay submissions in their actual submission order (recoverable from public tx order). Cancellations are similarly order-bound.

**Atomicity.** Capacity violation in `_append_order` reverts the whole tx (escrow + note + accumulator). A cancel rejected by `_assert_epoch_open` or `_assert_not_filled` leaves `cancel_acc` unmutated because `_append_cancel` is enqueued after the guards.

## 9. Testing

Tests are split along the project's established line: **TXE for schema/state-shape; TS integration for happy-path.** The existing Orderbook TXE tests (`contracts/orderbook/src/test.nr`) cover only input-validation negative paths because `submit_order`'s happy path needs a real `Token` contract + authwits, which the suite intentionally defers to integration (see the comment block at `test.nr:117-120`). 5d-1 follows that pattern.

### 9.1 TXE tests (`contracts/orderbook/src/test.nr`, no Docker)

Extend the existing tests rather than add new ones:

| # | Test | New assertion |
|---|---|---|
| TX1 | `constructor_sets_initial_epoch_state` | initial `order_acc == 0`, `cancel_acc == 0`, `order_count == 0`, `cancel_count == 0`. |
| TX2 | `close_epoch_advances_to_next_epoch` | the new epoch's four new fields are all `0` (reset from zero — trivially correct because no submits happened, but locks the reset write). |

Plus update the two `MAX_FILLS` references in `test.nr` to `MAX_ORDERS_PER_EPOCH`.

### 9.2 TS integration tests (`tests/integration/orderbook.test.ts`, needs Docker / dev stack)

Add a 4th `describe` block — `orderbook order accumulator (live integration)` — alongside the existing three:

| # | Test | Asserts |
|---|---|---|
| IT1 | Single submit chain link | After one `submit_order`, `get_epoch()` returns `order_acc == poseidon2([0, c₁])`, `order_count == 1`, `cancel_acc == 0`, `cancel_count == 0`. Expected `c₁` and `acc'` computed in-test via `poseidon2Hash` from `@aztec/foundation/crypto`. |
| IT2 | Three-submit replay | `order_acc` after three submits equals manually-replayed 3-link chain; `order_count == 3`. |
| IT3 | Cancel after submit | After one submit + one cancel of the same order, `cancel_acc == poseidon2([0, c_i])`, `cancel_count == 1`, `order_count` unchanged. |
| IT4 | Submit-cancel commitment-equality invariant | After one submit + one cancel of the same order, `order_acc == cancel_acc` (proves both sides compute the identical `c_i`). |
| IT5 | Capacity | 128 `submit_order` succeed; the 129th reverts with `"epoch order capacity reached"`. Slow (128 live submits). |
| IT6 | Epoch reset from nonzero state | Submit orders to make `order_count > 0`, advance past expiry, `close_epoch` → new epoch's four new fields are `0`. Repeat with `close_epoch_and_clear` (resets even when fills/swap are non-empty). |

## 10. Affected files

- `contracts/orderbook/src/main.nr` — `MAX_FILLS` rename, `EpochState` extension, `submit_order` + `_append_order`, `cancel_order` + `_append_cancel`, `close_epoch` / `close_epoch_and_clear` / constructor reset lines.
- `contracts/orderbook/src/test.nr` — extend `constructor_sets_initial_epoch_state` and `close_epoch_advances_to_next_epoch`; rename `MAX_FILLS` references.
- `tests/integration/orderbook.test.ts` — new `describe` block with IT1-IT6.
- `tests/integration/generated/Orderbook.ts` — regenerated by `pnpm codegen` (pretest hook) after the contract changes; commit the regenerated file per project convention.

Not touched: `contracts/pool/*`, `contracts/token/*`, `aggregator/*`, `cli/*`, other integration files, `scripts/*`.

## 11. Forward References

- **Week 5d-2** (clearing circuit) will consume `order_acc`, `cancel_acc`, `order_count`, `cancel_count` as public inputs and the per-order preimages as private inputs; it asserts a replay of the private list produces the on-chain chain values, then clears the multiset difference.
- **Week 5d-3** will replace `close_epoch_and_clear`'s authority gate with a recursive proof check against those public inputs, and introduce the `CLOSING` epoch state.
- **Week 5d-4** will replace the `fills: Map<Field, PublicMutable<u128>>` with a single committed Merkle root over `(order_nonce, amount_out)` leaves; `claim_fill` becomes inclusion-proof based.
