# Week 5d-3: On-chain Recursive Verify Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Week 5c `clearing_authority` gate on the orderbook with a recursive `std::verify_proof_with_type` call against the embedded Week 5d-2 clearing-circuit verification key, and reduce `MAX_ORDERS_PER_EPOCH` from 128 to 32 so the production circuit's proof actually fits in the dev VPS's RAM budget.

**Architecture:** A new private function `close_epoch_and_clear_verified(public_inputs, proof)` verifies via `std::verify_proof_with_type` (constrained ACIR — only callable from `#[external("private")]`), then enqueues `_apply_verified_clearing(public_inputs)`, an `#[only_self]` public callback that runs the Week 5c clearing flow (net AMM swap + fill recording + epoch advance) under public-state guards. Replay protection is automatic via Week 5d-1's accumulator binding — a replayed proof's `order_acc` cannot match the post-clearing epoch's reset value of `0`. VK and `vk_hash` are constructor-bound `PublicImmutable`s populated from `circuits/clearing/target/vk/` at deploy.

**Tech Stack:** Noir 1.0.0-beta.19 + `std::verify_proof_with_type` (Honk proof type 1), aztec-nr v4.2.0, Aztec.js v4.2.1, the `bb` prover bundled at `~/.aztec/versions/4.2.1/node_modules/@aztec/bb.js/build/<arch>/bb`, TypeScript `node:test` + `tsx`.

**Source spec:** `docs/superpowers/specs/2026-05-20-zswap-aztec-week-05d-3-onchain-recursive-verify-design.md`

**Execution preconditions:**
- VPS dev stack on `zswap-vps` (anvil :18545, aztec :18080) running.
- Local Mac + VPS both have Aztec 4.2.1 toolchain (set up in 5d-2). `bb` available at `/root/.aztec/versions/4.2.1/node_modules/@aztec/bb.js/build/amd64-linux/bb` on VPS.
- HEAD is `3cd1712` (Week 5d-3 spec committed).

**Headline risk:** Task 1 reduces N to 32 expecting the N=32 production circuit will fit in proof-gen RAM. Empirically validated in Task 6 (live e2e). If E1 OOMs at N=32, the contingency is N=16 — implementer falls back, re-running Task 1's edits with the smaller constant.

---

## File Structure

**Modified:**
- `circuits/clearing/src/types.nr` — `MAX_ORDERS_PER_EPOCH` 128 → 32.
- `contracts/orderbook/src/main.nr` — `MAX_ORDERS_PER_EPOCH` 128 → 32; storage diff (drop `clearing_authority`, add `clearing_vk` + `clearing_vk_hash`); constructor signature; new `flatten_clearing_public` helper; new private `close_epoch_and_clear_verified` + public callback `_apply_verified_clearing`; remove W5c `close_epoch_and_clear(fills, swap)`.
- `contracts/orderbook/src/test.nr` — drop W5c authority tests; add 5d-3 schema + callback negative tests; update IT5's skip message.
- `aggregator/src/clearing.ts` — `MAX_ORDERS_PER_EPOCH = 32`.
- `aggregator/src/witness.ts` — `MAX_ORDERS_PER_EPOCH = 32`.
- `aggregator/test/witness.test.ts` — adjust reference vectors for N=32.
- `tests/integration/clearing.test.ts` — full rewrite from W5c trusted-flow to 5d-3 verified-flow (E1+E2+E3).
- `tests/integration/orderbook.test.ts` — IT5's skip message N=128 → N=32; IT6b (which used W5c's deleted `close_epoch_and_clear`) deleted (the new E1 covers epoch reset).
- `tests/integration/clearing-circuit.test.ts` (5d-2's) — use the new proof-byte helper from Task 5.
- `scripts/deploy-tokens.ts` — read `circuits/clearing/target/vk/vk` + `target/vk/vk_hash`, pass to orderbook constructor.
- `cli/src/commands/close-epoch.ts` — extend with `close-epoch-verified` subcommand; existing `close-epoch` (no-clear fallback) stays.

**Created:**
- `tests/integration/helpers/proof.ts` — `readProofAsFields(path: string): Promise<Fr[]>`.

**Not touched:** `contracts/pool/*`, `contracts/token/*`, `circuits/clearing/src/{binding,pricing,amm,main,test}.nr`.

---

## Task 1: Reduce `MAX_ORDERS_PER_EPOCH` from 128 to 32

A four-file global-sabit change. After this task, all downstream code is N=32. Empirical proof-gen viability is validated in Task 6 (E1); if it OOMs there, the contingency is to redo Task 1 with N=16.

**Files:**
- Modify: `circuits/clearing/src/types.nr`
- Modify: `contracts/orderbook/src/main.nr`
- Modify: `aggregator/src/clearing.ts`
- Modify: `aggregator/src/witness.ts`
- Modify: `aggregator/test/witness.test.ts`
- Modify: `tests/integration/orderbook.test.ts` (IT5 skip message)

- [ ] **Step 1: Edit `circuits/clearing/src/types.nr`.**

Change `pub global MAX_ORDERS_PER_EPOCH: u32 = 128;` to `pub global MAX_ORDERS_PER_EPOCH: u32 = 32;`. One-line change.

- [ ] **Step 2: Edit `contracts/orderbook/src/main.nr`.**

Find the line `pub global MAX_ORDERS_PER_EPOCH: u32 = 128;` (introduced in Week 5d-1 Task 1) and change to `pub global MAX_ORDERS_PER_EPOCH: u32 = 32;`.

- [ ] **Step 3: Edit `aggregator/src/clearing.ts`.**

Find `export const MAX_ORDERS_PER_EPOCH = 128;` near the top of the file and change to `export const MAX_ORDERS_PER_EPOCH = 32;`.

- [ ] **Step 4: Edit `aggregator/src/witness.ts`.**

Find `export const MAX_ORDERS_PER_EPOCH = 128;` and change to `export const MAX_ORDERS_PER_EPOCH = 32;`.

- [ ] **Step 5: Edit `aggregator/test/witness.test.ts`.**

The "emits the full fixed-size order/index/fill arrays" test asserts `ordersEntries === MAX_ORDERS_PER_EPOCH` — that import already points to the renamed const so it picks up 32 automatically. No code change needed for that assertion. Verify by reading the test that no hardcoded `128` lurks; if any exists, change to `32`.

- [ ] **Step 6: Edit `tests/integration/orderbook.test.ts` — IT5's skip message.**

Find the `it.skip(` for IT5 — the existing skip name is `"IT5: 128 submits succeed and the 129th reverts with epoch order capacity reached (skipped on Aztec 4.2.1: PXE tagging window)"`. Change the visible numbers from 128/129 to 32/33:

```ts
  it.skip(
    "IT5: 32 submits succeed and the 33rd reverts with epoch order capacity reached (still skipped: Aztec 4.2.1 PXE tagging window per-wallet cap is 20)",
    { timeout: 90 * 60 * 1_000 },
    async () => {
      ...
```

(The inner body keeps the existing `for (let i = 0; i < 128; i++)` loop — it stays unreachable while `.skip` is in place. Update the literal to 32 and the post-loop assertion to 32 for clarity; the test stays skipped either way.)

- [ ] **Step 7: Recompile + run TXE + run aggregator unit tests.**

Run:
```
pnpm compile 2>&1 | tail -10
pnpm test:noir 2>&1 | grep -E "tests? (passed|failed)" | tail -5
pnpm --filter @zswap/aggregator test 2>&1 | tail -10
```

Expected:
- `pnpm compile` completes 0, including the circuit compile.
- `pnpm test:noir` shows 14+10+4 = 28 TXE tests passing AND 11 Noir clearing-circuit unit tests passing.
- `pnpm --filter @zswap/aggregator test` shows the full aggregator suite (last count = 29) green.

If the test counts changed (e.g., one of the witness.test.ts reference vectors now mismatches because of the N reduction), open that test file and adjust the expected sizes (replace any literal `128` in array-length expectations with `32`, replace any `256` reflecting old `fills.length × 2` flatten with `64`, etc.).

- [ ] **Step 8: Commit.**

```
git add circuits/clearing/src/types.nr contracts/orderbook/src/main.nr aggregator/src/clearing.ts aggregator/src/witness.ts aggregator/test/witness.test.ts tests/integration/orderbook.test.ts
git commit -m "refactor: reduce MAX_ORDERS_PER_EPOCH from 128 to 32

The production N=128 clearing circuit (~904K gates) OOMs at proof
generation on the dev VPS. Reducing N to 32 puts the circuit at
~57K gates (O(N^2) reduction via the scan-and-pick loops), which
fits in the VPS's 8 GB + swap RAM budget. Cap remains enforced by
the same _append_order assert. IT5 stays skipped (Aztec 4.2.1
PXE tagging window per-wallet cap is 20, still below 32).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Orderbook storage diff + constructor signature + deploy-tokens.ts

Replace `clearing_authority` with `clearing_vk` + `clearing_vk_hash`. Update the constructor + deploy script. The W5c `close_epoch_and_clear(fills, swap)` function still exists but its authority check now references a removed field — comment it out temporarily OR keep it un-built-against (Task 4 deletes the whole function).

**Files:**
- Modify: `contracts/orderbook/src/main.nr`
- Modify: `contracts/orderbook/src/test.nr`
- Modify: `scripts/deploy-tokens.ts`

- [ ] **Step 1: Update `Storage` struct in `contracts/orderbook/src/main.nr`.**

Find the `struct Storage<Context>` block. Remove the `clearing_authority` line:

```noir
    // DELETE THIS LINE:
    clearing_authority: PublicImmutable<AztecAddress, Context>,
```

Add the two new lines in its place:

```noir
    /// Clearing circuit verification key (5d-2 circuit). Initialised at deploy
    /// and immutable thereafter. The orderbook is bound to one specific circuit
    /// by VK identity.
    clearing_vk: PublicImmutable<[Field; 112], Context>,
    /// Hash of `clearing_vk` (`bb write_vk` writes both files alongside each other).
    /// std::verify_proof_with_type requires the hash as a separate argument.
    clearing_vk_hash: PublicImmutable<Field, Context>,
```

- [ ] **Step 2: Update the constructor signature + body in `contracts/orderbook/src/main.nr`.**

Find the `fn constructor(...)` block. Replace the `clearing_authority: AztecAddress,` parameter with the two new ones. The full new constructor signature:

```noir
    fn constructor(
        token_a: AztecAddress,
        token_b: AztecAddress,
        epoch_length: u32,
        pool_addr: AztecAddress,
        clearing_vk: [Field; 112],
        clearing_vk_hash: Field,
    ) {
```

Update the body: replace `self.storage.clearing_authority.initialize(clearing_authority);` with:

```noir
        self.storage.clearing_vk.initialize(clearing_vk);
        self.storage.clearing_vk_hash.initialize(clearing_vk_hash);
```

- [ ] **Step 3: Update the orderbook's getter for clearing_authority — DELETE it.**

Find `unconstrained fn get_clearing_authority()` (Week 5c). Delete the entire function. Add two new getters in its place:

```noir
    /// Exposes the embedded clearing-circuit VK for off-chain verifier code that
    /// wants to sanity-check parity with the local target/vk file.
    #[external("utility")]
    unconstrained fn get_clearing_vk() -> [Field; 112] {
        self.storage.clearing_vk.read()
    }

    /// Exposes the embedded clearing-circuit VK hash.
    #[external("utility")]
    unconstrained fn get_clearing_vk_hash() -> Field {
        self.storage.clearing_vk_hash.read()
    }
```

- [ ] **Step 4: Temporarily silence the W5c `close_epoch_and_clear` function's authority check.**

The W5c fn at `contracts/orderbook/src/main.nr` starts with:
```noir
    fn close_epoch_and_clear(
        fills: BoundedVec<FillEntry, MAX_ORDERS_PER_EPOCH>,
        swap: LiquidityPool::ClearingSwap,
    ) {
        assert(self.msg_sender() == self.storage.clearing_authority.read(), "not clearing authority");
        ...
```

Replace ONLY that assert line with an unconditional revert so the function compiles but is effectively dead:

```noir
        assert(false, "close_epoch_and_clear deprecated; use close_epoch_and_clear_verified");
```

(Task 4 deletes the entire function. This step keeps the function callable-with-revert in the interim so Task 2 can compile + tests can run.)

- [ ] **Step 5: Update `contracts/orderbook/src/test.nr` — drop W5c authority tests, update constructor test.**

Find the test `close_epoch_and_clear_rejects_non_authority` (W5c) and DELETE it entirely — the assertion it's checking no longer exists.

Find the test `close_epoch_and_clear_rejects_before_expiry` (W5c) and DELETE it — same reason (the W5c fn now reverts unconditionally, so testing its expiry gate is moot).

Find `constructor_records_token_addrs_and_epoch_length` and update the `deploy_orderbook` helper signature + the test body. The helper takes `clearing_authority: AztecAddress` today; replace with `clearing_vk: [Field; 112]` + `clearing_vk_hash: Field`. Pass dummy values (all zeros) in test calls. The full helper:

```noir
unconstrained fn deploy_orderbook(
    env: &mut TestEnvironment,
    deployer: AztecAddress,
    token_a: AztecAddress,
    token_b: AztecAddress,
    epoch_length: u32,
    pool_addr: AztecAddress,
    clearing_vk: [Field; 112],
    clearing_vk_hash: Field,
) -> AztecAddress {
    let initializer_call =
        Orderbook::interface().constructor(token_a, token_b, epoch_length, pool_addr, clearing_vk, clearing_vk_hash);
    env.deploy("Orderbook").with_public_initializer(deployer, initializer_call)
}
```

Update every existing call site of `deploy_orderbook` in `test.nr` to pass `[0 as Field; 112]` and `0` for the two new args. Inside the `constructor_records_token_addrs_and_epoch_length` test, replace the `clearing_authority` assertion with VK assertions:

```noir
    let vk_dummy: [Field; 112] = [0 as Field; 112];
    let vk_hash_dummy: Field = 0;
    let orderbook = deploy_orderbook(&mut env, deployer, token_a, token_b, 42, pool_placeholder, vk_dummy, vk_hash_dummy);

    let stored_a: AztecAddress = env.execute_utility(Orderbook::at(orderbook).get_token_a_addr());
    let stored_b: AztecAddress = env.execute_utility(Orderbook::at(orderbook).get_token_b_addr());
    let stored_len: u32 = env.execute_utility(Orderbook::at(orderbook).get_epoch_length());
    let stored_pool: AztecAddress = env.execute_utility(Orderbook::at(orderbook).get_pool_addr());
    let stored_vk: [Field; 112] = env.execute_utility(Orderbook::at(orderbook).get_clearing_vk());
    let stored_vk_hash: Field = env.execute_utility(Orderbook::at(orderbook).get_clearing_vk_hash());

    assert(stored_a == token_a, "stored token_a must round-trip");
    assert(stored_b == token_b, "stored token_b must round-trip");
    assert(stored_len == 42, "stored epoch_length must round-trip");
    assert(stored_pool == pool_placeholder, "stored pool_addr must round-trip");
    // Quick spot check that the VK round-trips (zero-filled in this test); a fuller
    // check would compare all 112 entries — the spot-check covers serialisation.
    assert(stored_vk[0] == 0, "stored clearing_vk[0] must round-trip");
    assert(stored_vk_hash == 0, "stored clearing_vk_hash must round-trip");
```

(Remove the previous `let clearing_placeholder = env.create_light_account();` + `stored_clearing` lines, plus the `assert(stored_clearing == clearing_placeholder, ...)` assertion, all of which referenced the removed `clearing_authority` field.)

- [ ] **Step 6: Update `scripts/deploy-tokens.ts` to pass VK + vk_hash.**

The existing script calls `OrderbookContract.deploy(wallet, tokenA, tokenB, epoch_length, pool, admin)` where the last `admin` was the clearing_authority. Replace that last arg with the VK + vk_hash pair, loaded from `circuits/clearing/target/vk/`. Insert a helper at the top of the file:

```ts
import { readFileSync } from "node:fs";
import { Fr } from "@aztec/aztec.js/fields";

function readVkAndHash(): { vk: Fr[]; vkHash: Fr } {
  const vkBuf = readFileSync("circuits/clearing/target/vk/vk");
  const hashBuf = readFileSync("circuits/clearing/target/vk/vk_hash");
  if (vkBuf.length !== 112 * 32) {
    throw new Error(`expected 3584-byte vk, got ${vkBuf.length}`);
  }
  if (hashBuf.length !== 32) {
    throw new Error(`expected 32-byte vk_hash, got ${hashBuf.length}`);
  }
  const vk: Fr[] = [];
  for (let i = 0; i < 112; i++) {
    vk.push(Fr.fromBuffer(vkBuf.subarray(i * 32, (i + 1) * 32)));
  }
  const vkHash = Fr.fromBuffer(hashBuf);
  return { vk, vkHash };
}
```

(If `Fr.fromBuffer` is named differently in the local aztec.js fields module, use whatever buffer-to-Fr constructor exists — check by `grep -nE "fromBuffer|fromBigInt" node_modules/.pnpm/@aztec+aztec.js*/node_modules/@aztec/aztec.js/dest/fields/*.d.ts` — and adapt.)

Then update the orderbook deploy call to pass `vk` + `vkHash`:

```ts
const { vk, vkHash } = readVkAndHash();
const ob = await OrderbookContract.deploy(
  wallet,
  tUSDC.address,
  tETH.address,
  epoch_length,
  pool.address,
  vk,        // [Field; 112]
  vkHash,    // Field
).send({ from: admin });
```

- [ ] **Step 7: Recompile + run TXE.**

```
pnpm compile 2>&1 | tail -10
pnpm test:noir 2>&1 | grep -E "tests? (passed|failed)" | tail -5
```

Expected: clean compile + TXE shows 12+10+4 = 26 tests passing (we deleted 2 W5c authority tests). If 14 still shows for orderbook, the deletes didn't take effect.

- [ ] **Step 8: Commit.**

```
git add contracts/orderbook/src/main.nr contracts/orderbook/src/test.nr scripts/deploy-tokens.ts
git commit -m "feat(orderbook): drop clearing_authority; add clearing_vk + vk_hash

The Week 5c clearing_authority is replaced by an embedded verification key
(constructor-bound, immutable). 5d-3's recursive verify reads
clearing_vk + clearing_vk_hash from PublicImmutable storage. The W5c
close_epoch_and_clear function is gated to revert with a deprecation
message until Task 4 removes it; the W5c-only TXE tests
(close_epoch_and_clear_rejects_non_authority, _rejects_before_expiry)
are deleted with it. deploy-tokens.ts reads target/vk/vk + target/vk/vk_hash
and passes them to the constructor.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: `flatten_clearing_public` Noir helper + unit test

A pure function that serialises a `ClearingPublic` to `[Field; 83]` in the exact order `circuits/clearing/src/main.nr`'s `fn main` declares its `pub` parameters. The verifier inside `close_epoch_and_clear_verified` (Task 4) calls this once per tx.

**Files:**
- Modify: `contracts/orderbook/src/main.nr`
- Modify: `contracts/orderbook/src/test.nr`

- [ ] **Step 1: Add a `ClearingPublic` struct declaration to `contracts/orderbook/src/main.nr`.**

The contract needs the struct to type the public_inputs parameter. Place it near the other struct decls (e.g., right after `FillEntry`):

```noir
    /// Mirror of the Week 5d-2 clearing circuit's `ClearingPublic`. Field
    /// order MUST match `circuits/clearing/src/main.nr`'s fn main pub parameter
    /// declaration order, otherwise `flatten_clearing_public` produces a vector
    /// the prover did not flatten to and the verify rejects.
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
        pub fills:          [FillEntry; MAX_ORDERS_PER_EPOCH],
        pub fills_len:      u32,
        pub swap:           LiquidityPool::ClearingSwap,
    }
```

- [ ] **Step 2: Add `flatten_clearing_public` to `contracts/orderbook/src/main.nr`.**

Place it just before the `// ============================ CLEARING ============================` divider (where `close_epoch_and_clear_verified` will go in Task 4):

```noir
    /// Flatten a ClearingPublic to the [Field; 83] vector the recursive verifier
    /// expects. Slot order matches `circuits/clearing/src/main.nr`'s fn main pub
    /// parameter declaration order: scalars, then `fills`, then `fills_len`, then
    /// the 10 swap fields. ANY reorder on the circuit side requires the matching
    /// reorder here.
    fn flatten_clearing_public(p: ClearingPublic) -> [Field; 83] {
        let mut out: [Field; 83] = [0 as Field; 83];
        out[0] = p.order_acc;
        out[1] = p.cancel_acc;
        out[2] = p.order_count as Field;
        out[3] = p.cancel_count as Field;
        out[4] = p.reserve_a as Field;
        out[5] = p.reserve_b as Field;
        out[6] = p.lp_supply as Field;
        out[7] = p.clearing_price as Field;
        for i in 0..MAX_ORDERS_PER_EPOCH {
            out[8 + 2 * i] = p.fills[i].order_nonce;
            out[9 + 2 * i] = p.fills[i].amount_out as Field;
        }
        out[72] = p.fills_len as Field;
        out[73] = p.swap.a_to_pool as Field;
        out[74] = p.swap.b_to_pool as Field;
        out[75] = p.swap.a_from_pool as Field;
        out[76] = p.swap.b_from_pool as Field;
        out[77] = p.swap.reserve_a_add as Field;
        out[78] = p.swap.reserve_a_sub as Field;
        out[79] = p.swap.reserve_b_add as Field;
        out[80] = p.swap.reserve_b_sub as Field;
        out[81] = p.swap.fee_a_per_share_increment as Field;
        out[82] = p.swap.fee_b_per_share_increment as Field;
        out
    }
```

(`flatten_clearing_public` is not annotated with `#[external(...)]` — it's a contract-internal helper.)

- [ ] **Step 3: Add a TXE unit test for the slot order.**

Append to `contracts/orderbook/src/test.nr`:

```noir
#[test]
unconstrained fn flatten_clearing_public_slot_order() {
    use crate::Orderbook::{flatten_clearing_public, ClearingPublic, FillEntry};
    use pool::LiquidityPool;

    // Build a ClearingPublic with distinctive values per slot so any reorder shows up.
    let mut fills: [FillEntry; Orderbook::MAX_ORDERS_PER_EPOCH] = [
        FillEntry { order_nonce: 0, amount_out: 0 as u128 };
        Orderbook::MAX_ORDERS_PER_EPOCH
    ];
    fills[0] = FillEntry { order_nonce: 100, amount_out: 200 as u128 };
    fills[1] = FillEntry { order_nonce: 101, amount_out: 201 as u128 };

    let p = ClearingPublic {
        order_acc:      11,
        cancel_acc:     22,
        order_count:    33,
        cancel_count:   44,
        reserve_a:      55 as u128,
        reserve_b:      66 as u128,
        lp_supply:      77 as u128,
        clearing_price: 88 as u128,
        fills,
        fills_len:      2,
        swap: LiquidityPool::ClearingSwap {
            a_to_pool: 1001 as u128, b_to_pool: 1002 as u128,
            a_from_pool: 1003 as u128, b_from_pool: 1004 as u128,
            reserve_a_add: 1005 as u128, reserve_a_sub: 1006 as u128,
            reserve_b_add: 1007 as u128, reserve_b_sub: 1008 as u128,
            fee_a_per_share_increment: 1009 as u128, fee_b_per_share_increment: 1010 as u128,
        },
    };

    let flat = flatten_clearing_public(p);

    assert(flat[0] == 11, "slot 0 order_acc");
    assert(flat[1] == 22, "slot 1 cancel_acc");
    assert(flat[2] == 33, "slot 2 order_count");
    assert(flat[3] == 44, "slot 3 cancel_count");
    assert(flat[4] == 55, "slot 4 reserve_a");
    assert(flat[5] == 66, "slot 5 reserve_b");
    assert(flat[6] == 77, "slot 6 lp_supply");
    assert(flat[7] == 88, "slot 7 clearing_price");
    // fills[0] is at slots 8-9, fills[1] at slots 10-11
    assert(flat[8] == 100, "slot 8 fills[0].order_nonce");
    assert(flat[9] == 200, "slot 9 fills[0].amount_out");
    assert(flat[10] == 101, "slot 10 fills[1].order_nonce");
    assert(flat[11] == 201, "slot 11 fills[1].amount_out");
    // fills_len is at slot 72 (after 32 entries × 2 = 64 slots starting at 8)
    assert(flat[72] == 2, "slot 72 fills_len");
    assert(flat[73] == 1001, "slot 73 swap.a_to_pool");
    assert(flat[74] == 1002, "slot 74 swap.b_to_pool");
    assert(flat[75] == 1003, "slot 75 swap.a_from_pool");
    assert(flat[76] == 1004, "slot 76 swap.b_from_pool");
    assert(flat[77] == 1005, "slot 77 swap.reserve_a_add");
    assert(flat[78] == 1006, "slot 78 swap.reserve_a_sub");
    assert(flat[79] == 1007, "slot 79 swap.reserve_b_add");
    assert(flat[80] == 1008, "slot 80 swap.reserve_b_sub");
    assert(flat[81] == 1009, "slot 81 swap.fee_a_per_share_increment");
    assert(flat[82] == 1010, "slot 82 swap.fee_b_per_share_increment");
}
```

- [ ] **Step 4: Recompile + run TXE.**

```
pnpm compile 2>&1 | tail -5
pnpm test:noir 2>&1 | grep -E "tests? (passed|failed)" | tail -5
```

Expected: orderbook test count goes from 12 (Task 2) to 13 (one new test).

- [ ] **Step 5: Commit.**

```
git add contracts/orderbook/src/main.nr contracts/orderbook/src/test.nr
git commit -m "feat(orderbook): flatten_clearing_public + ClearingPublic struct

Adds the contract-side ClearingPublic struct mirroring the 5d-2 circuit
plus a flatten_clearing_public helper that serialises it to the [Field; 83]
vector the recursive verifier expects. Slot order is locked to the
fn main pub parameter declaration order in circuits/clearing/src/main.nr;
any reorder on either side breaks verification. One TXE unit test asserts
the slot layout against distinctive per-slot values.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: New private `close_epoch_and_clear_verified` + public callback `_apply_verified_clearing`; delete W5c `close_epoch_and_clear`

The substantive contract change. Replaces the dead-coded W5c function with the new verified flow.

**Files:**
- Modify: `contracts/orderbook/src/main.nr`
- Modify: `contracts/orderbook/src/test.nr`
- Modify: `tests/integration/orderbook.test.ts` (delete IT6b)

- [ ] **Step 1: Delete the W5c `close_epoch_and_clear` function in `contracts/orderbook/src/main.nr`.**

Find:
```noir
    #[external("public")]
    fn close_epoch_and_clear(
        fills: BoundedVec<FillEntry, MAX_ORDERS_PER_EPOCH>,
        swap: LiquidityPool::ClearingSwap,
    ) {
        assert(false, "close_epoch_and_clear deprecated; use close_epoch_and_clear_verified");
        ...
    }
```

Delete the entire function (start to closing `}`).

- [ ] **Step 2: Add the new private function + public callback in its place.**

```noir
    /// Apply one epoch's clearing on-chain, gated by a recursive verify of the
    /// Week 5d-2 clearing circuit's proof. The replacement for the W5c
    /// `close_epoch_and_clear`: no authority gate, no trust — anyone holding
    /// `(public_inputs, proof)` for the current epoch may advance it.
    ///
    /// Flow:
    /// 1. Flatten public_inputs to the [Field; 83] vector matching the prover's view.
    /// 2. `std::verify_proof_with_type(vk, proof, flat, vk_hash, 1)` — recursive verify
    ///    against the embedded clearing-circuit VK. Aborts the tx on a bad proof.
    /// 3. Enqueue `_apply_verified_clearing` which under public-state guards verifies
    ///    freshness (binding inputs match the current epoch's accumulators), runs the
    ///    net AMM swap + records fills + advances the epoch.
    ///
    /// Replay protection is automatic: an old proof's order_acc cannot match the
    /// post-clearing epoch's reset acc (=0).
    #[external("private")]
    fn close_epoch_and_clear_verified(
        public_inputs: ClearingPublic,
        proof: [Field; 456],
    ) {
        let flat = flatten_clearing_public(public_inputs);
        let vk = self.storage.clearing_vk.read();
        let vk_hash = self.storage.clearing_vk_hash.read();
        // 1 = Honk proof type per Aztec/bb conventions.
        std::verify_proof_with_type(vk, proof, flat, vk_hash, 1);
        self.enqueue_self._apply_verified_clearing(public_inputs);
    }

    /// Public callback: under public-state guards, run the net AMM swap, record
    /// per-order fills, and advance the epoch. only_self ensures only the matching
    /// close_epoch_and_clear_verified private call (via enqueue_self) can invoke it.
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

        // Net AMM swap (identical to the W5c flow).
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

        // Record each fill (same loop as W5c's close_epoch_and_clear).
        for i in 0..MAX_ORDERS_PER_EPOCH {
            if (i as u32) < public_inputs.fills_len {
                let e = public_inputs.fills[i];
                assert(e.amount_out > 0 as u128, "fill amount must be positive");
                assert(
                    self.storage.fills.at(e.order_nonce).read() == 0 as u128,
                    "order already filled",
                );
                self.storage.fills.at(e.order_nonce).write(e.amount_out);
            }
        }

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

- [ ] **Step 3: Add TXE negative tests in `contracts/orderbook/src/test.nr`.**

Append:

```noir
// _apply_verified_clearing is #[only_self]; an external public call must reject.
// We synthesize a minimal ClearingPublic with empty fills + zero swap so the
// callback's body would be a no-op if the only_self guard didn't fire first.
#[test(should_fail_with = "only this contract")]
unconstrained fn apply_verified_clearing_rejects_external_call() {
    let mut env = TestEnvironment::new();
    let deployer = env.create_light_account();
    let vk_dummy: [Field; 112] = [0 as Field; 112];
    let orderbook = deploy_orderbook(&mut env, deployer, deployer, deployer, 100, deployer, vk_dummy, 0);

    let mut fills: [Orderbook::FillEntry; Orderbook::MAX_ORDERS_PER_EPOCH] = [
        Orderbook::FillEntry { order_nonce: 0, amount_out: 0 as u128 };
        Orderbook::MAX_ORDERS_PER_EPOCH
    ];
    let zero_swap = pool::LiquidityPool::ClearingSwap {
        a_to_pool: 0 as u128, b_to_pool: 0 as u128, a_from_pool: 0 as u128, b_from_pool: 0 as u128,
        reserve_a_add: 0 as u128, reserve_a_sub: 0 as u128, reserve_b_add: 0 as u128,
        reserve_b_sub: 0 as u128, fee_a_per_share_increment: 0 as u128, fee_b_per_share_increment: 0 as u128,
    };
    let pi = Orderbook::ClearingPublic {
        order_acc: 0, cancel_acc: 0, order_count: 0, cancel_count: 0,
        reserve_a: 0 as u128, reserve_b: 0 as u128, lp_supply: 0 as u128,
        clearing_price: 0 as u128,
        fills, fills_len: 0, swap: zero_swap,
    };

    let stranger = env.create_light_account();
    // The #[only_self] guard fires before any body logic. Expected revert message
    // matches aztec-nr's only_self diagnostic.
    env.call_public(stranger, Orderbook::at(orderbook)._apply_verified_clearing(pi));
}

// Callback rejects when block < closes_at_block. We bypass #[only_self] by calling
// from the orderbook itself via the call_public_from_contract idiom — but TestEnvironment
// doesn't expose that. Instead exercise the early-expiry case at the integration layer.
// (E1 in tests/integration/clearing.test.ts covers the freshness path end-to-end.)
```

(Note: the test for the `epoch has not expired yet` and `order_acc mismatch` guards inside `_apply_verified_clearing` is left to integration (E3 in clearing.test.ts) because TestEnvironment doesn't naturally support calling `#[only_self]` functions as the contract itself. The on-chain integration covers them.)

- [ ] **Step 4: Delete IT6b from `tests/integration/orderbook.test.ts`.**

Find the `it("IT6b: close_epoch_and_clear resets all four accumulator fields from a nonzero state", ...)` block and delete it entirely. The fresh-fixture deploy inside it called the now-deleted W5c `close_epoch_and_clear(emptyFills, zeroSwap)`. IT6a (the close_epoch path) stays; the new E1 in clearing.test.ts (Task 6) covers the close-with-clearing path including reset.

- [ ] **Step 5: Recompile + run TXE.**

```
pnpm compile 2>&1 | tail -10
pnpm test:noir 2>&1 | grep -E "tests? (passed|failed)" | tail -5
```

Expected: orderbook test count is 14 (13 from Task 3 + 1 new only_self negative). Pool + Token counts unchanged.

- [ ] **Step 6: Commit.**

```
git add contracts/orderbook/src/main.nr contracts/orderbook/src/test.nr tests/integration/orderbook.test.ts
git commit -m "feat(orderbook): close_epoch_and_clear_verified (recursive verify)

New private close_epoch_and_clear_verified takes (ClearingPublic, [Field; 456]
proof), flattens public_inputs to [Field; 83], calls
std::verify_proof_with_type against the embedded VK + vk_hash, then
enqueues _apply_verified_clearing. The public callback (#[only_self]) runs
the W5c clearing flow (Pool::apply_clearing + fill recording + epoch
advance) under public-state guards including the freshness binding to
the current epoch's accumulators (replay protection).

The Week 5c authority-gated close_epoch_and_clear function is deleted.
IT6b in orderbook.test.ts (which exercised that function) is removed;
the new E1 in clearing.test.ts (next task) covers the verified flow
including epoch reset.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: `tests/integration/helpers/proof.ts` — Honk proof byte → Fr[]

A focused TS helper used by 5d-2's existing `clearing-circuit.test.ts` and 5d-3's new `clearing.test.ts` (Task 6).

**Files:**
- Create: `tests/integration/helpers/proof.ts`
- Modify: `tests/integration/clearing-circuit.test.ts` (use the helper)

- [ ] **Step 1: Write `tests/integration/helpers/proof.ts`.**

```ts
import { readFileSync } from "node:fs";
import { Fr } from "@aztec/aztec.js/fields";

/** Honk proof size in Fr field elements (per Aztec/bb conventions). */
export const HONK_PROOF_FIELDS = 456;
/** Honk proof size in bytes (each Fr serialises as 32 bytes, big-endian). */
export const HONK_PROOF_BYTES = HONK_PROOF_FIELDS * 32;

/**
 * Read `bb prove`'s binary proof output and parse it as a [Fr; 456] array
 * matching the shape `circuits/clearing/main.nr`'s `fn main` `proof:
 * [Field; 456]` argument expects. The orderbook's close_epoch_and_clear_verified
 * takes this array directly.
 */
export function readProofAsFields(path: string): Fr[] {
  const buf = readFileSync(path);
  if (buf.length !== HONK_PROOF_BYTES) {
    throw new Error(`expected ${HONK_PROOF_BYTES}-byte proof, got ${buf.length} (${path})`);
  }
  const fields: Fr[] = [];
  for (let i = 0; i < HONK_PROOF_FIELDS; i++) {
    fields.push(Fr.fromBuffer(buf.subarray(i * 32, (i + 1) * 32)));
  }
  return fields;
}
```

If `Fr.fromBuffer` is not the exact import (check via `grep -nE "^export|fromBuffer" node_modules/.pnpm/@aztec+aztec.js*/node_modules/@aztec/aztec.js/dest/fields/*.d.ts`), use the actual constructor the package exposes — common alternatives: `new Fr(buf)` or `Fr.fromBytes(buf)`.

- [ ] **Step 2: Adapt `tests/integration/clearing-circuit.test.ts` (5d-2 e2e) to use the helper.**

Open the file. Find the existing inline proof-parsing logic (likely a `readFileSync` + per-32-byte loop inside the test body). Replace it with:

```ts
import { readProofAsFields } from "./helpers/proof.js";

// ... inside the test:
const proofFields = readProofAsFields(`${CIRCUIT_DIR}/target/proof/proof`);
```

(The CIRCUIT_DIR path may currently target `circuits/clearing-test/` per the 5d-2 e2e — keep that, the helper is path-agnostic.)

- [ ] **Step 3: Sync to VPS + run the 5d-2 e2e to confirm the helper works.**

```
rsync -e ssh tests/integration/helpers/proof.ts zswap-vps:/root/zswap-aztec/tests/integration/helpers/proof.ts
rsync -e ssh tests/integration/clearing-circuit.test.ts zswap-vps:/root/zswap-aztec/tests/integration/clearing-circuit.test.ts
ssh zswap-vps "source /root/.zswap-env && cd /root/zswap-aztec && pnpm codegen > /tmp/codegen.log 2>&1 && cd tests && AZTEC_NODE_URL=http://localhost:18080 timeout 1800 node --import tsx --test --test-concurrency=1 --test-reporter=spec --test-name-pattern='E1' integration/clearing-circuit.test.ts 2>&1 | tail -30"
```

Expected: E1 passes (1 pass, 0 fail). The helper-based parsing produces the same Fr[] the inline code did.

- [ ] **Step 4: Commit.**

```
git add tests/integration/helpers/proof.ts tests/integration/clearing-circuit.test.ts
git commit -m "feat(tests): readProofAsFields helper

tests/integration/helpers/proof.ts exposes HONK_PROOF_FIELDS=456,
HONK_PROOF_BYTES=14592, and readProofAsFields(path) that parses
bb prove's binary output to an Fr[456] matching the circuit/contract
proof argument shape. The 5d-2 clearing-circuit.test.ts (E1) is
updated to use it.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Rewrite `tests/integration/clearing.test.ts` — E1 verified-flow happy path

The Week 5c integration test file currently tests the trusted `close_epoch_and_clear` flow. Replace it with the verified-flow E1: deploy fresh fixture (with real VK from circuits/clearing/target), submit + cancel some orders, run aggregator → witness builder → nargo execute → bb prove, parse proof, call `close_epoch_and_clear_verified`, assert epoch advanced.

**Files:**
- Modify: `tests/integration/clearing.test.ts` (full rewrite)

- [ ] **Step 1: Read the existing file to understand the deploy + submit fixture.**

```
wc -l tests/integration/clearing.test.ts
sed -n '1,80p' tests/integration/clearing.test.ts
```

Confirm the existing imports + test wallets pattern. The fresh-fixture deploy currently passes `admin` (or similar) as the clearing_authority — the rewrite passes VK + vk_hash instead.

- [ ] **Step 2: Rewrite the file. The full new content:**

```ts
/**
 * Week 5d-3 end-to-end: clearing via recursive proof verification.
 *
 * E1 deploys a fresh orderbook bound to the production clearing-circuit VK,
 * submits a small balanced batch, runs the aggregator + witness builder +
 * nargo execute + bb prove, parses the proof bytes, then calls the new
 * close_epoch_and_clear_verified private function. The contract recursively
 * verifies and the public callback applies the clearing.
 *
 * E2 mutates one Field in the proof and asserts the tx reverts (verify fails).
 * E3 replays a valid (public_inputs, proof) and asserts the freshness assert
 * in _apply_verified_clearing rejects (E3 in a follow-up task).
 *
 * Empirical N=32 proof-gen viability: this E1 is the first thing in the
 * pipeline that depends on bb prove succeeding at N=32 against the production
 * circuit. If E1 reports OOM at the proof step, the contingency is to redo
 * Task 1 with MAX_ORDERS_PER_EPOCH = 16 (re-run all preceding tasks' compile +
 * unit tests; they're constant-sabit-agnostic at the source level).
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import type { AztecAddress } from "@aztec/aztec.js/addresses";
import type { AztecNode } from "@aztec/aztec.js/node";
import type { EmbeddedWallet } from "@aztec/wallets/embedded";
import { Fr } from "@aztec/aztec.js/fields";

import { connectToSandbox } from "./helpers/sandbox.js";
import { getTestWallets } from "./helpers/wallets.js";
import { readProofAsFields } from "./helpers/proof.js";

import { TokenContract } from "./generated/Token.js";
import { OrderbookContract } from "./generated/Orderbook.js";
import { LiquidityPoolContract } from "./generated/LiquidityPool.js";

import { computeClearing } from "../../aggregator/src/clearing.js";
import { buildClearingWitness } from "../../aggregator/src/witness.js";

// VPS paths — the circuit + bb prover live there.
const CIRCUIT_DIR = "/root/zswap-aztec/circuits/clearing";
const BB_BIN = "/root/.aztec/versions/4.2.1/node_modules/@aztec/bb.js/build/amd64-linux/bb";

const SIDE_A_TO_B = false;
const SIDE_B_TO_A = true;
const PRICE_2 = 2_000_000_000_000_000_000n;
const ONE_TUSDC = 10n ** 6n;
const ONE_TETH = 10n ** 18n;

function randomField(): bigint {
  const buf = new Uint8Array(31);
  webcrypto.getRandomValues(buf);
  let n = 0n;
  for (const byte of buf) n = (n << 8n) | BigInt(byte);
  return n;
}

function readClearingVk(): { vk: Fr[]; vkHash: Fr } {
  // Read from local repo — Task 2's pnpm compile produces these.
  const vkBuf = readFileSync("circuits/clearing/target/vk/vk");
  const hashBuf = readFileSync("circuits/clearing/target/vk/vk_hash");
  if (vkBuf.length !== 112 * 32) throw new Error(`expected 3584-byte vk, got ${vkBuf.length}`);
  if (hashBuf.length !== 32) throw new Error(`expected 32-byte vk_hash, got ${hashBuf.length}`);
  const vk: Fr[] = [];
  for (let i = 0; i < 112; i++) vk.push(Fr.fromBuffer(vkBuf.subarray(i * 32, (i + 1) * 32)));
  return { vk, vkHash: Fr.fromBuffer(hashBuf) };
}

describe("clearing verified-flow (live integration)", { timeout: 30 * 60 * 1_000 }, () => {
  let node: AztecNode;
  let wallet: EmbeddedWallet;
  let admin: AztecAddress;
  let alice: AztecAddress;
  let bob: AztecAddress;
  let tUSDC: TokenContract;
  let tETH: TokenContract;
  let pool: LiquidityPoolContract;
  let orderbook: OrderbookContract;

  before(async () => {
    node = await connectToSandbox();
    const env = await getTestWallets(node, 3);
    wallet = env.wallet;
    admin = env.accounts[0]!;
    alice = env.accounts[1]!;
    bob   = env.accounts[2]!;

    // Standard token + pool deploy (mirror the existing orderbook.test.ts pattern).
    const dU = await TokenContract.deployWithOpts(
      { wallet, method: "constructor_with_minter" },
      "tUSDC".padEnd(31, "\0"), "tUSDC".padEnd(31, "\0"), 6, admin,
    ).send({ from: admin });
    tUSDC = dU.contract;

    const dE = await TokenContract.deployWithOpts(
      { wallet, method: "constructor_with_minter" },
      "tETH".padEnd(31, "\0"), "tETH".padEnd(31, "\0"), 18, admin,
    ).send({ from: admin });
    tETH = dE.contract;

    const dPool = await LiquidityPoolContract.deploy(wallet, tUSDC.address, tETH.address)
      .send({ from: admin });
    pool = dPool.contract;

    // Deploy orderbook with the REAL clearing-circuit VK.
    const { vk, vkHash } = readClearingVk();
    const dOB = await OrderbookContract.deploy(
      wallet, tUSDC.address, tETH.address, 10_000, pool.address, vk, vkHash,
    ).send({ from: admin });
    orderbook = dOB.contract;

    // Pool's apply_clearing requires the orderbook to be registered (5c set_orderbook).
    await pool.methods.set_orderbook(orderbook.address).send({ from: admin });

    // Seed alice + bob with balances.
    await tUSDC.methods.mint_to_private(alice, 1_000n * ONE_TUSDC).send({ from: admin });
    await tETH.methods.mint_to_private(bob, 100n * ONE_TETH).send({ from: admin });
  });

  it("E1: aggregator clearing -> witness -> bb prove -> close_epoch_and_clear_verified", async () => {
    // Step 1: submit a small balanced batch (1 buy + 1 sell at intersecting limits).
    const aliceNonce = { authwit: randomField(), orderNonce: randomField() };
    await orderbook.methods.submit_order(
      SIDE_A_TO_B, 100n * ONE_TUSDC, PRICE_2, aliceNonce.authwit, aliceNonce.orderNonce,
    ).send({ from: alice });

    const bobNonce = { authwit: randomField(), orderNonce: randomField() };
    await orderbook.methods.submit_order(
      SIDE_B_TO_A, 50n * ONE_TETH, PRICE_2, bobNonce.authwit, bobNonce.orderNonce,
    ).send({ from: bob });

    // Step 2: read on-chain epoch state + orders + pool snapshot.
    const epochRaw = await orderbook.methods.get_epoch().simulate({ from: admin });
    const epoch = (epochRaw as any).result ?? epochRaw;

    const aliceOrdersRaw = await orderbook.methods.get_orders(alice).simulate({ from: alice });
    const bobOrdersRaw   = await orderbook.methods.get_orders(bob).simulate({ from: bob });
    const aliceOrders = ((aliceOrdersRaw as any).result ?? aliceOrdersRaw).storage
                          .slice(0, Number(((aliceOrdersRaw as any).result ?? aliceOrdersRaw).len));
    const bobOrders = ((bobOrdersRaw as any).result ?? bobOrdersRaw).storage
                          .slice(0, Number(((bobOrdersRaw as any).result ?? bobOrdersRaw).len));
    const orders = [...aliceOrders, ...bobOrders].map((o: any) => ({
      side: Boolean(o.side),
      amount_in: BigInt(o.amount_in),
      limit_price: BigInt(o.limit_price),
      order_nonce: BigInt(o.nonce),
      submitted_at_block: Number(o.submitted_at_block),
      owner: BigInt(o.owner.inner ?? o.owner),
    }));

    // Pool snapshot. The Pool's getter returns (reserve_a, reserve_b, lp_supply).
    const poolSimRaw = await pool.methods.get_state().simulate({ from: admin });
    const poolSim = (poolSimRaw as any).result ?? poolSimRaw;
    const poolSnapshot = {
      reserve_a: BigInt(poolSim.reserve_a),
      reserve_b: BigInt(poolSim.reserve_b),
      lp_supply: BigInt(poolSim.lp_supply),
    };

    // Step 3: aggregator computeClearing.
    const aggregatorOrders = orders.map((o) => ({
      side: o.side,
      amountIn: o.amount_in,
      limitPrice: o.limit_price,
      submittedAtBlock: o.submitted_at_block,
      orderNonce: o.order_nonce,
    }));
    const clearing = computeClearing(
      { reserveA: poolSnapshot.reserve_a, reserveB: poolSnapshot.reserve_b, lpSupply: poolSnapshot.lp_supply },
      aggregatorOrders,
    );
    assert.ok(clearing.cleared, "aggregator must produce a cleared epoch");

    // Step 4: build the Prover.toml witness.
    const { proverToml } = buildClearingWitness({
      epoch: {
        order_acc: BigInt(epoch.order_acc),
        cancel_acc: BigInt(epoch.cancel_acc),
        order_count: Number(epoch.order_count),
        cancel_count: Number(epoch.cancel_count),
      },
      pool: poolSnapshot,
      orders,
      cancellationIndices: [],
      clearing,
    });

    // Step 5: ssh write Prover.toml to VPS + run nargo execute + bb prove.
    spawnSync("ssh", ["zswap-vps", `cat > ${CIRCUIT_DIR}/Prover.toml`], { input: proverToml });

    const exec = spawnSync("ssh", ["zswap-vps",
      `source /root/.zswap-env && cd ${CIRCUIT_DIR} && nargo execute --silence-warnings 2>&1`]);
    assert.equal(exec.status, 0, `nargo execute failed: ${exec.stdout?.toString()}\n${exec.stderr?.toString()}`);

    const prove = spawnSync("ssh", ["zswap-vps",
      `${BB_BIN} prove -b ${CIRCUIT_DIR}/target/clearing.json -w ${CIRCUIT_DIR}/target/clearing.gz -o ${CIRCUIT_DIR}/target/proof -t noir-recursive 2>&1`]);
    if (prove.status !== 0) {
      // If this is the N=32 OOM scenario, the user must fall back to N=16 (re-do Task 1).
      // Surface a clear error message so the human triaging knows.
      throw new Error(`bb prove failed (likely RAM OOM at N=32; fall back to N=16): exit=${prove.status}\n${prove.stdout?.toString()}\n${prove.stderr?.toString()}`);
    }

    // Step 6: copy the proof back, parse to Fr[456].
    spawnSync("scp", [`zswap-vps:${CIRCUIT_DIR}/target/proof/proof`, "/tmp/clearing-proof.bin"]);
    const proofFields = readProofAsFields("/tmp/clearing-proof.bin");
    assert.equal(proofFields.length, 456, "proof has 456 Field elements");

    // Step 7: build the ClearingPublic struct mirroring witness.toml's public-inputs ordering.
    // The contract takes this as a single struct arg; the contract's flatten_clearing_public
    // serialises it to the same [Field; 83] the prover used.
    const publicInputsStruct = buildPublicInputsStruct(epoch, poolSnapshot, clearing);

    // Step 8: call close_epoch_and_clear_verified.
    await orderbook.methods.close_epoch_and_clear_verified(publicInputsStruct, proofFields).send({ from: admin });

    // Step 9: assertions — epoch advanced, fills recorded, pool reserves shifted.
    const newEpochRaw = await orderbook.methods.get_epoch().simulate({ from: admin });
    const newEpoch = (newEpochRaw as any).result ?? newEpochRaw;
    assert.equal(Number(newEpoch.epoch_id), Number(epoch.epoch_id) + 1, "epoch_id incremented");
    assert.equal(Number(newEpoch.order_count), 0, "order_count reset to 0");
    assert.equal(Number(newEpoch.cancel_count), 0, "cancel_count reset to 0");

    for (const fill of clearing.fills) {
      const recorded = await orderbook.methods.get_fill(fill.orderNonce).simulate({ from: admin });
      assert.equal(BigInt((recorded as any).result ?? recorded), fill.amountOut, `fills[${fill.orderNonce}] recorded`);
    }
  });
});

/**
 * Build the ClearingPublic struct in the shape the contract's close_epoch_and_clear_verified
 * takes. Field order matches contracts/orderbook/src/main.nr's ClearingPublic struct.
 */
function buildPublicInputsStruct(epoch: any, pool: any, clearing: any) {
  const fills = [];
  for (let i = 0; i < 32; i++) {
    if (i < clearing.fills.length) {
      fills.push({ order_nonce: clearing.fills[i].orderNonce, amount_out: clearing.fills[i].amountOut });
    } else {
      fills.push({ order_nonce: 0n, amount_out: 0n });
    }
  }
  const reserveADelta = clearing.newReserveA - pool.reserve_a;
  const reserveBDelta = clearing.newReserveB - pool.reserve_b;

  // For E1's balanced scenario, fee_pool_*=0 and a_to_pool == reserve_a_add. If
  // fee withholding is non-trivial in a future test, recompute the gross flows
  // here matching the aggregator (see aggregator/src/witness.ts's logic).
  const ns = (clearing as any).netSwap ?? {
    aToPool: reserveADelta > 0n ? reserveADelta : 0n,
    aFromPool: reserveADelta < 0n ? -reserveADelta : 0n,
    bToPool: reserveBDelta > 0n ? reserveBDelta : 0n,
    bFromPool: reserveBDelta < 0n ? -reserveBDelta : 0n,
  };

  return {
    order_acc: BigInt(epoch.order_acc),
    cancel_acc: BigInt(epoch.cancel_acc),
    order_count: Number(epoch.order_count),
    cancel_count: Number(epoch.cancel_count),
    reserve_a: pool.reserve_a,
    reserve_b: pool.reserve_b,
    lp_supply: pool.lp_supply,
    clearing_price: clearing.clearingPrice,
    fills,
    fills_len: clearing.fills.length,
    swap: {
      a_to_pool: ns.aToPool, b_to_pool: ns.bToPool,
      a_from_pool: ns.aFromPool, b_from_pool: ns.bFromPool,
      reserve_a_add: reserveADelta > 0n ? reserveADelta : 0n,
      reserve_a_sub: reserveADelta < 0n ? -reserveADelta : 0n,
      reserve_b_add: reserveBDelta > 0n ? reserveBDelta : 0n,
      reserve_b_sub: reserveBDelta < 0n ? -reserveBDelta : 0n,
      fee_a_per_share_increment: clearing.feeAPerShareIncrement,
      fee_b_per_share_increment: clearing.feeBPerShareIncrement,
    },
  };
}
```

(The deploy fixture seeds enough balance for alice + bob to fund their orders. The pool isn't seeded with reserves here; if `computeClearing` requires non-zero initial reserves, deposit some via `pool.methods.deposit(...)` before the `it("E1"...)` block — adapt by adding `await pool.methods.deposit(initialA, initialB, ...).send({ from: admin });` before the submit_order calls. Check `clearing.ts`'s aggregator-side requirements.)

- [ ] **Step 3: Sync + run E1 on VPS.**

```
rsync -e ssh tests/integration/clearing.test.ts zswap-vps:/root/zswap-aztec/tests/integration/clearing.test.ts
ssh zswap-vps "source /root/.zswap-env && cd /root/zswap-aztec && pnpm codegen > /tmp/codegen.log 2>&1 && cd tests && AZTEC_NODE_URL=http://localhost:18080 timeout 1800 node --import tsx --test --test-concurrency=1 --test-reporter=spec --test-name-pattern='E1' integration/clearing.test.ts 2>&1 | tail -60"
```

Expected: E1 passes (`tests 1, pass 1, fail 0`). Total runtime ~15-25 min (fixture deploy + submits + nargo execute + bb prove + contract call + assertions).

**If E1 fails at `bb prove failed (likely RAM OOM at N=32; fall back to N=16)`:** STOP. Report BLOCKED back. The contingency is to redo Task 1 with `MAX_ORDERS_PER_EPOCH = 16` and re-run all preceding tasks' compile + tests (the constants in main.nr / types.nr / clearing.ts / witness.ts go to 16 instead of 32, the flatten_clearing_public slot 72/73 shift to slot 40/41 — but that recalc is a deterministic re-derivation, not new design). The controller decides.

- [ ] **Step 4: Commit (only after E1 passes).**

```
git add tests/integration/clearing.test.ts
git commit -m "test(clearing): E1 verified-flow happy path (5d-3)

Full rewrite of the W5c trusted-flow tests in clearing.test.ts.
E1: deploy orderbook bound to the production VK, submit 1 buy + 1 sell,
run aggregator + witness builder + nargo execute + bb prove, parse proof,
call close_epoch_and_clear_verified. Contract recursively verifies + the
public callback applies the clearing. Asserts epoch_id incremented and
fills recorded.

This test is the first place where N=32 production-circuit proof
generation is empirically exercised end-to-end.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: `tests/integration/clearing.test.ts` — E2 tampering + E3 replay

Append two more tests inside the same describe block. E2 corrupts a Field in the proof and asserts the contract reverts. E3 replays a valid `(public_inputs, proof)` and asserts the freshness check rejects.

**Files:**
- Modify: `tests/integration/clearing.test.ts`

- [ ] **Step 1: Append E2 inside the existing `describe(...)` block (after E1).**

```ts
  it("E2: a tampered proof byte makes close_epoch_and_clear_verified revert", async () => {
    // Repeat E1's pipeline up through bb prove. Pre-tamper proof bytes, then
    // call the contract — the recursive verify must reject.
    //
    // (For brevity, this test re-runs the whole submit-and-prove pipeline.
    //  The submit step uses fresh nonces so it lands cleanly in the current
    //  open epoch.)

    const aliceNonce = { authwit: randomField(), orderNonce: randomField() };
    await orderbook.methods.submit_order(
      SIDE_A_TO_B, 100n * ONE_TUSDC, PRICE_2, aliceNonce.authwit, aliceNonce.orderNonce,
    ).send({ from: alice });
    const bobNonce = { authwit: randomField(), orderNonce: randomField() };
    await orderbook.methods.submit_order(
      SIDE_B_TO_A, 50n * ONE_TETH, PRICE_2, bobNonce.authwit, bobNonce.orderNonce,
    ).send({ from: bob });

    const epochRaw = await orderbook.methods.get_epoch().simulate({ from: admin });
    const epoch = (epochRaw as any).result ?? epochRaw;

    // ... (same data-gathering + aggregator + witness builder logic as E1;
    //      in practice extract a helper function `produceProofForCurrentEpoch()`
    //      to keep E1 and E2 DRY — the helper returns { publicInputsStruct, proofFields }.)
    const { publicInputsStruct, proofFields } = await produceProofForCurrentEpoch(epoch);

    // Tamper: flip a bit in proof[0].
    const tampered = [...proofFields];
    tampered[0] = new Fr((proofFields[0].toBigInt() + 1n) % Fr.MODULUS);

    await assert.rejects(
      orderbook.methods.close_epoch_and_clear_verified(publicInputsStruct, tampered).send({ from: admin }),
      /verify|proof|invalid/i,
      "close_epoch_and_clear_verified must reject a tampered proof",
    );
  });

  it("E3: a replayed (public_inputs, proof) pair makes the freshness check reject", async () => {
    // Submit + prove + apply once. Then attempt to apply the SAME pair again.
    // The post-clearing epoch's order_acc is reset to 0, so the freshness check
    // public_inputs.order_acc == current.order_acc fails immediately.

    const aliceNonce = { authwit: randomField(), orderNonce: randomField() };
    await orderbook.methods.submit_order(
      SIDE_A_TO_B, 50n * ONE_TUSDC, PRICE_2, aliceNonce.authwit, aliceNonce.orderNonce,
    ).send({ from: alice });
    const bobNonce = { authwit: randomField(), orderNonce: randomField() };
    await orderbook.methods.submit_order(
      SIDE_B_TO_A, 25n * ONE_TETH, PRICE_2, bobNonce.authwit, bobNonce.orderNonce,
    ).send({ from: bob });

    const epochRaw = await orderbook.methods.get_epoch().simulate({ from: admin });
    const epoch = (epochRaw as any).result ?? epochRaw;
    const { publicInputsStruct, proofFields } = await produceProofForCurrentEpoch(epoch);

    // First apply — succeeds, advances epoch.
    await orderbook.methods.close_epoch_and_clear_verified(publicInputsStruct, proofFields).send({ from: admin });

    // Replay — must reject at order_acc mismatch.
    await assert.rejects(
      orderbook.methods.close_epoch_and_clear_verified(publicInputsStruct, proofFields).send({ from: admin }),
      /order_acc mismatch/i,
      "replayed (public_inputs, proof) must be rejected by the freshness assert",
    );
  });
```

You'll also extract a helper inside the describe block (or above it as a module-level function with closure over `orderbook`, `pool`, `tUSDC`, `tETH`, `alice`, `bob`, `admin`):

```ts
async function produceProofForCurrentEpoch(epoch: any): Promise<{
  publicInputsStruct: any;
  proofFields: Fr[];
}> {
  // Read alice + bob orders, pool snapshot, run aggregator, build witness,
  // write Prover.toml, nargo execute, bb prove, parse proof. (Same logic as E1
  // steps 2–7 — DRY helper.)
  ...
}
```

The implementer can inline the helper body by copying the relevant block from E1 verbatim. The helper makes E2 and E3 readable.

- [ ] **Step 2: Sync + run E2.**

```
rsync -e ssh tests/integration/clearing.test.ts zswap-vps:/root/zswap-aztec/tests/integration/clearing.test.ts
ssh zswap-vps "source /root/.zswap-env && cd /root/zswap-aztec/tests && AZTEC_NODE_URL=http://localhost:18080 timeout 1800 node --import tsx --test --test-concurrency=1 --test-reporter=spec --test-name-pattern='E2' integration/clearing.test.ts 2>&1 | tail -40"
```

Expected: E2 passes (asserts the tampered proof was rejected).

- [ ] **Step 3: Run E3.**

```
ssh zswap-vps "source /root/.zswap-env && cd /root/zswap-aztec/tests && AZTEC_NODE_URL=http://localhost:18080 timeout 1800 node --import tsx --test --test-concurrency=1 --test-reporter=spec --test-name-pattern='E3' integration/clearing.test.ts 2>&1 | tail -40"
```

Expected: E3 passes (the second apply call rejects with `/order_acc mismatch/i`).

- [ ] **Step 4: Commit.**

```
git add tests/integration/clearing.test.ts
git commit -m "test(clearing): E2 tampering rejection + E3 replay rejection

E2 flips one Field in the proof bytes and asserts the contract reverts
inside std::verify_proof_with_type. E3 reapplies the same (public_inputs,
proof) twice and asserts the freshness assert in _apply_verified_clearing
catches the replay because the post-clearing epoch's order_acc is 0.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: CLI `zswap close-epoch-verified`

A new subcommand that, given a proof file path and the current epoch state, calls `close_epoch_and_clear_verified` against the deployed orderbook. The existing `zswap close-epoch` stays as the no-clear fallback.

**Files:**
- Modify: `cli/src/commands/close-epoch.ts` (or create the new file alongside)

- [ ] **Step 1: Read the existing close-epoch.ts to mirror patterns.**

```
cat cli/src/commands/close-epoch.ts
```

Note the current command structure (yargs / commander / etc.), how it imports the orderbook contract, and how it reads `zswap.config.json` for the deployed address.

- [ ] **Step 2: Add a new `close-epoch-verified` subcommand.**

```ts
import { readFileSync } from "node:fs";
import { readProofAsFields } from "../../tests/integration/helpers/proof.js";  // OR re-locate the helper if cli should not depend on tests/

// ... inside the command registration:

cli.command("close-epoch-verified")
  .description("Apply a verified clearing — submits (public_inputs, proof) to the orderbook")
  .option("--proof <path>", "Path to bb prove's binary proof file", "/tmp/clearing-proof.bin")
  .option("--public-inputs <path>", "Path to a JSON file with the ClearingPublic struct", "/tmp/clearing-public-inputs.json")
  .action(async (opts: { proof: string; publicInputs: string }) => {
    const config = readZswapConfig();
    const { wallet, node } = await connectAndLoad(config);
    const orderbook = await OrderbookContract.at(config.orderbookAddress, wallet);

    const proofFields = readProofAsFields(opts.proof);
    const publicInputsStruct = JSON.parse(readFileSync(opts.publicInputs, "utf8"));

    console.log(`Submitting close_epoch_and_clear_verified with ${proofFields.length}-Field proof…`);
    await orderbook.methods.close_epoch_and_clear_verified(publicInputsStruct, proofFields).send({ from: wallet.getAddress() });
    console.log("Epoch advanced + clearing applied.");
  });
```

(`readZswapConfig` + `connectAndLoad` mirror whatever the existing close-epoch command uses to load `zswap.config.json` and connect to PXE. If the existing pattern differs, adapt.)

Note: if importing `readProofAsFields` from `../../tests/integration/helpers/proof.js` is awkward (cli shouldn't depend on tests/), MOVE the helper to `aggregator/src/proof.ts` or `cli/src/proof.ts` and update Task 5's commit to put it there — the tests then import from the new home.

- [ ] **Step 3: Verify the CLI builds + the new subcommand shows up in --help.**

```
pnpm --filter @zswap/cli build
pnpm --filter @zswap/cli zswap --help 2>&1 | grep close-epoch-verified
```

Expected: the new subcommand appears in the help output.

- [ ] **Step 4: Commit.**

```
git add cli/src/commands/close-epoch.ts
git commit -m "feat(cli): zswap close-epoch-verified subcommand

Reads a bb prove'd proof file + a JSON public_inputs file and calls
orderbook.close_epoch_and_clear_verified. The existing close-epoch
command stays as the permissionless no-clear fallback.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Wrap-up — tag + README

- [ ] **Step 1: Update README status line.**

In `README.md`, replace the existing **Status:** paragraph (currently mentioning Week 5d-2) with:

```
**Status:** Week 5d-3 complete. The orderbook's `close_epoch_and_clear_verified` private function recursively verifies the Week 5d-2 clearing-circuit proof via `std::verify_proof_with_type`, then enqueues a public callback that runs the net AMM swap + records fills + advances the epoch. The Week 5c `clearing_authority` is gone; anyone holding a valid `(public_inputs, proof)` pair for the current epoch can advance it. To make this testable, `MAX_ORDERS_PER_EPOCH` is reduced from 128 to 32 (the production `bb prove` RAM budget on the dev VPS). One live end-to-end test (E1 happy-path) verifies the full pipeline; E2 tampering and E3 replay verify rejection paths. Production-scale raising of N back toward 128 is gated on better prover infrastructure (Week 5d-4 + future). Next: Week 5d-4 — Merkle settlement root for `claim_fill` inclusion proofs.
```

Add new doc links to the Documentation section:

```
- [Week 5d-2 Standalone Noir Clearing Circuit Design](docs/superpowers/specs/2026-05-20-zswap-aztec-week-05d-2-clearing-circuit-design.md)
- [Week 5d-2 Implementation Plan](docs/superpowers/plans/2026-05-20-zswap-aztec-week-05d-2-clearing-circuit.md)
- [Week 5d-3 On-chain Recursive Verify Design](docs/superpowers/specs/2026-05-20-zswap-aztec-week-05d-3-onchain-recursive-verify-design.md)
- [Week 5d-3 Implementation Plan](docs/superpowers/plans/2026-05-20-zswap-aztec-week-05d-3-onchain-recursive-verify.md)
```

(The 5d-2 doc links may already be missing if Week 5d-2's wrap-up didn't add them — add them now if so.)

- [ ] **Step 2: Commit + tag.**

```
git add README.md
git commit -m "docs(readme): Week 5d-3 complete

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
git tag -a week-05d-3-onchain-recursive-verify -m "Week 5d-3: orderbook recursively verifies the 5d-2 clearing proof"
git rev-list -n1 week-05d-3-onchain-recursive-verify
git log --oneline -10
```

---

## Self-Review

**1. Spec coverage:**
- §3 in-scope / Reduce N to 32 → Task 1.
- §3 / new private fn + public callback → Task 4.
- §3 / storage diff → Task 2.
- §3 / remove W5c authority gate → Task 4 (delete the function).
- §3 / keep close_epoch fallback → unchanged; no task needed.
- §3 / flatten_clearing_public → Task 3.
- §3 / proof.ts helper → Task 5.
- §3 / TXE schema + callback negative tests → Task 2 (schema), Task 4 (only_self).
- §3 / E1/E2/E3 integration → Tasks 6 + 7.
- §3 / deploy-tokens.ts → Task 2.
- §3 / CLI → Task 8.
- §4 architecture / Flow + storage diff + constructor sig + replay protection → Task 2 (storage + sig), Task 4 (the fn body).
- §5 N=32 → Task 1.
- §6 flatten + slot table → Task 3.
- §7 proof byte parsing → Task 5.
- §8 test plan → Tasks 2, 3, 4 (TXE) + Tasks 6, 7 (integration).
- §9 affected files → matches Tasks 1-8.
- §10 risks → Task 1 + Task 6 callouts.

**2. Placeholder scan:**
- Task 2 Step 6 says "If `Fr.fromBuffer` is named differently … adapt" — that's a concrete fallback instruction with a grep, not a placeholder.
- Task 6 Step 2 has a `produceProofForCurrentEpoch` helper described as "copy the relevant block from E1 verbatim" — that's the same kind of explicit DRY-via-copy the prior weeks used; not a placeholder.
- Task 6 Step 3 includes a CONCRETE error branch ("If E1 fails at `bb prove failed`: STOP. Report BLOCKED") — that's a real branching instruction, not a placeholder.
- No "TBD", "TODO", "implement later" strings.

**3. Type consistency:**
- `ClearingPublic` struct field names match between Task 3 (struct decl) and Task 4 (new fn + callback) and Task 6 (TS-side struct builder): `order_acc`, `cancel_acc`, `order_count`, `cancel_count`, `reserve_a/b`, `lp_supply`, `clearing_price`, `fills`, `fills_len`, `swap`.
- `clearing_vk: PublicImmutable<[Field; 112], Context>` and `clearing_vk_hash: PublicImmutable<Field, Context>` consistent across Tasks 2, 3, 4, and TS-side in Task 2 + Task 6's `readClearingVk()` helper.
- `flatten_clearing_public(p: ClearingPublic) -> [Field; 83]` signature consistent in Task 3 (decl) and Task 4 (call site).
- `HONK_PROOF_FIELDS = 456` consistent: Task 5 (helper export), Task 6/7 (assertions).
- `Fr` import from `@aztec/aztec.js/fields` consistent across Tasks 2, 5, 6, 7.
