# Week 5d-4 Implementation Plan — Merkle Settlement Root + Inclusion-Proof `claim_fill`

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the flat `fills: BoundedVec<FillEntry, 32>` clearing-circuit public-input vector with a single `fills_root: Field` Merkle root, and rewrite `claim_fill` into an inclusion-proof verification against per-epoch stored roots.

**Architecture:** The clearing circuit builds a depth-5 Poseidon2 Merkle tree over its 32 fill slots and exposes only the root. The orderbook stores `Map<u32, fills_root>` keyed by epoch_id (1 slot per clearing instead of 32). `claim_fill` takes 5 siblings + a leaf index, recomputes the leaf locally as `poseidon2([order_nonce, amount_out])`, walks the 5-level path, and asserts equality against the stored root via an `only_self` public callback. The aggregator persists per-epoch snapshots so makers can construct inclusion proofs off-chain at claim time.

**Tech Stack:** Noir 1.0.0-beta.19, aztec-nr 4.2.0, `noir-lang/poseidon` v0.3.0, `bb` 4.2.1 (UltraHonk), `@aztec/foundation/crypto/poseidon` for JS poseidon2 parity, Node 22 `node:test` runner via `tsx`.

**Spec reference:** [`docs/superpowers/specs/2026-05-21-zswap-aztec-week-05d-4-merkle-settlement-root-design.md`](../specs/2026-05-21-zswap-aztec-week-05d-4-merkle-settlement-root-design.md)

---

## File Structure

**New files:**
- `circuits/clearing/src/merkle.nr` — `fill_leaf` + `merkle_root_32` (pure Noir helpers).
- `aggregator/src/merkle.ts` — `buildFillsTree(fills)` JS parity of the circuit-side Merkle.
- `aggregator/src/snapshot.ts` — per-epoch JSON snapshot writer + reader.
- `aggregator/test/merkle.test.ts` — JS-vs-fixture parity tests.
- `aggregator/test/snapshot.test.ts` — snapshot round-trip tests.
- `tests/integration/claim-merkle.test.ts` — full e2e: submit → close-verified → claim with inclusion proof.

**Modified files:**
- `circuits/clearing/src/main.nr` — drop `fills`/`fills_len` pub args, add `fills_root` pub, integrate Merkle.
- `circuits/clearing/src/test.nr` — add merkle parity tests.
- `aggregator/src/witness.ts` — emit `fills_root` in TOML instead of `fills` + `fills_len`.
- `aggregator/test/witness.test.ts` — update fixture expectations.
- `aggregator/package.json` — add `@aztec/foundation` dep.
- `contracts/orderbook/src/main.nr` — storage diff, ClearingPublic shape, flatten function, `_apply_verified_clearing`, `claim_fill`, `_assert_fill_root` callback, drop `fills` Map / `_assert_not_filled` / `_assert_fill` / `get_fill`.
- `contracts/orderbook/src/test.nr` — replace fill-related TXE tests with the T4–T9b suite.
- `tests/integration/helpers/proof.ts` — possibly update `HONK_PROOF_FIELDS` / `HONK_VK_FIELDS` if Task 3's empirical check finds drift.
- `tests/integration/clearing.test.ts` — update `buildPublicInputsStruct` for the new shape.
- `cli/src/commands/claim.ts` — load snapshot, compute inclusion proof, pass to new `claim_fill` signature.
- `.gitignore` — add `aggregator/snapshots/`.

**Not modified (despite touching the same area):**
- `scripts/deploy-tokens.ts` — already reads `circuits/clearing/target/vk.bin/vk_hash`, so a circuit rebuild auto-refreshes the constructor arg. No code change needed.
- `cli/src/commands/close-epoch.ts` — `close-epoch-verified` already JSON-parses `public_inputs` as `unknown`, so the new shape flows through without code change (only the JSON file content changes).
- `aggregator/src/clearing.ts` — pure-compute; no Merkle wiring here (Task 5's snapshot.ts pulls from it).

---

### Task 1: Circuit Merkle module

**Files:**
- Create: `circuits/clearing/src/merkle.nr`
- Modify: `circuits/clearing/src/test.nr` (add merkle tests)
- Modify: `circuits/clearing/src/main.nr` (add `mod merkle;` line; tests don't compile otherwise)

- [ ] **Step 1: Add the module declaration so the new file is picked up**

In `circuits/clearing/src/main.nr` at the top, after `mod test;`, add `mod merkle;` so the binding compiles before the helpers are used. Replace lines 1-5:

```rust
mod types;
mod binding;
mod pricing;
mod amm;
mod merkle;
mod test;
```

- [ ] **Step 2: Write the failing merkle tests in `circuits/clearing/src/test.nr`**

Append at the end of `circuits/clearing/src/test.nr`:

```rust
// ============================================================================
// Week 5d-4: Merkle settlement root tests (sec 10.1 T1-T3).
// ============================================================================
use crate::merkle::{fill_leaf, merkle_root_32};

#[test]
fn merkle_empty_leaf_is_poseidon2_of_zero_zero() {
    // The padding leaf - poseidon2_hash([0, 0]) - is what every empty slot collapses to.
    let empty = fill_leaf(0 as Field, 0 as u128);
    let expected = poseidon::poseidon2::Poseidon2::hash([0 as Field, 0 as Field], 2);
    assert(empty == expected, "fill_leaf(0,0) must equal poseidon2([0,0])");
}

#[test]
fn merkle_fill_leaf_binds_order_nonce_and_amount() {
    // Two leaves that differ only in order_nonce produce distinct hashes.
    let l1 = fill_leaf(1 as Field, 100 as u128);
    let l2 = fill_leaf(2 as Field, 100 as u128);
    assert(l1 != l2, "leaf must be sensitive to order_nonce");
    // Two leaves that differ only in amount_out produce distinct hashes.
    let l3 = fill_leaf(1 as Field, 100 as u128);
    let l4 = fill_leaf(1 as Field, 101 as u128);
    assert(l3 != l4, "leaf must be sensitive to amount_out");
}

#[test]
fn merkle_root_all_zero_leaves_deterministic() {
    // The all-empty-slot tree root - well-known constant for the contract's
    // "no clearing recorded" sentinel boundary. The merkle_root_32 of 32 copies
    // of fill_leaf(0,0) must be reproducible and stable.
    let empty = fill_leaf(0 as Field, 0 as u128);
    let leaves: [Field; 32] = [empty; 32];
    let root_a = merkle_root_32(leaves);
    let root_b = merkle_root_32(leaves);
    assert(root_a == root_b, "merkle_root_32 is not deterministic");
}

#[test]
fn merkle_root_single_nonzero_leaf_traces() {
    // Construct a 32-leaf tree where only index 0 differs from the empty sentinel.
    // Manually hash the path: level0[0] vs level0[1] (both empty), level1[0] hashes them,
    // up the spine on the "left always" path (leaf_index = 0).
    let empty = fill_leaf(0 as Field, 0 as u128);
    let mine = fill_leaf(7 as Field, 42 as u128);
    let mut leaves: [Field; 32] = [empty; 32];
    leaves[0] = mine;

    // Walk the path manually for leaf_index = 0 (all "left").
    let mut node = mine;
    // Level 0 sibling: leaves[1] (still the empty leaf).
    node = poseidon::poseidon2::Poseidon2::hash([node, empty], 2);
    // Levels 1-4 siblings: the all-empty subtree root at the corresponding depth.
    let mut sibling = poseidon::poseidon2::Poseidon2::hash([empty, empty], 2);
    for _level in 0..4 {
        node = poseidon::poseidon2::Poseidon2::hash([node, sibling], 2);
        sibling = poseidon::poseidon2::Poseidon2::hash([sibling, sibling], 2);
    }

    let computed = merkle_root_32(leaves);
    assert(node == computed, "manual path trace must match merkle_root_32 output");
}

#[test]
fn merkle_root_changes_with_leaf_swap() {
    // Swapping a single non-zero leaf into a different slot changes the root
    // (rules out a trivial "sum of leaves" or other index-insensitive implementation).
    let empty = fill_leaf(0 as Field, 0 as u128);
    let leaf_a = fill_leaf(9 as Field, 1000 as u128);
    let mut leaves_lo: [Field; 32] = [empty; 32];
    leaves_lo[0] = leaf_a;
    let mut leaves_hi: [Field; 32] = [empty; 32];
    leaves_hi[31] = leaf_a;
    let root_lo = merkle_root_32(leaves_lo);
    let root_hi = merkle_root_32(leaves_hi);
    assert(root_lo != root_hi, "leaf position must affect root");
}
```

- [ ] **Step 3: Run tests to verify they fail to compile (missing module)**

```bash
cd circuits/clearing && nargo test --silence-warnings 2>&1 | tail -20
```

Expected: compile error referencing `crate::merkle::fill_leaf` (unresolved import). The non-merkle tests in `test.nr` must still pass; we just need the new ones to fail in a recognisable way.

- [ ] **Step 4: Create the merkle module with the helpers**

Write `circuits/clearing/src/merkle.nr`:

```rust
//! Week 5d-4: Merkle settlement root over the 32-slot fills array.
//!
//! Mirrors the contract-side claim_fill verifier and the JS-side
//! `aggregator/src/merkle.ts` bit-for-bit. Leaf := poseidon2([order_nonce, amount_out as Field]).
//! Empty slots use leaf = poseidon2([0, 0]); order_nonce 0 is reserved as the empty sentinel
//! and a real submission must never use it (asserted at submit_order time by the contract).

use crate::types::MAX_ORDERS_PER_EPOCH;

/// Hash one fill slot to its Merkle leaf.
pub fn fill_leaf(order_nonce: Field, amount_out: u128) -> Field {
    poseidon::poseidon2::Poseidon2::hash([order_nonce, amount_out as Field], 2)
}

/// Compute the root of a depth-5 Merkle tree over `leaves` using Poseidon2.
/// Caller passes already-hashed leaves (use `fill_leaf` per slot, including empty slots).
pub fn merkle_root_32(leaves: [Field; MAX_ORDERS_PER_EPOCH]) -> Field {
    // The level array is dimensioned to the maximum width; `width` tracks the
    // active prefix. We use a fixed-size [Field; 32] array (Noir lacks dynamic
    // sizing inside a constrained function) and ignore the tail past `width`.
    let mut level: [Field; MAX_ORDERS_PER_EPOCH] = leaves;
    let mut width: u32 = MAX_ORDERS_PER_EPOCH;
    for _round in 0..5 {  // 32 -> 16 -> 8 -> 4 -> 2 -> 1
        let half = width / 2;
        let mut next: [Field; MAX_ORDERS_PER_EPOCH] = [0; MAX_ORDERS_PER_EPOCH];
        for i in 0..16 {
            if (i as u32) < half {
                next[i] = poseidon::poseidon2::Poseidon2::hash(
                    [level[2 * i], level[2 * i + 1]],
                    2,
                );
            }
        }
        level = next;
        width = half;
    }
    level[0]
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd circuits/clearing && nargo test --silence-warnings 2>&1 | tail -30
```

Expected: all tests pass, including the new five merkle tests. If `merkle_empty_leaf_is_poseidon2_of_zero_zero`, `merkle_fill_leaf_binds_order_nonce_and_amount`, `merkle_root_all_zero_leaves_deterministic`, `merkle_root_single_nonzero_leaf_traces`, and `merkle_root_changes_with_leaf_swap` all show as PASS, the module is wired correctly.

- [ ] **Step 6: Commit**

```bash
git add circuits/clearing/src/merkle.nr circuits/clearing/src/main.nr circuits/clearing/src/test.nr
git commit -m "feat(circuits/clearing): merkle.nr — fill_leaf + merkle_root_32

Pure Noir helpers for the Week 5d-4 settlement root. Depth-5 Poseidon2
tree over 32 leaves; leaf = poseidon2([order_nonce, amount_out as Field]).
JS-side parity (aggregator/src/merkle.ts) lands in Task 4."
```

---

### Task 2: Circuit main.nr public-input shape rewrite

**Files:**
- Modify: `circuits/clearing/src/main.nr`

- [ ] **Step 1: Replace `fn main`'s pub parameter block — drop `fills`, `fills_len`; add `fills_root`**

In `circuits/clearing/src/main.nr`, replace lines 9-30 (the `fn main(` declaration) with:

```rust
fn main(
    // Binding (public)
    order_acc: pub Field,
    cancel_acc: pub Field,
    order_count: pub u32,
    cancel_count: pub u32,

    // Pre-clearing pool snapshot (public)
    reserve_a: pub u128,
    reserve_b: pub u128,
    lp_supply: pub u128,

    // Aggregator's claimed clearing output (public)
    clearing_price: pub u128,
    fills_root: pub Field,
    swap: pub ClearingSwap,

    // Witness (private) - same as 5d-2.
    orders: [OrderPreimage; MAX_ORDERS_PER_EPOCH],
    cancelled_indices: [u32; MAX_ORDERS_PER_EPOCH],
    fills: [FillEntry; MAX_ORDERS_PER_EPOCH],
    fills_len: u32,
    fill_to_order_index: [u32; MAX_ORDERS_PER_EPOCH],
) {
```

Note: `fills` and `fills_len` move from `pub` to private witness. The internal matching/validation loops (existing lines 32-167) keep using them as before — only the externally-observable surface shrinks.

- [ ] **Step 2: After the existing validation block (right after the AMM k-monotonicity assertion at the end of `fn main`), add the Merkle root cross-check**

Append before the closing `}` of `fn main`:

```rust
    // Build the 32-slot leaf array (padded slots use empty sentinel poseidon2([0,0]))
    // and assert it hashes to the public-input fills_root.
    let mut leaves: [Field; MAX_ORDERS_PER_EPOCH] = [0; MAX_ORDERS_PER_EPOCH];
    for i in 0..MAX_ORDERS_PER_EPOCH {
        if (i as u32) < fills_len {
            leaves[i] = crate::merkle::fill_leaf(fills[i].order_nonce, fills[i].amount_out);
        } else {
            leaves[i] = crate::merkle::fill_leaf(0 as Field, 0 as u128);
        }
    }
    let computed_root = crate::merkle::merkle_root_32(leaves);
    assert(computed_root == fills_root, "fills_root mismatch with internal fills");
```

- [ ] **Step 3: Compile to verify the new shape**

```bash
cd circuits/clearing && nargo compile --silence-warnings 2>&1 | tail -10
```

Expected: clean compile (any warnings around unused fields go away because both `fills` and `fills_len` are now consumed in the new assertion). Output: `circuits/clearing/target/clearing.json` regenerated.

- [ ] **Step 4: Run the existing circuit unit tests to confirm no regression**

```bash
cd circuits/clearing && nargo test --silence-warnings 2>&1 | tail -20
```

Expected: ALL pre-existing tests still PASS, plus the five new merkle tests added in Task 1. Tests in `test.nr` that previously exercised `fn main` directly with a `fills`/`fills_len` pub input do not exist (the existing tests are unit-tests of `pricing.nr` / `binding.nr` / `merkle.nr` helpers); the integration check happens at Task 3's bb prove.

- [ ] **Step 5: Commit**

```bash
git add circuits/clearing/src/main.nr
git commit -m "feat(circuits/clearing): public-input shape — drop fills/fills_len, add fills_root

Replaces the 64-field flat fills + fills_len public-input vector with a
single Merkle root; circuit asserts root matches the internally-built tree
over the 32 fill leaves. Net public-input count: 83 -> 19 fields."
```

---

### Task 3: Rebuild artifacts + empirical bridge check

**Files:**
- Modify (only if empirical drift): `tests/integration/helpers/proof.ts`
- Modify (only if empirical drift): `cli/src/commands/close-epoch.ts`

This task validates the spec's bb-format hypothesis (proof = 500 fields, vk = 115 fields, contract constraint sizes 456/127 stay the same) post-circuit-change, and rolls forward any drift before downstream tasks consume the artifacts.

- [ ] **Step 1: Rebuild the circuit + write a fresh VK via the workspace script**

```bash
pnpm compile 2>&1 | tail -20
```

Expected: `circuits/clearing/target/clearing.json` regenerated; `circuits/clearing/target/vk.bin/vk` regenerated; `circuits/clearing/target/vk.bin/vk_hash` regenerated (this is what `scripts/deploy-tokens.ts` reads — the constructor arg auto-refreshes from this file on next deploy).

- [ ] **Step 2: Produce a witness + prove against a minimal test fixture**

Construct a minimal Prover.toml with no fills (`fills_len = 0`, empty witness arrays + `fills_root` = root of 32 empty leaves) to exercise the new shape with the smallest possible witness. Write to `circuits/clearing/Prover.toml`:

```bash
cd circuits/clearing
cat > Prover.toml <<'EOF'
order_acc = "0x0"
cancel_acc = "0x0"
order_count = 0
cancel_count = 0
reserve_a = "1000000"
reserve_b = "2000000"
lp_supply = "1000000"
clearing_price = "1500000000000000000"
fills_root = "REPLACE_WITH_EMPTY_ROOT"
swap = { a_to_pool = "0", b_to_pool = "0", a_from_pool = "0", b_from_pool = "0", reserve_a_add = "0", reserve_a_sub = "0", reserve_b_add = "0", reserve_b_sub = "0", fee_a_per_share_increment = "0", fee_b_per_share_increment = "0" }
orders = [ { side = false, amount_in = "0", limit_price = "0", order_nonce = "0x0", submitted_at_block = 0, owner = "0x0" }, { side = false, amount_in = "0", limit_price = "0", order_nonce = "0x0", submitted_at_block = 0, owner = "0x0" }, { side = false, amount_in = "0", limit_price = "0", order_nonce = "0x0", submitted_at_block = 0, owner = "0x0" }, { side = false, amount_in = "0", limit_price = "0", order_nonce = "0x0", submitted_at_block = 0, owner = "0x0" }, { side = false, amount_in = "0", limit_price = "0", order_nonce = "0x0", submitted_at_block = 0, owner = "0x0" }, { side = false, amount_in = "0", limit_price = "0", order_nonce = "0x0", submitted_at_block = 0, owner = "0x0" }, { side = false, amount_in = "0", limit_price = "0", order_nonce = "0x0", submitted_at_block = 0, owner = "0x0" }, { side = false, amount_in = "0", limit_price = "0", order_nonce = "0x0", submitted_at_block = 0, owner = "0x0" }, { side = false, amount_in = "0", limit_price = "0", order_nonce = "0x0", submitted_at_block = 0, owner = "0x0" }, { side = false, amount_in = "0", limit_price = "0", order_nonce = "0x0", submitted_at_block = 0, owner = "0x0" }, { side = false, amount_in = "0", limit_price = "0", order_nonce = "0x0", submitted_at_block = 0, owner = "0x0" }, { side = false, amount_in = "0", limit_price = "0", order_nonce = "0x0", submitted_at_block = 0, owner = "0x0" }, { side = false, amount_in = "0", limit_price = "0", order_nonce = "0x0", submitted_at_block = 0, owner = "0x0" }, { side = false, amount_in = "0", limit_price = "0", order_nonce = "0x0", submitted_at_block = 0, owner = "0x0" }, { side = false, amount_in = "0", limit_price = "0", order_nonce = "0x0", submitted_at_block = 0, owner = "0x0" }, { side = false, amount_in = "0", limit_price = "0", order_nonce = "0x0", submitted_at_block = 0, owner = "0x0" }, { side = false, amount_in = "0", limit_price = "0", order_nonce = "0x0", submitted_at_block = 0, owner = "0x0" }, { side = false, amount_in = "0", limit_price = "0", order_nonce = "0x0", submitted_at_block = 0, owner = "0x0" }, { side = false, amount_in = "0", limit_price = "0", order_nonce = "0x0", submitted_at_block = 0, owner = "0x0" }, { side = false, amount_in = "0", limit_price = "0", order_nonce = "0x0", submitted_at_block = 0, owner = "0x0" }, { side = false, amount_in = "0", limit_price = "0", order_nonce = "0x0", submitted_at_block = 0, owner = "0x0" }, { side = false, amount_in = "0", limit_price = "0", order_nonce = "0x0", submitted_at_block = 0, owner = "0x0" }, { side = false, amount_in = "0", limit_price = "0", order_nonce = "0x0", submitted_at_block = 0, owner = "0x0" }, { side = false, amount_in = "0", limit_price = "0", order_nonce = "0x0", submitted_at_block = 0, owner = "0x0" }, { side = false, amount_in = "0", limit_price = "0", order_nonce = "0x0", submitted_at_block = 0, owner = "0x0" }, { side = false, amount_in = "0", limit_price = "0", order_nonce = "0x0", submitted_at_block = 0, owner = "0x0" }, { side = false, amount_in = "0", limit_price = "0", order_nonce = "0x0", submitted_at_block = 0, owner = "0x0" }, { side = false, amount_in = "0", limit_price = "0", order_nonce = "0x0", submitted_at_block = 0, owner = "0x0" }, { side = false, amount_in = "0", limit_price = "0", order_nonce = "0x0", submitted_at_block = 0, owner = "0x0" }, { side = false, amount_in = "0", limit_price = "0", order_nonce = "0x0", submitted_at_block = 0, owner = "0x0" }, { side = false, amount_in = "0", limit_price = "0", order_nonce = "0x0", submitted_at_block = 0, owner = "0x0" }, { side = false, amount_in = "0", limit_price = "0", order_nonce = "0x0", submitted_at_block = 0, owner = "0x0" } ]
cancelled_indices = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
fills = [ { order_nonce = "0x0", amount_out = "0" }, { order_nonce = "0x0", amount_out = "0" }, { order_nonce = "0x0", amount_out = "0" }, { order_nonce = "0x0", amount_out = "0" }, { order_nonce = "0x0", amount_out = "0" }, { order_nonce = "0x0", amount_out = "0" }, { order_nonce = "0x0", amount_out = "0" }, { order_nonce = "0x0", amount_out = "0" }, { order_nonce = "0x0", amount_out = "0" }, { order_nonce = "0x0", amount_out = "0" }, { order_nonce = "0x0", amount_out = "0" }, { order_nonce = "0x0", amount_out = "0" }, { order_nonce = "0x0", amount_out = "0" }, { order_nonce = "0x0", amount_out = "0" }, { order_nonce = "0x0", amount_out = "0" }, { order_nonce = "0x0", amount_out = "0" }, { order_nonce = "0x0", amount_out = "0" }, { order_nonce = "0x0", amount_out = "0" }, { order_nonce = "0x0", amount_out = "0" }, { order_nonce = "0x0", amount_out = "0" }, { order_nonce = "0x0", amount_out = "0" }, { order_nonce = "0x0", amount_out = "0" }, { order_nonce = "0x0", amount_out = "0" }, { order_nonce = "0x0", amount_out = "0" }, { order_nonce = "0x0", amount_out = "0" }, { order_nonce = "0x0", amount_out = "0" }, { order_nonce = "0x0", amount_out = "0" }, { order_nonce = "0x0", amount_out = "0" }, { order_nonce = "0x0", amount_out = "0" }, { order_nonce = "0x0", amount_out = "0" }, { order_nonce = "0x0", amount_out = "0" }, { order_nonce = "0x0", amount_out = "0" } ]
fills_len = 0
fill_to_order_index = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
EOF
```

Then compute the empty-tree root via a one-off node script and patch it in:

```bash
node --input-type=module --eval '
import { poseidon2Hash } from "@aztec/foundation/crypto/poseidon";
let leaf = (await poseidon2Hash([0n, 0n])).toString();
let level = Array(32).fill(leaf);
for (let w = 32; w > 1; w /= 2) {
  const next = [];
  for (let i = 0; i < w; i += 2) {
    next.push((await poseidon2Hash([BigInt(level[i]), BigInt(level[i+1])])).toString());
  }
  level = next;
}
console.log("EMPTY_ROOT=" + level[0]);
' 2>&1 | tee /tmp/empty-root.txt

EMPTY_ROOT=$(grep EMPTY_ROOT /tmp/empty-root.txt | cut -d= -f2)
# bigint string -> 0x-prefixed hex for TOML.
EMPTY_ROOT_HEX=$(node -e "console.log('0x' + BigInt('$EMPTY_ROOT').toString(16))")
sed -i.bak "s|REPLACE_WITH_EMPTY_ROOT|$EMPTY_ROOT_HEX|" circuits/clearing/Prover.toml
```

Then execute + prove:

```bash
cd circuits/clearing
nargo execute --silence-warnings clearing 2>&1 | tail -5
# clearing.gz written to target/

ROOT="$(cd ../.. && pwd)"
VERSION="$(tr -d '[:space:]' < "$ROOT/.aztec-version")"
docker run --rm --entrypoint bash \
  -v "$ROOT:/work" -w /work/circuits/clearing \
  "aztecprotocol/aztec:$VERSION" \
  -c "/usr/src/barretenberg/ts/build/arm64-linux/bb prove \
        -b target/clearing.json -w target/clearing.gz -o target/proofdir" 2>&1 | tail -10
```

Expected: bb prove succeeds. RAM peak should stay under ~6 GB (within the dev VPS budget; 31 extra Poseidon2 hashes from the Merkle should add ~8K gates over the 5d-2 baseline).

- [ ] **Step 3: Inspect the proof + vk file sizes — empirical bridge check**

```bash
ls -la circuits/clearing/target/proofdir/proof circuits/clearing/target/vk.bin/vk
```

Expected:
- `proof` = **16000 bytes** (500 fields × 32) — same as 5d-3.
- `vk` = **3680 bytes** (115 fields × 32) — same as 5d-3.

If both match: the hypothesis holds; no bridging changes needed. Skip Step 4.

If either differs: compute the new field counts and update both helpers. Step 4 covers the patch.

- [ ] **Step 4: (conditional) update bridge constants if file sizes drifted**

If `proof` size ≠ 16000 bytes, replace in `tests/integration/helpers/proof.ts:5`:

```ts
export const HONK_PROOF_FIELDS = <new count>;
```

If `vk` size ≠ 3680 bytes, replace in `tests/integration/helpers/proof.ts:10`:

```ts
export const HONK_VK_FIELDS = <new count>;
```

The CLI bridging in `cli/src/commands/close-epoch.ts:21-22` (`CONTRACT_PROOF_SIZE = 456`, `CONTRACT_VK_SIZE = 127`) reflects the **contract**'s constraint signature, not the file. These do NOT change unless the contract's `[Field; 456]` / `[Field; 127]` declarations are altered in Task 7 — leave them alone here.

- [ ] **Step 5: Commit the rebuilt artifacts (if not gitignored) + any bridge updates**

```bash
git status circuits/clearing/target tests/integration/helpers/proof.ts
# target/ is in .gitignore (per repo root) so no artifact commit; only proof.ts if patched.

# Only commit if Step 4 was needed:
if git diff --quiet tests/integration/helpers/proof.ts; then
  echo "No bridge drift — nothing to commit"
else
  git add tests/integration/helpers/proof.ts
  git commit -m "fix(tests/proof): update HONK_*_FIELDS for 5d-4 circuit rebuild"
fi
```

Expected: usually clean (artifact directories are ignored, hypothesis holds). If a bridge update was needed, a single one-file commit lands here.

---

### Task 4: Aggregator JS Merkle module + parity test

**Files:**
- Create: `aggregator/src/merkle.ts`
- Create: `aggregator/test/merkle.test.ts`
- Modify: `aggregator/package.json` (add `@aztec/foundation` dep)

- [ ] **Step 1: Add the `@aztec/foundation` dependency to the aggregator package**

Modify `aggregator/package.json`. Add a `dependencies` block (currently the file only has `devDependencies`):

```json
{
  "name": "@zswap/aggregator",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --import tsx --test 'test/**/*.test.ts'",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@aztec/foundation": "4.2.1",
    "@aztec/aztec.js": "4.2.1"
  },
  "devDependencies": {
    "@types/node": "^22.7.0",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0"
  }
}
```

Run `pnpm install` from the repo root to materialise the dep in the workspace:

```bash
pnpm install 2>&1 | tail -10
```

Expected: pnpm reports the new dep added under `aggregator`; no warnings.

- [ ] **Step 2: Write the failing parity test**

Create `aggregator/test/merkle.test.ts`:

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Fr } from "@aztec/aztec.js/fields";
import { poseidon2Hash } from "@aztec/foundation/crypto/poseidon";
import { buildFillsTree, fillLeaf, merkleRoot32 } from "../src/merkle.js";
import type { JsFillEntry } from "../src/merkle.js";

describe("aggregator/merkle", () => {
  it("fillLeaf((0,0)) equals poseidon2([0,0]) — empty-slot sentinel", async () => {
    const leaf = await fillLeaf(new Fr(0n), 0n);
    const expected = await poseidon2Hash([0n, 0n]);
    assert.equal(leaf.toString(), expected.toString());
  });

  it("fillLeaf is sensitive to order_nonce", async () => {
    const a = await fillLeaf(new Fr(1n), 100n);
    const b = await fillLeaf(new Fr(2n), 100n);
    assert.notEqual(a.toString(), b.toString());
  });

  it("fillLeaf is sensitive to amount_out", async () => {
    const a = await fillLeaf(new Fr(1n), 100n);
    const b = await fillLeaf(new Fr(1n), 101n);
    assert.notEqual(a.toString(), b.toString());
  });

  it("merkleRoot32 of all empty leaves is deterministic", async () => {
    const empty = await fillLeaf(new Fr(0n), 0n);
    const leaves: Fr[] = Array(32).fill(empty);
    const r1 = await merkleRoot32(leaves);
    const r2 = await merkleRoot32(leaves);
    assert.equal(r1.toString(), r2.toString());
  });

  it("buildFillsTree returns a path that reconstructs root for every populated slot", async () => {
    const fills: JsFillEntry[] = [
      { order_nonce: new Fr(11n), amount_out: 100n },
      { order_nonce: new Fr(22n), amount_out: 200n },
      { order_nonce: new Fr(33n), amount_out: 300n },
    ];
    const out = await buildFillsTree(fills);
    assert.equal(out.leaves.length, 32);

    // Re-walk the path for each populated slot.
    for (const fill of fills) {
      const path = out.paths.get(fill.order_nonce.toString());
      assert.ok(path, `missing path for nonce ${fill.order_nonce}`);
      const leaf = await fillLeaf(fill.order_nonce, fill.amount_out);
      let current = leaf;
      let idx = path.leaf_index;
      for (let level = 0; level < 5; level++) {
        const bit = idx & 1;
        const sibling = path.siblings[level]!;
        current = bit === 0
          ? await poseidon2Hash([current.toBigInt(), sibling.toBigInt()])
          : await poseidon2Hash([sibling.toBigInt(), current.toBigInt()]);
        idx >>= 1;
      }
      assert.equal(idx, 0, "leaf_index must consume all 5 bits");
      assert.equal(current.toString(), out.root.toString());
    }
  });

  it("buildFillsTree throws on duplicate order_nonce", async () => {
    const fills: JsFillEntry[] = [
      { order_nonce: new Fr(7n), amount_out: 100n },
      { order_nonce: new Fr(7n), amount_out: 200n },
    ];
    await assert.rejects(() => buildFillsTree(fills), /duplicate/);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
pnpm --filter @zswap/aggregator test 2>&1 | tail -15
```

Expected: import error — `aggregator/src/merkle.ts` doesn't exist yet, so the test file fails to resolve.

- [ ] **Step 4: Implement `aggregator/src/merkle.ts`**

Create `aggregator/src/merkle.ts`:

```ts
/**
 * Week 5d-4 Merkle settlement tree (JS parity of circuits/clearing/src/merkle.nr).
 * Depth 5; 32 leaves; Poseidon2 (via @aztec/foundation). Empty slots use
 * leaf = poseidon2([0, 0]) — same sentinel as the circuit's `fill_leaf(0, 0)`.
 */
import { Fr } from "@aztec/aztec.js/fields";
import { poseidon2Hash } from "@aztec/foundation/crypto/poseidon";

export const TREE_LEAVES = 32;
export const TREE_DEPTH = 5;

export interface JsFillEntry {
  order_nonce: Fr;
  amount_out: bigint;
}

export interface MerkleTreeOutput {
  root: Fr;
  leaves: Fr[];                                          // length TREE_LEAVES (= 32)
  paths: Map<string, { siblings: Fr[]; leaf_index: number }>;  // keyed by order_nonce.toString()
}

/** poseidon2([order_nonce, amount_out as Field]) — matches circuits/clearing/src/merkle.nr's fill_leaf. */
export async function fillLeaf(orderNonce: Fr, amountOut: bigint): Promise<Fr> {
  return poseidon2Hash([orderNonce.toBigInt(), amountOut]);
}

/** Hash 32 leaves into the depth-5 root. */
export async function merkleRoot32(leaves: Fr[]): Promise<Fr> {
  if (leaves.length !== TREE_LEAVES) {
    throw new Error(`expected ${TREE_LEAVES} leaves, got ${leaves.length}`);
  }
  let level: Fr[] = leaves.slice();
  for (let round = 0; round < TREE_DEPTH; round++) {
    const next: Fr[] = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(await poseidon2Hash([level[i]!.toBigInt(), level[i + 1]!.toBigInt()]));
    }
    level = next;
  }
  return level[0]!;
}

/**
 * Build the full Merkle tree from a list of populated fills.
 * - Pads to 32 leaves with the (0,0) sentinel.
 * - Returns the root, the 32 leaf hashes, and per-populated-fill inclusion paths.
 * - Throws on duplicate order_nonce among populated fills (the circuit would not produce one).
 */
export async function buildFillsTree(fills: JsFillEntry[]): Promise<MerkleTreeOutput> {
  if (fills.length > TREE_LEAVES) {
    throw new Error(`too many fills (${fills.length}); max ${TREE_LEAVES}`);
  }
  const seen = new Set<string>();
  for (const f of fills) {
    const k = f.order_nonce.toString();
    if (seen.has(k)) throw new Error(`duplicate order_nonce ${k}`);
    seen.add(k);
  }

  // Hash leaves (populated + padding sentinels).
  const leaves: Fr[] = [];
  for (let i = 0; i < TREE_LEAVES; i++) {
    if (i < fills.length) {
      leaves.push(await fillLeaf(fills[i]!.order_nonce, fills[i]!.amount_out));
    } else {
      leaves.push(await fillLeaf(new Fr(0n), 0n));
    }
  }

  // Build the per-level node arrays, retaining them so we can later read off siblings.
  const levels: Fr[][] = [leaves];
  for (let r = 0; r < TREE_DEPTH; r++) {
    const prev = levels[r]!;
    const next: Fr[] = [];
    for (let i = 0; i < prev.length; i += 2) {
      next.push(await poseidon2Hash([prev[i]!.toBigInt(), prev[i + 1]!.toBigInt()]));
    }
    levels.push(next);
  }
  const root = levels[TREE_DEPTH]![0]!;

  // For each populated fill, harvest siblings going up.
  const paths = new Map<string, { siblings: Fr[]; leaf_index: number }>();
  for (let i = 0; i < fills.length; i++) {
    let idx = i;
    const siblings: Fr[] = [];
    for (let r = 0; r < TREE_DEPTH; r++) {
      const siblingIdx = idx ^ 1;
      siblings.push(levels[r]![siblingIdx]!);
      idx >>= 1;
    }
    paths.set(fills[i]!.order_nonce.toString(), { siblings, leaf_index: i });
  }

  return { root, leaves, paths };
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
pnpm --filter @zswap/aggregator test 2>&1 | tail -15
```

Expected: all six merkle tests PASS. Existing `witness.test.ts` may FAIL — that's expected and is fixed in Task 6.

- [ ] **Step 6: Commit**

```bash
git add aggregator/package.json aggregator/src/merkle.ts aggregator/test/merkle.test.ts pnpm-lock.yaml
git commit -m "feat(aggregator): merkle.ts — JS parity of circuit Merkle tree

Adds buildFillsTree(fills) with @aztec/foundation poseidon2Hash; produces
root, leaves[32], and per-populated-fill inclusion paths (siblings[5] +
leaf_index). Six parity tests cover empty-slot sentinel, leaf sensitivity,
root determinism, and end-to-end path-reconstructs-root for each fill."
```

---

### Task 5: Aggregator snapshot module

**Files:**
- Create: `aggregator/src/snapshot.ts`
- Create: `aggregator/test/snapshot.test.ts`

- [ ] **Step 1: Write the failing snapshot test**

Create `aggregator/test/snapshot.test.ts`:

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Fr } from "@aztec/aztec.js/fields";
import { buildFillsTree, type JsFillEntry } from "../src/merkle.js";
import { writeSnapshot, readSnapshot, findEpochForNonce } from "../src/snapshot.js";

describe("aggregator/snapshot", () => {
  it("writes and reads back a snapshot identically", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zswap-snapshot-"));
    try {
      const fills: JsFillEntry[] = [
        { order_nonce: new Fr(101n), amount_out: 500n },
        { order_nonce: new Fr(202n), amount_out: 750n },
      ];
      const tree = await buildFillsTree(fills);
      writeSnapshot(dir, { epoch_id: 7, fills, tree });

      const round = readSnapshot(dir, 7);
      assert.equal(round.epoch_id, 7);
      assert.equal(round.fills_root, tree.root.toString());
      assert.equal(round.leaves.length, 32);
      const fill101 = round.paths.get(new Fr(101n).toString());
      assert.ok(fill101, "expected path for nonce 0x65");
      assert.equal(fill101.leaf_index, 0);
      assert.equal(fill101.siblings.length, 5);
      // Spot-check that round-trip preserves big-int amounts as strings.
      const populated = round.leaves.slice(0, 2);
      assert.equal(populated.length, 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("findEpochForNonce returns the matching epoch_id, or null", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zswap-snapshot-"));
    try {
      const fillsA: JsFillEntry[] = [{ order_nonce: new Fr(11n), amount_out: 100n }];
      const fillsB: JsFillEntry[] = [{ order_nonce: new Fr(22n), amount_out: 200n }];
      writeSnapshot(dir, { epoch_id: 3, fills: fillsA, tree: await buildFillsTree(fillsA) });
      writeSnapshot(dir, { epoch_id: 5, fills: fillsB, tree: await buildFillsTree(fillsB) });
      assert.equal(findEpochForNonce(dir, new Fr(11n).toString()), 3);
      assert.equal(findEpochForNonce(dir, new Fr(22n).toString()), 5);
      assert.equal(findEpochForNonce(dir, new Fr(999n).toString()), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm --filter @zswap/aggregator test 2>&1 | tail -10
```

Expected: import error — `aggregator/src/snapshot.ts` doesn't exist.

- [ ] **Step 3: Implement `aggregator/src/snapshot.ts`**

Create `aggregator/src/snapshot.ts`:

```ts
/**
 * Per-epoch snapshot store for the Week 5d-4 settlement Merkle tree.
 *
 * The aggregator writes one JSON file per closed epoch under `<dir>/epoch-<N>.json`;
 * the CLI's `zswap claim` reads it back to construct the inclusion proof.
 */
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { Fr } from "@aztec/aztec.js/fields";
import type { JsFillEntry, MerkleTreeOutput } from "./merkle.js";

export interface SnapshotInput {
  epoch_id: number;
  fills: JsFillEntry[];
  tree: MerkleTreeOutput;
}

export interface SnapshotLeafJson {
  order_nonce: string;   // 0x-prefixed Field hex
  amount_out: string;    // decimal bigint string
  leaf_hash: string;     // 0x-prefixed Field hex
}

export interface SnapshotPathJson {
  siblings: string[];    // length 5, 0x-prefixed
  leaf_index: number;
}

export interface SnapshotJson {
  epoch_id: number;
  fills_root: string;
  leaves: SnapshotLeafJson[];
  paths: Record<string, SnapshotPathJson>;
}

/** In-memory snapshot returned by readSnapshot — same fields, with paths as a Map. */
export interface Snapshot {
  epoch_id: number;
  fills_root: string;
  leaves: SnapshotLeafJson[];
  paths: Map<string, { siblings: Fr[]; leaf_index: number }>;
}

export function snapshotPath(dir: string, epoch_id: number): string {
  return join(dir, `epoch-${epoch_id}.json`);
}

export function writeSnapshot(dir: string, snap: SnapshotInput): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const leaves: SnapshotLeafJson[] = [];
  for (let i = 0; i < snap.tree.leaves.length; i++) {
    const populated = snap.fills[i];
    leaves.push({
      order_nonce: populated ? populated.order_nonce.toString() : new Fr(0n).toString(),
      amount_out: populated ? populated.amount_out.toString() : "0",
      leaf_hash: snap.tree.leaves[i]!.toString(),
    });
  }
  const paths: Record<string, SnapshotPathJson> = {};
  for (const [nonce, path] of snap.tree.paths) {
    paths[nonce] = {
      siblings: path.siblings.map((s) => s.toString()),
      leaf_index: path.leaf_index,
    };
  }
  const json: SnapshotJson = {
    epoch_id: snap.epoch_id,
    fills_root: snap.tree.root.toString(),
    leaves,
    paths,
  };
  writeFileSync(snapshotPath(dir, snap.epoch_id), JSON.stringify(json, null, 2));
}

export function readSnapshot(dir: string, epoch_id: number): Snapshot {
  const raw = JSON.parse(readFileSync(snapshotPath(dir, epoch_id), "utf8")) as SnapshotJson;
  const paths = new Map<string, { siblings: Fr[]; leaf_index: number }>();
  for (const [nonce, p] of Object.entries(raw.paths)) {
    paths.set(nonce, {
      siblings: p.siblings.map((s) => Fr.fromString(s)),
      leaf_index: p.leaf_index,
    });
  }
  return {
    epoch_id: raw.epoch_id,
    fills_root: raw.fills_root,
    leaves: raw.leaves,
    paths,
  };
}

/**
 * Linear scan over `<dir>/epoch-*.json`; returns the epoch_id whose snapshot
 * carries `order_nonce_hex` as a populated path, or null. The CLI uses this when
 * the maker doesn't pass --epoch explicitly.
 */
export function findEpochForNonce(dir: string, order_nonce_hex: string): number | null {
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => /^epoch-\d+\.json$/.test(f));
  for (const f of files) {
    const raw = JSON.parse(readFileSync(join(dir, f), "utf8")) as SnapshotJson;
    if (raw.paths[order_nonce_hex]) return raw.epoch_id;
  }
  return null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm --filter @zswap/aggregator test 2>&1 | tail -15
```

Expected: snapshot tests + merkle tests PASS (existing witness.test.ts still may FAIL — fixed in Task 6).

- [ ] **Step 5: Commit**

```bash
git add aggregator/src/snapshot.ts aggregator/test/snapshot.test.ts
git commit -m "feat(aggregator): snapshot.ts — per-epoch fills snapshot store

Writes <dir>/epoch-<N>.json on clearing, exposing fills_root + leaves[] +
inclusion paths keyed by order_nonce. CLI reads via findEpochForNonce
when the maker doesn't pass --epoch explicitly."
```

---

### Task 6: Witness builder TOML rewrite

**Files:**
- Modify: `aggregator/src/witness.ts`
- Modify: `aggregator/test/witness.test.ts`

- [ ] **Step 1: Update the witness test fixture expectations to the new TOML shape**

Read the current `aggregator/test/witness.test.ts` to understand the existing assertions, then update them. The new TOML must contain `fills_root = "0x..."` (single Field) and a 32-entry `fills` private witness array, no `fills_len`-as-pub.

Replace the file `aggregator/test/witness.test.ts` with:

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildClearingWitness, MAX_ORDERS_PER_EPOCH } from "../src/witness.js";
import { type ClearingResult } from "../src/clearing.js";

describe("buildClearingWitness", () => {
  it("emits the new fills_root public input + 32-entry private fills array", async () => {
    const epoch = { order_acc: 0n, cancel_acc: 0n, order_count: 1, cancel_count: 0 };
    const pool = { reserve_a: 1_000_000n, reserve_b: 2_000_000n, lp_supply: 1_000_000n };
    const orders = [{
      side: false,
      amount_in: 1000n,
      limit_price: 2_000_000_000_000_000_000n,
      order_nonce: 0x1n,
      submitted_at_block: 5,
      owner: 0xa1n,
    }];
    const clearing: ClearingResult = {
      cleared: true,
      clearingPrice: 1_500_000_000_000_000_000n,
      fills: [{ orderNonce: 0x1n, filledIn: 1000n, amountOut: 666n }],
      newReserveA: 1_000_500n,
      newReserveB: 1_999_500n,
      feeAPerShareIncrement: 0n,
      feeBPerShareIncrement: 0n,
    };
    const out = await buildClearingWitness({
      epoch, pool, orders, cancellationIndices: [], clearing,
    });

    // The TOML must now expose fills_root as a public input (a single line)
    // and the fills array is the PRIVATE 32-entry witness (one inline table per slot).
    assert.match(out.proverToml, /^fills_root = "0x[0-9a-f]+"$/m,
      "missing fills_root public input");
    assert.doesNotMatch(out.proverToml, /^fills_len\s*=/m,
      "fills_len must not be a public input anymore (now private witness)");

    // Spot-check that the 32-entry private fills array survives (we test it's an array of 32 inline tables).
    const fillsBlock = out.proverToml.match(/^fills = \[\s*(?:\{[^\}]+\},\s*){32}\]/m);
    assert.ok(fillsBlock, "expected 32-entry private fills array in TOML");
    assert.ok(out.fillsRoot, "buildClearingWitness must return fillsRoot");
    assert.match(out.fillsRoot, /^0x[0-9a-f]+$/);
    assert.equal(out.maxOrdersPerEpoch, MAX_ORDERS_PER_EPOCH);
  });

  it("handles a no-fills clearing — fills_root collapses to the all-empty-leaves root", async () => {
    const epoch = { order_acc: 0n, cancel_acc: 0n, order_count: 0, cancel_count: 0 };
    const pool = { reserve_a: 1_000n, reserve_b: 2_000n, lp_supply: 1_000n };
    const clearing: ClearingResult = {
      cleared: false,
      clearingPrice: 0n,
      fills: [],
      newReserveA: 1_000n,
      newReserveB: 2_000n,
      feeAPerShareIncrement: 0n,
      feeBPerShareIncrement: 0n,
    };
    const out = await buildClearingWitness({
      epoch, pool, orders: [], cancellationIndices: [], clearing,
    });
    assert.match(out.proverToml, /^fills_root = "0x[0-9a-f]+"$/m);
    assert.match(out.fillsRoot, /^0x[0-9a-f]+$/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm --filter @zswap/aggregator test 2>&1 | tail -15
```

Expected: failures because `buildClearingWitness` doesn't return `fillsRoot`/`maxOrdersPerEpoch` yet and the TOML still emits `fills_len = N` as a top-level public input.

- [ ] **Step 3: Rewrite `aggregator/src/witness.ts` to emit the new shape**

Apply two structural changes in `aggregator/src/witness.ts`:

a) Change the `ClearingWitness` interface (around line 41) to expose the root and the maxPerEpoch used:

```ts
export interface ClearingWitness {
  /** TOML-encoded text to write to circuits/clearing/Prover.toml. */
  proverToml: string;
  /** The Merkle root the circuit will assert against (also the public input). */
  fillsRoot: string;
  /** The 32 leaf hashes (post-padding) — for snapshot.ts consumption. */
  leaves: string[];
  /** Echo of the cap actually used (mirrors arg / fallback). */
  maxOrdersPerEpoch: number;
}
```

b) Change `buildClearingWitness` to `async` and rewrite the TOML emission to drop the top-level `fills` + `fills_len` public lines and add a top-level `fills_root` public line; keep the 32-entry private `fills` array + `fills_len` as private witness. Replace the function body starting at `export function buildClearingWitness({` (around line 57) — return-type goes to `Promise<ClearingWitness>`:

```ts
export async function buildClearingWitness(args: {
  epoch: EpochState;
  pool: PoolSnapshotForCircuit;
  orders: OrderNotePreimage[];
  cancellationIndices: number[];
  clearing: ClearingResult;
  /** Override the circuit's MAX_ORDERS_PER_EPOCH for smaller test circuits (default: 32). */
  maxOrders?: number;
}): Promise<ClearingWitness> {
  const { epoch, pool, orders, cancellationIndices, clearing } = args;
  const maxPerEpoch = args.maxOrders ?? MAX_ORDERS_PER_EPOCH;
  if (orders.length !== epoch.order_count) {
    throw new Error(`orders.length (${orders.length}) != epoch.order_count (${epoch.order_count})`);
  }
  if (cancellationIndices.length !== epoch.cancel_count) {
    throw new Error(`cancellationIndices.length (${cancellationIndices.length}) != epoch.cancel_count (${epoch.cancel_count})`);
  }

  // -- existing padding / canonical-fill derivation block unchanged --
  const ordersPadded: OrderNotePreimage[] = orders.slice();
  while (ordersPadded.length < maxPerEpoch) {
    ordersPadded.push({
      side: false, amount_in: 0n, limit_price: 0n,
      order_nonce: 0n, submitted_at_block: 0, owner: 0n,
    });
  }
  const cancelledPadded: number[] = cancellationIndices.slice();
  while (cancelledPadded.length < maxPerEpoch) cancelledPadded.push(0);

  const SCALE = 1_000_000_000_000_000_000n;
  const FEE_NUM_CIRCUIT = 30n;
  const FEE_DEN_CIRCUIT = 10_000n;
  function circuitPayout(order: OrderNotePreimage, clearingPrice: bigint): bigint {
    const gross = order.side
      ? (order.amount_in * clearingPrice) / SCALE
      : (order.amount_in * SCALE) / clearingPrice;
    return (gross * (FEE_DEN_CIRCUIT - FEE_NUM_CIRCUIT)) / FEE_DEN_CIRCUIT;
  }

  const orderNonceSet = new Set(orders.map((o) => o.order_nonce));
  for (const fill of clearing.fills) {
    if (!orderNonceSet.has(fill.orderNonce)) {
      throw new Error(`fill order_nonce ${fill.orderNonce} not in orders[]`);
    }
  }

  const filledNonces = new Set(clearing.fills.map((f) => f.orderNonce));
  const canonicalFills: { orderNonce: bigint; amountOut: bigint }[] = [];
  const fillToOrderIndex: number[] = [];
  for (let i = 0; i < orders.length; i++) {
    const o = orders[i]!;
    if (filledNonces.has(o.order_nonce)) {
      canonicalFills.push({
        orderNonce: o.order_nonce,
        amountOut: circuitPayout(o, clearing.clearingPrice),
      });
      fillToOrderIndex.push(i);
    }
  }
  while (fillToOrderIndex.length < maxPerEpoch) fillToOrderIndex.push(0);

  // -- existing swap-fields derivation block unchanged --
  let grossBuyInA = 0n, grossSellInB = 0n, buyerPayoutsB = 0n, sellerPayoutsA = 0n;
  for (const cf of canonicalFills) {
    const order = orders.find((o) => o.order_nonce === cf.orderNonce);
    if (!order) continue;
    if (order.side) { grossSellInB += order.amount_in; sellerPayoutsA += cf.amountOut; }
    else { grossBuyInA += order.amount_in; buyerPayoutsB += cf.amountOut; }
  }
  const sat = (x: bigint, y: bigint) => (x > y ? x - y : 0n);
  const aToPool = sat(grossBuyInA, sellerPayoutsA);
  const aFromPool = sat(sellerPayoutsA, grossBuyInA);
  const bToPool = sat(grossSellInB, buyerPayoutsB);
  const bFromPool = sat(buyerPayoutsB, grossSellInB);
  const grossBuyOutB  = clearing.clearingPrice > 0n ? (grossBuyInA * SCALE) / clearing.clearingPrice : 0n;
  const grossSellOutA = clearing.clearingPrice > 0n ? (grossSellInB * clearing.clearingPrice) / SCALE : 0n;
  const feePoolA = grossSellOutA >= sellerPayoutsA ? grossSellOutA - sellerPayoutsA : 0n;
  const feePoolB = grossBuyOutB  >= buyerPayoutsB  ? grossBuyOutB  - buyerPayoutsB  : 0n;
  const feeAPerShareIncrement = pool.lp_supply > 0n ? (feePoolA * SCALE) / pool.lp_supply : 0n;
  const feeBPerShareIncrement = pool.lp_supply > 0n ? (feePoolB * SCALE) / pool.lp_supply : 0n;
  const netFlowA = aToPool - aFromPool - feePoolA;
  const netFlowB = bToPool - bFromPool - feePoolB;
  const reserveAAdd = netFlowA > 0n ? netFlowA : 0n;
  const reserveASub = netFlowA < 0n ? -netFlowA : 0n;
  const reserveBAdd = netFlowB > 0n ? netFlowB : 0n;
  const reserveBSub = netFlowB < 0n ? -netFlowB : 0n;

  // -- NEW: Merkle root over canonical fills (padded to maxPerEpoch). --
  const { buildFillsTree } = await import("./merkle.js");
  const { Fr } = await import("@aztec/aztec.js/fields");
  const tree = await buildFillsTree(
    canonicalFills.map((cf) => ({ order_nonce: new Fr(cf.orderNonce), amount_out: cf.amountOut })),
  );

  // -- Build TOML --
  const lines: string[] = [];
  // Public inputs (matching circuits/clearing/src/main.nr fn main pub args).
  lines.push(`order_acc = "0x${epoch.order_acc.toString(16)}"`);
  lines.push(`cancel_acc = "0x${epoch.cancel_acc.toString(16)}"`);
  lines.push(`order_count = ${epoch.order_count}`);
  lines.push(`cancel_count = ${epoch.cancel_count}`);
  lines.push(`reserve_a = "${pool.reserve_a}"`);
  lines.push(`reserve_b = "${pool.reserve_b}"`);
  lines.push(`lp_supply = "${pool.lp_supply}"`);
  lines.push(`clearing_price = "${clearing.clearingPrice}"`);
  lines.push(`fills_root = "${tree.root.toString()}"`);
  lines.push(`swap = { ` +
    `a_to_pool = "${aToPool}", b_to_pool = "${bToPool}", a_from_pool = "${aFromPool}", b_from_pool = "${bFromPool}", ` +
    `reserve_a_add = "${reserveAAdd}", reserve_a_sub = "${reserveASub}", ` +
    `reserve_b_add = "${reserveBAdd}", reserve_b_sub = "${reserveBSub}", ` +
    `fee_a_per_share_increment = "${feeAPerShareIncrement}", fee_b_per_share_increment = "${feeBPerShareIncrement}" }`);

  // Private witness arrays (orders, cancelled_indices, fills, fills_len, fill_to_order_index).
  lines.push(`orders = [`);
  for (const o of ordersPadded) {
    lines.push(`  { side = ${o.side}, amount_in = "${o.amount_in}", limit_price = "${o.limit_price}", ` +
      `order_nonce = "0x${o.order_nonce.toString(16)}", submitted_at_block = ${o.submitted_at_block}, ` +
      `owner = "0x${o.owner.toString(16)}" },`);
  }
  lines.push(`]`);
  lines.push(`cancelled_indices = [${cancelledPadded.join(", ")}]`);
  lines.push(`fills = [`);
  for (let i = 0; i < maxPerEpoch; i++) {
    const f = i < canonicalFills.length ? canonicalFills[i] : null;
    const nonce = f ? `"0x${f.orderNonce.toString(16)}"` : `"0x0"`;
    const out = f ? `"${f.amountOut}"` : `"0"`;
    lines.push(`  { order_nonce = ${nonce}, amount_out = ${out} },`);
  }
  lines.push(`]`);
  lines.push(`fills_len = ${canonicalFills.length}`);
  lines.push(`fill_to_order_index = [${fillToOrderIndex.join(", ")}]`);

  return {
    proverToml: lines.join("\n") + "\n",
    fillsRoot: tree.root.toString(),
    leaves: tree.leaves.map((l) => l.toString()),
    maxOrdersPerEpoch: maxPerEpoch,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm --filter @zswap/aggregator test 2>&1 | tail -20
```

Expected: all aggregator tests PASS — witness.test.ts new fixture expectations, plus merkle.test.ts and snapshot.test.ts from Tasks 4-5.

- [ ] **Step 5: Commit**

```bash
git add aggregator/src/witness.ts aggregator/test/witness.test.ts
git commit -m "feat(aggregator/witness): emit fills_root pub input + private fills witness

ClearingWitness now returns { proverToml, fillsRoot, leaves, maxOrdersPerEpoch }
so callers can snapshot the tree directly. Drops fills/fills_len from the
TOML's public-input section; moves them into the private witness slot."
```

---

### Task 7: Orderbook contract — storage + struct + flatten

**Files:**
- Modify: `contracts/orderbook/src/main.nr`

This task rewrites the contract's data shape and the structural functions but DOES NOT touch `claim_fill` yet (Task 8). To keep the contract compiling between tasks, this task also deletes references to the dropped `fills` Map (the `_assert_not_filled`, `_assert_fill`, `get_fill` functions, and the post-clearing fills loop) — Task 8 then introduces the new claim_fill + `_assert_fill_root` + `get_fills_root`.

- [ ] **Step 1: Replace the storage struct**

In `contracts/orderbook/src/main.nr`, replace lines 112-127 (the entire `#[storage] struct Storage<Context>` block) with:

```rust
    #[storage]
    struct Storage<Context> {
        orders: Owned<PrivateSet<OrderNote, Context>, Context>,
        current_epoch: PublicMutable<EpochState, Context>,
        token_a_addr: PublicImmutable<AztecAddress, Context>,
        token_b_addr: PublicImmutable<AztecAddress, Context>,
        epoch_length: PublicImmutable<u32, Context>,
        pool_addr: PublicImmutable<AztecAddress, Context>,
        /// Hash of the clearing-circuit VK. Initialised at deploy and immutable.
        /// The full VK is provided as calldata to close_epoch_and_clear_verified.
        clearing_vk_hash: PublicImmutable<Field, Context>,
        /// Week 5d-4: per-epoch Merkle settlement root over the 32-leaf fills array.
        /// `_apply_verified_clearing` writes one slot per clearing; claim_fill reads
        /// it back to verify a maker-supplied inclusion proof.
        fills_root: Map<u32, PublicMutable<Field, Context>, Context>,
    }
```

- [ ] **Step 2: Replace the ClearingPublic struct**

Replace lines 97-110 (the `ClearingPublic` struct) with:

```rust
    /// Mirror of the Week 5d-4 clearing circuit's ClearingPublic. Field order
    /// MUST match circuits/clearing/src/main.nr's fn main pub parameter declaration
    /// (order_acc, cancel_acc, order_count, cancel_count, reserve_a, reserve_b,
    /// lp_supply, clearing_price, fills_root, swap). Reorder requires matching
    /// reorder in flatten_clearing_public.
    #[derive(Deserialize, Eq, Packable, Serialize)]
    pub struct ClearingPublic {
        pub order_acc:      Field,
        pub cancel_acc:     Field,
        pub order_count:    u32,
        pub cancel_count:   u32,
        pub reserve_a:      u128,
        pub reserve_b:      u128,
        pub lp_supply:      u128,
        pub clearing_price: u128,
        pub fills_root:     Field,
        pub swap:           LiquidityPool::ClearingSwap,
    }
```

- [ ] **Step 3: Replace `flatten_clearing_public` with the [Field; 19] variant**

Replace lines 351-387 (the entire `#[contract_library_method] fn flatten_clearing_public` block) with:

```rust
    /// Flatten a ClearingPublic to the [Field; 19] vector the recursive verifier
    /// expects. Slot order matches circuits/clearing/src/main.nr's fn main pub
    /// parameter declaration order: 8 scalars, then fills_root, then the 10 swap
    /// fields. ANY reorder on the circuit side requires the matching reorder here.
    #[contract_library_method]
    fn flatten_clearing_public(p: ClearingPublic) -> [Field; 19] {
        let mut out: [Field; 19] = [0 as Field; 19];
        out[0] = p.order_acc;
        out[1] = p.cancel_acc;
        out[2] = p.order_count as Field;
        out[3] = p.cancel_count as Field;
        out[4] = p.reserve_a as Field;
        out[5] = p.reserve_b as Field;
        out[6] = p.lp_supply as Field;
        out[7] = p.clearing_price as Field;
        out[8] = p.fills_root;
        out[9]  = p.swap.a_to_pool as Field;
        out[10] = p.swap.b_to_pool as Field;
        out[11] = p.swap.a_from_pool as Field;
        out[12] = p.swap.b_from_pool as Field;
        out[13] = p.swap.reserve_a_add as Field;
        out[14] = p.swap.reserve_a_sub as Field;
        out[15] = p.swap.reserve_b_add as Field;
        out[16] = p.swap.reserve_b_sub as Field;
        out[17] = p.swap.fee_a_per_share_increment as Field;
        out[18] = p.swap.fee_b_per_share_increment as Field;
        out
    }
```

- [ ] **Step 4: Rewrite `_apply_verified_clearing` — drop the 32-fill loop, add single fills_root write**

Replace lines 431-484 (the entire `_apply_verified_clearing` function body) with:

```rust
    /// Public callback: run the net AMM swap, store the per-epoch fills root,
    /// and advance the epoch. only_self ensures only the matching
    /// close_epoch_and_clear_verified private call can invoke it.
    #[external("public")]
    #[only_self]
    fn _apply_verified_clearing(public_inputs: ClearingPublic) {
        let current = self.storage.current_epoch.read();
        let block: u32 = self.context.block_number();
        assert(block >= current.closes_at_block, "epoch has not expired yet");

        // Freshness: bind to the CURRENT epoch's accumulators. Replay rejects here.
        assert(public_inputs.order_acc == current.order_acc, "order_acc mismatch");
        assert(public_inputs.cancel_acc == current.cancel_acc, "cancel_acc mismatch");
        assert(public_inputs.order_count == current.order_count, "order_count mismatch");
        assert(public_inputs.cancel_count == current.cancel_count, "cancel_count mismatch");

        // Net AMM swap (identical to the W5c/5d-3 flow).
        let pool = self.storage.pool_addr.read();
        let swap = public_inputs.swap;
        if swap.a_to_pool > 0 as u128 {
            self.call(Token::at(self.storage.token_a_addr.read()).transfer_public_to_public(
                self.address, pool, swap.a_to_pool, 0,
            ));
        }
        if swap.b_to_pool > 0 as u128 {
            self.call(Token::at(self.storage.token_b_addr.read()).transfer_public_to_public(
                self.address, pool, swap.b_to_pool, 0,
            ));
        }
        self.call(LiquidityPool::at(pool).apply_clearing(swap));

        // Week 5d-4: single storage write — the per-epoch Merkle settlement root.
        // claim_fill reads this back at claim time via _assert_fill_root.
        self.storage.fills_root.at(current.epoch_id).write(public_inputs.fills_root);

        // Advance the epoch (accumulator fields reset to 0).
        let epoch_length = self.storage.epoch_length.read();
        self.storage.current_epoch.write(EpochState {
            epoch_id: current.epoch_id + 1,
            state: EPOCH_STATE_OPEN,
            opened_at_block: block,
            closes_at_block: block + epoch_length,
            order_acc:   0,
            cancel_acc:  0,
            order_count: 0,
            cancel_count: 0,
        });
    }
```

- [ ] **Step 5: Delete `_assert_not_filled`, `_assert_fill`, and `get_fill`; update `cancel_order` to drop the `_assert_not_filled` enqueue**

Delete the function `_assert_not_filled` (lines 274-280). Delete the `_assert_fill` function (lines 536-542). Delete the `get_fill` utility (lines 682-685).

Also in `cancel_order` (around line 617), DELETE the line `self.enqueue_self._assert_not_filled(order_nonce);`. The cancel-after-fill protection is now enforced by the token contract's `transfer_public_to_private` underflowing if the orderbook's public balance is short (per spec §6.5).

Replace the comment block above `_assert_epoch_open` enqueues in `cancel_order` (around the deleted line) so the new ordering is documented. Specifically replace:

```rust
        // Gate cancellation to OPEN + not-filled, then fold into cancel_acc, all BEFORE
        // the escrow-return public call. The Week 5c ordering rationale stands: a
        // rejected cancel must surface the clean guard message instead of a token
        // underflow, and the cancel_acc fold must be visible only if the cancel actually
        // proceeds to the escrow return.
        self.enqueue_self._assert_epoch_open();
        self.enqueue_self._assert_not_filled(order_nonce);
        self.enqueue_self._append_cancel(c_i);
```

with:

```rust
        // Gate cancellation to OPEN, then fold into cancel_acc, all BEFORE the
        // escrow-return public call. The 5c _assert_not_filled guard is dropped in
        // 5d-4: cancel-after-fill is now blocked at the token-contract level —
        // _apply_verified_clearing moves filled amount_in to the pool, leaving the
        // orderbook's public balance short, so the transfer_public_to_private call
        // underflows and the whole tx (including the OrderNote nullification + the
        // cancel_acc fold) atomically reverts. See specs/2026-05-21-...-design.md §6.5.
        self.enqueue_self._assert_epoch_open();
        self.enqueue_self._append_cancel(c_i);
```

- [ ] **Step 6: Compile**

```bash
pnpm compile 2>&1 | tail -10
```

Expected: clean compile. If a compile error references `claim_fill` (line ~498-532), that's expected — Task 8 fixes it. **Stop here if claim_fill is the only blocker.** Otherwise the compile must succeed.

(If `claim_fill` blocks the build, temporarily delete its body — Task 8 rewrites the whole function regardless, so deletion-and-rewrite is an acceptable transient state. Leave a `// claim_fill rewrite lands in Task 8` comment so the gap is obvious.)

- [ ] **Step 7: Commit**

```bash
git add contracts/orderbook/src/main.nr
git commit -m "refactor(orderbook): 5d-4 storage diff + ClearingPublic shape + flatten

Drops the fills Map (replaced by fills_root: Map<u32, Field>), the
_assert_not_filled / _assert_fill / get_fill artifacts, and the 32-iteration
fill recording loop in _apply_verified_clearing. flatten_clearing_public
shrinks 83 -> 19 fields. cancel_order's cancel-after-fill guard moves down
to the token-contract underflow per spec §6.5.

claim_fill rewrite + _assert_fill_root + get_fills_root land in the next
task; the build may not pass yet."
```

---

### Task 8: Orderbook contract — `claim_fill` + `_assert_fill_root` + `get_fills_root`

**Files:**
- Modify: `contracts/orderbook/src/main.nr`

- [ ] **Step 1: Add `std` import for poseidon2 if not already imported, and rewrite the `claim_fill` private function**

Replace the entire `claim_fill` function (lines ~498-532 — the function from "Claim the output of a filled order." through `self.enqueue_self._assert_fill(...)`) with:

```rust
    /// Claim the output of a filled order via Merkle inclusion proof.
    ///
    /// The maker recomputes the leaf `poseidon2([order_nonce, claimed_amount_out])`
    /// locally and walks the 5-level path through `siblings[0..5]` keyed by the bits
    /// of `leaf_index`. The resulting root is asserted equal to `fills_root[epoch_id]`
    /// by the enqueued `_assert_fill_root` callback. Double-claim protection: popping
    /// the OrderNote nullifies it (one-shot). Cancel-after-fill protection: see
    /// spec §6.5 (token-contract underflow).
    #[external("private")]
    fn claim_fill(
        order_nonce: Field,
        claimed_amount_out: u128,
        epoch_id: u32,
        siblings: [Field; 5],
        leaf_index: u32,
    ) {
        let maker = self.msg_sender();

        // 1. Retrieve + nullify the maker's filled OrderNote (cancel_order pattern;
        //    the nullifier is the double-claim guard).
        let options = NoteGetterOptions::new().select(
            OrderNote::properties().nonce,
            Comparator.EQ,
            order_nonce,
        ).set_limit(1);
        let notes = self.storage.orders.at(maker).pop_notes(options);
        assert(notes.len() == 1, "order not found");
        let order = notes.get(0);
        assert(order.owner == maker, "not order owner");

        // 2. Recompute the leaf locally (matches circuits/clearing/src/merkle.nr's fill_leaf).
        let leaf = poseidon2_hash([order_nonce, claimed_amount_out as Field]);

        // 3. Walk the depth-5 Merkle path. leaf_index's LSB picks current side at each level.
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
        // After 5 shifts, idx must be zero — guards against leaf_index >= 32.
        assert(idx == 0, "leaf_index out of bounds");

        // 4. Pay out: a buy (side=false) is owed token B; a sell (side=true) is owed token A.
        let token: AztecAddress = if order.side {
            self.storage.token_a_addr.read()
        } else {
            self.storage.token_b_addr.read()
        };
        self.call(Token::at(token).transfer_public_to_private(
            self.address,
            maker,
            claimed_amount_out,
            0,
        ));

        // 5. Atomically verify the computed root against the stored per-epoch root.
        self.enqueue_self._assert_fill_root(epoch_id, current);
    }

    /// Public callback for claim_fill — assert the locally-recomputed root matches
    /// the per-epoch root recorded in storage by _apply_verified_clearing. only_self.
    #[external("public")]
    #[only_self]
    fn _assert_fill_root(epoch_id: u32, computed_root: Field) {
        let stored = self.storage.fills_root.at(epoch_id).read();
        assert(stored != 0, "no clearing recorded for epoch");
        assert(computed_root == stored, "fill merkle root mismatch");
    }
```

- [ ] **Step 2: Add a `get_fills_root` utility (replaces `get_fill`)**

Inside the `// ============================ UNCONSTRAINED GETTERS ============================` block, after `get_clearing_vk_hash`, add:

```rust
    /// The per-epoch Merkle settlement root (0 == no clearing recorded for that epoch).
    /// A maker reads this to confirm an epoch has been cleared before constructing
    /// an inclusion proof for claim_fill.
    #[external("utility")]
    unconstrained fn get_fills_root(epoch_id: u32) -> Field {
        self.storage.fills_root.at(epoch_id).read()
    }
```

- [ ] **Step 3: Compile**

```bash
pnpm compile 2>&1 | tail -10
```

Expected: clean compile of the orderbook contract. `tests/integration/generated/Orderbook.ts` regenerated via `scripts/codegen.sh` (the `pretest` hook).

- [ ] **Step 4: Run noir tests to confirm nothing else regressed**

```bash
pnpm test:noir 2>&1 | tail -30
```

Expected: existing orderbook TXE tests in `contracts/orderbook/src/test.nr` either still PASS or reference now-deleted functions (we fix the latter in Task 9). Tests in `contracts/pool/`, `contracts/token/` PASS unchanged.

- [ ] **Step 5: Commit**

```bash
git add contracts/orderbook/src/main.nr
git commit -m "feat(orderbook): claim_fill — Merkle inclusion-proof verification

New signature: (order_nonce, claimed_amount_out, epoch_id, siblings[5],
leaf_index). Recomputes leaf locally, walks 5 levels, enqueues
_assert_fill_root which compares to storage.fills_root[epoch_id]. Replaces
the old _assert_fill (Map<Field, u128> lookup) callback. Adds
get_fills_root(epoch_id) utility (replaces get_fill(order_nonce)).
Double-claim still guarded by OrderNote nullification."
```

---

### Task 9: Orderbook TXE tests (T4–T9b)

**Files:**
- Modify: `contracts/orderbook/src/test.nr`

- [ ] **Step 1: Inspect `contracts/orderbook/src/test.nr` and remove tests that reference deleted functions**

The 5c/5d-3 tests that referenced `get_fill`, `fills` Map, `_assert_not_filled`, or `_assert_fill` no longer compile. Read the file and identify those tests — for each, either delete it (if it tested the deleted code path) or update it (if it tested incidental behavior). Use grep to locate them:

```bash
grep -n "get_fill\|_assert_not_filled\|_assert_fill\b\|\.fills\.at" contracts/orderbook/src/test.nr
```

Delete each test referenced by these matches that exists as a `#[test]` function. Leave intact: tests for `submit_order`, `cancel_order` (still works — the `_assert_not_filled` enqueue is gone, but the test scaffolding does not assert against it), `close_epoch`, and the OrderNote serialization tests.

- [ ] **Step 2: Append the T4–T9b suite at the end of `contracts/orderbook/src/test.nr`**

Append this block to `contracts/orderbook/src/test.nr`:

```rust
// ============================================================================
// Week 5d-4: claim_fill Merkle inclusion-proof tests (sec 10.2 T4-T9b).
//
// TXE limitations: std::verify_proof_with_type is a no-op in TXE (per
// memory/reference_aztec_txe_recursive_verify.md), so these tests do NOT call
// close_epoch_and_clear_verified — they instead seed fills_root[epoch_id]
// directly by invoking _apply_verified_clearing as the contract self-caller.
// ============================================================================

use crate::Orderbook::{ClearingPublic, FillEntry};
use poseidon::poseidon2::Poseidon2;

// Empty-leaf sentinel: poseidon2_hash([0, 0]). Computed inline to avoid an
// orchestration dep on the standalone circuit's merkle.nr in TXE context.
unconstrained fn empty_leaf() -> Field {
    Poseidon2::hash([0 as Field, 0 as Field], 2)
}

// Hash one populated leaf.
unconstrained fn populated_leaf(order_nonce: Field, amount_out: u128) -> Field {
    Poseidon2::hash([order_nonce, amount_out as Field], 2)
}

// Compute the root of a 32-leaf depth-5 tree. JS-side merkle.ts mirrors.
unconstrained fn root_32(leaves: [Field; 32]) -> Field {
    let mut level: [Field; 32] = leaves;
    let mut width: u32 = 32;
    for _round in 0..5 {
        let half = width / 2;
        let mut next: [Field; 32] = [0; 32];
        for i in 0..16 {
            if (i as u32) < half {
                next[i] = Poseidon2::hash([level[2 * i], level[2 * i + 1]], 2);
            }
        }
        level = next;
        width = half;
    }
    level[0]
}

// Build a single-populated-fill tree with the fill at slot 0; return root + siblings.
unconstrained fn build_single_fill_tree(order_nonce: Field, amount_out: u128) -> (Field, [Field; 5]) {
    let empty = empty_leaf();
    let mut leaves: [Field; 32] = [empty; 32];
    leaves[0] = populated_leaf(order_nonce, amount_out);
    let root = root_32(leaves);

    // siblings[0] = leaves[1] = empty leaf
    // siblings[1] = poseidon2(leaves[2], leaves[3]) = poseidon2(empty, empty)
    // siblings[2..5] = empty subtree roots at depths 2..5
    let mut siblings: [Field; 5] = [0; 5];
    siblings[0] = empty;
    let mut empty_sub = Poseidon2::hash([empty, empty], 2);
    siblings[1] = empty_sub;
    for level in 2..5 {
        empty_sub = Poseidon2::hash([empty_sub, empty_sub], 2);
        siblings[level] = empty_sub;
    }
    (root, siblings)
}

// Helper: seed fills_root[epoch_id] by direct `_apply_verified_clearing` invocation.
// `current_epoch` must already be advanced past closes_at_block and have matching
// order_acc/cancel_acc/order_count/cancel_count for the freshness asserts to pass.
unconstrained fn seed_fills_root(
    env: &mut TestEnvironment,
    contract_addr: AztecAddress,
    caller: AztecAddress,
    public_inputs: ClearingPublic,
) {
    // (Implementation note: invoke via the contract's _apply_verified_clearing as the
    // self-caller. TestEnvironment exposes a method to bypass only_self by setting
    // msg_sender = contract_addr. Reuse the same pattern as the W5c close_epoch tests.)
    env.call_public_as(contract_addr, Orderbook::interface()._apply_verified_clearing(public_inputs));
}

// Common fixture: deploy + submit one order + close_epoch + seed a known fills_root.
// Returns (deployer, maker, contract_addr, order_nonce, amount_out, epoch_id, siblings).
// The maker has a valid OrderNote ready for claim_fill at the returned values.
unconstrained fn claim_fill_fixture()
    -> (AztecAddress, AztecAddress, AztecAddress, Field, u128, u32, [Field; 5])
{
    // [See contracts/orderbook/src/test.nr's existing close_epoch fixtures for
    //  the deploy + submit + close_epoch helper sequence used here. Substitute
    //  the W5c get_fill-based wait-for-fill assertion with a direct seed.]

    // PLACEHOLDER: this block is built up from the existing test fixtures in
    // test.nr — the same `deploy_orderbook` helper at line 83, `submit_order`
    // pattern from earlier tests, and the time-advance pattern from close_epoch
    // tests. The new tail seeds fills_root[0] by constructing a public_inputs
    // with order_acc/cancel_acc matching the post-submit epoch state and a
    // build_single_fill_tree-derived fills_root.
    //
    // The implementer expands this fixture using the patterns already in test.nr.
    // Concretely:
    //   1. let mut env = TestEnvironment::new();
    //   2. deploy_orderbook with a non-zero clearing_vk_hash sentinel.
    //   3. maker = env.create_light_account(); env.fund_with_token(maker, ...);
    //   4. Call submit_order(side, amount_in, limit_price, nonce=0x1, order_nonce=0xA).
    //   5. Capture the post-submit (order_acc, order_count) from get_epoch().
    //   6. Advance env.advance_blocks(epoch_length).
    //   7. Build (root, siblings) = build_single_fill_tree(0xA, amount_out=999).
    //   8. Construct public_inputs with that root and matching binding fields.
    //   9. seed_fills_root(...) — the contract advances epoch_id 0 -> 1.
    //  10. Return (deployer, maker, contract_addr, 0xA, 999, 0 /* the epoch with the fill */, siblings).
    panic("fixture body — implementer expands using deploy_orderbook + submit_order + advance_blocks + seed_fills_root, modeled on the W5c close_epoch fixtures")
}

#[test]
unconstrained fn t4_claim_fill_happy_path() {
    let (_, maker, contract, order_nonce, amount_out, epoch_id, siblings) = claim_fill_fixture();
    Orderbook::interface().claim_fill(order_nonce, amount_out, epoch_id, siblings, 0)
        .call_as(maker);
    // No assertion needed - a successful call confirms the path verified.
}

#[test(should_fail_with = "fill merkle root mismatch")]
unconstrained fn t5_wrong_sibling_reverts() {
    let (_, maker, contract, order_nonce, amount_out, epoch_id, mut siblings) = claim_fill_fixture();
    siblings[2] = siblings[2] + 1;  // tamper one sibling
    Orderbook::interface().claim_fill(order_nonce, amount_out, epoch_id, siblings, 0)
        .call_as(maker);
}

#[test(should_fail_with = "fill merkle root mismatch")]
unconstrained fn t6_wrong_amount_reverts() {
    let (_, maker, contract, order_nonce, amount_out, epoch_id, siblings) = claim_fill_fixture();
    Orderbook::interface().claim_fill(order_nonce, amount_out + 1 as u128, epoch_id, siblings, 0)
        .call_as(maker);
}

#[test(should_fail_with = "no clearing recorded for epoch")]
unconstrained fn t7_wrong_epoch_reverts() {
    let (_, maker, contract, order_nonce, amount_out, _epoch_id, siblings) = claim_fill_fixture();
    Orderbook::interface().claim_fill(order_nonce, amount_out, 99 as u32, siblings, 0)
        .call_as(maker);
}

#[test(should_fail_with = "order not found")]
unconstrained fn t8_replay_reverts_at_note_pop() {
    let (_, maker, contract, order_nonce, amount_out, epoch_id, siblings) = claim_fill_fixture();
    // First claim succeeds (nullifies the OrderNote).
    Orderbook::interface().claim_fill(order_nonce, amount_out, epoch_id, siblings, 0)
        .call_as(maker);
    // Second claim must fail at pop_notes — the nullifier is now committed.
    Orderbook::interface().claim_fill(order_nonce, amount_out, epoch_id, siblings, 0)
        .call_as(maker);
}

#[test(should_fail_with = "leaf_index out of bounds")]
unconstrained fn t9_oob_leaf_index_reverts() {
    let (_, maker, contract, order_nonce, amount_out, epoch_id, siblings) = claim_fill_fixture();
    Orderbook::interface().claim_fill(order_nonce, amount_out, epoch_id, siblings, 32 as u32)
        .call_as(maker);
}

// T9b: cancel-after-fill drain protection lives at the token-contract layer.
// In TXE we assert the orderbook's public balance state is consistent — a real
// cancel_order attempt after a clearing would underflow the token's
// transfer_public_to_private (orderbook balance was moved to the pool by
// apply_clearing). The atomic transaction semantics then revert. This test
// uses the same fixture but does NOT call claim_fill; instead it calls
// cancel_order and expects the token-level revert.
#[test(should_fail_with = "balance underflow")]
unconstrained fn t9b_cancel_after_fill_token_underflow() {
    let (_, maker, _contract, order_nonce, _amount_out, _epoch_id, _siblings) = claim_fill_fixture();
    // The maker tries to cancel even though their order was filled in the seeded clearing.
    // The orderbook's public token balance was moved to the pool by apply_clearing,
    // so transfer_public_to_private underflows; atomicity reverts the whole tx.
    Orderbook::interface().cancel_order(order_nonce, 0 as Field).call_as(maker);
}
```

The `claim_fill_fixture` body intentionally `panic`s with a hand-off message — the implementer fills in the body using the deploy_orderbook + submit_order + advance_blocks patterns already in `contracts/orderbook/src/test.nr` (the helpers around the existing close_epoch tests). Subagents executing this task should expand the fixture by mirroring those helpers; do not invent new test infrastructure.

- [ ] **Step 3: Run noir tests**

```bash
pnpm test:noir 2>&1 | tail -40
```

Expected: T4 (happy path) PASSES, T5–T9b PASS (each fails with the documented `should_fail_with` message). If T9b fails with a non-matching message (token contract phrasing differs), update the `should_fail_with` to match the actual revert. The other tests' revert messages match the strings in `claim_fill` / `_assert_fill_root`.

- [ ] **Step 4: Commit**

```bash
git add contracts/orderbook/src/test.nr
git commit -m "test(orderbook): T4-T9b claim_fill Merkle inclusion-proof TXE suite

T4: happy path (correct path verifies). T5: wrong sibling reverts. T6:
wrong amount reverts (leaf hash mismatches). T7: wrong epoch reverts (no
clearing recorded). T8: replay reverts at note pop. T9: leaf_index >= 32
reverts. T9b: cancel-after-fill blocked by token-level balance underflow
(spec §6.5 protection)."
```

---

### Task 10: CLI `zswap claim` rewrite

**Files:**
- Modify: `cli/src/commands/claim.ts`

- [ ] **Step 1: Replace `cli/src/commands/claim.ts` with the snapshot-based flow**

Replace the file contents with:

```ts
import type { Command } from "commander";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { Fr } from "@aztec/aztec.js/fields";
import { OrderbookContract } from "../../../tests/integration/generated/Orderbook.js";
import { loadConfig } from "../config.js";
import { openCli } from "../wallet.js";
import { parseField } from "../field.js";
import { readSnapshot, findEpochForNonce } from "../../../aggregator/src/snapshot.js";

const DEFAULT_SNAPSHOT_DIR = process.env.ZSWAP_SNAPSHOT_DIR ?? "aggregator/snapshots";

export function registerClaim(program: Command): void {
  program
    .command("claim")
    .description("claim the output of a filled order via Merkle inclusion proof")
    .requiredOption("--nonce <field>", "order-identity nonce of the filled order")
    .option("--epoch <num>", "epoch_id the order was filled in (auto-discovered if omitted)")
    .option(
      "--snapshots <dir>",
      "directory containing aggregator/snapshots/epoch-<N>.json (default: aggregator/snapshots; override via $ZSWAP_SNAPSHOT_DIR)",
      DEFAULT_SNAPSHOT_DIR,
    )
    .action(async (_opts, cmd: Command) => {
      const opts = cmd.optsWithGlobals();
      const orderNonce = parseField(String(opts.nonce));
      const snapshotsDir: string = opts.snapshots as string;

      // Resolve the epoch the maker's nonce was filled in.
      const nonceHex = orderNonce.toString();
      const epochId: number | null = opts.epoch !== undefined
        ? Number(opts.epoch)
        : findEpochForNonce(snapshotsDir, nonceHex);
      if (epochId === null) {
        throw new Error(
          `could not locate a snapshot file containing nonce ${nonceHex} under ${snapshotsDir}. ` +
          `Pass --epoch <N> explicitly, or check the aggregator wrote a snapshot for that epoch.`,
        );
      }

      const snap = readSnapshot(snapshotsDir, epochId);
      const path = snap.paths.get(nonceHex);
      if (!path) {
        throw new Error(`snapshot epoch-${epochId}.json does not contain a path for nonce ${nonceHex}`);
      }

      const leafJson = snap.leaves.find((l) => l.order_nonce === nonceHex);
      if (!leafJson || leafJson.amount_out === "0") {
        throw new Error(
          `order ${nonceHex} appears in epoch-${epochId}.json but with amount_out = 0 (not filled). ` +
          `Use cancel_order during the next OPEN epoch instead.`,
        );
      }
      const amountOut = BigInt(leafJson.amount_out);

      const config = loadConfig(opts.config);
      const ctx = await openCli(config, Number(opts.account));
      try {
        const orderbook = await OrderbookContract.at(
          AztecAddress.fromString(config.orderbook),
          ctx.wallet,
        );

        // The generated bindings may be stale relative to the new claim_fill signature
        // until pnpm codegen runs. Cast through `any` (same pattern as close-epoch.ts).
        const orderbookDyn = orderbook as unknown as {
          methods: {
            claim_fill: (
              orderNonce: Fr,
              claimedAmountOut: bigint,
              epochId: number,
              siblings: Fr[],
              leafIndex: number,
            ) => { send: (args: { from: AztecAddress }) => Promise<unknown> };
          };
        };

        await orderbookDyn.methods
          .claim_fill(orderNonce, amountOut, epochId, path.siblings, path.leaf_index)
          .send({ from: ctx.account });

        console.log(
          `claimed ${amountOut} output tokens for order ${nonceHex} (epoch ${epochId}, leaf_index ${path.leaf_index})`,
        );
      } finally {
        await ctx.stop();
      }
    });
}
```

- [ ] **Step 2: Run the CLI typecheck**

```bash
pnpm --filter @zswap/cli typecheck 2>&1 | tail -10
```

Expected: clean typecheck. If `parseField` returns something other than `Fr`, the `orderNonce.toString()` and `snap.paths.get(nonceHex)` line may need a minor adjustment — inspect `cli/src/field.ts` if so.

- [ ] **Step 3: Commit**

```bash
git add cli/src/commands/claim.ts
git commit -m "feat(cli/claim): snapshot-based inclusion-proof claim

Reads aggregator/snapshots/epoch-<N>.json to load amount_out + siblings +
leaf_index. --epoch is auto-discovered via findEpochForNonce; --snapshots
defaults to aggregator/snapshots/ and is overridable via \$ZSWAP_SNAPSHOT_DIR.
Replaces the W5c get_fill RPC + flat-amount call with the new 5d-4 signature
(order_nonce, claimed_amount_out, epoch_id, siblings[5], leaf_index)."
```

---

### Task 11: Update existing integration test (clearing.test.ts) for the new shape

**Files:**
- Modify: `tests/integration/clearing.test.ts`

- [ ] **Step 1: Update `buildPublicInputsStruct` to emit the new shape**

In `tests/integration/clearing.test.ts`, locate `buildPublicInputsStruct` (around line 671). Replace the entire function body with one that computes the Merkle root inline and returns the new struct shape. The function signature stays similar but it becomes async because Merkle uses async poseidon2Hash:

Replace lines 671-731 (the entire function) with:

```ts
async function buildPublicInputsStruct(
  epoch: { order_acc: bigint; cancel_acc: bigint; order_count: bigint | number; cancel_count: bigint | number },
  pool: { reserve_a: bigint; reserve_b: bigint; lp_supply: bigint },
  clearing: {
    clearingPrice: bigint;
    fills: { orderNonce: bigint; amountOut: bigint }[];
    newReserveA: bigint;
    newReserveB: bigint;
    feeAPerShareIncrement: bigint;
    feeBPerShareIncrement: bigint;
  },
  _ordersForWitness: OrderNotePreimage[],
) {
  // Week 5d-4: fills_root replaces the old fills[] + fills_len pub inputs.
  const { buildFillsTree } = await import("../../aggregator/src/merkle.js");
  const tree = await buildFillsTree(
    clearing.fills.map((f) => ({ order_nonce: new Fr(f.orderNonce), amount_out: f.amountOut })),
  );

  const deltaA = clearing.newReserveA - pool.reserve_a;
  const deltaB = clearing.newReserveB - pool.reserve_b;
  const swap = {
    a_to_pool: 0n,
    b_to_pool: 0n,
    a_from_pool: 0n,
    b_from_pool: 0n,
    reserve_a_add: deltaA > 0n ? deltaA : 0n,
    reserve_a_sub: deltaA < 0n ? -deltaA : 0n,
    reserve_b_add: deltaB > 0n ? deltaB : 0n,
    reserve_b_sub: deltaB < 0n ? -deltaB : 0n,
    fee_a_per_share_increment: clearing.feeAPerShareIncrement,
    fee_b_per_share_increment: clearing.feeBPerShareIncrement,
  };

  return {
    order_acc: epoch.order_acc,
    cancel_acc: epoch.cancel_acc,
    order_count: Number(epoch.order_count),
    cancel_count: Number(epoch.cancel_count),
    reserve_a: pool.reserve_a,
    reserve_b: pool.reserve_b,
    lp_supply: pool.lp_supply,
    clearing_price: clearing.clearingPrice,
    fills_root: tree.root.toBigInt(),
    swap,
  };
}
```

- [ ] **Step 2: Update every call site of `buildPublicInputsStruct` AND `buildClearingWitness` to `await` them**

Both functions became async in this slice (`buildClearingWitness` async in Task 6; `buildPublicInputsStruct` async in Step 1 above).

```bash
grep -n "buildPublicInputsStruct\|buildClearingWitness" tests/integration/clearing.test.ts
```

For each match that is a call expression (not the import line), prefix with `await`. The known call site at `tests/integration/clearing.test.ts:394` is currently `const { proverToml } = buildClearingWitness({...})`; rewrite as `const { proverToml } = await buildClearingWitness({...})`. The function containing this call must itself be `async` — it already is (the surrounding `it(...)` body is async).

- [ ] **Step 3: Run the integration test against the live dev stack**

```bash
# Ensure scripts/dev.sh is running in another terminal first.
pnpm test --filter='./tests/**' 2>&1 | tail -30
```

Expected: E1 still PASSES end-to-end (deploy → submit → bb prove with new circuit → contract verifies → state advances). E2 + E3 stay `it.skip` (TXE doesn't run recursive verify).

If E1 fails with a "fills_root mismatch with internal fills" message from the circuit, double-check that the JS Merkle and the Noir Merkle produce identical roots — Task 4's parity tests should have caught divergence, but the integration is the final word.

- [ ] **Step 4: Commit**

```bash
git add tests/integration/clearing.test.ts
git commit -m "test(clearing): update E1 buildPublicInputsStruct for 5d-4 shape

ClearingPublic now carries fills_root: Field (a 1-slot Merkle root over
the 32-leaf fills tree) instead of fills[]: [FillEntry; 32] + fills_len: u32.
Imports buildFillsTree from aggregator/src/merkle.ts to compute the root.
E2 + E3 remain it.skip per TXE recursive-verify limitations."
```

---

### Task 12: Full e2e claim test (claim-merkle.test.ts)

**Files:**
- Create: `tests/integration/claim-merkle.test.ts`

- [ ] **Step 1: Write the new e2e test**

Create `tests/integration/claim-merkle.test.ts`. Model the structure on the existing `tests/integration/clearing.test.ts` E1 test (its 700+-line deploy + submit + prove + verify scaffold is the template). Goal: alice and bob both submit; admin closes via verified clearing; alice and bob each claim via inclusion proof; assert each receives the expected output token amount privately.

Because the full scaffold is long, the file mirrors clearing.test.ts E1 structure precisely. Sketch:

```ts
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Fr } from "@aztec/aztec.js/fields";

import { connectToSandbox } from "./helpers/sandbox.js";
import { getTestWallets } from "./helpers/wallets.js";
import { OrderbookContract } from "./generated/Orderbook.js";
import { LiquidityPoolContract } from "./generated/LiquidityPool.js";
import { TokenContract } from "./generated/Token.js";
import { buildFillsTree } from "../../aggregator/src/merkle.js";
import { writeSnapshot, readSnapshot } from "../../aggregator/src/snapshot.js";
import { computeClearing } from "../../aggregator/src/clearing.js";
import { buildClearingWitness, type OrderNotePreimage } from "../../aggregator/src/witness.js";

// (constants block — copy SIDE_*, PRICE_2, etc. from clearing.test.ts top.)

describe("Week 5d-4 e2e — claim_fill with Merkle inclusion proof", () => {
  let env: Awaited<ReturnType<typeof connectToSandbox>>;
  let snapshotsDir: string;

  before(async () => {
    env = await connectToSandbox();
    snapshotsDir = mkdtempSync(join(tmpdir(), "zswap-snap-"));
  });

  after(async () => {
    await env.cleanup();
    rmSync(snapshotsDir, { recursive: true, force: true });
  });

  it("alice + bob both submit, admin closes verified, both claim via inclusion proof", async () => {
    // -- DEPLOY block (mirror clearing.test.ts E1):
    //   1. deploy tUSDC + tETH.
    //   2. deploy LiquidityPool + deposit reserves.
    //   3. deploy Orderbook with the production clearing_vk_hash from
    //      circuits/clearing/target/vk.bin/vk_hash.
    //   4. pool.set_orderbook(orderbook.address).
    //   5. mint to alice + bob.

    // -- SUBMIT block (mirror clearing.test.ts E1):
    //   alice submits SIDE_A_TO_B (buy), amount_in = X, limit = PRICE_2, nonce = 0x1, order_nonce = aliceNonce.
    //   bob submits SIDE_B_TO_A (sell), amount_in matched to net out, limit = PRICE_2, nonce = 0x2, order_nonce = bobNonce.

    // -- CLEARING block (mirror clearing.test.ts E1):
    //   1. read epoch + pool snapshot + order notes.
    //   2. computeClearing → ClearingResult with 2 fills.
    //   3. buildClearingWitness → proverToml + fillsRoot + leaves.
    //   4. write Prover.toml; nargo execute; bb prove.

    // -- SNAPSHOT (new):
    //   build the tree, write to snapshotsDir/epoch-0.json (the epoch alice+bob submitted in).
    const tree = await buildFillsTree([
      { order_nonce: new Fr(aliceNonce), amount_out: aliceExpectedOut },
      { order_nonce: new Fr(bobNonce),   amount_out: bobExpectedOut },
    ]);
    writeSnapshot(snapshotsDir, {
      epoch_id: 0,
      fills: [
        { order_nonce: new Fr(aliceNonce), amount_out: aliceExpectedOut },
        { order_nonce: new Fr(bobNonce),   amount_out: bobExpectedOut },
      ],
      tree,
    });

    // -- CLOSE verified (mirror clearing.test.ts E1):
    //   buildPublicInputsStruct + readProofAsFields + readVkAsFields →
    //   orderbook.close_epoch_and_clear_verified(...). After this call,
    //   on-chain fills_root[0] == tree.root.

    // -- CLAIM (new):
    //   For each maker:
    //     const snap = readSnapshot(snapshotsDir, 0);
    //     const path = snap.paths.get(new Fr(<maker>Nonce).toString())!;
    //     orderbook.claim_fill(<maker>Nonce, <maker>ExpectedOut, 0, path.siblings, path.leaf_index)
    //       .send({ from: makerAddress });
    //   Assert each maker's PRIVATE balance increased by the expected output amount
    //   (token B for alice, token A for bob).
    //
    //   Use the same per-maker private balance read pattern as clearing.test.ts E1.
  });
});
```

The implementer expands the comment blocks using the exact code patterns from `tests/integration/clearing.test.ts`'s E1 body — deploy helpers, submit helpers, prove helpers, etc. — substituting only the post-clearing claim step. Do not invent new helpers; reuse what E1 already does.

- [ ] **Step 2: Run the new test**

```bash
# scripts/dev.sh must be running.
pnpm test --filter='./tests/**' -- --test-name-pattern='Week 5d-4 e2e' 2>&1 | tail -30
```

Expected: the new test PASSES. Alice and bob each receive their expected output tokens in private balance. Total wallclock ≈ 45-60s (one bb prove call dominates).

- [ ] **Step 3: Commit**

```bash
git add tests/integration/claim-merkle.test.ts
git commit -m "test(e2e): claim_fill Merkle inclusion-proof full integration

alice + bob submit; aggregator runs computeClearing + buildFillsTree;
admin invokes close_epoch_and_clear_verified with the new 19-field
ClearingPublic shape; each maker then constructs an inclusion proof from
the per-epoch snapshot and claims via the new claim_fill signature.
Private balances assert the expected payouts."
```

---

### Task 13: `.gitignore` + housekeeping

**Files:**
- Modify: `.gitignore`

- [ ] **Step 1: Add `aggregator/snapshots/` to `.gitignore`**

Append to `.gitignore`:

```
# Week 5d-4: per-epoch fills snapshots (runtime state, regenerated by the aggregator)
aggregator/snapshots/
```

- [ ] **Step 2: Verify nothing under `aggregator/snapshots/` is currently tracked**

```bash
git ls-files aggregator/snapshots 2>&1
```

Expected: empty output. If anything IS tracked there (e.g., from a test that forgot to clean up), `git rm -r --cached aggregator/snapshots/` it before committing.

- [ ] **Step 3: Commit**

```bash
git add .gitignore
git commit -m "chore: gitignore aggregator/snapshots/ — runtime state"
```

---

## Post-implementation

After Task 13 commits:

1. Confirm the full pipeline runs green:
   ```bash
   pnpm compile && pnpm test:noir && pnpm --filter @zswap/aggregator test && pnpm --filter @zswap/cli typecheck
   ```
2. With `scripts/dev.sh` running, also confirm:
   ```bash
   pnpm test
   ```
3. Update `README.md`'s status line to reflect 5d-4 complete + sub-project 1 complete (out of scope for this plan; do as a follow-up commit).
4. (Deferred — separate session) Re-run `scripts/deploy-and-run-testnet.ts` with the new circuit + `epoch_length=30` to complete the 5d-3 testnet validation gap. Per `memory/project_5d3_testnet_validation.md` the runner is idempotent via `/tmp/testnet-zswap.config.json`.
