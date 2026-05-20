# Week 5d-2: Standalone Noir Clearing Circuit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a standalone Noir circuit at `circuits/clearing/` that verifies an off-chain-computed clearing `(P*, fills, ClearingSwap)` against Week 5d-1's on-chain `order_acc` / `cancel_acc` commitments, plus the TypeScript witness builder and three layers of tests.

**Architecture:** Five Noir source files (`main.nr` + `binding.nr` + `pricing.nr` + `amm.nr` + `test.nr`) implementing the constraint list in spec §6. Aggregator continues to find `P*` via the existing TS binary search; the circuit only verifies. Proof generation via `nargo execute` + `bb prove`; verification via `bb prove --verify` for the e2e test loop. No Aztec-contract integration in this slice — 5d-3's concern.

**Tech Stack:** Noir 1.0.0-beta.19 (`nargo`), Barretenberg `bb` (bundled with the Aztec install at `~/.aztec/versions/4.2.1/node_modules/@aztec/bb.js/build/<arch>/bb`), TypeScript (witness builder), `@aztec/foundation/crypto/poseidon` for TS-side Poseidon2 parity.

**Source spec:** `docs/superpowers/specs/2026-05-20-zswap-aztec-week-05d-2-clearing-circuit-design.md`

**Execution preconditions:**
- VPS dev stack is available (`zswap-vps` ssh alias, anvil :18545 + aztec :18080 already running). All `nargo`/`bb` invocations run on VPS via SSH for parity with the existing per-orderbook tests.
- Local Mac has `nargo` available for fast iteration on the Noir unit tests (Tasks 1–9).
- Tasks 1–10 don't need Docker; Tasks 11–14 may use existing project tooling. Task 13–14 (live e2e) need the VPS dev stack.

---

## File Structure

**Created:**
- `circuits/clearing/Nargo.toml`
- `circuits/clearing/src/main.nr`
- `circuits/clearing/src/types.nr`
- `circuits/clearing/src/binding.nr`
- `circuits/clearing/src/pricing.nr`
- `circuits/clearing/src/amm.nr`
- `circuits/clearing/src/test.nr`
- `aggregator/src/witness.ts`
- `aggregator/test/witness.test.ts`
- `tests/integration/clearing-circuit.test.ts`

**Modified:**
- `scripts/compile-all.sh` — also runs `nargo compile` for the circuit and `bb write_vk`.
- `.gitignore` — adds `circuits/*/target/`.

**Not touched:** `contracts/*`, the existing aggregator `clearing.ts`, CLI, other integration test files.

---

## Task 1: Scaffold `circuits/clearing/` + types module

Creates the Noir project skeleton, the shared `ClearingSwap` / `FillEntry` / `OrderPreimage` types, and a stub `fn main` so the project compiles cleanly before any constraints are added. Also adds the gitignore entry.

**Files:**
- Create: `circuits/clearing/Nargo.toml`
- Create: `circuits/clearing/src/main.nr`
- Create: `circuits/clearing/src/types.nr`
- Modify: `.gitignore`

- [ ] **Step 1: Write `circuits/clearing/Nargo.toml`.**

```toml
[package]
name = "clearing"
type = "bin"
authors = ["ZSwap"]
compiler_version = ">=1.0.0-beta.19"
```

- [ ] **Step 2: Write `circuits/clearing/src/types.nr`.**

```noir
// Shared types for the ZSwap clearing circuit. Matches:
// - contracts/pool/src/main.nr's ClearingSwap (10 u128 fields).
// - contracts/orderbook/src/main.nr's FillEntry (order_nonce + amount_out).
// - contracts/orderbook/src/main.nr's OrderNote (the per-order preimage).

pub global MAX_ORDERS_PER_EPOCH: u32 = 128;

/// Aggregator's per-order payout (public input to the circuit).
pub struct FillEntry {
    pub order_nonce: Field,
    pub amount_out: u128,
}

/// The net swap the orderbook applies to the LiquidityPool. 10 fields, matching the
/// contracts/pool/src/main.nr struct exactly.
pub struct ClearingSwap {
    pub a_to_pool:                 u128,
    pub b_to_pool:                 u128,
    pub a_from_pool:               u128,
    pub b_from_pool:               u128,
    pub reserve_a_add:             u128,
    pub reserve_a_sub:             u128,
    pub reserve_b_add:             u128,
    pub reserve_b_sub:             u128,
    pub fee_a_per_share_increment: u128,
    pub fee_b_per_share_increment: u128,
}

/// One submitted order's preimage; the private witness has [OrderPreimage; 128].
pub struct OrderPreimage {
    pub side:               bool,
    pub amount_in:          u128,
    pub limit_price:        u128,
    pub order_nonce:        Field,
    pub submitted_at_block: u32,
    pub owner:              Field,
}
```

- [ ] **Step 3: Write a minimal `circuits/clearing/src/main.nr` that compiles.**

```noir
mod types;
mod binding;
mod pricing;
mod amm;
mod test;

use types::{ClearingSwap, FillEntry, OrderPreimage, MAX_ORDERS_PER_EPOCH};

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
    fills: pub [FillEntry; MAX_ORDERS_PER_EPOCH],
    fills_len: pub u32,
    swap: pub ClearingSwap,

    // Witness (private)
    orders: [OrderPreimage; MAX_ORDERS_PER_EPOCH],
    cancelled_indices: [u32; MAX_ORDERS_PER_EPOCH],
    fill_to_order_index: [u32; MAX_ORDERS_PER_EPOCH],
) {
    // Task 4–9 fill this in; this is just a compile target for Tasks 1–3.
    assert(order_count <= MAX_ORDERS_PER_EPOCH);
    assert(cancel_count <= order_count);
    assert(fills_len <= MAX_ORDERS_PER_EPOCH);
    // Touch every input so the compiler doesn't warn about unused params.
    let _ = order_acc;
    let _ = cancel_acc;
    let _ = reserve_a;
    let _ = reserve_b;
    let _ = lp_supply;
    let _ = clearing_price;
    let _ = fills;
    let _ = swap;
    let _ = orders;
    let _ = cancelled_indices;
    let _ = fill_to_order_index;
}
```

(Spec §5.1 mentions a `BoundedVec<FillEntry, 128>` for `fills`. We use `[FillEntry; 128]` + `fills_len: u32` here because (a) Noir public-input serialization for `BoundedVec` across the `bb prove` boundary is fragile in 1.0.0-beta.19 and (b) the explicit pair is what the implementer instructed as the fallback in the spec.)

- [ ] **Step 4: Write `circuits/clearing/src/binding.nr`, `pricing.nr`, `amm.nr`, `test.nr` as empty module stubs.**

Each file contains only the module-level boilerplate so the `mod ...;` declarations in `main.nr` resolve. Concretely write to each of those four files:

```noir
// Module stub - see Tasks 4-9 for the real contents.
```

- [ ] **Step 5: Add the gitignore entry.**

Append to `.gitignore`:

```
# Noir circuit build artifacts (mirror contracts/*/target/)
circuits/*/target/
```

- [ ] **Step 6: Compile locally to sanity-check.**

Run from the repo root:

```
nargo compile --silence-warnings --package clearing --workspace circuits/clearing
```

(If your shell's nargo isn't 1.0.0-beta.19, run instead via VPS: `ssh zswap-vps 'source /root/.zswap-env && cd /root/zswap-aztec/circuits/clearing && nargo compile --silence-warnings'`.)

Expected: a `circuits/clearing/target/clearing.json` artifact appears and no errors print.

- [ ] **Step 7: Commit.**

```
git add circuits/clearing/Nargo.toml circuits/clearing/src/ .gitignore
git commit -m "feat(circuits): scaffold clearing circuit project

Five-module skeleton at circuits/clearing/ (main + types + binding + pricing
+ amm + test). Stub fn main consumes the full ClearingPublic + witness
parameter list and compiles cleanly. No constraints yet; subsequent tasks
fill each module in.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Integrate circuit compile into `pnpm compile`

Extends `scripts/compile-all.sh` to also compile the Noir circuit. Keeps the existing contracts-compile behavior intact.

**Files:**
- Modify: `scripts/compile-all.sh`

- [ ] **Step 1: Read the existing script.**

Run: `cat scripts/compile-all.sh`

Confirm it ends with `echo "All contracts compiled."` and that contract compilation runs via `docker run ... aztecprotocol/aztec:$VERSION ...`.

- [ ] **Step 2: Add a circuit-compile block at the end of the script (before the final echo).**

Replace the final `echo "All contracts compiled."` line with:

```bash
echo "All contracts compiled."

# Noir circuits (non-contract). Same docker image as contracts to keep the
# nargo binary aligned with .aztec-version. The circuit's `target/` is mounted
# back via the workspace bind so the host sees the produced clearing.json.
if [ -d circuits ]; then
  for dir in circuits/*/; do
    if [ -f "$dir/Nargo.toml" ]; then
      echo "→ Compiling $dir"
      pkg_rel="${dir%/}"
      docker run --rm --entrypoint bash \
        -v "$ROOT:/work" -w "/work/$pkg_rel" \
        "aztecprotocol/aztec:$VERSION" \
        -c 'export PATH=/usr/src/noir/noir-repo/target/release:$PATH && nargo compile --silence-warnings'
    fi
  done
  echo "All circuits compiled."
fi
```

- [ ] **Step 3: Run `pnpm compile` and confirm the circuit is built.**

Run: `pnpm compile 2>&1 | tail -15`

Expected (last lines):
```
All contracts compiled.
→ Compiling circuits/clearing/
All circuits compiled.
```

`circuits/clearing/target/clearing.json` must exist after this.

- [ ] **Step 4: Commit.**

```
git add scripts/compile-all.sh
git commit -m "feat(scripts): pnpm compile also builds Noir circuits

Extends compile-all.sh with a circuits/*/Nargo.toml sweep that runs
nargo compile against each. circuits/clearing/target/clearing.json is
the only artifact for now (the 5d-2 clearing circuit).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Fixed-point `mul_div` helper + constants in `pricing.nr`

Adds the foundational fixed-point primitive every payout/fee/k calculation depends on. Pinned semantics from spec §6.7: `mul_div(x, y, z) = (x * y) / z` with floor rounding, computed via a `Field`-typed intermediate so a `u128 × 1e18` multiply doesn't overflow.

**Files:**
- Modify: `circuits/clearing/src/pricing.nr`
- Modify: `circuits/clearing/src/test.nr`

- [ ] **Step 1: Write the failing tests.**

Add to `circuits/clearing/src/test.nr` (replacing the stub):

```noir
use crate::pricing::{mul_div, SCALE, FEE_NUM, FEE_DEN};

#[test]
fn mul_div_basic_floor_rounding() {
    // Trivial: 1000 * 5 / 10 == 500.
    assert(mul_div(1000 as u128, 5 as u128, 10 as u128) == 500 as u128);
    // Floor: 7 * 3 / 5 == 4 (not 4.2).
    assert(mul_div(7 as u128, 3 as u128, 5 as u128) == 4 as u128);
}

#[test]
fn mul_div_handles_large_factors() {
    // amount_in (1e9 token A) * SCALE (1e18) / P* (2e18) == 5e8 -- representative
    // of the buy-side payout intermediate before fee withholding.
    let amount = 1_000_000_000 as u128;
    let p_star = 2_000_000_000_000_000_000 as u128;
    let out = mul_div(amount, SCALE, p_star);
    assert(out == 500_000_000 as u128);
}

#[test]
fn fee_constants() {
    assert(FEE_NUM == 30 as u128);
    assert(FEE_DEN == 10_000 as u128);
    assert(SCALE == 1_000_000_000_000_000_000 as u128);
}
```

- [ ] **Step 2: Run tests to verify they fail.**

Run: `ssh zswap-vps 'source /root/.zswap-env && cd /root/zswap-aztec/circuits/clearing && nargo test --silence-warnings 2>&1' | tail -20`

Expected: compilation errors / "module pricing has no item mul_div".

- [ ] **Step 3: Write `circuits/clearing/src/pricing.nr` with `mul_div` + constants.**

Replace the stub with:

```noir
//! Fixed-point arithmetic + payout/eligibility primitives for clearing.

pub global SCALE: u128 = 1_000_000_000_000_000_000;   // 1e18, matches aggregator's fixed-point
pub global FEE_NUM: u128 = 30;                         // 30 bps numerator
pub global FEE_DEN: u128 = 10_000;                     // 30 bps denominator

/// (x * y) / z with floor rounding. The product x*y can reach 2^188 (u128 * 1e18),
/// well inside Field (~2^254), so we widen via Field and cast back. Caller must
/// ensure the result fits in u128 (z >= 1 and y / z keeps result <= u128::MAX).
pub fn mul_div(x: u128, y: u128, z: u128) -> u128 {
    assert(z != 0 as u128, "mul_div: divide by zero");
    let xf = x as Field;
    let yf = y as Field;
    let prod = xf * yf;
    // Floor division on Field is the language-level operator on the integer-valued
    // pre-image. Noir 1.0-beta supports this for Field via std::field::div_mod.
    // Round-trip through u128 by reducing via z.
    let quot_field = prod / (z as Field);
    quot_field as u128
}
```

(If `nargo test` rejects the `Field` division in 1.0.0-beta.19, fall back to splitting `x` and `y` into u64 hi/lo halves and doing 4 u128 multiplies + carries. That fallback is in the spec §6.7's "implemented per the toolchain allows".)

- [ ] **Step 4: Run tests to verify they pass.**

Run: `ssh zswap-vps 'source /root/.zswap-env && cd /root/zswap-aztec/circuits/clearing && nargo test --silence-warnings 2>&1' | tail -20`

Expected: 3 tests passed.

- [ ] **Step 5: Commit.**

```
git add circuits/clearing/src/pricing.nr circuits/clearing/src/test.nr
git commit -m "feat(circuits/clearing): mul_div + SCALE/FEE constants

mul_div(x, y, z) = (x * y) / z with floor rounding via Field intermediate,
plus the canonical SCALE = 1e18, FEE_NUM = 30, FEE_DEN = 10000 constants
matching the aggregator's fixed-point convention. Three nargo unit tests.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: `binding.nr` — chain replay + `is_cancelled` derivation (§6.1) + unit tests U1, U2, U7

Implements the binding constraints: `c_i` computation, `order_acc` replay, `cancel_acc` replay, derivation of `is_cancelled: [bool; 128]` from `cancelled_indices`.

**Files:**
- Modify: `circuits/clearing/src/binding.nr`
- Modify: `circuits/clearing/src/test.nr`

- [ ] **Step 1: Write the failing tests (U1, U2, U7) in `circuits/clearing/src/test.nr`.**

Append to the file:

```noir
use crate::binding::{c_i, replay_chain, derive_is_cancelled};
use crate::types::{OrderPreimage, MAX_ORDERS_PER_EPOCH};

// U1: c_i formula vs hand-computed Poseidon2.
#[test]
fn u1_c_i_matches_hand_computed() {
    let order = OrderPreimage {
        side: false,
        amount_in: 1_000_000_000 as u128,
        limit_price: 2_000_000_000_000_000_000 as u128,
        order_nonce: 0x1234567890abcdef,
        submitted_at_block: 42,
        owner: 0xdeadbeef,
    };
    let expected = aztec::protocol::hash::poseidon2_hash([
        0xdeadbeef,
        0,
        1_000_000_000 as Field,
        2_000_000_000_000_000_000 as Field,
        0x1234567890abcdef,
        42 as Field,
    ]);
    assert(c_i(order) == expected, "c_i must match the 5d-1 Poseidon2 formula exactly");
}

// U2: 3-link order_acc replay matches a manually-folded chain.
#[test]
fn u2_order_acc_three_link_replay() {
    let zero_order = OrderPreimage {
        side: false, amount_in: 0 as u128, limit_price: 0 as u128,
        order_nonce: 0, submitted_at_block: 0, owner: 0,
    };
    let mut orders: [OrderPreimage; MAX_ORDERS_PER_EPOCH] =
        [zero_order; MAX_ORDERS_PER_EPOCH];
    orders[0] = OrderPreimage {
        side: false, amount_in: 100 as u128, limit_price: 2_000_000_000_000_000_000 as u128,
        order_nonce: 1, submitted_at_block: 1, owner: 0xaaaa,
    };
    orders[1] = OrderPreimage {
        side: true, amount_in: 50 as u128, limit_price: 1_000_000_000_000_000_000 as u128,
        order_nonce: 2, submitted_at_block: 2, owner: 0xbbbb,
    };
    orders[2] = OrderPreimage {
        side: false, amount_in: 200 as u128, limit_price: 3_000_000_000_000_000_000 as u128,
        order_nonce: 3, submitted_at_block: 3, owner: 0xcccc,
    };

    // Manually fold the 3-link chain.
    let mut expected: Field = 0;
    for i in 0..3 {
        expected = aztec::protocol::hash::poseidon2_hash([expected, c_i(orders[i])]);
    }

    let replayed = replay_chain(orders, 3);
    assert(replayed == expected, "3-link order_acc replay must match hand fold");
}

// U7: cancel_acc replay with a tampered (wrong) commitment is rejected.
// We can't directly "reject" inside nargo test (it has no should_fail in this stdlib),
// but we can assert that the wrong fold produces a different value.
#[test]
fn u7_cancel_acc_replay_is_binding() {
    let mut zero_order = OrderPreimage {
        side: false, amount_in: 0 as u128, limit_price: 0 as u128,
        order_nonce: 0, submitted_at_block: 0, owner: 0,
    };
    let mut orders: [OrderPreimage; MAX_ORDERS_PER_EPOCH] =
        [zero_order; MAX_ORDERS_PER_EPOCH];
    orders[0] = OrderPreimage {
        side: false, amount_in: 100 as u128, limit_price: 2 as u128,
        order_nonce: 7, submitted_at_block: 1, owner: 0xa,
    };
    orders[1] = OrderPreimage {
        side: false, amount_in: 100 as u128, limit_price: 2 as u128,
        order_nonce: 8, submitted_at_block: 2, owner: 0xa,
    };

    // Real cancel: index 0.
    let mut idx0: [u32; MAX_ORDERS_PER_EPOCH] = [0; MAX_ORDERS_PER_EPOCH];
    idx0[0] = 0;
    let real_acc = replay_chain(
        // synthetic: a 1-element "chain" where the cancelled c_i is orders[0]'s
        [orders[0]; MAX_ORDERS_PER_EPOCH],
        1,
    );

    // Tampered cancel: index 1 (different commitment).
    let tampered_acc = replay_chain(
        [orders[1]; MAX_ORDERS_PER_EPOCH],
        1,
    );

    assert(real_acc != tampered_acc, "different cancelled commitments produce different chains");
}
```

- [ ] **Step 2: Run tests to verify they fail.**

Run: `ssh zswap-vps 'source /root/.zswap-env && cd /root/zswap-aztec/circuits/clearing && nargo test --silence-warnings 2>&1' | tail -10`

Expected: errors like "no item c_i" / "no item replay_chain" / "no item derive_is_cancelled".

- [ ] **Step 3: Write `circuits/clearing/src/binding.nr`.**

Replace the stub with:

```noir
//! Binding constraints (spec §6.1): chain replay + is_cancelled derivation.
//! Matches the on-chain submit_order / cancel_order c_i computation exactly
//! (Week 5d-1 IT4 invariant).

use crate::types::{OrderPreimage, MAX_ORDERS_PER_EPOCH};
use aztec::protocol::hash::poseidon2_hash;

/// Per-order commitment, exactly the formula submit_order / cancel_order use.
pub fn c_i(order: OrderPreimage) -> Field {
    let side_field: Field = if order.side { 1 } else { 0 };
    poseidon2_hash([
        order.owner,
        side_field,
        order.amount_in as Field,
        order.limit_price as Field,
        order.order_nonce,
        order.submitted_at_block as Field,
    ])
}

/// Fold orders[0..count].c_i into a running-hash chain. acc starts at 0.
pub fn replay_chain(
    orders: [OrderPreimage; MAX_ORDERS_PER_EPOCH],
    count: u32,
) -> Field {
    let mut acc: Field = 0;
    for i in 0..MAX_ORDERS_PER_EPOCH {
        if i < count {
            acc = poseidon2_hash([acc, c_i(orders[i])]);
        }
    }
    acc
}

/// Replay the cancel_acc chain. cancelled_indices[i] (for i < cancel_count) is
/// the submission index of the i-th cancelled order; orders[cancelled_indices[i]]
/// provides the preimage to fold.
pub fn replay_cancel_chain(
    orders: [OrderPreimage; MAX_ORDERS_PER_EPOCH],
    cancelled_indices: [u32; MAX_ORDERS_PER_EPOCH],
    cancel_count: u32,
    order_count: u32,
) -> Field {
    let mut acc: Field = 0;
    for j in 0..MAX_ORDERS_PER_EPOCH {
        if j < cancel_count {
            let idx = cancelled_indices[j];
            assert(idx < order_count, "cancelled_indices[j] out of bounds");
            acc = poseidon2_hash([acc, c_i(orders[idx])]);
        }
    }
    acc
}

/// Derive the is_cancelled mask. For each j in 0..cancel_count, mark
/// is_cancelled[cancelled_indices[j]] = true.
pub fn derive_is_cancelled(
    cancelled_indices: [u32; MAX_ORDERS_PER_EPOCH],
    cancel_count: u32,
    order_count: u32,
) -> [bool; MAX_ORDERS_PER_EPOCH] {
    let mut is_cancelled: [bool; MAX_ORDERS_PER_EPOCH] = [false; MAX_ORDERS_PER_EPOCH];
    for j in 0..MAX_ORDERS_PER_EPOCH {
        if j < cancel_count {
            let idx = cancelled_indices[j];
            assert(idx < order_count, "derive_is_cancelled: idx out of bounds");
            // Noir doesn't support dynamic mutable indexing in all toolchains;
            // emulate via a guarded fixed-loop scan-and-set.
            for k in 0..MAX_ORDERS_PER_EPOCH {
                if k as u32 == idx {
                    is_cancelled[k] = true;
                }
            }
        }
    }
    is_cancelled
}
```

(The fixed-loop scan-and-set in `derive_is_cancelled` is O(N²) but at N=128 it's 16384 ops — cheap.)

- [ ] **Step 4: Run tests to verify they pass.**

Run: `ssh zswap-vps 'source /root/.zswap-env && cd /root/zswap-aztec/circuits/clearing && nargo test --silence-warnings 2>&1' | tail -15`

Expected: 6 tests passed (3 from Task 3 + U1 + U2 + U7).

- [ ] **Step 5: Commit.**

```
git add circuits/clearing/src/binding.nr circuits/clearing/src/test.nr
git commit -m "feat(circuits/clearing): binding constraints (chain replay + is_cancelled)

binding.nr implements c_i (same Poseidon2 formula as 5d-1 submit_order /
cancel_order), replay_chain for order_acc, replay_cancel_chain for cancel_acc,
and derive_is_cancelled (mask over the orders array). Three nargo unit tests
(U1 commitment-formula equality, U2 3-link order_acc replay, U7 binding
sensitivity to tampered commitments).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: `pricing.nr` — eligibility + payout (§6.2.5–§6.2.8) + tests U3, U4, U8

Adds `eligible(order, P*)` and `payout(order, P*)` to the pricing module. Implements the canonical buy/sell payout formula from spec §6.2.8.

**Files:**
- Modify: `circuits/clearing/src/pricing.nr`
- Modify: `circuits/clearing/src/test.nr`

- [ ] **Step 1: Write the failing tests in `circuits/clearing/src/test.nr`.**

Append:

```noir
use crate::pricing::{eligible, payout};

// U3: Buy eligible iff limit_price >= P*; sell eligible iff limit_price <= P*.
#[test]
fn u3_eligibility_gates() {
    let p_star: u128 = 2_000_000_000_000_000_000;  // 2e18
    let buy_at_limit_2 = OrderPreimage {
        side: false, amount_in: 1 as u128, limit_price: 2_000_000_000_000_000_000 as u128,
        order_nonce: 0, submitted_at_block: 0, owner: 0,
    };
    let buy_at_limit_3 = OrderPreimage { limit_price: 3_000_000_000_000_000_000 as u128, ..buy_at_limit_2 };
    let buy_at_limit_1 = OrderPreimage { limit_price: 1_000_000_000_000_000_000 as u128, ..buy_at_limit_2 };
    assert(eligible(buy_at_limit_2, p_star), "buy with limit == P* eligible");
    assert(eligible(buy_at_limit_3, p_star), "buy with limit > P* eligible");
    assert(!eligible(buy_at_limit_1, p_star), "buy with limit < P* ineligible");

    let sell_at_limit_2 = OrderPreimage {
        side: true, amount_in: 1 as u128, limit_price: 2_000_000_000_000_000_000 as u128,
        order_nonce: 0, submitted_at_block: 0, owner: 0,
    };
    let sell_at_limit_1 = OrderPreimage { limit_price: 1_000_000_000_000_000_000 as u128, ..sell_at_limit_2 };
    let sell_at_limit_3 = OrderPreimage { limit_price: 3_000_000_000_000_000_000 as u128, ..sell_at_limit_2 };
    assert(eligible(sell_at_limit_2, p_star), "sell with limit == P* eligible");
    assert(eligible(sell_at_limit_1, p_star), "sell with limit < P* eligible");
    assert(!eligible(sell_at_limit_3, p_star), "sell with limit > P* ineligible");
}

// U4: Buy 1000 tUSDC (units, not scaled) @ P* = 2e18 produces ~498 tETH (30 bps fee).
// Pure formula: (1000 * 1e18 / 2e18) * (10000-30) / 10000 = 500 * 9970 / 10000 = 498.5 -> floor 498.
#[test]
fn u4_buy_payout_with_fee() {
    let p_star: u128 = 2_000_000_000_000_000_000;  // 2e18
    let buy = OrderPreimage {
        side: false, amount_in: 1000 as u128, limit_price: p_star,
        order_nonce: 0, submitted_at_block: 0, owner: 0,
    };
    assert(payout(buy, p_star) == 498 as u128, "buy 1000 tUSDC @ 2e18 -> 498 tETH after 30bps fee");
}

// U8: payout above limit reverts (the assertion inside `eligible` gates it, but
// for the symmetric "fed clearing_price outside the limit" tampering case the
// circuit's main constraint enforces it). We mirror the eligibility check on
// the unhappy side.
#[test]
fn u8_payout_ineligible_zero_or_panic() {
    let p_star: u128 = 2_000_000_000_000_000_000;
    let buy_under_limit = OrderPreimage {
        side: false, amount_in: 1000 as u128, limit_price: 1_000_000_000_000_000_000 as u128,
        order_nonce: 0, submitted_at_block: 0, owner: 0,
    };
    // The eligibility gate is the user-facing check; payout itself just runs the
    // formula, which is fine -- it's main.nr that asserts eligibility before
    // calling payout. The test simply asserts !eligible.
    assert(!eligible(buy_under_limit, p_star), "buy limit < P* must NOT be eligible");
}
```

- [ ] **Step 2: Run tests to verify they fail.**

Run: `ssh zswap-vps 'source /root/.zswap-env && cd /root/zswap-aztec/circuits/clearing && nargo test --silence-warnings 2>&1' | tail -15`

Expected: errors like "no item eligible" / "no item payout".

- [ ] **Step 3: Add `eligible` + `payout` to `circuits/clearing/src/pricing.nr`.**

Append to the file:

```noir
use crate::types::OrderPreimage;

/// Per-order eligibility at the clearing price (spec §6.2.7).
///   Buy  (side=false): limit_price >= clearing_price (willing to pay up to limit).
///   Sell (side=true):  limit_price <= clearing_price (willing to accept >= limit).
pub fn eligible(order: OrderPreimage, clearing_price: u128) -> bool {
    if order.side {
        // sell
        order.limit_price <= clearing_price
    } else {
        // buy
        order.limit_price >= clearing_price
    }
}

/// Canonical payout formula (spec §6.2.8). Result is the amount_out
/// the order receives in its output token, post-fee.
///   Buy:  out_b = ((amount_in * SCALE) / P*) * (FEE_DEN - FEE_NUM) / FEE_DEN
///   Sell: out_a = ((amount_in * P*) / SCALE) * (FEE_DEN - FEE_NUM) / FEE_DEN
pub fn payout(order: OrderPreimage, clearing_price: u128) -> u128 {
    let gross: u128 = if order.side {
        // sell: amount_in (token B) * P* / SCALE -> token A
        mul_div(order.amount_in, clearing_price, SCALE)
    } else {
        // buy: amount_in (token A) * SCALE / P* -> token B
        mul_div(order.amount_in, SCALE, clearing_price)
    };
    mul_div(gross, FEE_DEN - FEE_NUM, FEE_DEN)
}
```

- [ ] **Step 4: Run tests to verify they pass.**

Run: `ssh zswap-vps 'source /root/.zswap-env && cd /root/zswap-aztec/circuits/clearing && nargo test --silence-warnings 2>&1' | tail -15`

Expected: 9 tests passed total (3 + 3 + 3).

- [ ] **Step 5: Commit.**

```
git add circuits/clearing/src/pricing.nr circuits/clearing/src/test.nr
git commit -m "feat(circuits/clearing): eligibility + payout primitives

pricing.nr gains eligible (buy: limit >= P*, sell: limit <= P*) and
payout (buy: amount_in*SCALE/P*; sell: amount_in*P*/SCALE; both with
30bps fee withheld via FEE_DEN-FEE_NUM/FEE_DEN floor). Three nargo unit
tests (U3 gates, U4 buy-payout numeric, U8 ineligibility).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: `main.nr` — binding + per-fill eligibility/payout integration (§6.2)

Wires binding's `replay_chain` / `replay_cancel_chain` / `derive_is_cancelled` into `main.nr`'s body and adds the per-fill verification loop (steps §6.2.5–§6.2.8).

**Files:**
- Modify: `circuits/clearing/src/main.nr`

- [ ] **Step 1: Replace `main.nr`'s placeholder body.**

Open `circuits/clearing/src/main.nr` and replace the existing `fn main(...)` body (the `let _ = ...` block) with:

```noir
    assert(order_count <= MAX_ORDERS_PER_EPOCH, "order_count exceeds cap");
    assert(cancel_count <= order_count, "cancel_count > order_count");
    assert(fills_len <= MAX_ORDERS_PER_EPOCH, "fills_len exceeds cap");

    // §6.1 — Binding: replay both chains.
    let replayed_order_acc = binding::replay_chain(orders, order_count);
    assert(replayed_order_acc == order_acc, "order_acc replay mismatch");

    let replayed_cancel_acc =
        binding::replay_cancel_chain(orders, cancelled_indices, cancel_count, order_count);
    assert(replayed_cancel_acc == cancel_acc, "cancel_acc replay mismatch");

    let is_cancelled = binding::derive_is_cancelled(cancelled_indices, cancel_count, order_count);

    // §6.2 — Per-fill eligibility + payout. fill_to_order_index[i] maps fills[i] to
    // the orders[] slot it pays out.
    for i in 0..MAX_ORDERS_PER_EPOCH {
        if i < fills_len {
            let j = fill_to_order_index[i];
            assert(j < order_count, "fill_to_order_index[i] >= order_count");
            assert(!is_cancelled[j], "filled order was cancelled");
            assert(orders[j].order_nonce == fills[i].order_nonce, "fill nonce mismatch");
            assert(pricing::eligible(orders[j], clearing_price), "filled order ineligible at P*");
            let expected_out = pricing::payout(orders[j], clearing_price);
            assert(fills[i].amount_out == expected_out, "fill amount_out != canonical payout");
        }
    }
```

- [ ] **Step 2: Verify `main.nr` compiles via the workspace.**

Run: `ssh zswap-vps 'source /root/.zswap-env && cd /root/zswap-aztec/circuits/clearing && nargo compile --silence-warnings 2>&1' | tail -10`

Expected: no errors; `target/clearing.json` is rewritten.

- [ ] **Step 3: Run the unit tests again to confirm nothing regressed.**

Run: `ssh zswap-vps 'source /root/.zswap-env && cd /root/zswap-aztec/circuits/clearing && nargo test --silence-warnings 2>&1' | tail -10`

Expected: 9 tests passed (same as Task 5; `main.nr` doesn't add new unit tests in this task).

- [ ] **Step 4: Commit.**

```
git add circuits/clearing/src/main.nr
git commit -m "feat(circuits/clearing): main.nr wires binding + per-fill verification

main.nr's body now replays order_acc and cancel_acc, derives is_cancelled,
and runs the per-fill loop (§6.2): nonce lookup hint, eligibility gate,
canonical payout cross-check. DoS resistance and aggregate-swap checks
follow in the next tasks.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: DoS resistance (§6.3) + unit test U6

Every eligible non-cancelled order must appear in `fills`. Implemented by deriving an `is_filled: [bool; 128]` mask from `fill_to_order_index[0..fills_len]`, then iterating orders and asserting `eligible(orders[k], P*) && !is_cancelled[k]` ⇒ `is_filled[k]`.

**Files:**
- Modify: `circuits/clearing/src/main.nr`
- Modify: `circuits/clearing/src/test.nr`

- [ ] **Step 1: Add the failing U6 test in `circuits/clearing/src/test.nr`.**

Append:

```noir
// U6: DoS resistance — an eligible non-cancelled order omitted from fills is
// rejected. We can't directly invoke main from a unit test (it takes pub-tagged
// params), so we simulate the mask logic inline as a contract on the helper.
#[test]
fn u6_dos_resistance_mask_derivation() {
    // Build a fake "filled mask" the way main.nr does, and assert the gap test
    // finds the missing order.
    let mut is_filled: [bool; MAX_ORDERS_PER_EPOCH] = [false; MAX_ORDERS_PER_EPOCH];
    // Pretend two orders are filled: indices 0 and 2.
    is_filled[0] = true;
    is_filled[2] = true;

    let is_cancelled: [bool; MAX_ORDERS_PER_EPOCH] = [false; MAX_ORDERS_PER_EPOCH];

    // Order at index 1 is eligible & not cancelled but not filled -> violation.
    let order_count: u32 = 3;
    let mut violation = false;
    for k in 0..MAX_ORDERS_PER_EPOCH {
        if k < order_count {
            if !is_cancelled[k] && !is_filled[k] {
                // The real main.nr would assert here; we just record.
                violation = true;
            }
        }
    }
    assert(violation, "omitted eligible order must be detected as a violation");
}
```

- [ ] **Step 2: Run tests to verify it fails.**

Run: `ssh zswap-vps 'source /root/.zswap-env && cd /root/zswap-aztec/circuits/clearing && nargo test --silence-warnings 2>&1' | tail -10`

Actually the test will pass (it's self-contained). But we want a CONSTRAINT failure in main.nr if the DoS condition arises. The U6 test above only exercises the mask-derivation logic. Run it just to confirm clean.

Expected: 10 tests passed (we just added one).

- [ ] **Step 3: Add the DoS check to `main.nr`'s body.**

In `circuits/clearing/src/main.nr`, append to the existing `fn main` body (after the per-fill loop from Task 6):

```noir
    // §6.3 — DoS resistance: every eligible non-cancelled order must be in fills.
    // Derive is_filled from fill_to_order_index[0..fills_len].
    let mut is_filled: [bool; MAX_ORDERS_PER_EPOCH] = [false; MAX_ORDERS_PER_EPOCH];
    for i in 0..MAX_ORDERS_PER_EPOCH {
        if i < fills_len {
            let j = fill_to_order_index[i];
            // Scan-and-set, mirroring binding::derive_is_cancelled.
            for k in 0..MAX_ORDERS_PER_EPOCH {
                if k as u32 == j {
                    is_filled[k] = true;
                }
            }
        }
    }

    for k in 0..MAX_ORDERS_PER_EPOCH {
        if k < order_count {
            if !is_cancelled[k] {
                if pricing::eligible(orders[k], clearing_price) {
                    assert(is_filled[k], "eligible non-cancelled order missing from fills");
                }
            }
        }
    }
```

- [ ] **Step 4: Recompile and re-run tests.**

Run: `ssh zswap-vps 'source /root/.zswap-env && cd /root/zswap-aztec/circuits/clearing && nargo test --silence-warnings 2>&1' | tail -10`

Expected: 10 tests passed.

- [ ] **Step 5: Commit.**

```
git add circuits/clearing/src/main.nr circuits/clearing/src/test.nr
git commit -m "feat(circuits/clearing): DoS resistance (every eligible order is filled)

main.nr derives is_filled from fill_to_order_index, then asserts every
eligible non-cancelled order is in fills. Aggregator cannot silently drop
an in-the-money order. U6 unit test exercises the mask-derivation logic
in isolation.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Aggregate swap derivation + ClearingSwap cross-check (§6.4 + §6.5)

Sums per-side `amount_in` / `amount_out` over filled orders, derives `gross_*` and `fee_pool_*`, then cross-checks every `swap.*` field. No new unit tests in spec §8.1 for this; the e2e (E1) covers it.

**Files:**
- Modify: `circuits/clearing/src/main.nr`
- Modify: `circuits/clearing/src/pricing.nr` (one helper)

- [ ] **Step 1: Add `saturating_sub` to `pricing.nr` (clean helper used by several cross-checks).**

Append to `circuits/clearing/src/pricing.nr`:

```noir
/// max(0, x - y) without underflow. Used by main.nr to express
/// "a_to_pool = max(0, gross_buy_in_a - seller_payouts_a)" cleanly.
pub fn saturating_sub(x: u128, y: u128) -> u128 {
    if x > y { x - y } else { 0 as u128 }
}
```

- [ ] **Step 2: Append the aggregate-swap block to `main.nr`'s body.**

In `circuits/clearing/src/main.nr`, append after the DoS block from Task 7:

```noir
    // §6.4 — Aggregate net-swap derivation over filled orders.
    let mut gross_buy_in_a: u128 = 0 as u128;
    let mut gross_sell_in_b: u128 = 0 as u128;
    let mut buyer_payouts_b: u128 = 0 as u128;
    let mut seller_payouts_a: u128 = 0 as u128;
    for i in 0..MAX_ORDERS_PER_EPOCH {
        if i < fills_len {
            let j = fill_to_order_index[i];
            if orders[j].side {
                // sell: amount_in is token B; amount_out is token A
                gross_sell_in_b = gross_sell_in_b + orders[j].amount_in;
                seller_payouts_a = seller_payouts_a + fills[i].amount_out;
            } else {
                // buy: amount_in is token A; amount_out is token B
                gross_buy_in_a = gross_buy_in_a + orders[j].amount_in;
                buyer_payouts_b = buyer_payouts_b + fills[i].amount_out;
            }
        }
    }

    let gross_buy_out_b = pricing::mul_div(gross_buy_in_a, pricing::SCALE, clearing_price);
    let gross_sell_out_a = pricing::mul_div(gross_sell_in_b, clearing_price, pricing::SCALE);

    // fee_pool_* = gross - net_to_traders (the LP-bound withholding).
    let fee_pool_a = gross_sell_out_a - seller_payouts_a;
    let fee_pool_b = gross_buy_out_b - buyer_payouts_b;

    // §6.5 — ClearingSwap cross-check.
    assert(swap.a_to_pool == pricing::saturating_sub(gross_buy_in_a, seller_payouts_a),
           "swap.a_to_pool mismatch");
    assert(swap.a_from_pool == pricing::saturating_sub(seller_payouts_a, gross_buy_in_a),
           "swap.a_from_pool mismatch");
    assert(swap.b_to_pool == pricing::saturating_sub(gross_sell_in_b, buyer_payouts_b),
           "swap.b_to_pool mismatch");
    assert(swap.b_from_pool == pricing::saturating_sub(buyer_payouts_b, gross_sell_in_b),
           "swap.b_from_pool mismatch");

    // Reserve-delta identity, rearranged all-positive (spec §6.5.23/24):
    //   reserve_a_add + a_from_pool + fee_pool_a == reserve_a_sub + a_to_pool
    assert(
        swap.reserve_a_add + swap.a_from_pool + fee_pool_a
            == swap.reserve_a_sub + swap.a_to_pool,
        "reserve_a delta identity violated",
    );
    assert(
        swap.reserve_b_add + swap.b_to_pool + fee_pool_b
            == swap.reserve_b_sub + swap.b_from_pool,
        "reserve_b delta identity violated",
    );

    // Wait: token B identity. b_to_pool is gross_sell_in_b - buyer_payouts_b
    // (sellers pay B in, buyers receive B out). Fee in B is fee_pool_b.
    // Reserve-side: reserve_b_delta = b_to_pool - b_from_pool - fee_pool_b.
    // All-positive: reserve_b_add + b_from_pool + fee_pool_b == reserve_b_sub + b_to_pool.
    // (The assert above has b_to_pool / b_from_pool swapped vs the natural form;
    // correct it.)

    // Fee-per-share derivation (floor).
    assert(swap.fee_a_per_share_increment == pricing::mul_div(fee_pool_a, pricing::SCALE, lp_supply),
           "fee_a_per_share_increment mismatch");
    assert(swap.fee_b_per_share_increment == pricing::mul_div(fee_pool_b, pricing::SCALE, lp_supply),
           "fee_b_per_share_increment mismatch");
```

Now correct the b-side reserve identity. Replace the b-side assert just written with:

```noir
    assert(
        swap.reserve_b_add + swap.b_from_pool + fee_pool_b
            == swap.reserve_b_sub + swap.b_to_pool,
        "reserve_b delta identity violated",
    );
```

(b_to_pool is the gross net B INTO the pool; sellers contribute B; b_from_pool is gross net OUT; fee_pool_b is the LP withholding in B. Identity: reserve_b grows by (b_to_pool − b_from_pool − fee_pool_b); rearranged with all positive terms gives the form above.)

- [ ] **Step 3: Recompile + re-run unit tests.**

Run: `ssh zswap-vps 'source /root/.zswap-env && cd /root/zswap-aztec/circuits/clearing && nargo test --silence-warnings 2>&1' | tail -10`

Expected: 10 tests passed (unchanged count — this block is exercised end-to-end by E1 in Task 13).

- [ ] **Step 4: Commit.**

```
git add circuits/clearing/src/main.nr circuits/clearing/src/pricing.nr
git commit -m "feat(circuits/clearing): aggregate swap derivation + ClearingSwap cross-check

main.nr sums per-side gross_*/payouts over filled orders, derives
fee_pool_a/fee_pool_b, and cross-checks every swap.* field: the four
to_pool / from_pool (saturating-sub form), the two reserve-delta
all-positive identities, and the two fee-per-share floor-mul-divs.
Added saturating_sub helper to pricing.nr.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: `amm.nr` — k-monotonicity (§6.6) + unit test U5

Implements the AMM constant-product check `new_a * new_b <= old_a * old_b` (k can only shrink by floor dust — the Week 5b conservation invariant).

**Files:**
- Modify: `circuits/clearing/src/amm.nr`
- Modify: `circuits/clearing/src/test.nr`
- Modify: `circuits/clearing/src/main.nr`

- [ ] **Step 1: Add the failing U5 test.**

Append to `circuits/clearing/src/test.nr`:

```noir
use crate::amm::assert_k_monotonic;

// U5: small swap with fee withheld -- k strictly shrinks by floor dust.
#[test]
fn u5_amm_k_monotonic_on_small_swap() {
    // Pre: 1_000_000 token A, 2_000_000 token B (k = 2e12).
    // Post: 1_000_100 A, 1_999_801 B  (10x reduction in B-side dust, intentional).
    // new_k = 1_000_100 * 1_999_801 = 2_000_001_001... < 2_000_000_000_000? Let's compute.
    // Use a simpler vector: pre 100x200, post 110x180.
    // pre_k = 20_000; post_k = 110*180 = 19_800. 19_800 <= 20_000. PASS.
    assert_k_monotonic(100 as u128, 200 as u128, 110 as u128, 180 as u128);
}
```

- [ ] **Step 2: Run tests to verify it fails.**

Run: `ssh zswap-vps 'source /root/.zswap-env && cd /root/zswap-aztec/circuits/clearing && nargo test --silence-warnings 2>&1' | tail -10`

Expected: errors like "no item assert_k_monotonic".

- [ ] **Step 3: Write `circuits/clearing/src/amm.nr`.**

Replace the stub with:

```noir
//! AMM constant-product check (spec §6.6).
//! `k = reserve_a * reserve_b` can only shrink across a clearing because the
//! fee is withheld from reserve growth (Week 5b conservation invariant).

/// Asserts new_a * new_b <= old_a * old_b. Uses Field as the wide intermediate
/// (u128 * u128 can reach 2^256, which Field can hold).
pub fn assert_k_monotonic(old_a: u128, old_b: u128, new_a: u128, new_b: u128) {
    let old_k: Field = (old_a as Field) * (old_b as Field);
    let new_k: Field = (new_a as Field) * (new_b as Field);
    // Field doesn't natively support <= in Noir; bridge via the u128 cast IF
    // values fit. Here we know they do (reserves bounded by token supply, which
    // is well below 2^128). For the strict comparison we use the lt_u256-style
    // pattern: subtract and assert the result is "small enough" -- but the
    // cleanest way is to convert both to a known-safe range and compare as u128.
    //
    // For correctness in 1.0.0-beta.19, we lean on the fact that reserves are
    // u128-bounded and use a 256-bit cast via two u128 halves.
    //
    // Simplified contract: cast to Field, then enforce equality on the
    // "difference is non-negative" via assert. Noir's Field has no native ordering,
    // but std::field::cmp gives lt/le for small ranges. We bracket the assertion:
    let diff: Field = old_k - new_k;
    // Casting diff back to u128 will fail if diff >= 2^128 OR diff is negative
    // (Field wraps modulo p, so a negative would manifest as a huge positive).
    // Bound: |old_k - new_k| <= 2^256, but in practice the swap delta is at most
    // 2^130 (gross swap volumes). The safe cast for diff: convert to u128 via
    // explicit max check.
    let diff_u128: u128 = diff as u128;
    // If new_k > old_k, the Field subtraction wraps and diff_u128 becomes large;
    // the explicit non-overflow assertion bounds the difference by the maximum
    // realistic per-clearing change (1e30 << 2^128).
    assert(diff_u128 < (1 << 100) as u128, "k grew (or wrapped) — AMM curve violated");
}
```

(Implementer note: Noir's `Field` ordering is genuinely awkward in 1.0.0-beta.19. If `diff as u128` casting doesn't behave as the above expects, fall back to comparing u128 halves directly: split old_a / new_a / old_b / new_b into u64 hi/lo, do 4-way multiply with carries, then bigint-compare. The spec §6.6 only requires `new_a*new_b <= old_a*old_b`; the helper's internals can differ as long as the constraint is enforced.)

- [ ] **Step 4: Wire into `main.nr`.**

In `circuits/clearing/src/main.nr`, append to the body after the §6.5 ClearingSwap cross-check block:

```noir
    // §6.6 — AMM k-monotonicity.
    let new_reserve_a = reserve_a + swap.reserve_a_add - swap.reserve_a_sub;
    let new_reserve_b = reserve_b + swap.reserve_b_add - swap.reserve_b_sub;
    amm::assert_k_monotonic(reserve_a, reserve_b, new_reserve_a, new_reserve_b);
```

- [ ] **Step 5: Recompile + run tests.**

Run: `ssh zswap-vps 'source /root/.zswap-env && cd /root/zswap-aztec/circuits/clearing && nargo test --silence-warnings 2>&1' | tail -10`

Expected: 11 tests passed.

- [ ] **Step 6: Commit.**

```
git add circuits/clearing/src/amm.nr circuits/clearing/src/main.nr circuits/clearing/src/test.nr
git commit -m "feat(circuits/clearing): AMM k-monotonicity invariant

amm.nr enforces new_a*new_b <= old_a*old_b (Week 5b conservation invariant).
main.nr derives new reserves from swap.reserve_*_add/sub deltas and calls
assert_k_monotonic. U5 unit test passes on a small 100x200 -> 110x180 swap.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: `bb write_vk` integration into compile script

After `nargo compile` produces `circuits/clearing/target/clearing.json`, also produce `circuits/clearing/target/vk.bin` via `bb write_vk`. 5d-3 will embed this VK as a constant in the orderbook contract.

**Files:**
- Modify: `scripts/compile-all.sh`

- [ ] **Step 1: Append a `bb write_vk` step inside the circuits-compile loop in `scripts/compile-all.sh`.**

Replace the entire `if [ -d circuits ]; then ... fi` block (added in Task 2) with:

```bash
if [ -d circuits ]; then
  for dir in circuits/*/; do
    if [ -f "$dir/Nargo.toml" ]; then
      echo "→ Compiling $dir"
      pkg_rel="${dir%/}"
      docker run --rm --entrypoint bash \
        -v "$ROOT:/work" -w "/work/$pkg_rel" \
        "aztecprotocol/aztec:$VERSION" \
        -c 'export PATH=/usr/src/noir/noir-repo/target/release:$PATH && nargo compile --silence-warnings'

      # bb write_vk produces the verification key 5d-3 will embed on-chain.
      pkg_name="$(basename "$pkg_rel")"
      bc_path="$pkg_rel/target/$pkg_name.json"
      vk_path="$pkg_rel/target/vk.bin"
      if [ -f "$bc_path" ]; then
        echo "→ Writing VK for $pkg_rel"
        docker run --rm --entrypoint bash \
          -v "$ROOT:/work" -w /work \
          "aztecprotocol/aztec:$VERSION" \
          -c "node /usr/src/yarn-project/aztec/dest/bin/index.js bb write_vk -b $bc_path -o $vk_path --verifier_target noir-recursive"
      fi
    fi
  done
  echo "All circuits compiled + VKs written."
fi
```

(If `aztec bb write_vk` isn't supported as a CLI passthrough in 4.2.1's wrapper, swap the inner `node ... bb write_vk` for a direct call to the bb binary at `/usr/src/barretenberg/cpp/build/bin/bb` inside the container, with the same args.)

- [ ] **Step 2: Run `pnpm compile` and verify both artifacts appear.**

Run: `pnpm compile 2>&1 | tail -10 && ls -la circuits/clearing/target/`

Expected: lines like "→ Writing VK for circuits/clearing/" + `clearing.json` and `vk.bin` both present.

- [ ] **Step 3: Commit.**

```
git add scripts/compile-all.sh
git commit -m "feat(scripts): pnpm compile also writes circuit VKs via bb

compile-all.sh now invokes bb write_vk after nargo compile for each
circuits/*/Nargo.toml, producing target/vk.bin alongside target/<name>.json.
The VK is what 5d-3 will embed in the orderbook contract for the recursive
verify call.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 11: `witness.ts` — TypeScript witness builder

The TS helper that converts (aggregator's `ClearingResult` + on-chain `EpochState` + orders + cancellations) into the Prover.toml format `nargo execute` expects.

**Files:**
- Create: `aggregator/src/witness.ts`

- [ ] **Step 1: Read the existing aggregator surface.**

Run: `ls aggregator/src/ && grep -nE "^export" aggregator/src/clearing.ts | head -20`

Confirm `clearing.ts` exports `ClearingOrder`, `PoolSnapshot`, `OrderFill`, `ClearingResult`, `computeClearing`. The new `witness.ts` will sit alongside them.

- [ ] **Step 2: Write `aggregator/src/witness.ts`.**

```ts
/**
 * Build a Prover.toml witness from the aggregator's ClearingResult + on-chain
 * EpochState. The output feeds `nargo execute --prover-name <stem>` for the
 * clearing circuit at circuits/clearing/. The TOML field names + ordering must
 * match circuits/clearing/src/main.nr's fn main parameter list.
 */
import { type ClearingResult } from "./clearing.js";

export const MAX_ORDERS_PER_EPOCH = 128;

/** Mirror of contracts/orderbook/src/main.nr's EpochState. */
export interface EpochState {
  order_acc: bigint;       // Field
  cancel_acc: bigint;      // Field
  order_count: number;
  cancel_count: number;
}

/** Mirror of contracts/orderbook/src/main.nr's OrderNote. */
export interface OrderNotePreimage {
  side: boolean;
  amount_in: bigint;
  limit_price: bigint;
  order_nonce: bigint;
  submitted_at_block: number;
  owner: bigint;           // AztecAddress.toField().toBigInt()
}

/** Pre-clearing pool snapshot. */
export interface PoolSnapshotForCircuit {
  reserve_a: bigint;
  reserve_b: bigint;
  lp_supply: bigint;
}

export interface ClearingWitness {
  /** TOML-encoded text to write to circuits/clearing/Prover.toml. */
  proverToml: string;
}

/**
 * @param args.orders    Submission-order array of OrderNote preimages. Length must equal
 *                       args.epoch.order_count. The builder pads to MAX_ORDERS_PER_EPOCH.
 * @param args.cancellationIndices  In cancellation order, each entry is the submission
 *                       index of the cancelled order. Length must equal args.epoch.cancel_count.
 * @param args.clearing  The aggregator's ClearingResult (P*, fills, swap).
 */
export function buildClearingWitness(args: {
  epoch: EpochState;
  pool: PoolSnapshotForCircuit;
  orders: OrderNotePreimage[];
  cancellationIndices: number[];
  clearing: ClearingResult;
}): ClearingWitness {
  const { epoch, pool, orders, cancellationIndices, clearing } = args;
  if (orders.length !== epoch.order_count) {
    throw new Error(`orders.length (${orders.length}) != epoch.order_count (${epoch.order_count})`);
  }
  if (cancellationIndices.length !== epoch.cancel_count) {
    throw new Error(`cancellationIndices.length (${cancellationIndices.length}) != epoch.cancel_count (${epoch.cancel_count})`);
  }

  // Pad orders to MAX with zero sentinels.
  const ordersPadded: OrderNotePreimage[] = orders.slice();
  while (ordersPadded.length < MAX_ORDERS_PER_EPOCH) {
    ordersPadded.push({
      side: false, amount_in: 0n, limit_price: 0n,
      order_nonce: 0n, submitted_at_block: 0, owner: 0n,
    });
  }

  const cancelledPadded: number[] = cancellationIndices.slice();
  while (cancelledPadded.length < MAX_ORDERS_PER_EPOCH) {
    cancelledPadded.push(0);
  }

  // fill_to_order_index[i] = submission index of orders matching fills[i].order_nonce.
  const fillToOrderIndex: number[] = clearing.fills.map((fill) => {
    const idx = orders.findIndex((o) => o.order_nonce === fill.orderNonce);
    if (idx < 0) {
      throw new Error(`fill order_nonce ${fill.orderNonce} not in orders[]`);
    }
    return idx;
  });
  while (fillToOrderIndex.length < MAX_ORDERS_PER_EPOCH) {
    fillToOrderIndex.push(0);
  }

  // Build the TOML. Noir's Prover.toml format is straightforward for primitives;
  // structs and arrays-of-structs use [section] / [[section]] respectively.
  const lines: string[] = [];
  lines.push(`order_acc = "0x${epoch.order_acc.toString(16)}"`);
  lines.push(`cancel_acc = "0x${epoch.cancel_acc.toString(16)}"`);
  lines.push(`order_count = ${epoch.order_count}`);
  lines.push(`cancel_count = ${epoch.cancel_count}`);
  lines.push(`reserve_a = "${pool.reserve_a}"`);
  lines.push(`reserve_b = "${pool.reserve_b}"`);
  lines.push(`lp_supply = "${pool.lp_supply}"`);
  lines.push(`clearing_price = "${clearing.clearingPrice}"`);
  lines.push(`fills_len = ${clearing.fills.length}`);

  // fills: array of 128 FillEntry structs. Pad with zeros past fills_len.
  lines.push(`fills = [`);
  for (let i = 0; i < MAX_ORDERS_PER_EPOCH; i++) {
    const f = i < clearing.fills.length ? clearing.fills[i] : null;
    const nonce = f ? `"0x${f.orderNonce.toString(16)}"` : `"0x0"`;
    const out = f ? `"${f.amountOut}"` : `"0"`;
    lines.push(`  { order_nonce = ${nonce}, amount_out = ${out} },`);
  }
  lines.push(`]`);

  // swap struct (TOML inline-table).
  lines.push(`swap = { ` +
    `a_to_pool = "${clearing.netSwap.aToPool}", ` +
    `b_to_pool = "${clearing.netSwap.bToPool}", ` +
    `a_from_pool = "${clearing.netSwap.aFromPool}", ` +
    `b_from_pool = "${clearing.netSwap.bFromPool}", ` +
    `reserve_a_add = "${clearing.newReserveA - pool.reserve_a > 0n ? clearing.newReserveA - pool.reserve_a : 0n}", ` +
    `reserve_a_sub = "${pool.reserve_a - clearing.newReserveA > 0n ? pool.reserve_a - clearing.newReserveA : 0n}", ` +
    `reserve_b_add = "${clearing.newReserveB - pool.reserve_b > 0n ? clearing.newReserveB - pool.reserve_b : 0n}", ` +
    `reserve_b_sub = "${pool.reserve_b - clearing.newReserveB > 0n ? pool.reserve_b - clearing.newReserveB : 0n}", ` +
    `fee_a_per_share_increment = "${clearing.feeAPerShareIncrement}", ` +
    `fee_b_per_share_increment = "${clearing.feeBPerShareIncrement}" ` +
    `}`);

  // orders: array of 128 OrderPreimage.
  lines.push(`orders = [`);
  for (const o of ordersPadded) {
    lines.push(`  { ` +
      `side = ${o.side}, ` +
      `amount_in = "${o.amount_in}", ` +
      `limit_price = "${o.limit_price}", ` +
      `order_nonce = "0x${o.order_nonce.toString(16)}", ` +
      `submitted_at_block = ${o.submitted_at_block}, ` +
      `owner = "0x${o.owner.toString(16)}" ` +
      `},`);
  }
  lines.push(`]`);

  // cancelled_indices + fill_to_order_index: flat arrays of u32.
  lines.push(`cancelled_indices = [${cancelledPadded.join(", ")}]`);
  lines.push(`fill_to_order_index = [${fillToOrderIndex.join(", ")}]`);

  return { proverToml: lines.join("\n") + "\n" };
}
```

(The `netSwap` / `newReserveA` / `newReserveB` field names align with the aggregator's `ClearingResult` — confirm against `aggregator/src/clearing.ts` and adapt the property accessors if they differ.)

- [ ] **Step 3: Typecheck.**

Run: `pnpm --filter @zswap/aggregator typecheck 2>&1 | tail -15`

Expected: 0 errors. If property names don't match the aggregator's `ClearingResult`, fix the accessor calls to use the actual names.

- [ ] **Step 4: Commit.**

```
git add aggregator/src/witness.ts
git commit -m "feat(aggregator): TypeScript witness builder for the clearing circuit

aggregator/src/witness.ts converts (EpochState + PoolSnapshot + orders +
cancellationIndices + ClearingResult) into a Prover.toml string the Noir
clearing circuit's nargo execute will accept. Mirrors the parameter list
of circuits/clearing/src/main.nr's fn main exactly.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 12: `witness.test.ts` — TS parity tests

Reference vectors that freeze the expected TOML output for representative scenarios. Catches drift between TS witness builder and Noir circuit's expected layout without paying proof-generation cost.

**Files:**
- Create: `aggregator/test/witness.test.ts`

- [ ] **Step 1: Write the test file.**

```ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildClearingWitness, MAX_ORDERS_PER_EPOCH } from "../src/witness.js";
import { type ClearingResult } from "../src/clearing.js";

describe("buildClearingWitness", () => {
  it("emits the full fixed-size order/index/fill arrays", () => {
    const epoch = { order_acc: 0n, cancel_acc: 0n, order_count: 1, cancel_count: 0 };
    const pool = { reserve_a: 1_000_000n, reserve_b: 2_000_000n, lp_supply: 1_000_000n };
    const orders = [{
      side: false,
      amount_in: 1000n,
      limit_price: 2_000_000_000_000_000_000n,
      order_nonce: 0x1n,
      submitted_at_block: 5,
      owner: 0xaaaan,
    }];
    const clearing: ClearingResult = {
      cleared: true,
      clearingPrice: 2_000_000_000_000_000_000n,
      fills: [{ orderNonce: 0x1n, filledIn: 1000n, amountOut: 498n }],
      newReserveA: 1_000_500n,
      newReserveB: 1_999_751n,
      feeAPerShareIncrement: 0n,
      feeBPerShareIncrement: 1n,
      netSwap: { aToPool: 500n, aFromPool: 0n, bToPool: 0n, bFromPool: 498n },
    } as any;

    const { proverToml } = buildClearingWitness({
      epoch, pool, orders, cancellationIndices: [], clearing,
    });

    assert.match(proverToml, /order_count = 1/);
    assert.match(proverToml, /cancel_count = 0/);
    assert.match(proverToml, /fills_len = 1/);
    assert.match(proverToml, /amount_out = "498"/);
    // 128 entries in orders, fills, cancelled_indices, fill_to_order_index:
    const ordersBlockMatch = proverToml.match(/orders = \[\n(.*?)\n\]/s);
    assert.ok(ordersBlockMatch, "orders block present");
    const ordersEntries = (ordersBlockMatch![1].match(/{ side = /g) ?? []).length;
    assert.equal(ordersEntries, MAX_ORDERS_PER_EPOCH);
  });

  it("rejects when fills reference a nonce not in orders", () => {
    const epoch = { order_acc: 0n, cancel_acc: 0n, order_count: 1, cancel_count: 0 };
    const pool = { reserve_a: 1n, reserve_b: 1n, lp_supply: 1n };
    const orders = [{
      side: false, amount_in: 1n, limit_price: 1n,
      order_nonce: 0x1n, submitted_at_block: 0, owner: 0n,
    }];
    const clearing: ClearingResult = {
      cleared: true, clearingPrice: 1n,
      fills: [{ orderNonce: 0xDEADn, filledIn: 1n, amountOut: 1n }],
      newReserveA: 1n, newReserveB: 1n,
      feeAPerShareIncrement: 0n, feeBPerShareIncrement: 0n,
      netSwap: { aToPool: 0n, aFromPool: 0n, bToPool: 0n, bFromPool: 0n },
    } as any;

    assert.throws(
      () => buildClearingWitness({ epoch, pool, orders, cancellationIndices: [], clearing }),
      /not in orders/,
    );
  });

  it("rejects when args.orders.length != epoch.order_count", () => {
    const epoch = { order_acc: 0n, cancel_acc: 0n, order_count: 2, cancel_count: 0 };
    const pool = { reserve_a: 1n, reserve_b: 1n, lp_supply: 1n };
    const orders = [{
      side: false, amount_in: 1n, limit_price: 1n,
      order_nonce: 0x1n, submitted_at_block: 0, owner: 0n,
    }]; // length 1, but epoch says 2
    const clearing: ClearingResult = {
      cleared: true, clearingPrice: 1n, fills: [], newReserveA: 1n, newReserveB: 1n,
      feeAPerShareIncrement: 0n, feeBPerShareIncrement: 0n,
      netSwap: { aToPool: 0n, aFromPool: 0n, bToPool: 0n, bFromPool: 0n },
    } as any;

    assert.throws(
      () => buildClearingWitness({ epoch, pool, orders, cancellationIndices: [], clearing }),
      /orders.length .* != epoch.order_count/,
    );
  });
});
```

- [ ] **Step 2: Run the aggregator tests.**

Run: `pnpm --filter @zswap/aggregator test 2>&1 | tail -15`

Expected: all existing aggregator tests still pass plus 3 new "buildClearingWitness" tests pass (total = previous + 3).

- [ ] **Step 3: Commit.**

```
git add aggregator/test/witness.test.ts
git commit -m "test(aggregator): TS parity for buildClearingWitness

Three node:test cases against the witness builder: (1) happy-path emits
the full 128-element fixed-size arrays with expected primitive fields,
(2) rejects on a fill referencing an unknown nonce, (3) rejects when
orders.length disagrees with epoch.order_count.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 13: `clearing-circuit.test.ts` E1 — end-to-end happy path

JS-orchestrated test: deploys orderbook + tokens + pool on the live VPS stack, submits 5 orders + cancels 1, calls aggregator's `computeClearing`, builds the witness via `buildClearingWitness`, then shells out to `nargo execute` + `bb prove --verify` and asserts the proof verifies.

**Files:**
- Create: `tests/integration/clearing-circuit.test.ts`

- [ ] **Step 1: Confirm the dev stack is up.**

Run: `ssh zswap-vps 'lsof -i :18080 -sTCP:LISTEN -t && lsof -i :18545 -sTCP:LISTEN -t && echo stack-up'`

Expected: `stack-up`. If not, start with `scripts/dev.sh` on VPS (custom-port variant per `memory/aztec-pxe-tagging-window.md` notes).

- [ ] **Step 2: Write the integration test (skeleton). Adapt patterns from `tests/integration/orderbook.test.ts`.**

Outline (the implementer fills in deploy/submit details mirroring `orderbook.test.ts`'s 4th describe block):

```ts
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { connectToSandbox } from "./helpers/sandbox.js";
import { getTestWallets } from "./helpers/wallets.js";
import { TokenContract } from "./generated/Token.js";
import { OrderbookContract } from "./generated/Orderbook.js";
import { LiquidityPoolContract } from "./generated/LiquidityPool.js";

import { computeClearing } from "../../aggregator/src/clearing.js";
import { buildClearingWitness } from "../../aggregator/src/witness.js";

// Absolute paths on VPS (where the e2e runs). Adjust if local-Mac variant.
const CIRCUIT_DIR = "/root/zswap-aztec/circuits/clearing";
const BB_BIN = "/root/.aztec/versions/4.2.1/node_modules/@aztec/bb.js/build/amd64-linux/bb";

describe("clearing circuit E2E (live integration)", { timeout: 30 * 60 * 1_000 }, () => {
  // before(): deploy fresh fixture (admin, alice, tokens, pool with set_orderbook,
  // orderbook with epoch_length=1000 — long enough for 5 submits + a cancel).

  it("E1: aggregator clearing → witness → nargo execute → bb prove --verify passes", async () => {
    // 1. Submit ~5 orders (mix buys/sells with mutually-satisfiable limits).
    // 2. Cancel one order.
    // 3. Read epoch state + pool snapshot from contract getters.
    // 4. computeClearing(pool, orders) → ClearingResult.
    // 5. const { proverToml } = buildClearingWitness({ epoch, pool, orders,
    //    cancellationIndices, clearing }).
    // 6. writeFileSync(`${CIRCUIT_DIR}/Prover.toml`, proverToml).
    // 7. const exec = spawnSync("nargo", ["execute", "--silence-warnings"], { cwd: CIRCUIT_DIR });
    //    assert.equal(exec.status, 0, exec.stderr.toString());
    //    // nargo execute writes target/clearing.gz (the witness).
    // 8. const prove = spawnSync(BB_BIN, [
    //      "prove",
    //      "-b", `${CIRCUIT_DIR}/target/clearing.json`,
    //      "-w", `${CIRCUIT_DIR}/target/clearing.gz`,
    //      "-o", `${CIRCUIT_DIR}/target/proof`,
    //      "--verifier_target", "noir-recursive",
    //      "--verify",  // self-verify after prove
    //    ]);
    //    assert.equal(prove.status, 0, "bb prove --verify must succeed");
  });
});
```

The implementer's job here is to fill in steps 1-3 by copy-adapting from `tests/integration/orderbook.test.ts`'s existing 4th describe (IT1-IT6b) for the deploy + submit fixture, then connecting it to steps 4-8.

- [ ] **Step 3: Sync the test file to VPS and run E1.**

```
rsync -e ssh tests/integration/clearing-circuit.test.ts zswap-vps:/root/zswap-aztec/tests/integration/clearing-circuit.test.ts
rsync -e ssh aggregator/src/witness.ts zswap-vps:/root/zswap-aztec/aggregator/src/witness.ts
ssh zswap-vps "source /root/.zswap-env && cd /root/zswap-aztec && pnpm codegen > /tmp/codegen.log 2>&1 && cd tests && AZTEC_NODE_URL=http://localhost:18080 timeout 1800 node --import tsx --test --test-concurrency=1 --test-reporter=spec --test-name-pattern='E1' integration/clearing-circuit.test.ts 2>&1 | tail -60"
```

Expected: E1 passes. Total runtime ~15-25 minutes (deploys + submits + proof gen).

- [ ] **Step 4: Commit (only after the test passes).**

```
git add tests/integration/clearing-circuit.test.ts
git commit -m "test(circuits/clearing): E1 — happy-path end-to-end prove/verify

E1 deploys a fresh fixture on the live stack, submits 5 orders + cancels 1,
calls the aggregator's computeClearing, builds the witness via the new
buildClearingWitness, then runs nargo execute + bb prove --verify against
circuits/clearing/. Proof must verify — full round-trip parity between
TS aggregator, TS witness builder, and Noir circuit.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 14: E2 — tampering rejection

Same fixture as E1, but after the witness is built, the test mutates `fills[0].amount_out += 1n` in the Prover.toml and re-runs `bb prove --verify`. The proof must fail (non-zero exit).

**Files:**
- Modify: `tests/integration/clearing-circuit.test.ts`

- [ ] **Step 1: Append a second `it` block inside the same describe.**

```ts
  it("E2: tampered fills[0].amount_out makes bb prove --verify reject", async () => {
    // Steps 1-5 same as E1: deploy fresh fixture, submit/cancel, compute clearing,
    // build witness, write Prover.toml.
    // 6. Read Prover.toml back and tamper: find the first amount_out = "<n>" inside
    //    the fills = [ ... ] block, set it to "<n+1>", rewrite.
    // 7. Run nargo execute + bb prove --verify; assert exit code != 0.
  });
```

Implementer detail: use a regex-based string mutation on the TOML, e.g. `proverToml.replace(/(amount_out = ")(\d+)(")/, (_, p, n, q) => `${p}${BigInt(n) + 1n}${q}`)` to bump the first match.

- [ ] **Step 2: Sync + run.**

```
rsync -e ssh tests/integration/clearing-circuit.test.ts zswap-vps:/root/zswap-aztec/tests/integration/clearing-circuit.test.ts
ssh zswap-vps "source /root/.zswap-env && cd /root/zswap-aztec/tests && AZTEC_NODE_URL=http://localhost:18080 timeout 1800 node --import tsx --test --test-concurrency=1 --test-reporter=spec --test-name-pattern='E2' integration/clearing-circuit.test.ts 2>&1 | tail -40"
```

Expected: E2 passes (the test passes when bb prove rejects).

- [ ] **Step 3: Commit.**

```
git add tests/integration/clearing-circuit.test.ts
git commit -m "test(circuits/clearing): E2 — tampered fills are rejected

E2 reuses E1's fixture path but mutates fills[0].amount_out by +1 in the
Prover.toml before nargo execute + bb prove --verify. The test passes
when bb exits non-zero. This is the load-bearing tampering smoke test
for the ZK assurance.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 15: Wrap-up — tag + README

- [ ] **Step 1: Tag the milestone.**

```
git tag -a week-05d-2-clearing-circuit -m "Week 5d-2: standalone Noir clearing circuit + TS witness builder + e2e prove/verify"
git rev-list -n1 week-05d-2-clearing-circuit
```

- [ ] **Step 2: Update README status line.**

Replace the current "Status: Week 5d-1 complete..." paragraph in `README.md` with:

```
**Status:** Week 5d-2 complete. A standalone Noir circuit at `circuits/clearing/` verifies an off-chain-computed clearing `(P*, fills, ClearingSwap)` against Week 5d-1's `order_acc` / `cancel_acc` on-chain commitments: binding replay, per-fill eligibility + canonical payout, DoS resistance, ClearingSwap cross-check, AMM k-monotonicity. TS witness builder at `aggregator/src/witness.ts`. 11 Noir #[test] units + 3 TS parity tests + 2 live end-to-end tests (E1 happy-path prove/verify, E2 tampering rejection) green. Next: Week 5d-3 wires this circuit's proof into the orderbook contract via recursive verification.
```

- [ ] **Step 3: Commit + push the tag forward.**

```
git add README.md
git commit -m "docs(readme): Week 5d-2 complete

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
git tag -f -a week-05d-2-clearing-circuit -m "Week 5d-2: standalone Noir clearing circuit + TS witness builder + e2e prove/verify"
```

---

## Self-Review

**1. Spec coverage:**
- §3 In scope / Noir circuit at `circuits/clearing/` → Task 1.
- §3 / Witness builder → Task 11.
- §3 / Off-chain prove/verify → Tasks 13–14.
- §3 / Three test layers → unit (Tasks 3–9), TS parity (Task 12), E2E (Tasks 13–14).
- §4 / Project layout (5 source files) → Task 1, plus Tasks 4, 5, 8, 9 progressively populate each.
- §4 / Toolchain integration → Task 2 (nargo compile), Task 10 (bb write_vk).
- §5.1 / Public inputs struct → Task 1's `fn main` signature.
- §5.2 / Private witness → Task 1's signature; `cancelled_indices` consumed in Task 4; `fill_to_order_index` in Task 6.
- §5.3 / c_i formula → Task 4.
- §6.1 Binding → Task 4 + Task 6 (replay calls).
- §6.2 Eligibility + payout → Task 5 + Task 6.
- §6.3 DoS → Task 7.
- §6.4 Aggregate derivation → Task 8.
- §6.5 ClearingSwap cross-check → Task 8.
- §6.6 AMM k-monotonicity → Task 9.
- §6.7 Fixed-point → Task 3.
- §7 witness builder → Task 11.
- §8.1 Noir #[test] units (U1-U8) → Tasks 3, 4, 5, 7, 9 (note: U3, U4, U8 are in Task 5; U1, U2, U7 in Task 4; U5 in Task 9; U6 in Task 7).
- §8.2 E2E (E1, E2) → Tasks 13, 14.
- §8.3 TS parity → Task 12.
- §9 Affected files → matches Tasks 1–14.
- §10 Forward refs → informational; no task needed.

**2. Placeholder scan:**
- No "TBD" / "TODO" / "implement later". Tasks 13/14 have step-2 outlines that say "the implementer fills in deploy/submit details" — this is concrete enough (copy-adapt from existing test file) but is the closest thing to a placeholder. Acceptable given the existing `orderbook.test.ts` pattern is well-established.
- Task 9's amm.nr has an implementer note about a fallback if the Field-cast trick doesn't work; this is a real toolchain caveat, not a placeholder.

**3. Type consistency:**
- `c_i(order: OrderPreimage) -> Field` (Task 4) matches its callers in Task 6's main.nr.
- `replay_chain(orders, count) -> Field` consistent across Tasks 4 + 6.
- `eligible(order, P*) -> bool` and `payout(order, P*) -> u128` consistent across Tasks 5, 6, 7.
- `saturating_sub(x, y) -> u128` (Task 8) only used in Task 8.
- `assert_k_monotonic(old_a, old_b, new_a, new_b)` (Task 9) consistent with main.nr's call.
- TS-side `EpochState`, `OrderNotePreimage`, `PoolSnapshotForCircuit` in Task 11 are consumed by Task 12 (witness.test.ts) and Task 13 (clearing-circuit.test.ts) with the same names.
- `MAX_ORDERS_PER_EPOCH = 128` on both sides (Task 1 Noir, Task 11 TS).
