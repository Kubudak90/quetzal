# Week 5d-2: Standalone Noir Clearing Circuit — Design

**Status:** approved
**Sub-project:** Week 5d (trustless clearing via ZK proof), slice 2 of 4

---

## 1. Goal

Implement a standalone Noir circuit that proves an off-chain-computed clearing is correct. The aggregator continues to discover the clearing price `P*` via the existing binary search in `aggregator/src/clearing.ts`; the circuit verifies that the resulting `(P*, fills, ClearingSwap)` satisfies the auction's constraints against the order set committed to by Week 5d-1's on-chain accumulators.

This week ships **the circuit + off-chain prove/verify tooling only.** Recursive verification inside the Aztec `Orderbook` contract (which makes the proof actually gating `close_epoch_and_clear`) is Week 5d-3.

## 2. Background

Week 5d-1 added two per-epoch running-hash chains to `EpochState` — `order_acc` over submitted-order commitments, `cancel_acc` over cancelled-order commitments — plus the counts `order_count` and `cancel_count`. Those chains are the binding handle: any party with access to the orders' preimages can prove "I cleared exactly this epoch's submitted-minus-cancelled order set."

Week 5c shipped on-chain *trusted* clearing: `close_epoch_and_clear(fills, swap)` accepts a `clearing_authority`-signed payload and relays it. The Week 5d series replaces that trust with a verified ZK proof. 5d-2 builds the proof; 5d-3 wires it into the contract.

## 3. Scope

**In scope (the verifier model "A + B" — binding + clearing correctness):**

- A new top-level Noir circuit at `circuits/clearing/`, type `bin`, with a `fn main` that consumes a `ClearingPublic` public-inputs struct and a private witness.
- Binding constraints: order-set replay against `order_acc` / `cancel_acc` using the same Poseidon2 formula as 5d-1.
- Clearing-correctness constraints: per-order eligibility at `P*`, payout formula per fill, DoS-resistance (every eligible non-cancelled order is in `fills`), aggregate net-swap derivation, ClearingSwap field cross-check, AMM k-monotonicity, fee-per-share derivation.
- Witness-builder TypeScript module in `aggregator/src/witness.ts`.
- Off-chain prove/verify tooling via `nargo execute` + `bb prove` + `bb verify`.
- Three layers of tests: Noir `#[test]` units, a JS-orchestrated end-to-end test against the live stack, and a TS-only witness-parity test.

**Out of scope (deferred):**

- Discovery of `P*` inside the circuit (binary search). The aggregator continues to do this; the circuit verifies, not searches. (Avoids the ~16384-inner-op cost.)
- Recursive verification inside the `Orderbook` contract → Week 5d-3.
- Merkle settlement root over fills → Week 5d-4. 5d-2 leaves `fills` as a flat public-input vector (matches the contract's existing `BoundedVec<FillEntry, 128>` surface).
- The "skip" case (no-eligible-orders, degenerate-pool, no-convergence). The circuit assumes an active clearing — `fills.len() >= 1`. The permissionless `close_epoch` path remains the skip fallback.

## 4. Architecture

**Project layout:**

```
circuits/clearing/
├── Nargo.toml          # type = "bin", name = "clearing", Noir 1.0.0-beta.19
└── src/
    ├── main.nr         # fn main(...) — orchestration
    ├── binding.nr      # order_acc / cancel_acc replay + is_cancelled derivation
    ├── pricing.nr      # eligibility, payout formula, fee, ClearingSwap derivation
    ├── amm.nr          # k-monotonicity + reserve delta consistency
    └── test.nr         # Noir #[test] units (mod test;)
```

Five focused files instead of one main.nr — 5d-1's main.nr was already at the edge of reasonable, and 5d-2's circuit is larger. The `binding`, `pricing`, `amm`, `test` modules are imported by `main.nr` and surface tight named functions.

`circuits/clearing/target/` is gitignored (mirror `contracts/*/target/`).

**Toolchain integration:**

- `scripts/compile.sh` (or `pnpm compile`) runs `nargo compile` for the circuit in addition to the contracts. Output: `circuits/clearing/target/clearing.json` (the ACIR).
- A new step writes the verification key: `bb write_vk -b circuits/clearing/target/clearing.json -o circuits/clearing/target/vk.bin`. 5d-3 will embed this VK.
- `bb` binary is shipped with the local Aztec install at `~/.aztec/versions/4.2.1/node_modules/@aztec/bb.js/build/<arch>/bb` — referenced by full path or via PATH augmentation.

## 5. I/O Interface

### 5.1 Public inputs (revealed by the proof; the 5d-3 contract gate's interface)

```noir
struct FillEntry {
    order_nonce: Field,
    amount_out: u128,
}

struct ClearingSwap {
    a_to_pool:                  u128,
    b_to_pool:                  u128,
    a_from_pool:                u128,
    b_from_pool:                u128,
    reserve_a_add:              u128,
    reserve_a_sub:              u128,
    reserve_b_add:              u128,
    reserve_b_sub:              u128,
    fee_a_per_share_increment:  u128,
    fee_b_per_share_increment:  u128,
}

struct ClearingPublic {
    // Binding (from 5d-1's EpochState):
    order_acc:    Field,
    cancel_acc:   Field,
    order_count:  u32,
    cancel_count: u32,

    // Pre-clearing pool snapshot:
    reserve_a: u128,
    reserve_b: u128,
    lp_supply: u128,

    // Aggregator's claimed clearing output:
    clearing_price: u128,                       // Q-1e18
    fills: BoundedVec<FillEntry, 128>,
    swap: ClearingSwap,
}
```

(If `BoundedVec` does not serialize directly as a public-input format in the prove/verify pipeline, the implementer flattens to `fills: [FillEntry; 128]` + `fills_len: u32` at the boundary; the in-circuit logic is identical.)

`ClearingSwap`'s 10 fields are byte-identical to the existing struct in `contracts/pool/src/main.nr`. 5d-3's `close_epoch_and_clear(public_inputs, proof)` plugs the verified `swap` into the existing `LiquidityPool::apply_clearing(swap)` call without changing the pool's surface.

### 5.2 Private inputs (witness — only the prover sees)

```noir
struct OrderPreimage {
    side:               bool,
    amount_in:          u128,
    limit_price:        u128,
    order_nonce:        Field,
    submitted_at_block: u32,
    owner:              Field,        // AztecAddress.inner
}

orders:              [OrderPreimage; 128],   // submission order; slots [order_count..128] zero
cancelled_indices:   [u32; 128],             // indexes into `orders`, in cancellation order
fill_to_order_index: [u32; 128],             // each fills[i] points to orders[j], lookup hint
```

`cancelled_indices[i]` (for `i < cancel_count`) is the submission index of the i-th cancelled order; `cancelled_indices[i] < order_count` is enforced. Slots `[cancel_count..128]` are unused (the circuit's `for` loop short-circuits past `cancel_count`).

`fill_to_order_index[i]` (for `i < fills.len()`) is a witness-supplied lookup that says "fill i corresponds to orders[j]." The circuit verifies the nonces match. This avoids 128² in-circuit search.

### 5.3 Order commitment formula (matches Week 5d-1)

```
c_i = poseidon2_hash([
    orders[i].owner,
    if orders[i].side { 1 } else { 0 },
    orders[i].amount_in as Field,
    orders[i].limit_price as Field,
    orders[i].order_nonce,
    orders[i].submitted_at_block as Field,
])
```

Bit-for-bit identical to `submit_order`'s and `cancel_order`'s `c_i` computations (the IT4 invariant).

## 6. Verification Logic (Constraint List)

The circuit asserts each of the following in order. Any failure aborts proving.

### 6.1 Binding

1. `cancel_count <= order_count` (cancellations cannot exceed submissions).
2. Replay `order_acc`: `acc = 0; for i in 0..128 { if i < order_count { acc = poseidon2_hash([acc, c_i(orders[i])]) } }; assert acc == public.order_acc`.
3. Replay `cancel_acc`: `acc = 0; for j in 0..128 { if j < cancel_count { assert(cancelled_indices[j] < order_count); acc = poseidon2_hash([acc, c_i(orders[cancelled_indices[j]])]) } }; assert acc == public.cancel_acc`.
4. Derive `is_cancelled: [bool; 128]`: `is_cancelled[k] = false` for all k; for each `j < cancel_count`, set `is_cancelled[cancelled_indices[j]] = true`. (Implementation: iterate, mark.)

### 6.2 Per-fill eligibility & payout

For each `i < fills.len()`, with `j = fill_to_order_index[i]`:

5. `assert(j < order_count && !is_cancelled[j])` — must point to a real, uncancelled order.
6. `assert(orders[j].order_nonce == fills[i].order_nonce)` — lookup hint consistent.
7. **Eligibility:**
   - Buy (`orders[j].side == false`): `assert(orders[j].limit_price >= clearing_price)`.
   - Sell (`orders[j].side == true`):  `assert(orders[j].limit_price <= clearing_price)`.
8. **Payout** — the canonical formula (matches `aggregator/src/clearing.ts` `mulDiv` semantics, floor rounding):
   - Buy:  `expected_out_b = mul_div(orders[j].amount_in, SCALE, clearing_price)`; then `expected_out_b = mul_div(expected_out_b, FEE_DEN - FEE_NUM, FEE_DEN)`.
   - Sell: `expected_out_a = mul_div(orders[j].amount_in, clearing_price, SCALE)`; then `expected_out_a = mul_div(expected_out_a, FEE_DEN - FEE_NUM, FEE_DEN)`.
   - `assert(fills[i].amount_out == expected_out)`.

### 6.3 DoS resistance (every eligible non-cancelled order is filled)

9. Derive `is_filled: [bool; 128]` from `fill_to_order_index[0..fills.len()]`.
10. For each `k < order_count` where `!is_cancelled[k]`: if eligibility holds (per §6.2.7) at `clearing_price`, then `assert(is_filled[k])`. An aggregator cannot silently exclude an in-the-money order.

### 6.4 Aggregate net-swap derivation

Compute over filled orders:

11. `gross_buy_in_a = Σ orders[j].amount_in` over filled buys.
12. `gross_sell_in_b = Σ orders[j].amount_in` over filled sells.
13. `buyer_payouts_b = Σ fills[i].amount_out` over filled buys.
14. `seller_payouts_a = Σ fills[i].amount_out` over filled sells.
15. `gross_buy_out_b = mul_div(gross_buy_in_a, SCALE, clearing_price)`  *(pre-fee gross)*
16. `gross_sell_out_a = mul_div(gross_sell_in_b, clearing_price, SCALE)`  *(pre-fee gross)*
17. `fee_pool_a = gross_sell_out_a - seller_payouts_a`
18. `fee_pool_b = gross_buy_out_b - buyer_payouts_b`

### 6.5 ClearingSwap cross-check

19. `assert(swap.a_to_pool == saturating_sub(gross_buy_in_a, seller_payouts_a))`
20. `assert(swap.a_from_pool == saturating_sub(seller_payouts_a, gross_buy_in_a))` (one of `a_to_pool` / `a_from_pool` is zero).
21. `assert(swap.b_to_pool == saturating_sub(gross_sell_in_b, buyer_payouts_b))`
22. `assert(swap.b_from_pool == saturating_sub(buyer_payouts_b, gross_sell_in_b))`
23. **Reserve-delta identity (token A)** — `assert(swap.reserve_a_add + swap.a_from_pool + fee_pool_a == swap.reserve_a_sub + swap.a_to_pool)`. Rearranged form of `reserve_delta == net_flow_in - fee_withheld`, kept all-positive so Noir's unsigned u128 arithmetic suffices.
24. **Reserve-delta identity (token B)** — same with `swap.reserve_b_*`, `swap.b_to_pool/b_from_pool`, and `fee_pool_b`.
25. `assert(swap.fee_a_per_share_increment == mul_div(fee_pool_a, SCALE, lp_supply))` *(floor; matches aggregator)*
26. `assert(swap.fee_b_per_share_increment == mul_div(fee_pool_b, SCALE, lp_supply))`

### 6.6 AMM k-monotonicity (Week 5b conservation invariant)

27. `new_reserve_a = reserve_a + swap.reserve_a_add - swap.reserve_a_sub`
28. `new_reserve_b = reserve_b + swap.reserve_b_add - swap.reserve_b_sub`
29. `assert(new_reserve_a * new_reserve_b <= reserve_a * reserve_b)` — fee withheld; `k` only shrinks by floor dust.

### 6.7 Fixed-point conventions

- `SCALE = 10^18` (matches `aggregator/src/fixed-point.ts`).
- `FEE_NUM = 30`, `FEE_DEN = 10_000` (30 bps).
- `mul_div(x, y, z) = (x * y) / z` with floor rounding. Implemented in Noir via a wider intermediate (Field-based or `u256` as the toolchain allows) to avoid overflow on `amount * SCALE` (10^18 ≈ 2^60; `amount` up to 2^128 ⇒ intermediate up to 2^188, fits comfortably inside Field, which is ~2^254).

## 7. Witness Builder (TypeScript)

New module: `aggregator/src/witness.ts`. Single public function:

```ts
import { type EpochState, type OrderNotePreimage } from "./types.js";
import { type ClearingResult, type PoolSnapshot } from "./clearing.js";

export interface ClearingWitness {
  /** TOML-encoded text to feed `nargo execute` via `--prover-toml-path`. */
  proverToml: string;
  /** Same data parsed; useful for cross-impl parity tests. */
  publicInputs: ClearingPublicTS;
  privateInputs: ClearingPrivateTS;
}

export function buildClearingWitness(args: {
  epoch: EpochState;
  pool: PoolSnapshot;
  orders: OrderNotePreimage[];           // in submission order, length === order_count
  cancellationIndices: number[];          // in cancellation order, length === cancel_count
  clearing: ClearingResult;               // from aggregator's computeClearing
}): ClearingWitness;
```

Responsibilities:
- Pad `orders` with sentinel zero-init entries to 128 slots.
- Build `cancelled_indices[]` padded to 128.
- Build `fill_to_order_index[]` by matching `fills[i].orderNonce` against orders' nonces.
- Serialize to the `Prover.toml` format Noir expects.

Determinism is the entire point: the witness builder must produce values the circuit accepts on the first try, exactly. The IT4 invariant from 5d-1 (submit/cancel commitment-equality across TS and Noir) is the model for this — same Poseidon2 inputs in the same order.

## 8. Testing

Three test layers.

### 8.1 Noir `#[test]` units (`circuits/clearing/src/test.nr`, no Docker, fast)

| # | Test | Asserts |
|---|---|---|
| U1 | `c_i` formula vs hand-computed | 5d-1 binding-equivalent Poseidon2 input order |
| U2 | `order_acc` 3-link replay (no sentinel) | Constraint §6.1.2 in isolation |
| U3 | Eligibility — buy `limit >= P*`, sell `limit <= P*` | §6.2.7 |
| U4 | Payout — buy 1000 tUSDC @ `P* = 2e18` produces ~498 tETH (30bps fee withheld) | §6.2.8 + fixed-point conventions |
| U5 | AMM k-monotonicity on a small synthetic swap | §6.6 |
| U6 | DoS resistance — fills omitting an eligible order is rejected | §6.3 |
| U7 | `cancel_acc` replay with wrong commitment is rejected | §6.1.3 — binding-tampering negative |
| U8 | Eligibility tampering — `clearing_price` outside an order's limit is rejected | §6.2.7 negative |

Run via `nargo test` (no proof generation; concrete-input execution with assert checks). Fast — each test seconds. Already runnable on the VPS dev box.

### 8.2 JS-orchestrated end-to-end (`tests/integration/clearing-circuit.test.ts`, live stack)

| # | Test | Asserts |
|---|---|---|
| E1 | Happy path: 5 orders + 1 cancel → aggregator clearing → witness → `nargo execute` + `bb prove` + `bb verify` returns OK | Full prove/verify round trip; aggregator/witness/circuit parity |
| E2 | Tampered fills: take E1's witness, manually set `fills[0].amount_out += 1n` → `bb verify` rejects | Tampering smoke test (the ZK assurance) |

Each test ~10-20 min (proof generation is the slow step). Runs on VPS against the existing live stack.

### 8.3 TS-only witness parity (`aggregator/test/witness.test.ts`, Vitest unit)

Build a witness from a frozen reference scenario (orders + cancellations + clearing). Assert each TOML field matches an expected golden value. No circuit run.

This catches drift between the TS `buildClearingWitness` and the Noir circuit's expected layout — without paying proof-generation cost. ~6-10 reference vectors covering common shapes (1-side-only, mixed, edge fee dust).

## 9. Affected Files

- `circuits/clearing/Nargo.toml` — new.
- `circuits/clearing/src/main.nr`, `binding.nr`, `pricing.nr`, `amm.nr`, `test.nr` — new (5 source files).
- `scripts/compile.sh` (or equivalent in `package.json`) — extend to also run `nargo compile` on the circuit and `bb write_vk`.
- `aggregator/src/witness.ts` — new.
- `aggregator/test/witness.test.ts` — new (existing aggregator test infra).
- `tests/integration/clearing-circuit.test.ts` — new.
- `.gitignore` — add `circuits/*/target/`.

Not touched: `contracts/*`, existing aggregator clearing module (`clearing.ts`), CLI, other integration tests.

## 10. Forward References

- **Week 5d-3** will consume `circuits/clearing/target/clearing.json` + `vk.bin` and embed recursive verification inside the `Orderbook` contract. `close_epoch_and_clear` becomes `close_epoch_and_clear(public_inputs, proof)`, gated by `std::verify_proof`. The `clearing_authority` storage slot is repurposed (or removed). A `CLOSING` epoch state may be added.
- **Week 5d-4** will replace the flat `fills` public-input vector with a Merkle root; `claim_fill` becomes inclusion-proof based. 5d-2's `fills`-as-public-input is the temporary form.

## 11. Open Risk

The biggest risk is **fixed-point precision drift** between the TS aggregator and the Noir circuit. They must produce byte-identical `amount_out` for every fill, byte-identical fee accruals, etc., or every proof fails. Mitigation: §6.7 pins the `mul_div(x, y, z) = (x * y) / z` (floor) convention on both sides; §8.3 freezes reference vectors so drift is caught without paying proof-generation cost.

Secondary risk: **proof generation time** in the bb prover for this circuit size. Each E1/E2 run is 10-20 min on commodity hardware. If it balloons beyond ~30 min on the VPS, we'd cap circuit size or split into sub-circuits. The unit tests (Noir `nargo test`, no proof) don't have this risk and provide the bulk of the assurance.
