# ZSwap-on-Aztec MVP — Design Spec

**Status:** Draft, awaiting user review
**Date:** 2026-05-14
**Sub-project:** 1 of 6 (MVP Vertical Slice). See `2026-05-14-zswap-aztec-roadmap.md` for full protocol roadmap.
**Target devnet release:** ~12 weeks from kickoff

---

## 1. Executive Summary

ZSwap-on-Aztec is an MEV-resistant dark-pool DEX implemented as Noir smart contracts on the Aztec Network. Orders are submitted as encrypted private notes, batched per epoch, and cleared at a single uniform price determined by the AMM bonding curve and revealed order set. Frontrunning and sandwich attacks are mathematically impossible because all orders within an epoch settle simultaneously at one price.

This MVP delivers a single-pair, uniform-liquidity vertical slice: end-to-end private trade with private LP positions, swap fees accruing to LPs, FIFO-fair carryover for over-subscribed epochs, and order cancellation. The MVP runs against a single trusted aggregator; permissionless aggregation arrives in sub-project 3.

The design is a faithful adaptation of Penumbra's ZSwap to Aztec's native private-note model. Penumbra solves the analogous problem on Cosmos via threshold encryption + DAR auctions; Aztec's per-user encrypted notes let us use a simpler user-PXE reveal channel in V1.

---

## 2. Goals & Non-Goals

### 2.1 Goals (MVP scope)

1. **Private order submission.** A user submits an order whose side, amount, and limit price are never visible on-chain except inside their own wallet's PXE.
2. **Uniform clearing price per epoch.** All filled orders in an epoch settle at one price. MEV via reordering is impossible by construction.
3. **Private LP positions.** An LP's share, deposit history, and accrued fees are visible only to their own wallet. Total reserves and total LP supply are public aggregates (Penumbra parity).
4. **Fee accrual from day one.** 0.3% swap fee on inputs, fully distributed to LPs via cumulative-fee-per-share snapshots in position notes.
5. **Order cancellation and carryover.** Standing limit orders persist across epochs until filled or cancelled. Over-subscribed epochs (>128 orders) carry the surplus to the next epoch, FIFO.
6. **Devnet-deployable.** Targets `aztec-packages v4.2.1` API surface. CLI-first; no UI in MVP.

### 2.2 Non-goals (deferred to later sub-projects)

| Deferred feature | Sub-project |
|---|---|
| Concentrated liquidity (range positions) | 2 |
| Permissionless aggregator with bonding/slashing, threshold-decryption committee | 3 |
| Multi-pair pools and atomic multi-hop routing | 4 |
| L1 ↔ Aztec bridge for real assets, web UI, indexer, wallet integration | 5 |
| Protocol fee splitter, fee tier registry, governance contract | 6 |

The MVP intentionally trades feature breadth for cryptographic depth: it must prove the FBA core works end-to-end before any extension is built on top.

---

## 3. System Architecture

### 3.1 On-chain contracts (Noir, `aztec-nr` v4.2.1)

| Contract | Responsibility |
|---|---|
| `TokenContract` (×2: `tUSDC`, `tETH`) | Standard Aztec private token. Test assets only in MVP; real bridged assets arrive in sub-project 5. Derived from the official `aztec-standards` token. |
| `OrderbookContract` | Order submission/cancellation private functions. Holds the persistent `PrivateSet<OrderNote>` (standing limit orders). |
| `ClearingContract` | Public `close_epoch_and_clear(...)` function. Verifies the aggregator's clearing proof, updates pool reserves, posts settlement Merkle root, opens next epoch. |
| `LiquidityPoolContract` | LP `deposit`/`withdraw` private functions. Holds `PrivateSet<PositionNote>` (private positions) and public aggregate reserves, total supply, and cumulative fee counters. |

In MVP these four contracts are deployed as separate Aztec contracts. They reference each other by address. Cross-contract calls use the standard `enqueue` pattern for private-to-public and direct calls for private-to-private.

A possible later refactor: collapse `OrderbookContract` and `ClearingContract` into one (they share state heavily and never need independent upgrade). Left separate in MVP for clearer reasoning about each contract's invariants in isolation.

### 3.2 Off-chain components

| Component | Stack | Responsibility |
|---|---|---|
| Aggregator client | TypeScript (Node 22), `@aztec/aztec.js`, Noir.js | Watches the chain for `close_epoch_and_clear` opportunities. Collects user reveals over the reveal channel. Computes clearing price. Generates the clearing proof. Submits the clearing transaction. |
| Reveal collector | TypeScript, part of aggregator | Receives signed reveal payloads from user PXEs over a simple WebSocket relay. MVP-only minimum-viable channel; sub-project 3 replaces this with threshold encryption + DKG committee. |
| CLI | TypeScript, `commander` + `@aztec/aztec.js` | `zswap deposit`, `zswap order`, `zswap cancel`, `zswap withdraw`, `zswap claim`. Thin wrapper over wallet + contract calls. Also publishes the user's order reveal to the reveal collector. |

### 3.3 Data flow — one epoch

```
[Block 0] open_epoch (atomic with previous close)
  ├─ Users call submit_order (private):
  │    – consume input token notes via TokenContract
  │    – commit encrypted OrderNote to orderbook
  │    – emit encrypted log to self (+ also publish reveal to aggregator)
  └─ Users may call cancel_order (private) any time during OPEN

[Block 100] (close threshold reached)

[Block 100+] aggregator off-chain:
  ├─ Reads all OrderNote commitments from the orderbook (public commitments)
  ├─ Reads reveal payloads from its collector
  ├─ Cross-references: every commitment must have a matching reveal,
  │     otherwise that order is treated as unrevealed and not filled
  ├─ Selects oldest 128 eligible orders (FIFO by submitted_at_block)
  ├─ Computes clearing price P* (iterative binary search)
  ├─ Computes per-order fill amounts
  ├─ Builds settlement Merkle tree
  ├─ Generates clearing proof in Noir
  └─ Submits close_epoch_and_clear(proof, public_inputs)

[Block N+1] ClearingContract:
  ├─ Verifies proof
  ├─ Updates pool reserves (public)
  ├─ Updates cumulative fee counters (public)
  ├─ Stores settlement Merkle root keyed by epoch_id (public)
  ├─ Increments epoch_id, opens new epoch
  └─ For partial-fill remnants: nullifies original OrderNote, commits a new
     OrderNote with reduced amount_in and preserved submitted_at_block

[Async] Users open their settlement notes:
  ├─ PXE detects new encrypted log from clearing tx
  └─ User calls claim_settlement(note, merkle_proof) → receives token notes
```

---

## 4. Storage Model

```rust
// LiquidityPoolContract storage
#[storage]
struct LiquidityPoolStorage<Context> {
    // Public aggregates (kimliksiz)
    total_reserve_a:      PublicMutable<u128, Context>,
    total_reserve_b:      PublicMutable<u128, Context>,
    total_lp_supply:      PublicMutable<u128, Context>,
    cum_fee_a_per_share:  PublicMutable<u128, Context>,  // 1e18-scaled
    cum_fee_b_per_share:  PublicMutable<u128, Context>,

    // Private state
    positions:            PrivateSet<PositionNote, Context>,
}

// OrderbookContract storage
#[storage]
struct OrderbookStorage<Context> {
    orders:               PrivateSet<OrderNote, Context>,
    current_epoch:        PublicMutable<EpochState, Context>,
    clearing_addr:        PublicImmutable<AztecAddress, Context>,  // authorized caller for _advance_epoch
}

// ClearingContract storage
#[storage]
struct ClearingStorage<Context> {
    // Per-epoch settlement Merkle root for claim verification
    settlement_roots:     Map<u32, PublicMutable<Field, Context>, Context>,
    // Clearing proof verifier key
    verifier_key:         PublicImmutable<VerifierKey, Context>,
    orderbook_addr:       PublicImmutable<AztecAddress, Context>,
    pool_addr:            PublicImmutable<AztecAddress, Context>,
}

struct EpochState {
    epoch_id:           u32,
    state:              u8,     // 0=OPEN, 1=CLOSING, 2=SETTLED
    opened_at_block:    u32,
    closes_at_block:    u32,    // opened_at_block + 100
}
```

`PublicMutable` versus `PublicImmutable` choice: `verifier_key` is immutable (set at deploy, never changes in MVP). Reserves and fee counters are mutable. Epoch state is mutable.

---

## 5. Note Types

```rust
#[note]
struct OrderNote {
    submitted_at_block:   u32,
    side:                 bool,           // 0 = A→B, 1 = B→A
    amount_in:            u128,
    limit_price:          u128,           // 1e18-scaled fixed-point
    nonce:                Field,
    owner:                AztecAddress,
}

#[note]
struct PositionNote {
    lp_share:                          u128,
    cum_fee_a_per_share_at_deposit:    u128,
    cum_fee_b_per_share_at_deposit:    u128,
    deposit_epoch:                     u32,
    owner:                             AztecAddress,
}

#[note]
struct SettlementNote {
    amount_out:   u128,
    asset_out:    bool,    // 0 = A, 1 = B
    epoch_id:     u32,
    owner:        AztecAddress,
}
```

**Note hash & nullifier.** All three notes derive their commitment via Aztec's standard `compute_note_hash_and_nullifier` macro pattern. The nullifier is domain-separated by note type.

**Encryption.** Each note is encrypted to its owner's incoming-view public key using Aztec's standard encryption pattern (`encode_and_encrypt(note, recipient_pubkey)`). This produces the encrypted log that only the owner's PXE can open.

**Why `OrderNote` has no `epoch_id`.** Orders are standing limit orders. They live in the orderbook from submission until either fully filled or cancelled. `submitted_at_block` enforces FIFO ordering within and across epochs.

---

## 6. Epoch State Machine

```
   ┌─────────────────────────────────────────────────────────┐
   v                                                         │
┌─────────┐  open_epoch     ┌──────────┐   submit_order      │
│ SETTLED │ ───────────────>│   OPEN   │ <───── (private)    │
│         │  (atomic with   │          │                     │
│         │   close)        │  100 blk │   cancel_order      │
└─────────┘                 │          │ <───── (private)    │
     ^                      └─────┬────┘                     │
     │                            │                          │
     │           block ≥ closes_at_block                     │
     │                            │                          │
     │                            v                          │
     │                      ┌──────────┐                     │
     │  close_epoch         │ CLOSING  │  (aggregator        │
     │  _and_clear()        │          │   off-chain)        │
     │ <────────────────────│          │                     │
     │                      └──────────┘                     │
     └────────────────────────────┘
```

**Transition table:**

| From | To | Trigger | Function | Caller |
|---|---|---|---|---|
| `SETTLED` | `OPEN` | clearing completes | `_open_next_epoch` (internal) | `ClearingContract` |
| `OPEN` | `OPEN` | order submit | `submit_order` | user (private) |
| `OPEN` | `OPEN` | order cancel | `cancel_order` | user (private) |
| `OPEN` | `CLOSING` | implicit (`block ≥ closes_at_block`) | none — checked in `close_epoch_and_clear` | — |
| `CLOSING` | `SETTLED` | clearing accepted | `close_epoch_and_clear` | aggregator (public) |

**Atomicity.** `SETTLED → OPEN` happens within the same public transaction as the preceding `CLOSING → SETTLED`. There is no idle gap.

**Cross-contract epoch ownership.** `current_epoch` lives on `OrderbookContract` (because order submission needs to read it). `ClearingContract` advances it by calling a gated public function on the orderbook: `OrderbookContract._advance_epoch(new_epoch_id, opened_at_block)`, restricted to `msg_sender() == clearing_addr`. This call is enqueued from within `close_epoch_and_clear` so the state transition is atomic with clearing.

---

## 7. Order Lifecycle

### 7.1 Submission

```rust
#[external("private")]
fn submit_order(
    amount_in:           u128,
    side:                bool,
    limit_price:         u128,
    input_note_secrets:  BoundedVec<Field, MAX_INPUT_NOTES>,
) {
    let sender = self.msg_sender();
    let epoch  = self.storage.current_epoch.read_public();
    assert(epoch.state == EpochState::OPEN, "epoch not open");

    // Consume input token notes
    let token = if side == 0 { TOKEN_A_ADDRESS } else { TOKEN_B_ADDRESS };
    TokenContract::at(token)
        .transfer_to_orderbook(sender, amount_in, input_note_secrets)
        .call(&mut self.context);

    // Mint OrderNote, encrypted to sender
    let order = OrderNote {
        submitted_at_block: self.context.block_number(),
        side, amount_in, limit_price,
        nonce: rand_field(),
        owner: sender,
    };
    self.storage.orders.insert(order).emit(encode_and_encrypt(sender, order));
}
```

After this private call, the CLI also publishes a **signed reveal** to the aggregator's collector: `{ order_hash, side, amount_in, limit_price, signature }`. The signature is over the order hash using the user's Aztec address key, proving the reveal authentic. Without this off-chain reveal, the aggregator only sees the commitment and cannot include the order in clearing.

### 7.2 Cancellation

```rust
#[external("private")]
fn cancel_order(order_note_secret: Field) {
    let order  = self.storage.orders.get(order_note_secret);
    let sender = self.msg_sender();
    assert(order.owner == sender);

    let epoch = self.storage.current_epoch.read_public();
    assert(epoch.state == EpochState::OPEN, "cannot cancel mid-clearing");

    self.storage.orders.remove(order).emit_nullifier();

    let token = if order.side == 0 { TOKEN_A_ADDRESS } else { TOKEN_B_ADDRESS };
    TokenContract::at(token)
        .transfer_from_orderbook(sender, order.amount_in)
        .enqueue(&mut self.context);
}
```

Cancellation is gated to `OPEN` because mid-clearing the order might already be selected for fill; allowing cancel during `CLOSING` would let users race the clearing tx.

### 7.3 Carryover

The clearing circuit produces, in addition to settlement notes, **remnant order notes** for partial fills. Concretely:

- If an order's fill amount equals its `amount_in`: full fill. The original note is nullified; only the settlement note is produced.
- If an order's fill amount is less than `amount_in`: partial fill. The original note is nullified AND a new `OrderNote` is committed with `amount_in_new = amount_in − fill`, same `submitted_at_block`, new `nonce`, same `owner`. This new note is encrypted to the owner so their PXE picks it up next epoch.
- If an order is in the orderbook but not selected for this epoch (rank > 128 by `submitted_at_block`): not touched. It remains in the `PrivateSet` for next epoch.

Partial-fill carryover and non-selection carryover are different mechanisms; both yield orders that persist to the next epoch. Both can be cancelled normally via `cancel_order`.

---

## 8. Clearing Algorithm & Circuit

### 8.1 Off-chain clearing algorithm

```
Input:
  pool_state = (Ra, Rb)
  orders = [(amount_in, side, limit_price, submitted_at_block, owner) × n]
  total_lp_supply

Step 1: Select up to 128 oldest orders (FIFO by submitted_at_block).
Step 2: If no orders eligible, skip clearing entirely (epoch closes with zero fills, new epoch opens).
Step 3: Binary-search for P* in [Ra/Rb / 100, Ra/Rb × 100]:
  for candidate P:
    eligible_buys  = orders.filter(side=0, limit_price >= P).take(128)
    eligible_sells = orders.filter(side=1, limit_price <= P).take(128)
    sum_a_in  = sum of eligible_buys.amount_in
    sum_b_in  = sum of eligible_sells.amount_in
    # Cross-net at P
    net_a = sum_a_in − sum_b_in × P
    if net_a > 0:
      # net flow A → B through AMM
      out_b = Rb − (Ra × Rb) / (Ra + net_a × (1 − fee))
      realized_p = net_a / out_b
    else:
      # net flow B → A through AMM
      in_b = −net_a / P
      out_a = Ra − (Ra × Rb) / (Rb + in_b × (1 − fee))
      realized_p = out_a / in_b
    if realized_p == P (within tolerance): return P, fills, new_pool_state
Step 4: Pro-rata distribute fills at P*.
```

### 8.2 Noir clearing circuit (verifies the aggregator's claim)

Public inputs (committed to on-chain):
- `epoch_id`
- `pool_state_before` (Ra, Rb, total_lp_supply, cum_fees)
- `pool_state_after` (Ra', Rb', total_lp_supply, cum_fees')
- `clearing_price` (P*)
- `settlement_merkle_root`
- `order_commitments_root` (Merkle root of the 128 included commitments, ordered by `submitted_at_block`)
- `num_filled`

Private inputs (witness):
- `orders[128]` — revealed order plaintexts
- `commitment_paths[128]` — Merkle inclusion paths in the orderbook tree
- `fills[128]` — per-order fill amounts
- `settlement_paths[128]` — Merkle paths into the settlement tree

Constraints:
1. **Commitment integrity.** For each i: `hash(orders[i]) == commitment[i]` and inclusion in the orderbook tree verifies.
2. **FIFO fairness.** The 128 included orders are the 128 oldest in the orderbook by `submitted_at_block`. This is proven by including, as additional witness, the (would-be 129th) oldest excluded order's commitment and verifying its `submitted_at_block ≥ max(included.submitted_at_block)`.
3. **Limit price respected.** For each filled order, `fills[i] > 0` implies `limit_price` is consistent with `clearing_price`.
4. **AMM swap correctness.** `pool_state_after` follows from `pool_state_before`, aggregate net flow, and the constant-product formula with 0.3% fee.
5. **Fee accrual.** `cum_fee_a_per_share_after = cum_fee_a_per_share_before + (collected_fee_a × 1e18) / total_lp_supply`. Same for B.
6. **Settlement tree.** The Merkle root computed from the 128 settlement leaves (one per included order, fill amount in token B for buys / token A for sells) equals `settlement_merkle_root`.
7. **Remnant notes.** For each partial-filled order, a new orderbook note is committed (witnessed) with the correct reduced amount.

### 8.3 Circuit size budget

- 128 orders × ~50 constraints per order check = ~6,400
- FIFO comparison sweep = ~256 comparisons × 4 constraints = ~1,000
- AMM swap math (u128 multiplications and divisions, fixed-point arithmetic) = ~500
- Settlement Merkle tree (depth 7, 128 leaves) = ~7 × 128 = ~900 hash constraints
- Total estimated: ~10K constraints — well within Honk prover capacity. Proof generation time on M-series Mac: estimated 60-120s. To be benchmarked in week 6.

If proof time exceeds the 100-block epoch interval, fallback options in order: (a) reduce to 96 orders, (b) parallelize witness generation, (c) introduce recursion for order-batch verification.

---

## 9. Liquidity Provision

### 9.1 Deposit

```rust
#[external("private")]
fn deposit(amount_a: u128, amount_b: u128) {
    let sender = self.msg_sender();
    // Consume token notes (handled by TokenContract calls)

    // Snapshot public state
    let cum_a = self.storage.cum_fee_a_per_share.read_public();
    let cum_b = self.storage.cum_fee_b_per_share.read_public();
    let total = self.storage.total_lp_supply.read_public();
    let ra    = self.storage.total_reserve_a.read_public();
    let rb    = self.storage.total_reserve_b.read_public();

    // Share calculation (V2 formula)
    // If amount_a/amount_b doesn't match the pool ratio, take the smaller side
    // and refund the unused remainder of the other side back to the user.
    let shares;
    let used_a;
    let used_b;
    if total == 0 {
        shares = sqrt(amount_a * amount_b);          // initial deposit
        used_a = amount_a;
        used_b = amount_b;
    } else {
        let shares_from_a = amount_a * total / ra;
        let shares_from_b = amount_b * total / rb;
        if shares_from_a < shares_from_b {
            shares = shares_from_a;
            used_a = amount_a;
            used_b = ra == 0 ? amount_b : amount_a * rb / ra;  // matching B
        } else {
            shares = shares_from_b;
            used_b = amount_b;
            used_a = rb == 0 ? amount_a : amount_b * ra / rb;
        }
    }
    let refund_a = amount_a - used_a;
    let refund_b = amount_b - used_b;

    let position = PositionNote {
        lp_share: shares,
        cum_fee_a_per_share_at_deposit: cum_a,
        cum_fee_b_per_share_at_deposit: cum_b,
        deposit_epoch: self.storage.current_epoch.read_public().epoch_id,
        owner: sender,
    };
    self.storage.positions.insert(position).emit(encode_and_encrypt(sender, position));

    // Enqueue public-state update with the actually used amounts
    self.enqueue_self._add_to_reserves(used_a, used_b, shares);

    // Refund unused remainders (if any)
    if refund_a > 0 {
        TokenContract::at(TOKEN_A).transfer_from_pool(sender, refund_a).enqueue(&mut self.context);
    }
    if refund_b > 0 {
        TokenContract::at(TOKEN_B).transfer_from_pool(sender, refund_b).enqueue(&mut self.context);
    }
}

#[external("public")]
#[only_self]
fn _add_to_reserves(amount_a: u128, amount_b: u128, shares: u128) {
    let ra = self.storage.total_reserve_a.read();
    let rb = self.storage.total_reserve_b.read();
    let s  = self.storage.total_lp_supply.read();
    self.storage.total_reserve_a.write(ra + amount_a);
    self.storage.total_reserve_b.write(rb + amount_b);
    self.storage.total_lp_supply.write(s + shares);
}
```

Public observers see: total reserves and total LP supply incremented by some amount. They do not see which address deposited or what fraction of supply they hold.

### 9.2 Withdraw with fee claim

```rust
#[external("private")]
fn withdraw(position_note_secret: Field) {
    let position = self.storage.positions.get(position_note_secret);
    let sender   = self.msg_sender();
    assert(position.owner == sender);

    let cum_a_now = self.storage.cum_fee_a_per_share.read_public();
    let cum_b_now = self.storage.cum_fee_b_per_share.read_public();
    let total     = self.storage.total_lp_supply.read_public();
    let ra        = self.storage.total_reserve_a.read_public();
    let rb        = self.storage.total_reserve_b.read_public();

    let principal_a = position.lp_share * ra / total;
    let principal_b = position.lp_share * rb / total;
    let fees_a = position.lp_share * (cum_a_now - position.cum_fee_a_per_share_at_deposit) / 1e18;
    let fees_b = position.lp_share * (cum_b_now - position.cum_fee_b_per_share_at_deposit) / 1e18;

    let payout_a = principal_a + fees_a;
    let payout_b = principal_b + fees_b;

    self.storage.positions.remove(position).emit_nullifier();
    self.enqueue_self._reduce_reserves(payout_a, payout_b, position.lp_share);

    TokenContract::at(TOKEN_A).transfer_from_pool(sender, payout_a).enqueue(&mut self.context);
    TokenContract::at(TOKEN_B).transfer_from_pool(sender, payout_b).enqueue(&mut self.context);
}
```

Public observers see total reserves decrease and total LP supply decrease. They do not see the depositor, the share, or the fee split between principal and fees.

---

## 10. Settlement & Claim Flow

The clearing transaction is **constant-size in on-chain state**: regardless of how many orders are filled, only one Merkle root is written to the `settlement_roots` map. The transaction *does* emit up to 128 encrypted logs (one per filled order, addressed to the respective order owner), but these are not part of the persistent state tree — they are call-data records that PXEs scan. Gas-wise, the cost scales linearly with filled orders for log emission, but state writes are O(1) per clearing.

After clearing, each filled user's PXE detects the encrypted log addressed to it. The PXE reconstructs the user's `SettlementNote` and Merkle inclusion proof from the log payload (which includes the leaf position and sibling hashes). The user then calls:

```rust
#[external("private")]
fn claim_settlement(
    settlement_note: SettlementNote,
    merkle_proof:    [Field; SETTLEMENT_TREE_DEPTH],
) {
    let sender = self.msg_sender();
    assert(settlement_note.owner == sender);

    let root = self.storage.settlement_roots.at(settlement_note.epoch_id).read();
    assert(verify_merkle_inclusion(hash(settlement_note), merkle_proof, root));

    let nullifier = compute_settlement_nullifier(settlement_note);
    assert(!self.context.is_nullifier_emitted(nullifier));
    self.context.emit_nullifier(nullifier);

    let token = if settlement_note.asset_out == 0 { TOKEN_A } else { TOKEN_B };
    TokenContract::at(token)
        .mint_to(sender, settlement_note.amount_out)
        .enqueue(&mut self.context);
}
```

Claims can happen at any time after clearing — they are independent transactions. The user pays only their own claim's gas, not the clearing tx's gas.

---

## 11. Trust Model

### 11.1 Aggregator (MVP: trusted singleton)

The aggregator is the only entity that can submit `close_epoch_and_clear`. In MVP this is a single TypeScript service run by the protocol team. Its powers:

| Power | On-chain constraint |
|---|---|
| Choose when to close an epoch | Only after `block ≥ closes_at_block` |
| Choose the clearing price | The circuit's `verify_amm_swap` rejects any inconsistent price |
| Choose which 128 orders to include | FIFO constraint forces the oldest 128 |
| Collect user reveals | Off-chain; an order without a reveal cannot be included |

### 11.2 Attack surface in MVP

| Attack | Constraint preventing it | Residual risk |
|---|---|---|
| Forge clearing price | Circuit constraint #4 (AMM swap) | None — proof fails verification |
| Reorder fills for MEV extraction | Circuit constraint #2 (FIFO) | None |
| Censor a user's order | None directly; aggregator can refuse to include a revealed order | Mitigation: user can submit reveals to the public chain via a fallback path (sub-project 3) |
| Stall (never close epoch) | None in MVP | Users can `cancel_order` to recover funds. Liveness fallback (anyone can submit clearing proof with their own collected reveals) is sub-project 3. |
| Fabricate reveals for an order the user didn't send | Reveal signature check; the aggregator's submitted proof binds revealed `amount_in`, `limit_price` to the commitment hash | None — wrong fields produce wrong hash |

The MVP trust model is summarized as: **the aggregator can stall the protocol but cannot steal funds, charge wrong prices, or front-run users.** Funds are always recoverable via `cancel_order`. This is acceptable for a devnet protocol; mainnet requires sub-project 3.

---

## 12. Repository Structure

```
aztec-project/
├── contracts/
│   ├── orderbook/              # Noir contract package
│   │   ├── src/main.nr
│   │   └── Nargo.toml
│   ├── clearing/
│   ├── liquidity_pool/
│   └── token/                  # tUSDC and tETH
├── circuits/
│   └── clearing/               # Separate Noir package for the clearing proof
│       ├── src/main.nr
│       └── Nargo.toml
├── aggregator/
│   ├── package.json
│   └── src/
│       ├── index.ts
│       ├── orderbook-watcher.ts
│       ├── clearing-algo.ts
│       ├── proof-generator.ts
│       └── reveal-collector.ts
├── cli/
│   ├── package.json
│   └── src/
│       ├── index.ts
│       ├── commands/{deposit,order,cancel,withdraw,claim}.ts
│       └── reveal-publisher.ts
├── tests/
│   ├── noir/                   # TXE tests (mod test; in contracts)
│   ├── unit/                   # TypeScript per-contract
│   ├── integration/            # multi-contract flows
│   └── e2e/                    # full sandbox + aggregator + CLI
├── scripts/
│   ├── deploy-devnet.ts
│   └── seed-test-state.ts
├── docs/superpowers/
│   ├── specs/                  # current spec + future sub-project specs
│   └── decisions/              # ADRs
├── package.json                # pnpm workspaces root
├── pnpm-workspace.yaml
└── README.md
```

---

## 13. Test Strategy

### 13.1 Noir TXE tests (in-contract `mod test;`)

- Note ownership and nullifier uniqueness for each note type
- `submit_order` rejects when epoch is not OPEN
- `cancel_order` rejects when not owner
- `deposit` share calculation correctness (initial, subsequent)
- `withdraw` fee math correctness against synthetic cumulative-fee values
- Clearing circuit constraints — one negative test per constraint (wrong price, broken FIFO, fee mismatch, etc.)

### 13.2 Unit tests (TypeScript)

- Clearing algorithm: binary search converges, partial-fill math, edge cases (single order, single side, exact match)
- Reveal collector: signature verification, replay rejection

### 13.3 Integration tests (Aztec sandbox)

Required scenarios:
1. Single BUY ↔ single SELL — both fill at the cross-price
2. BUY with no matching SELL — partial fill against pool, remnant carries
3. 129 orders submitted — 128 oldest fill, 129th carries to next epoch
4. Cancel during OPEN — funds returned, no leak
5. Deposit → trades occur → withdraw — fee claim is correct
6. Two LPs at different snapshots — fees split proportionally to share × duration
7. Negative: clearing tx with wrong price — rejected
8. Negative: clearing tx mid-epoch — rejected

### 13.4 E2E tests

1. Full CLI flow: deposit, submit 3 orders, wait for clearing, claim, withdraw
2. Stress: 128 orders, measure proof time, validate gas
3. Liveness probe: aggregator killed mid-epoch — orders remain cancellable

### 13.5 Continuous integration

GitHub Actions matrix:
- Noir compile + TXE tests on every PR (~5 min)
- TypeScript unit + integration on every PR (~15 min)
- E2E nightly on `main` (~45 min)

---

## 14. Implementation Plan

| Week | Deliverable |
|---|---|
| 1 | Repo scaffolded (Aztec starter clone + pnpm workspaces), `tUSDC`/`tETH` test tokens deployed and unit-tested |
| 2 | `OrderbookContract` skeleton with storage; `submit_order` private function |
| 3 | `cancel_order`, FIFO ordering; orderbook unit + TXE tests green |
| 4 | `LiquidityPoolContract` storage and `deposit`/`withdraw` private functions |
| 5 | Fee accrual (snapshot math); LP unit + TXE tests green |
| 6 | Clearing circuit V0 (no FIFO constraint yet) — first end-to-end happy path |
| 7 | FIFO constraint, carryover remnant logic, partial fill |
| 8 | Clearing circuit complete; circuit benchmarks; tune `MAX_ORDERS_PER_EPOCH` if needed |
| 9 | TypeScript aggregator: clearing algorithm, proof generation, reveal collector |
| 10 | CLI + integration test suite |
| 11 | E2E + stress + liveness fallback tests |
| 12 | Devnet deployment, public-facing README, first announcement-readiness review |

**Critical path:** weeks 6-8 (clearing circuit). All other tracks can run in parallel after week 5.

---

## 15. Risks & Mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Clearing-proof time exceeds 1 epoch (20 min) | Medium | Week-6 early benchmark. Fallback: reduce `MAX_ORDERS_PER_EPOCH` to 96 or 64, or introduce recursion. |
| Aztec breaks Noir API mid-project | Low–Medium | Pin `aztec-packages v4.2.1`. Migration buffer reserved in week 12. |
| Reveal channel UX is awful in CLI | Medium | Week-9 prototype with relay; if friction is too high, defer p2p to sub-project 3 and accept centralized relay for MVP. |
| FIFO constraint blows up circuit size 4× from baseline | Low | Week-6 benchmark. If real, switch to "soft FIFO" (orders within ±5 blocks treated as equal). |
| L1 bridge complexity creeps into MVP scope | Medium | Explicitly **out of scope**. Test tokens are mintable on Aztec only. Bridge = sub-project 5. |

---

## 16. Open Questions Deferred to Implementation

These items don't need answers to start implementation but must be revisited:

- **Reveal relay design.** WebSocket pub-sub against a single relay server, or a small Redis-backed queue? Decide in week 9 based on traffic estimates.
- **Settlement Merkle tree hashing primitive.** Poseidon2 (cheaper in Noir) or Pedersen (existing aztec-nr utilities)? Decide in week 7 after circuit benchmarking.
- **Random nonce source in `submit_order`.** Aztec PXE provides randomness; use `unsafe_rand_field()` or commit-reveal scheme? Decide in week 2.

These deferred items are tracked as ADRs in `docs/superpowers/decisions/` once decided.

---

## 17. Acceptance Criteria for MVP Completion

The MVP ships when **all** of the following are true on Aztec devnet:

1. All Noir TXE tests pass.
2. All TypeScript integration tests pass.
3. The 8 integration scenarios in §13.3 pass end-to-end on devnet.
4. The clearing proof generates in ≤ 90 seconds on M-series Mac for 128 orders.
5. A documented walkthrough exists where a fresh user installs the CLI, makes a deposit, submits an order, sees clearing complete, and claims their settlement — start to finish in under 15 minutes once the network is running.
6. The README explains the protocol, the trust model, and the path to sub-project 3 (permissionless aggregator).
