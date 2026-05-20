# Week 5d-3: On-chain Recursive Verify — Design

**Status:** approved
**Sub-project:** Week 5d (trustless clearing via ZK proof), slice 3 of 4

---

## 1. Goal

Replace the `clearing_authority` trust on the orderbook contract with a recursive verification of the Week 5d-2 clearing circuit's proof. After this slice, `close_epoch_and_clear` is gated by `std::verify_proof_with_type` against the embedded clearing-circuit verification key, not by an authority signature. Anyone holding a valid clearing proof can advance the epoch.

This slice also reduces `MAX_ORDERS_PER_EPOCH` from 128 to 32, the largest N for which the current dev VPS can actually generate a Honk proof; without that reduction, the new private function has nothing to verify.

## 2. Background

Week 5c shipped trusted on-chain clearing: `close_epoch_and_clear(fills, swap)` accepts a `clearing_authority`-signed payload and relays it. Week 5d-1 added on-chain order/cancel running-hash chains; Week 5d-2 shipped the standalone Noir clearing circuit + TS witness builder + off-chain prove/verify pipeline. Week 5d-3 wires the proof into the orderbook contract.

The empirical spike (a throwaway test contract) confirmed `std::verify_proof_with_type` compiles and runs in Aztec `#[external("private")]` functions on aztec-nr v4.2.0 + nargo 1.0.0-beta.19. It does **not** compile in `#[external("public")]` or `#[external("utility")]` functions — the Aztec macro rewrites those to unconstrained AVM bytecode, and the verify builtin is constrained-ACIR-only. The design below therefore puts verification in a private function and uses the standard hint-validate pattern (private verifies, enqueues `#[only_self]` public callback that applies state).

The Week 5d-2 wrap-up flagged a real constraint: the production N=128 clearing circuit (~904K gates) OOMs at proof generation on the dev VPS (8 GB RAM + 8 GB swap). Without a proof, there is nothing to recursively verify. This slice resolves that by **reducing N to 32** across the project, putting the circuit at ~57K gates which fits comfortably in current RAM.

## 3. Scope

**In scope:**

- Reduce `MAX_ORDERS_PER_EPOCH` from 128 to 32 in: `circuits/clearing/src/types.nr`, `contracts/orderbook/src/main.nr`, `aggregator/src/clearing.ts`, `aggregator/src/witness.ts` (and any cascading test constants).
- `Orderbook` contract: new private function `close_epoch_and_clear_verified(public_inputs: ClearingPublic, proof: [Field; 456])` that recursively verifies via `std::verify_proof_with_type` and enqueues a public callback `_apply_verified_clearing(public_inputs)` for state writes.
- `Orderbook` storage: drop `clearing_authority: PublicImmutable<AztecAddress>`. Add `clearing_vk: PublicImmutable<[Field; 112]>` + `clearing_vk_hash: PublicImmutable<Field>`. Constructor signature changes accordingly.
- Remove the Week 5c `close_epoch_and_clear(fills, swap)` authority-gated function entirely.
- Keep `close_epoch()` (the permissionless no-clear fallback added in Week 4) — if a proof never arrives, anyone can still advance the epoch without clearing.
- `flatten_clearing_public(ClearingPublic) -> [Field; 83]` Noir helper for the public-inputs serialization the verifier expects.
- TS proof-parsing helper at `tests/integration/helpers/proof.ts`: reads `bb prove`'s binary proof file, returns `[Fr; 456]`.
- TXE schema tests + integration tests (E1 happy-path, E2 tampering rejection, E3 replay rejection).
- `scripts/deploy-tokens.ts`: read `circuits/clearing/target/vk/vk` and `target/vk/vk_hash`, pass to orderbook constructor.
- CLI: new `zswap close-epoch-verified <proof-path>` command; existing `zswap close-epoch` stays as the no-clear fallback.

**Out of scope (deferred):**

- The `CLOSING` epoch state — the design uses one-step verified close (OPEN → OPEN) with the existing `state == OPEN` invariant; CLOSING stays as a reserved value in `EpochState` for a future slice if needed.
- Aztec production-scale proof generation for N ≥ 64 — requires a beefier prover host, deferred.
- Merkle settlement root over fills — Week 5d-4.
- Removing the aggregator-as-trusted-relay assumption (makers still send order plaintexts to a single aggregator; an MPC or per-maker prover scheme is a much later concern).

## 4. Architecture

### 4.1 Flow

```
zswap close-epoch-verified (CLI)
  ↓
private fn close_epoch_and_clear_verified(public_inputs, proof)
  ├─ flat = flatten_clearing_public(public_inputs)               // [Field; 83]
  ├─ vk = self.storage.clearing_vk.read()                         // [Field; 112]
  ├─ vk_hash = self.storage.clearing_vk_hash.read()               // Field
  ├─ std::verify_proof_with_type(vk, proof, flat, vk_hash, 1)     // 1 = Honk
  └─ enqueue_self._apply_verified_clearing(public_inputs)
       ↓ (public callback, #[only_self])
       ├─ EpochState oku; block >= closes_at_block; public_inputs alanları current ile eşleşiyor
       ├─ Pool::apply_clearing(swap)
       ├─ fills[i].order_nonce → amount_out kaydı (existing Map<Field, u128>)
       └─ EpochState ilerlet (epoch_id+1, accumulator alanları 0)
```

The hint-validate pattern is the same as `submit_order` → `_assert_epoch_open` + `_append_order` and `cancel_order` → `_assert_not_filled` + `_append_cancel`: private context computes the witness-bound result; an enqueued `#[only_self]` public callback applies it under public-state guards. Atomicity is automatic — any callback assert reverts the whole tx.

### 4.2 Storage diff

| Field | Week 5c | Week 5d-3 |
|---|---|---|
| `clearing_authority: PublicImmutable<AztecAddress>` | present | **removed** |
| `clearing_vk_hash: PublicImmutable<Field>` | absent | **added** (constructor arg) |

`fills: Map<Field, PublicMutable<u128>>` and all Week 5d-1 accumulator fields stay unchanged.

**Storage-only-the-hash, VK as calldata** — implementation deviation from the spec's earlier draft. Aztec's `MAX_PUBLIC_DATA_UPDATE_REQUESTS_PER_TX = ~63` limit makes initialising `PublicImmutable<[Field; 112]>` in a constructor impossible (one tx can't write 112 storage slots). Resolution: store only the 1-slot `clearing_vk_hash`. The full `[Field; 112]` VK is provided as a calldata arg to `close_epoch_and_clear_verified` each call; the contract's verifier (`std::verify_proof_with_type`) takes both VK and `key_hash`, and Honk's internal verifier-key check binds the VK to the stored hash. Caller cannot substitute a different VK without also providing a matching hash that the contract rejects (mismatch → stored hash ≠ supplied → revert).

### 4.3 Constructor signature

```noir
#[external("public")]
#[initializer]
fn constructor(
    token_a: AztecAddress,
    token_b: AztecAddress,
    epoch_length: u32,
    pool_addr: AztecAddress,
    clearing_vk_hash: Field,
) { ... }
```

The deploy script reads `circuits/clearing/target/vk/vk_hash` (32 bytes, one Field) and passes it. The full VK array is NOT stored on-chain (see the storage-only-the-hash note above) — it's provided as a calldata arg to `close_epoch_and_clear_verified` each call.

### 4.4 Replay protection

No explicit nonce. The `ClearingPublic` struct already carries `order_acc`, `cancel_acc`, `order_count`, `cancel_count` — all per-epoch and all reset to 0 when the epoch advances. After `_apply_verified_clearing` advances the epoch, the same proof's `public_inputs.order_acc` (= the old epoch's acc) cannot match the new epoch's `current.order_acc` (= 0), and the `order_acc == current.order_acc` assert in the callback rejects the replay. No code beyond the standard freshness check is needed.

## 5. Reducing N to 32

A single global sabit change with four touchpoints:

- `circuits/clearing/src/types.nr`: `pub global MAX_ORDERS_PER_EPOCH: u32 = 32;`
- `contracts/orderbook/src/main.nr`: same global (already exists from Week 5d-1 rename).
- `aggregator/src/clearing.ts`: `export const MAX_ORDERS_PER_EPOCH = 32;`
- `aggregator/src/witness.ts`: same.

Expected gate count: ~57K (was ~904K at N=128 — most cost was the O(N²) scan-and-pick patterns inside `derive_is_cancelled`, `replay_cancel_chain`, the per-fill loop, the DoS check, and aggregate-swap). At N=32, those O(N²) loops shrink to 32×32 = 1024 each. RAM budget at proof time should fit comfortably in the dev VPS's 8 GB + swap.

If empirically the N=32 production circuit still OOMs, the fallback is N=16 (~14K gates, same order of magnitude as the existing N=4 `clearing-test`). The plan's first task validates proof gen at N=32 before depending on it; if it fails, the user decides whether to drop further to N=16 or invest in larger prover hardware.

## 6. Public-inputs Serialisation

The recursion ABI requires a flat `[Field; K]` array. The order MUST match the public-parameter declaration in `circuits/clearing/src/main.nr`'s `fn main`. The total K at N=32 is **83**:

| Range | Count | Source |
|---|---|---|
Order matches `circuits/clearing/src/main.nr`'s `fn main` pub parameter declaration order — `fills` BEFORE `fills_len`, `swap` last:

| Slot range | Count | Source |
|---|---|---|
| `[0..2)` `order_acc`, `cancel_acc` | 2 | Field |
| `[2..4)` `order_count`, `cancel_count` | 2 | u32 cast to Field |
| `[4..8)` `reserve_a`, `reserve_b`, `lp_supply`, `clearing_price` | 4 | u128 cast to Field |
| `[8..72)` `fills[i].order_nonce`, `fills[i].amount_out` for i in 0..32 | 64 | 2 per FillEntry |
| `[72]` `fills_len` | 1 | u32 cast to Field |
| `[73..83)` 10 `swap.*` fields | 10 | 10 × u128 |
| **Total** | **83** | |

The Noir helper:

```noir
fn flatten_clearing_public(p: ClearingPublic) -> [Field; 83] {
    let mut out = [0 as Field; 83];
    out[0] = p.order_acc;
    out[1] = p.cancel_acc;
    out[2] = p.order_count as Field;
    out[3] = p.cancel_count as Field;
    out[4] = p.reserve_a as Field;
    out[5] = p.reserve_b as Field;
    out[6] = p.lp_supply as Field;
    out[7] = p.clearing_price as Field;
    for i in 0..32 {
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

The TS witness builder's `Prover.toml` output already serialises in this same order (5d-2's `aggregator/src/witness.ts`). After the N=128→32 reduction, the witness builder's `fills` slot count drops from 128 to 32 but the field order is unchanged.

The order is identical to circuits/clearing/main.nr's `fn main` `pub` parameter list (which is what `bb prove` flattens to the proof's public-inputs array). The contract-side `flatten_clearing_public` MUST stay in sync with main.nr — any reordering on one side requires the matching reorder on the other.

## 7. Honk Proof Byte → `[Field; 456]` Parsing (TS test helper)

`bb prove --verifier_target noir-recursive` writes a binary file containing 456 × 32 = 14_592 bytes. The new helper `tests/integration/helpers/proof.ts` exposes:

```ts
import { readFileSync } from "node:fs";
import { Fr } from "@aztec/aztec.js/fields";

export const HONK_PROOF_FIELDS = 456;
export const HONK_PROOF_BYTES = HONK_PROOF_FIELDS * 32;

export function readProofAsFields(path: string): Fr[] {
  const buf = readFileSync(path);
  if (buf.length !== HONK_PROOF_BYTES) {
    throw new Error(`expected ${HONK_PROOF_BYTES} bytes, got ${buf.length}`);
  }
  const fields: Fr[] = [];
  for (let i = 0; i < HONK_PROOF_FIELDS; i++) {
    fields.push(Fr.fromBuffer(buf.subarray(i * 32, (i + 1) * 32)));
  }
  return fields;
}
```

Same helper used by both E1 (happy path) and E2 (tampering — mutate one Field after parsing).

## 8. Test Plan

### 8.1 TXE schema tests (`contracts/orderbook/src/test.nr`, no Docker)

| # | Test | Asserts |
|---|---|---|
| TX1 | `constructor_records_clearing_vk` | constructor accepts the 112-Field VK + Field vk_hash; `get_clearing_vk()` / `get_clearing_vk_hash()` round-trip them. |
| TX2 | `constructor_records_token_addrs_and_epoch_length` (extend existing) | drop the `clearing_authority` assertion; verify the new VK args round-trip alongside. |
| TX3 | `close_epoch_and_clear_rejects_non_authority` (delete) | the W5c authority-gated function is removed; this test goes with it. |
| TX4 | `apply_verified_clearing_rejects_before_expiry` (new) | call the public callback before `closes_at_block` → "epoch has not expired yet". Calls via `enqueue_self`-mimicking pattern (the existing `#[only_self]` test idiom). |
| TX5 | `apply_verified_clearing_rejects_wrong_order_acc` (new) | public_inputs with a fabricated `order_acc` → "order_acc mismatch". Exercises the replay-protection guard's logic. |

### 8.2 Integration E2E (`tests/integration/clearing.test.ts` — rewrite of W5c file)

| # | Test | Asserts |
|---|---|---|
| E1 | Happy path | Fresh fixture deploys orderbook with the production N=32 VK; alice submits 3 orders, bob cancels 1; aggregator → witness → `nargo execute` → `bb prove` produces a real proof; helper parses it to `[Fr; 456]`; orderbook's `close_epoch_and_clear_verified(public_inputs, proof)` tx succeeds; epoch_id advanced; fills recorded; pool reserves updated per swap. |
| E2 | Tampering | Same path as E1, mutate `proof[0]` by `+ 1n` before sending. Tx must revert (verify_proof_with_type fail inside the private fn). |
| E3 | Replay | Run E1 to a successful clearing; with the SAME `(public_inputs, proof)` pair, attempt a second `close_epoch_and_clear_verified` call. Tx must revert at the `public_inputs.order_acc == current.order_acc` assert in the public callback (current acc is 0 in the new epoch). |

E1 runtime estimate: deploy fixture ~3-5 min + submits ~30s × 4 = 2 min + clearing + proof gen ~10-15 min + verify + apply ~1 min → 16-22 min. E2/E3 reuse the deploy + share most steps. Total integration suite walltime ~45-60 min on the VPS.

### 8.3 Cross-impl parity

No new test needed. The existing `aggregator/test/witness.test.ts` (5d-2 Task 12) already verifies the witness builder; after the N=128→32 const change, those tests adjust their expected sizes (fills array length, etc.) but the structure is the same.

## 9. Affected Files

**Modified:**
- `circuits/clearing/src/types.nr` — N=32.
- `contracts/orderbook/src/main.nr` — N=32; constructor signature; storage diff; new private fn + public callback; remove W5c `close_epoch_and_clear`; new getter for vk.
- `contracts/orderbook/src/test.nr` — adjust TX1-TX5.
- `aggregator/src/clearing.ts` — N=32.
- `aggregator/src/witness.ts` — N=32.
- `aggregator/test/witness.test.ts` — N=32 reference vectors.
- `tests/integration/clearing.test.ts` — full rewrite (W5c authority-gated → 5d-3 verified flow).
- `tests/integration/orderbook.test.ts` — IT5 (skipped at 128) re-evaluate at N=32 (could now run live); IT6 deploy args + the close-and-clear path adjust.
- `scripts/deploy-tokens.ts` — pass VK + vk_hash to orderbook constructor.
- `cli/src/commands/close-epoch.ts` — new `close-epoch-verified` variant; keep existing `close-epoch` for no-clear fallback.

**Created:**
- `tests/integration/helpers/proof.ts` — `readProofAsFields` helper.

**Not touched:** `contracts/pool/*`, `contracts/token/*`, `circuits/clearing/src/{binding,pricing,amm,main,test}.nr` (the circuit's interior logic is unchanged — only N changes via the global).

## 10. Risks & Open Questions

1. **N=32 proof generation on VPS RAM:** the plan's first task validates this empirically. If proof gen still OOMs, fall back to N=16 (a global-sabit change, no further code impact). The user has been told this contingency is a possibility but unlikely.
2. **`std::verify_proof_with_type` runtime behaviour in non-trivial cases:** the spike confirmed the API compiles and a dummy-input call fails as expected, but the full verify path on a real Honk proof inside an Aztec private function has not been exercised in this codebase. E1 is the load-bearing confirmation.
3. **Proof byte format stability:** `bb`'s output format (456 Fields, big-endian, 32 bytes each) is documented in the bb code (`HONK_PROOF_SIZE = 456` from `bb_proof_verification/src/lib.nr`). If bb's format shifts in a future Aztec version, the helper updates with it.

## 11. Forward References

- **Week 5d-4** will replace the public `fills: BoundedVec<FillEntry, 32>` calldata with a Merkle root committed in `_apply_verified_clearing`; `claim_fill` becomes inclusion-proof based. The flat-fills payload here is the temporary form.
- Once a beefier prover host is available, the N=32 constant can be increased back toward 64 / 128 with the same code paths intact (the only blocker is the prover's RAM budget).
- Trustless aggregation across multiple makers / MPC-style prover schemes — a much later concern; not on the Week 5d sub-project's roadmap.
