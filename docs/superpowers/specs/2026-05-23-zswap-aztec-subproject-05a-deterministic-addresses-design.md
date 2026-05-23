# Sub-project 5a: Deterministic Addresses + Sub-4 Carryforward Fixes

**Status:** Design
**Date:** 2026-05-23
**Parent project:** [ZSwap-on-Aztec](2026-05-14-zswap-aztec-mvp-design.md) — sub-project 5 (split into 5a / 5b / 5c)
**Predecessor specs:**
- [Sub-3 Permissionless Aggregator](2026-05-22-zswap-aztec-subproject-03-dar-permissionless-aggregator-design.md) — introduced the 4-deploy circular-dep wart
- [Sub-2.5 Circuit Integration](2026-05-22-zswap-aztec-subproject-02-5-circuit-integration-design.md) — `close_epoch_and_clear_verified` blocked on testnet by the wart
- [Sub-4 Multi-Pair Routing](2026-05-23-zswap-aztec-subproject-04-multi-pair-routing-design.md) — closes with 7 carryforward limitations; this spec addresses #1, #2, #6

## Goal

Unblock `close_epoch_and_clear_verified` on Aztec testnet by collapsing the 4-deploy Orderbook↔Treasury circular-dep ceremony to a 2-deploy deterministic-address sequence. While the contract is being touched, ship three Sub-4 carryforward fixes that are tightly coupled to the same files: per-hop nullifier scheme (Sub-4 #1 — 2-hop double-claim), 1-hop DoS resistance check in the circuit (Sub-4 #2), and a mutable pool registry (Sub-4 #6 — `MAX_POOLS` fixed at deploy time).

Sub-5a is a **focused, code-tight sub-project** (~12 tasks, ~2 weeks) whose deliverable is a SINGLE successful testnet `close_epoch_and_clear_verified` transaction. That single tx simultaneously resolves the testnet dormancy of Sub-1 5d-3, Sub-2.5, Sub-3, and Sub-4. L1 Bridge (Sub-5b) and Production Infrastructure (Sub-5c) are separate sub-projects.

## Non-Goals

- L1 Bridge / real Ethereum token portal — Sub-5b.
- Production-grade monitoring, incident response, mainnet deploy runbook — Sub-5c.
- Sub-4 #3 (Field truncation in `pool_token_pairs` canonical ordering) — minor; circuit-only; deferred.
- Sub-4 #5 (statistical privacy leak from per-epoch pool activity pattern) — needs design work for dummy-order mitigation; Sub-6 brainstorm.
- Sub-4 #7 (composite pricing triangular-arbitrage-free) — circuit math + market microstructure work; deferred.
- General Aztec API improvements (deterministic-address pre-compute is consumed, not contributed back).

## Section 1 — Deterministic-Address Pre-Compute

Aztec.js exposes `getContractInstanceFromInstantiationParams` which yields a contract's address from `(contractAddressSalt, deployer, contractClassId, constructorArgsHash)`. The critical question for breaking the Orderbook↔Treasury cycle: **does `contractAddressSalt` produce an address that depends on `constructorArgsHash`, or is it args-independent?**

- **If args-INDEPENDENT** (address = f(salt, deployer, class_id) only): the cycle breaks cleanly. Pick a salt, derive Orderbook's address from `(salt, admin, OrderbookClassId)` BEFORE choosing constructor args. Deploy Treasury with that address. Deploy Orderbook with Treasury's address + the same salt; the resulting address matches the precomputation. Two deploys total. Both `PublicImmutable` fields preserved.
- **If args-DEPENDENT** (address = f(salt, deployer, class_id, constructorArgsHash)): cycle is irreducible at the address-derivation level. Fallback: change `Treasury.orderbook_addr` from `PublicImmutable` to `PublicMutable` plus an idempotent `set_orderbook(addr)` setter guarded by `assert(stored == AztecAddress::ZERO, "orderbook already set")` so it can only be assigned once. Three deploys total (deploy Treasury with ZERO placeholder → deploy Orderbook with real Treasury address → call `treasury.set_orderbook(orderbook)`).

**Phase A1 (the prototype task)** empirically determines which branch applies by writing a small TypeScript probe that deploys two trivial contracts with identical salt but different constructor args and compares addresses. The rest of Phase A then branches on the result. Both branches lead to a working testnet `close_epoch`; the args-INDEPENDENT branch is preferred because both PublicImmutable invariants survive (no upgrade path the deployer could exploit).

**Deploy ceremony (preferred branch, 2 deploys):**

```typescript
import { getContractInstanceFromInstantiationParams } from "@aztec/aztec.js/utils";
import { TreasuryContract } from "../tests/integration/generated/Treasury.js";
import { OrderbookContract } from "../tests/integration/generated/Orderbook.js";

const orderbookSalt = Fr.random();

// Step 1: compute Orderbook's future address from salt + deployer + class_id alone
const orderbookFutureInstance = await getContractInstanceFromInstantiationParams(
  OrderbookContract.artifact,
  { deployer: admin, salt: orderbookSalt },
  // args omitted — verified args-independent in Task A1
);
const orderbookFutureAddress = orderbookFutureInstance.address;

// Step 2: deploy Treasury pointing at the precomputed Orderbook address
const treasury = await TreasuryContract.deploy(
  wallet, tUSDCAddress, orderbookFutureAddress, admin,
).send({ from: admin });

// Step 3: deploy Orderbook with the SAME salt + real Treasury address
const orderbook = await OrderbookContract.deploy(
  wallet, epochLength, vkHash, registryAddress,
  treasury.contract.address,
  aggregatorFee, poolCount, poolAddrs, poolTokenA, poolTokenB,
  poolRegistryAdmin,
)
  .send({ from: admin, contractAddressSalt: orderbookSalt });

// Step 4: sanity assert
assert.equal(orderbook.contract.address.toString(), orderbookFutureAddress.toString());
```

**Fallback branch (args-DEPENDENT, 3 deploys):**

Treasury's `orderbook_addr: PublicMutable<AztecAddress, Context>`. `constructor(bond_token, deployer)` drops the `orderbook_addr` arg. New external `set_orderbook(addr: AztecAddress)` (caller must be deployer; `assert(stored == AztecAddress::ZERO, "already set")`). Deploy Treasury, deploy Orderbook with `treasury.address`, then call `treasury.set_orderbook(orderbook.address)`. Treasury still has `assert(caller == orderbook_addr)` on `pay_aggregator`, but the address is set-once via the setter rather than constructor-immutable.

## Section 2 — Per-Hop Nullifier Scheme

Sub-4 #1 root cause: Aztec's default `compute_nullifier` for a `#[note]`-decorated struct produces ONE nullifier per note. `PrivateSet.pop_notes` emits that nullifier and the note can never be re-spent. For 2-hop orders this means the first `claim_fill --hop 0` consumes the OrderNote and `claim_fill --hop 1` finds no note.

**Sub-5a fix:** OrderNote keeps its default `compute_note_hash`, but `claim_fill` no longer calls `pop_notes`. Instead it calls `get_notes` (read-only) + emits a **manual per-hop nullifier** derived from `(note_hash, secret, hop_index, domain_tag)`. Each hop produces a distinct nullifier; the nullifier-set's collision rule prevents double-claiming of the same hop.

**Nullifier derivation:**

```rust
global Z_HOP_CLAIM_TAG: Field = poseidon2_hash("ZSWAP_HOP_CLAIM", 1);   // compile-time
global Z_CANCEL_TAG:    Field = poseidon2_hash("ZSWAP_CANCEL",    1);   // compile-time

#[contract_library_method]
fn derive_per_hop_nullifier(note: OrderNote, hop_index: u8, secret: Field) -> Field {
    poseidon2_hash([
        note.compute_note_hash(),
        secret,
        hop_index as Field,
        Z_HOP_CLAIM_TAG,
    ], 4)
}

#[contract_library_method]
fn derive_cancel_nullifier(note: OrderNote, secret: Field) -> Field {
    poseidon2_hash([note.compute_note_hash(), secret, Z_CANCEL_TAG], 3)
}
```

`secret` is the maker's nullifier key (derived from the account's `npk_m` via Aztec's standard key derivation; private context provides this via `context.this_keys()` or equivalent — Sub-3's existing OrderNote nullifier already uses this same secret).

**`claim_fill` body change** (replaces the Sub-4 E1 body):

```rust
#[external("private")]
fn claim_fill(
    epoch_id: u32,
    order_nonce: Field,
    hop_index: u8,
    amount_out: u128,
    pool_id: u32,
    leaf_index: u32,
    sibling_path: [Field; 6],
) {
    assert(hop_index < 2 as u8, "hop_index must be 0 or 1");

    // 1. Merkle proof (unchanged from Sub-4 E1)
    let leaf = poseidon2_hash([order_nonce, hop_index as Field, amount_out as Field, pool_id as Field], 4);
    let stored_root = self.storage.fills_root.at(epoch_id).read();
    let computed_root = verify_merkle_proof_64(leaf, leaf_index, sibling_path);
    assert(computed_root == stored_root, "Merkle proof mismatch");

    // 2. Read OrderNote WITHOUT popping
    let options = NoteGetterOptions::new()
        .select(OrderNote::properties().nonce,  Comparator::EQ, order_nonce)
        .select(OrderNote::properties().owner,  Comparator::EQ, self.msg_sender().to_field())
        .set_limit(1);
    let notes = self.storage.orders.get_notes(options);
    assert(notes.len() == 1, "no matching order note");
    let note = notes.get(0);
    assert((hop_index as u8) < note.path_len, "hop_index >= path_len");

    // 3. Emit per-hop nullifier (collision-fails if this hop was already claimed)
    let secret = derive_nullifier_secret_from_owner(note.owner);
    let nullifier = derive_per_hop_nullifier(note, hop_index, secret);
    context.push_new_nullifier(nullifier, 0);

    // 4. Payout (unchanged Sub-4 E1 path-aware token derivation)
    let output_token = derive_output_token(note, hop_index);
    self.call(Token::at(output_token).transfer_public_to_private(
        self.address, note.owner, amount_out, 0 as Field
    ));
}
```

**Cancel-order body change:** `cancel_order` uses `derive_cancel_nullifier` and emits it. After cancellation the note's CANCEL nullifier is set; subsequent `claim_fill` calls for this note succeed independently (different `hop_index` tag) which is FINE because the orderbook's accumulator chain in the circuit prevents a cancelled order from being filled — claim attempts on a cancelled order fail Merkle proof verification (no leaf exists in `fills_root`).

**Privacy semantics:**

- Two `claim_fill --hop` calls on the same 2-hop order emit two distinct nullifiers. An observer cannot link them to each other or to the original `submit_order` (each nullifier is `poseidon2`-derived from secrets only the maker knows).
- The OrderNote stays in PrivateSet forever (no pop). Storage cost: bounded — old notes are pruned by Aztec's epoch-window garbage collection (per `reference_aztec_pxe_tagging_window` memory).
- Double-claim attempt: the second emission of the same per-hop nullifier reverts at the Aztec L2 rollup with the standard "nullifier already exists" error.

## Section 3 — 1-Hop DoS Resistance Check in Circuit

Sub-4 #2 root cause: Sub-1 sec 6.3's DoS-resistance assertion ("every eligible non-cancelled order MUST be in `fills`") survived through Sub-2.5 but was inadvertently omitted from Sub-4's `fn main` block B during the multi-pool generalization. Block C's atomicity assertion covers 2-hop orders but NOT 1-hop orders. As shipped, a malicious aggregator can censor an eligible 1-hop order (drop it from `fills`) and the circuit accepts the proof.

**Sub-5a fix:** insert a new block `B'` between blocks B and C in `circuits/clearing/src/main.nr`:

```rust
// === B'. Sub-5a: 1-hop DoS resistance check ===
let mut is_filled: [bool; MAX_ORDERS_PER_EPOCH] = [false; MAX_ORDERS_PER_EPOCH];
for f in 0..(2 * MAX_ORDERS_PER_EPOCH) {
    if (f as u32) < fills_len {
        let oi = fill_to_order_index[f];
        for k in 0..MAX_ORDERS_PER_EPOCH {
            if (k as u32) == oi { is_filled[k] = true; }
        }
    }
}

for k in 0..MAX_ORDERS_PER_EPOCH {
    if (k as u32) < order_count {
        let order_k = orders[k];
        if (order_k.path_len == 2 as u8) & (!is_cancelled[k]) {
            // Resolve this 1-hop order's pool slot
            let (lo, hi) = if order_k.path[0] < order_k.path[1] {
                (order_k.path[0], order_k.path[1])
            } else {
                (order_k.path[1], order_k.path[0])
            };
            let mut p_slot: u32 = INVALID_POOL_ID;
            for p in 0..MAX_ACTIVE_POOLS_PER_EPOCH {
                if (p as u32) < active_pool_count {
                    let pair = pool_token_pairs[p];
                    if (pair[0] == lo) & (pair[1] == hi) { p_slot = p as u32; }
                }
            }
            // Only assert when the pool is active this epoch. Inactive pool
            // means no per-pair P* exists → 1-hop legitimately not filled.
            if p_slot != INVALID_POOL_ID {
                let mut p_star: u128 = 0 as u128;
                for p in 0..MAX_ACTIVE_POOLS_PER_EPOCH {
                    if (p as u32) == p_slot { p_star = active_pool_clearings[p].clearing_price; }
                }
                if pricing::eligible_with_p(order_k.side, order_k.limit_price, p_star) {
                    assert(is_filled[k], "eligible 1-hop order missing from fills (DoS)");
                }
            }
        }
    }
}
```

**Edge-case coverage:**

- 1-hop, pool active, eligible → MUST fill (asserted).
- 1-hop, pool active, ineligible → no obligation (assertion skipped).
- 1-hop, pool INACTIVE this epoch → no obligation (carry-forward to future epoch).
- 1-hop, cancelled → no obligation (matches Sub-1 pattern).
- 2-hop → block B' skips; block C handles atomicity.

**Gate impact:** Block B' is `MAX_ORDERS_PER_EPOCH × (MAX_ACTIVE_POOLS_PER_EPOCH ops + constant)` ≈ 32 × 6 × ~30 ops ≈ ~6K gates. Negligible (~2% of Sub-4's 276K total).

**Test plan:** add `circuits/clearing/src/test.nr` stub:

```rust
#[test(should_fail_with = "eligible 1-hop order missing from fills (DoS)")]
fn sub5a_dos_eligible_1hop_missing_stub() {
    assert(false, "eligible 1-hop order missing from fills (DoS)");
}
```

Plus a fixture-driven integration test in Sub-5a Task F1 (testnet runner stage).

## Section 4 — Mutable Pool Registry + `add_pool`

Sub-4 #6 root cause: `pool_count`, `pools`, `pool_token_a`, `pool_token_b` are all `PublicImmutable`. To add a 4th pool (e.g., a new tDOGE/tUSDC pair), the entire Orderbook + Treasury stack must be redeployed. This blocks Aztec testnet/mainnet operators from extending the protocol.

**Sub-5a fix:** flip the four pool-registry storage fields to `PublicMutable` AND introduce a new `pool_registry_admin: PublicImmutable<AztecAddress>` field (constructor parameter) gating the new `add_pool` function. Existing pools are never overwritten (only appended at index `pool_count`).

**Storage diff:**

```rust
// Sub-4 (current):
pools:        Map<u32, PublicImmutable<AztecAddress, Context>, Context>,
pool_token_a: Map<u32, PublicImmutable<AztecAddress, Context>, Context>,
pool_token_b: Map<u32, PublicImmutable<AztecAddress, Context>, Context>,
pool_count:   PublicImmutable<u32, Context>,

// Sub-5a (after):
pools:                Map<u32, PublicMutable<AztecAddress, Context>, Context>,
pool_token_a:         Map<u32, PublicMutable<AztecAddress, Context>, Context>,
pool_token_b:         Map<u32, PublicMutable<AztecAddress, Context>, Context>,
pool_count:           PublicMutable<u32, Context>,
pool_registry_admin:  PublicImmutable<AztecAddress, Context>,    // NEW
```

**Constructor signature change:** appends `pool_registry_admin: AztecAddress` (typically `admin`). Initialization loop writes initial pools via `.write()` (Mutable) instead of `.initialize()` (Immutable).

**`add_pool` external:**

```rust
pub global MAX_NUM_POOLS: u32 = 8;   // total registry cap (≠ MAX_ACTIVE_POOLS_PER_EPOCH=3)

/// Sub-5a: append a new pool to the registry. Caller must be pool_registry_admin.
/// Existing pool slots are untouched; only the next free slot is initialized.
#[external("public")]
fn add_pool(pool_addr: AztecAddress, token_a: AztecAddress, token_b: AztecAddress) {
    let caller = self.msg_sender();
    let admin = self.storage.pool_registry_admin.read();
    assert(caller == admin, "only pool_registry_admin");

    let count = self.storage.pool_count.read();
    assert(count < MAX_NUM_POOLS as u32, "pool registry full");

    let (lo, hi) = if (token_a.to_field() as Field) < (token_b.to_field() as Field) {
        (token_a, token_b)
    } else {
        (token_b, token_a)
    };
    let existing = self.resolve_pool_id_by_pair_internal(lo, hi);
    assert(existing == 0xFFFFFFFF as u32, "pair already registered");

    self.storage.pools.at(count).write(pool_addr);
    self.storage.pool_token_a.at(count).write(lo);
    self.storage.pool_token_b.at(count).write(hi);
    self.storage.pool_count.write(count + 1);
}
```

`resolve_pool_id_by_pair_internal` is a helper (the existing `resolve_pool_id_by_pair` view called internally; both share canonical-pair lookup logic).

**Why `MAX_NUM_POOLS = 8`:** Aztec's `MAX_PUBLIC_DATA_UPDATE_REQUESTS_PER_TX` ≈ 63 caps constructor-time storage writes. Each pool consumes 3 slot writes (address + token_a + token_b). 8 pools = 24 slot writes (plus other Orderbook init writes, comfortably under 63). Increasing later requires Orderbook redeploy — accepted limitation for MVP.

**Trust model implication:** `pool_registry_admin` can ADD pools but NOT modify existing ones (loop only writes to the `count` slot, which strictly grows). Existing makers' OrderNotes referencing pool_id 0/1/2 are protected from rug-pull. `transfer_pool_registry_admin(new_admin)` is intentionally NOT added in this sub-project — YAGNI; can come in Sub-6 governance work.

**Privacy implication:** `add_pool` is a public tx; the new (token_a, token_b) pair is visible on-chain at registration time. Acceptable — pool registry info is already public.

**Test plan (TXE):**

- `add_pool_happy_path`: admin appends 4th pool; `pool_count` becomes 4; `resolve_pool_id_by_pair` returns 3 for the new pair.
- `add_pool_rejects_duplicate_pair`: admin tries to re-add an existing pair → revert "pair already registered".
- `add_pool_rejects_non_admin_caller`: non-admin caller → revert "only pool_registry_admin".
- `add_pool_rejects_when_registry_full`: admin tries to add the 9th pool (MAX_NUM_POOLS=8) → revert "pool registry full".

## Section 5 — Testnet validation + phasing + success criteria

### Joint testnet runner: `scripts/testnet-sub5a.ts`

Generalizes the Sub-2.5 `testnet-m{1,2,3}` script chain into a single idempotent runner. 17 steps from wallet setup through `close_epoch_and_clear_verified` + per-hop claims + treasury balance verification. Persists state in `testnet-sub5a-state.json`; `pool_registry_admin = admin`. AZTEC_NODE_URL safety check (must include "testnet").

The runner's critical step (#14) is the first-ever successful testnet `close_epoch_and_clear_verified` transaction. That single tx resolves the dormant testnet validation of Sub-1 5d-3 (close_epoch path never landed), Sub-2.5 (substantially-validated but close_epoch blocked), Sub-3 (Treasury pay_aggregator path never executed), and Sub-4 (multi-pair clearing never proven live).

### Phasing (12 tasks across 6 phases, ~2 weeks)

| Phase | Tasks | Purpose |
|---|---|---|
| **A — Deterministic address (3)** | A1: empirically determine whether `contractAddressSalt` produces an args-independent address (write a small probe + log result + decide preferred-vs-fallback branch); A2: rewrite `scripts/deploy-tokens.ts` deploy ceremony per A1 outcome (2-deploy or 3-deploy variant); A3: TXE test for the new ceremony (where Docker permits) | Section 1 |
| **B — Per-hop nullifier (3)** | B1: per-hop nullifier helpers + domain tags; B2: claim_fill `get_notes`+per-hop nullifier rewrite; B3: cancel_order CANCEL_HOP_TAG nullifier | Section 2 |
| **C — 1-hop DoS (2)** | C1: circuit block B' + stub test; C2: nargo + bb prove against new circuit; vk_hash refresh | Section 3 |
| **D — Mutable pool registry (2)** | D1: Storage flip + `add_pool` + `pool_registry_admin`; constructor signature bump; D2: TXE tests for add_pool (happy/duplicate/non-admin/full) | Section 4 |
| **E — Testnet integration (1)** | E1: `scripts/testnet-sub5a.ts` 17-step runner | Section 5 |
| **F — Validation + close (1)** | F1: Execute testnet run, capture all tx hashes, write memory note, update README | Section 5 |

### Success criteria

1. **Section 1:** Deploy ceremony is 2 transactions (preferred branch) or 3 transactions (fallback branch). `Orderbook.treasury_addr` and `Treasury.orderbook_addr` cross-reference correctly; sentinel "address-not-deployed" error is gone.
2. **Section 2:** `claim_fill --hop 0` then `claim_fill --hop 1` both succeed on a 2-hop order; a second `--hop 0` attempt reverts with "nullifier already exists".
3. **Section 3:** Tampering test (witness emits an eligible 1-hop order's hop=0 fill absent from `fills`) causes `bb prove` to fail with the new assertion message. Happy-path proofs are unaffected.
4. **Section 4:** Admin can add a 4th pool; non-admin call reverts; duplicate-pair add reverts; 9th add reverts. Existing pools 0/1/2 are unmodified after `add_pool`.
5. **Section 5:** All 17 steps of `scripts/testnet-sub5a.ts` PASS on Aztec testnet. `close_epoch_and_clear_verified` lands on-chain with a documented tx hash. Sub-1 5d-3 + Sub-2.5 + Sub-3 + Sub-4 testnet dormancies all resolved.

### Aztec.js prototype risk (A1)

If A1 finds `contractAddressSalt` IS args-dependent, Phase A switches to the fallback branch:
- Treasury constructor drops `orderbook_addr` arg.
- Treasury gains `orderbook_addr: PublicMutable<AztecAddress>` storage + `set_orderbook(addr)` external with `assert(stored == AztecAddress::ZERO, "orderbook already set")` guard.
- Deploy ceremony is 3 tx: deploy Treasury, deploy Orderbook with `treasury.address`, call `treasury.set_orderbook(orderbook.address)`.
- Trust model marginally weakened: deployer can set the pointer once. After the set, `assert == ZERO` makes it permanent. Documented as known limitation.

The spec proceeds under the preferred-branch assumption. Phase A1's report explicitly notes whichever branch was taken so the implementation plan can branch correspondingly.

### Out-of-scope (Sub-5b/Sub-5c/Sub-6+)

- L1 Bridge / real Ethereum token portal — Sub-5b.
- Operator monitoring, deploy runbook, incident response — Sub-5c.
- Sub-4 #3 (Field truncation in `pool_token_pairs` canonical ordering) — minor; deferred.
- Sub-4 #5 (statistical privacy leak from pool activity) — design-heavy; Sub-6.
- Sub-4 #7 (composite pricing triangular-arbitrage-free) — circuit math + market microstructure; deferred.
- `transfer_pool_registry_admin` governance — Sub-6.
