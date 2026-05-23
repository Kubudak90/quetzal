# Quetzal on Aztec — Week 5d-4 Design: Merkle Settlement Root + Inclusion-Proof `claim_fill`

**Status:** spec
**Date:** 2026-05-21
**Predecessors:** [Week 5d-3 on-chain recursive verify design](./2026-05-20-zswap-aztec-week-05d-3-onchain-recursive-verify-design.md)
**Sub-project:** 1 of 6 (trustless clearing via ZK proof) — **final slice**
**Forward refs satisfied:** 5d-3 §11 ("Week 5d-4 will replace the flat `fills` public-input vector with a Merkle root; `claim_fill` becomes inclusion-proof based. The flat-fills payload here is the temporary form.")

---

## 1. Goal

Replace the flat `fills: BoundedVec<FillEntry, 32>` public-input vector — currently 64 of the 83 public-input slots — with a single `fills_root: Field` Merkle root over the 32 fill leaves. Move `claim_fill` from a per-order-nonce `Map<Field, u128>` storage lookup to an inclusion-proof verification against the per-epoch stored root.

**Net effect:**
- `ClearingPublic` public-input vector: **83 → 19 Field**. ~4× smaller calldata.
- Per-epoch contract storage writes: **up to 32 slots → 1 slot**.
- Historical claims preserved via `Map<u32, PublicMutable<Field>>` keyed by `epoch_id`.

## 2. Non-Goals

- No change to clearing algorithm, accumulators (5d-1), or recursive verify wiring (5d-3).
- No change to `MAX_ORDERS_PER_EPOCH = 32`.
- No change to RAM budget (incremental: 31 extra Poseidon2 hashes per prove ≈ negligible).
- No on-chain Merkle storage of *all* historical roots beyond the per-epoch Map — pruning is out of scope (cheap enough to keep all).
- `submit_order`'s `order_acc` chain-hash accumulator (5d-1) stays as-is; it doesn't need Merkle inclusion semantics yet.

## 3. Architecture overview

```
┌─────────────────────────────┐
│ clearing circuit (Noir bin) │  Computes fills array internally as before,
│  circuits/clearing/main.nr  │  hashes each into a leaf, builds depth-5
└──────────────┬──────────────┘  Merkle tree, exposes only `fills_root` pub.
               │ proof + fills_root
               ▼
┌─────────────────────────────┐
│ aggregator (JS)             │  Builds Merkle tree in JS in lockstep with
│  aggregator/src/merkle.ts   │  circuit; persists per-epoch snapshot for
│  aggregator/src/snapshot.ts │  later claim-time inclusion-proof lookup.
└──────────────┬──────────────┘
               │ snapshots/epoch-<N>.json
               │ + proof.bin + fills_root
               ▼
┌─────────────────────────────┐
│ orderbook contract          │  close_epoch_and_clear_verified:
│  contracts/orderbook/main.nr│   1. recursive verify proof (5d-3)
│                             │   2. fills_root → storage[epoch_id]
│                             │  claim_fill:
│                             │   1. pop OrderNote (one-shot via nullifier)
│                             │   2. recompute leaf
│                             │   3. walk Merkle path (5 levels)
│                             │   4. assert against storage[epoch_id]
│                             │   5. transfer
└─────────────────────────────┘
```

## 4. Data structures

### 4.1 Storage diff (`contracts/orderbook/src/main.nr`)

| Field | Before | After |
|---|---|---|
| `fills: Map<Field, PublicMutable<u128, Context>, Context>` | per-order_nonce payout amount | **removed** |
| `fills_root: Map<u32, PublicMutable<Field, Context>, Context>` | — | **new** — `epoch_id → Merkle root` |

The Map is keyed by `epoch_id` (u32). Past-epoch roots persist indefinitely; makers can claim long after the epoch closes. Map default (`0`) acts as the "no clearing recorded" sentinel.

### 4.2 `ClearingPublic` struct diff (circuit + contract mirror)

| Field | Before | After |
|---|---|---|
| `order_acc: Field` | unchanged | unchanged |
| `cancel_acc: Field` | unchanged | unchanged |
| `order_count: u32` | unchanged | unchanged |
| `cancel_count: u32` | unchanged | unchanged |
| `reserve_a, reserve_b, lp_supply` | unchanged | unchanged |
| `clearing_price` | unchanged | unchanged |
| `fills: [FillEntry; 32]` (64 fields) | present | **removed** |
| `fills_len: u32` | present | **removed** |
| `fills_root: Field` | — | **new** |
| `swap: SwapResult` (10 fields) | unchanged | unchanged |

Total public-input fields: **83 → 19**.

`flatten_clearing_public` (used to bridge from contract args to the recursive-verify call) shrinks correspondingly. Slot order:

```
[0]  order_acc
[1]  cancel_acc
[2]  order_count
[3]  cancel_count
[4]  reserve_a
[5]  reserve_b
[6]  lp_supply
[7]  clearing_price
[8]  fills_root              // new — replaces slots [8..73] from 5d-3
[9..18] swap (10 fields)     // inclusive — indices 9, 10, 11, 12, 13, 14, 15, 16, 17, 18
```

### 4.3 Merkle leaf format

```rust
leaf = poseidon2([order_nonce, amount_out as Field])
```

Justification: minimal (2-input Poseidon2 has lowest gate count). Owner-binding lives in the OrderNote nullification path (the note's `owner` is enforced when popped). Epoch-binding lives in the `Map<u32, …>` key (the contract reads `fills_root[epoch_id]`, so a maker proving a leaf against the wrong epoch's root won't match).

Empty slots: padded with `FillEntry { order_nonce: 0, amount_out: 0 }` → leaf = `poseidon2([0, 0])`. Order nonces in practice are derived from commitments containing randomness, so collision with the empty sentinel is negligible. (See §10.2 for the test that asserts a `nonce=0, amount=k` vs `nonce=0, amount=0` distinction; we never permit a real fill to use `order_nonce == 0`.)

### 4.4 Merkle tree shape

- **Leaves:** 32 (= `MAX_ORDERS_PER_EPOCH`).
- **Depth:** 5.
- **Hash:** Poseidon2 (2-input), same primitive as the leaf hash.
- **Order:** index-stable. Leaf `i` corresponds to `fills[i]` from the circuit's internal `fills` array (post-padding). The aggregator MUST produce the same `fills[]` ordering deterministically; circuit and aggregator MUST agree bit-for-bit.

## 5. Circuit changes (`circuits/clearing/src/main.nr`)

### 5.1 New helpers

```rust
fn merkle_root_32(leaves: [Field; 32]) -> Field {
    let mut level: [Field; 32] = leaves;
    let mut width: u32 = 32;
    for _round in 0..5 {  // 32 → 16 → 8 → 4 → 2 → 1
        let half = width / 2;
        let mut next: [Field; 32] = [0; 32];
        for i in 0..16 {
            if i < half {
                next[i] = poseidon2_hash([level[2*i], level[2*i + 1]]);
            }
        }
        level = next;
        width = half;
    }
    level[0]
}

fn fill_leaf(order_nonce: Field, amount_out: u128) -> Field {
    poseidon2_hash([order_nonce, amount_out as Field])
}
```

Uses the same `poseidon::poseidon2::Poseidon2::hash(inputs, N)` import pattern already wired into `circuits/clearing/Nargo.toml` per 5d-2.

### 5.2 `fn main` change

The internal matching logic still produces a `BoundedVec<FillEntry, 32>` (no change). After matching:

```rust
// Pad to fixed-32 with zero-entries
let mut fixed_fills: [FillEntry; 32] = [FillEntry::default(); 32];
for i in 0..32 {
    if i < internal_fills.len() {
        fixed_fills[i] = internal_fills.get_unchecked(i);
    }
}

// Hash each slot to a leaf
let mut leaves: [Field; 32] = [0; 32];
for i in 0..32 {
    leaves[i] = fill_leaf(fixed_fills[i].order_nonce, fixed_fills[i].amount_out);
}

// Merkle root → public output
fills_root = merkle_root_32(leaves);
```

`fills_root` becomes a `pub` return value. The old `fills` and `fills_len` `pub` returns are removed.

### 5.3 New VK / vk_hash

Circuit changed → new VK file → new `clearing_vk_hash`. All deploy scripts must recompute and pass the new hash to the Orderbook constructor.

### 5.4 bb artifact bridging (hypothesis + recheck)

Hypothesis (carries forward from 5d-3): the bb proof/VK file sizes are Honk-format constants independent of the inner-circuit's public-input count, because Aztec's IVC architecture handles public inputs via kernel IO, not embedded in the proof bytes:

- proof.bin: **500 fields → contract expects 456** (truncate, same as 5d-3)
- vk.bin: **115 fields → contract expects 127** (pad with `Fr.ZERO`, same as 5d-3)

If the hypothesis is wrong (proof/VK size changes with pub-input count), the integration test will catch it; `tests/integration/helpers/proof.ts` `HONK_PROOF_FIELDS` / `HONK_VK_FIELDS` constants get adjusted. The implementation plan includes an explicit empirical-recheck step after the circuit is rebuilt.

## 6. Contract changes (`contracts/orderbook/src/main.nr`)

### 6.1 Storage diff

Remove:
```rust
fills: Map<Field, PublicMutable<u128, Context>, Context>,
```

Add:
```rust
fills_root: Map<u32, PublicMutable<Field, Context>, Context>,
```

### 6.2 `flatten_clearing_public` rewrite

Shrinks from `[Field; 83]` to `[Field; 20]` per §4.2 slot table. `#[contract_library_method]` attribute preserved (per 5d-3 fix for Aztec macro's bare-fn treatment).

### 6.3 `close_epoch_and_clear_verified` change

Signature unchanged (still takes `(public_inputs, proof, vk)`), but `public_inputs.fills` / `public_inputs.fills_len` no longer exist; instead `public_inputs.fills_root`. The recursive-verify call is unchanged in shape (still passes empty `[]` public inputs per IVC convention).

### 6.4 `_apply_verified_clearing` change

Replaces the 32-iteration fill recording loop with one storage write:

```rust
// removed loop:
//   for i in 0..32 { if i < public_inputs.fills_len {
//       self.storage.fills.at(public_inputs.fills[i].order_nonce)
//                    .write(public_inputs.fills[i].amount_out);
//   }}

// new:
self.storage.fills_root.at(current.epoch_id).write(public_inputs.fills_root);
```

Freshness asserts (order_acc/cancel_acc/order_count/cancel_count match current state) preserved unchanged.

### 6.5 `claim_fill` rewrite

New signature:

```rust
#[external("private")]
fn claim_fill(
    order_nonce: Field,
    claimed_amount_out: u128,
    epoch_id: u32,
    siblings: [Field; 5],
    leaf_index: u32,
) {
    // 1. Pop OrderNote — owner check + nullifier-based one-shot guard
    let note = self.storage.orders.pop_note_for_nonce(order_nonce);
    assert(note.owner == context.msg_sender());

    // 2. Recompute leaf locally
    let leaf = poseidon2_hash([order_nonce, claimed_amount_out as Field]);

    // 3. Walk Merkle path (5 levels, LSB-first)
    let mut current = leaf;
    let mut idx = leaf_index;
    for level in 0..5 {
        let bit = idx & 1;
        current = if bit == 0 {
            poseidon2_hash([current, siblings[level]])
        } else {
            poseidon2_hash([siblings[level], current])
        };
        idx = idx >> 1;
    }
    assert(idx == 0);  // leaf_index < 32

    // 4. Pay the maker in private context (existing pattern)
    pool.transfer_public_to_private(claimed_amount_out, note.owner);

    // 5. Verify computed root against stored root
    self.enqueue_self._assert_fill_root(epoch_id, current);
}

#[external("public")]
#[only_self]
fn _assert_fill_root(epoch_id: u32, computed_root: Field) {
    let stored = self.storage.fills_root.at(epoch_id).read();
    assert(stored != 0, "no clearing recorded for epoch");
    assert(computed_root == stored, "fill merkle root mismatch");
}
```

**Double-claim protection** stays via OrderNote nullification (unchanged from 5c). Replay attempts after a successful claim fail at note pop (already nullified).

**Cancel-after-fill protection** (subtle — the 5c `fills` Map was load-bearing here):

The 5c contract gated `cancel_order` with a `_assert_not_filled(order_nonce)` callback that read `self.storage.fills.at(nonce).read() != 0`. Dropping the `fills` Map removes that gate, so 5d-4 MUST drop `_assert_not_filled` and rely on the next layer down for protection.

The token contract's `transfer_public_to_private` is that layer. After a successful clearing, `_apply_verified_clearing` invokes `pool.apply_clearing(swap)` which moves the filled orders' aggregate `amount_in` from the orderbook's public balance into the LiquidityPool's public balance. A subsequent cancel_order that tries to refund a filled order's `amount_in` finds the orderbook's public balance is short by that exact amount (the pool now holds it) and the token transfer underflows + reverts. Aztec transaction atomicity then rolls back the OrderNote nullification and `_append_cancel` fold, leaving the maker's state intact — they must use `claim_fill` instead.

This protection holds because:
1. ALL of a filled order's `amount_in` is moved to the pool by `apply_clearing` (no leftover sits in the orderbook).
2. Orderbook's public balance equals exactly `sum(unfilled_orders.amount_in)` per token at any time.
3. A cancel attempt for a filled order asks for `amount_in` of the input token that is no longer there.

The token-level error message ("insufficient public balance") is less friendly than the 5c "order already filled; use claim_fill" message. This is an acceptable UX regression for the storage win; the CLI can surface a clearer hint by checking `get_fills_root(epoch_id_of_order)` before submitting cancel.

Important: this only works for cancels AFTER a clearing that filled the order. For unfilled orders the pool received nothing for that order, the orderbook still holds the escrow, and cancel succeeds normally.

**Failed-claim atomicity:** if `_assert_fill_root` reverts, the entire tx reverts including the `transfer_public_to_private` and the nullifier insertion. The note returns to its un-nullified state. Standard Aztec tx atomicity.

## 7. Aggregator changes

### 7.1 New module: `aggregator/src/merkle.ts`

```ts
interface FillEntry { order_nonce: Fr; amount_out: bigint; }
interface MerkleTreeOutput {
  root: Fr;
  leaves: Fr[];  // length 32
  paths: Map<string /* order_nonce hex */, { siblings: Fr[]; leaf_index: number }>;
}

export function buildFillsTree(fills: FillEntry[]): MerkleTreeOutput;
```

Implementation MUST match the circuit's `merkle_root_32` bit-for-bit: same padding, same Poseidon2 primitive (via `@aztec/foundation/crypto/poseidon`'s `poseidon2Hash`), same leaf format.

### 7.2 New module: `aggregator/src/snapshot.ts`

Writes one JSON per epoch to `aggregator/snapshots/epoch-<N>.json`:

```json
{
  "epoch_id": 42,
  "fills_root": "0x...",
  "leaves": [
    { "order_nonce": "0x...", "amount_out": "1234", "leaf_hash": "0x..." },
    ...
  ],
  "paths": {
    "0x<order_nonce>": { "siblings": ["0x...", "0x...", ...], "leaf_index": 7 },
    ...
  }
}
```

Loaded by CLI at claim time. File-system persistence is sufficient for MVP (single-aggregator deployment). HTTP service can come later.

### 7.3 `aggregator/src/clearing.ts` modification

Just before invoking `bb prove`, after constructing the fills array:
1. Call `buildFillsTree(fills)` to get root + paths.
2. Write the snapshot via `snapshot.ts`.
3. Pass `fills_root` (not `fills` + `fills_len`) to the witness builder.

### 7.4 Parity test

`aggregator/tests/merkle.parity.test.ts` — fixed-input fixtures, asserts JS root == Noir TXE root for the same input.

## 8. CLI changes

### 8.1 `cli/src/commands/claim.ts`

New flag: `--epoch <N>` (optional). If omitted, CLI scans `aggregator/snapshots/*.json` for an entry containing `order_nonce`.

```bash
quetzal claim --nonce 0x... [--epoch 42]
```

Internally:
```ts
const snapshot = loadSnapshot(epoch_id);
const path = snapshot.paths[nonceHex];
const leaf = snapshot.leaves.find(l => l.order_nonce === nonceHex);
await orderbook.claim_fill(nonce, leaf.amount_out, epoch_id, path.siblings, path.leaf_index);
```

### 8.2 `cli/src/commands/close-epoch.ts`

`close-epoch-verified --public-inputs <json>` accepts the new ClearingPublic shape: `fills_root` field instead of `fills[]` + `fills_len`. Bridging helpers in `tests/integration/helpers/proof.ts` re-verified empirically after circuit rebuild.

## 9. Deploy script changes

`scripts/deploy-tokens.ts` and `scripts/deploy-and-run-testnet.ts`:

```ts
// Pre-compute clearing_vk_hash from new clearing.vk
const vkFields = readVkAsFields("circuits/clearing/target/clearing.vk");
const clearing_vk_hash = poseidon2Hash(vkFields);

await Orderbook.deploy(wallet, tokenA, tokenB, epoch_length, pool.address, clearing_vk_hash);
```

The old hardcoded `clearing_vk_hash` in `quetzal.config.json` is invalidated; deploys must refresh.

## 10. Test plan

### 10.1 Noir TXE (circuit) — `circuits/clearing/tests/`

- **T1: Merkle parity vs. JS.** Fixed [32] leaves → assert `merkle_root_32` output matches a JS-reference computed independently via the same poseidon2 primitive (the parity test in 7.4 runs from the JS side; this is the Noir-side anchor).
- **T2: Empty-leaf consistency.** All-zero leaves → root = `merkle_root_32([poseidon2(0,0); 32])`. Sanity-check the well-known constant.
- **T3: Single non-zero leaf.** `fills[0] = {nonce: X, amount: Y}`, rest zero → spot-check sibling path against manually traced root.

### 10.2 Noir TXE (contract) — `contracts/orderbook/tests/`

- **T4: Happy path.** Manually seed `fills_root[N]` storage by directly invoking `_apply_verified_clearing` with crafted public inputs (TXE doesn't run recursive verify, but contract logic is exercised). Call `claim_fill` with a correctly computed inclusion proof. Assert success + transfer recorded.
- **T5: Wrong sibling.** Same as T4 but flip a bit in `siblings[2]`. Assert revert with "fill merkle root mismatch".
- **T6: Wrong amount.** Same as T4 but pass `claimed_amount_out + 1`. Assert revert with "fill merkle root mismatch" (the recomputed leaf differs → recomputed root differs).
- **T7: Wrong epoch_id.** Same as T4 but pass `epoch_id + 1`. Assert revert with "no clearing recorded for epoch" (or "fill merkle root mismatch" if that epoch happens to have a different root).
- **T8: Replay.** T4 succeeds; immediately re-submit same `claim_fill`. Assert revert at note pop (nullifier collision).
- **T9: Leaf-index out of bounds.** `leaf_index = 32` (one bit too high). Assert revert at `assert(idx == 0)`.
- **T9b: Cancel-after-fill underflow.** Submit + clear so order is filled (apply_clearing moves amount_in to pool). Attempt `cancel_order` on the filled nonce. Assert revert (token-level "insufficient public balance"); orderbook public balance unchanged; OrderNote remains un-nullified.

### 10.3 Aggregator parity — `aggregator/tests/`

- **T10: Merkle JS == Noir.** Run T1's fixed input through both JS `buildFillsTree` and the circuit's `merkle_root_32` (via TXE harness). Assert roots match.

### 10.4 TS integration — `tests/integration/`

- **T11: Full e2e Merkle claim.** `tests/integration/claim-merkle.test.ts` — alice + bob submit; admin closes epoch via `close_epoch_and_clear_verified` with new Merkle-shape public inputs + real bb proof; alice and bob each call `quetzal claim` with computed paths; assert their private balances increase by the expected amounts.
- **T12: 5d-3 happy-path regression.** Update `tests/integration/clearing.test.ts` E1 to the new shape — same E2E mechanics, just the public-inputs structure changes. E2 + E3 (tampering, replay-at-verifier) stay `it.skip`'d for the same TXE-defers-verify reason documented in [`memory/reference_aztec_txe_recursive_verify.md`](../../../.claude/projects/-Users-huseyinarslan-Desktop-aztec-project/memory/reference_aztec_txe_recursive_verify.md).

### 10.5 Testnet (deferred)

The Week 5d-3 testnet validation gap (close_epoch_and_clear_verified never reached on real testnet) is recorded in `memory/project_5d3_testnet_validation.md`. After 5d-4 ships, the deferred testnet run subsumes 5d-3's gap — re-running `scripts/deploy-and-run-testnet.ts` with `epoch_length=30`+ exercises the new Merkle-root close path AND the still-unexercised recursive verify on testnet. ~75-min testnet walltime budgeted; not part of this slice's success criteria.

## 11. Migration notes

- **Existing deploys are not migration-compatible.** The Orderbook storage layout changed (Map<Field, u128> removed, Map<u32, Field> added). Fresh deploy required. Acceptable for pre-mainnet.
- **`clearing_vk_hash` refresh required.** All deploy artifacts that hardcode the hash (quetzal.config.json, deploy scripts) must regenerate.
- **Aggregator snapshot directory.** New runtime requirement: `aggregator/snapshots/` must be writable. Add to `.gitignore` (snapshots are runtime state, not source).

## 12. Success criteria

- All 12 test cases T1–T12 pass.
- `bb prove` on new circuit completes within previous RAM envelope (~5 GB peak, ~30s) — Merkle adds 31 Poseidon2 hashes (~8K gates) on top of ~57K → ~65K total gates.
- `pnpm test:noir` green; `pnpm test` green against fresh local dev stack.
- Public-input vector empirically observed at 19 fields (down from 83) in the new ClearingPublic flattening.
- New `clearing_vk_hash` documented in commit message + README status.

## 13. Out-of-scope / follow-ups

- **Multi-fills-per-order-nonce.** Currently one fill per submission; if a future change permits partial-fill-then-re-quote semantics, the leaf format may need a sequence number. Not now.
- **Submit-order Merkle accumulator (5d-5+).** `order_acc` is still a running-hash chain; converting it to a Merkle structure would enable O(log N) order inclusion proofs (useful for slashing or fraud-proof flows). Not in 5d-4.
- **HTTP-based snapshot service.** File-system snapshots are MVP-sufficient. A snapshot HTTP API + signed responses can come later if non-co-located makers need them.
- **Root prefetching/caching in CLI.** CLI scans `snapshots/` linearly to find the right epoch for a given nonce. For epoch counts > 1000 this gets slow; a tiny index file would fix it. Out of scope.

---

**Cross-refs:**
- [Week 5d-1 — order accumulator](./2026-05-20-zswap-aztec-week-05d-1-order-accumulator-design.md)
- [Week 5d-2 — standalone clearing circuit](./2026-05-20-zswap-aztec-week-05d-2-clearing-circuit-design.md)
- [Week 5d-3 — on-chain recursive verify](./2026-05-20-zswap-aztec-week-05d-3-onchain-recursive-verify-design.md)
