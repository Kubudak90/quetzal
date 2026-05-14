# ZSwap-on-Aztec Week 2 — Token Unification + OrderbookContract Scaffold + `submit_order`

**Status:** Draft, awaiting user review
**Date:** 2026-05-14
**Scope:** Week 2 of MVP. First half of the OrderbookContract work (Weeks 2–3 per MVP plan).
**Parent spec:** `2026-05-14-zswap-aztec-mvp-design.md`
**Preceding milestone:** `week-01-foundation` (commit `6435b8c`, plus polish commits `a0c1b87`, `44510fa`, `fd29967`).

---

## 1. Goals (in scope)

1. **Collapse `TokenA` / `TokenB` into a single `Token` contract.** One Noir source, two deployments at runtime, brand constants (`name`, `symbol`, `decimals`) passed as constructor arguments.
2. **OrderbookContract scaffold.** Public storage for the epoch state and contract references; private storage for the `OrderNote` set.
3. **`submit_order` private function with escrow.** Consumes a user's private token notes via `Token.transfer_private_to_public(...)`, moving the locked amount into the OrderbookContract's public balance on the relevant Token, then commits an encrypted `OrderNote` to the orderbook.
4. **Test coverage at two levels.** Noir TXE tests for in-contract logic; TypeScript integration tests for the cross-contract escrow flow against a live dev stack.

## 2. Non-goals (deferred to Week 3+)

| Deferred | Target |
|---|---|
| `cancel_order` (escrow return path) | Week 3 |
| `_advance_epoch` gated public function (called by `ClearingContract`) | Week 3+ (needs ClearingContract) |
| EpochState `OPEN → CLOSING → SETTLED` transitions | Week 3+ |
| Standing-order carryover semantics + FIFO fairness validation | Week 6–8 (clearing circuit) |
| CLI subcommand `zswap order` | Week 3 |
| Off-chain reveal collector / signed reveal publishing | Week 9 (aggregator) |
| LiquidityPoolContract | Week 4–5 |
| ClearingContract | Week 6–8 |

Week 2 deliberately ships a **partial** Orderbook: it can accept orders but cannot cancel, clear, or transition epochs. This is intentional — it lets us validate the cryptographic escrow flow end-to-end before adding more behavior.

---

## 3. Precondition refactor: Token unification

`contracts/token-a/` and `contracts/token-b/` are replaced by a single `contracts/token/`. The vendored 425-line Token implementation is preserved; only the brand surface changes.

### 3.1 Source-level changes

`contracts/token-a/src/main.nr` lines 1–9 currently set:

```rust
global TOKEN_NAME: str<5> = "tUSDC";
global TOKEN_SYMBOL: str<5> = "tUSDC";
global TOKEN_DECIMALS: u8 = 6;
```

These globals are **removed**. The constructor (`constructor_with_minter(name: str<31>, symbol: str<31>, decimals: u8, minter: AztecAddress)`) already accepts these as parameters and persists them in the contract's private storage. The globals were dead code overriding nothing functional.

After the refactor:

```
contracts/
└── token/
    ├── Nargo.toml          # name = "token"
    └── src/
        ├── main.nr         # pub contract Token { ... }  (425 lines)
        └── test.nr         # TXE tests covering mint + private transfer
```

### 3.2 TypeScript / deploy-script changes

- `tests/integration/generated/TokenA.ts` and `TokenB.ts` collapse into a single `Token.ts`.
- `scripts/codegen.sh` updates to a single `aztec codegen contracts/token/target -o tests/integration/generated`.
- `scripts/deploy-tokens.ts` deploys `Token` twice with different constructor arguments:
  ```ts
  const tUSDC = await TokenContract.deployWithOpts(
    { wallet: admin, method: "constructor_with_minter" },
    "tUSDC".padEnd(31, "\0"),
    "tUSDC".padEnd(31, "\0"),
    6n,
    admin.getAddress(),
  ).send().deployed();
  
  const tETH = await TokenContract.deployWithOpts(
    { wallet: admin, method: "constructor_with_minter" },
    "tETH".padEnd(31, "\0"),
    "tETH".padEnd(31, "\0"),
    18n,
    admin.getAddress(),
  ).send().deployed();
  ```
- `tests/integration/tokens.test.ts` updates to deploy two `Token` instances; the assertions remain semantically identical (tUSDC with 6 decimals, tETH with 18 decimals).

### 3.3 Verification

After the refactor, all 4 prior TXE assertions + 2 prior integration assertions still pass:

| Test | Note |
|---|---|
| `Token::mint_to_private_balance` (with tUSDC brand args) | replaces `TokenA::mint_and_check_balance` |
| `Token::mint_to_private_balance` (with tETH brand args) | replaces `TokenB::mint_and_check_balance` |
| `Token::private_transfer_moves_balance` (tUSDC) | replaces `TokenA::private_transfer_moves_balance` |
| `Token::private_transfer_moves_balance` (tETH) | replaces `TokenB::private_transfer_moves_balance` |
| Integration: tUSDC deploy + mint | balance assertion unchanged |
| Integration: tETH deploy + mint + transfer | balance assertions unchanged |

---

## 4. OrderbookContract — storage and types

### 4.1 Layout

```rust
use dep::aztec::macros::aztec;

#[aztec]
pub contract Orderbook {
    use dep::aztec::prelude::{
        AztecAddress, PublicMutable, PublicImmutable, PrivateSet,
    };

    global EPOCH_LENGTH: u32 = 100;        // ≈ 20 min at ~12s/block (devnet)
    global MAX_INPUT_NOTES: u32 = 8;       // bound on private token notes consumed per submit

    #[storage]
    struct Storage<Context> {
        // Private state: standing limit orders, no epoch_id (persistent across epochs)
        orders:        PrivateSet<OrderNote, Context>,

        // Public state: epoch metadata + immutable contract references
        current_epoch: PublicMutable<EpochState, Context>,
        token_a_addr:  PublicImmutable<AztecAddress, Context>,
        token_b_addr:  PublicImmutable<AztecAddress, Context>,
        clearing_addr: PublicImmutable<AztecAddress, Context>,
    }

    #[derive(Serialize, Deserialize)]
    pub struct EpochState {
        epoch_id:        u32,
        state:           u8,   // 0=OPEN, 1=CLOSING, 2=SETTLED — Week 2 ships with OPEN only
        opened_at_block: u32,
        closes_at_block: u32,
    }
}
```

### 4.2 `OrderNote`

```rust
#[note]
struct OrderNote {
    submitted_at_block: u32,
    side:               bool,    // 0 = A→B, 1 = B→A
    amount_in:          u128,
    limit_price:        u128,    // 1e18-scaled fixed-point
    nonce:              Field,
    owner:              AztecAddress,
}
```

The note's hash and nullifier follow Aztec's standard `compute_note_hash_and_nullifier` macro pattern. The note is encrypted to the owner's incoming-view public key so only their PXE can decrypt it.

**No `epoch_id` field.** The order is a standing limit order: it persists from submission until either cancellation (Week 3) or filling (Week 6–8 clearing circuit). `submitted_at_block` is the FIFO ordering key the clearing circuit will use later; in Week 2 it's only written, not read.

### 4.3 Constructor

```rust
#[public]
#[initializer]
fn constructor(token_a: AztecAddress, token_b: AztecAddress, clearing: AztecAddress) {
    let block = self.context.block_number();
    self.storage.current_epoch.write(EpochState {
        epoch_id: 0,
        state: 0,                        // OPEN
        opened_at_block: block,
        closes_at_block: block + EPOCH_LENGTH,
    });
    self.storage.token_a_addr.initialize(token_a);
    self.storage.token_b_addr.initialize(token_b);
    self.storage.clearing_addr.initialize(clearing);
}
```

**`clearing_addr` placeholder.** ClearingContract does not exist in Week 2. The constructor accepts a placeholder address (typically the deployer's). When ClearingContract lands (Week 6–8), the Orderbook is **redeployed** with the real address. MVP does not include on-chain upgradability; deploy-time configuration is fine.

---

## 5. `submit_order` — the only stateful private function in Week 2

### 5.1 Signature

```rust
#[external("private")]
fn submit_order(
    side: bool,
    amount_in: u128,
    limit_price: u128,
    input_notes: BoundedVec<Field, MAX_INPUT_NOTES>,   // user's token note secrets to consume
) {
    // ...
}
```

### 5.2 Logic

```
1. Read public epoch state, assert state == OPEN (= 0).
2. Read the relevant token contract address based on `side`.
3. Compute a fresh nonce (PXE-provided randomness).
4. Call Token.transfer_private_to_public(sender, orderbook_addr, amount_in, nonce)
   on the chosen token. This:
     a. Consumes the user's input notes equaling at least amount_in
        (Token contract's existing logic handles change return)
     b. Increments the Token contract's public balance entry for orderbook_addr by amount_in
   The call propagates failure (insufficient balance, wrong owner) up to the user's
   submit_order tx, which then reverts atomically.
5. Construct OrderNote with submitted_at_block = current block number,
   the provided side / amount_in / limit_price, a fresh nonce, owner = sender.
6. Insert into orderbook's PrivateSet<OrderNote>, emit encrypted log to sender.
```

### 5.3 Escrow accounting after a successful `submit_order`

| Where | Before | After |
|---|---|---|
| Sender's `Token_X` private balance | `B_sender` | `B_sender − amount_in` |
| `Orderbook_addr`'s `Token_X` public balance | `B_orderbook` | `B_orderbook + amount_in` |
| `orders` PrivateSet | N entries | N + 1 entries |
| Sender's PXE encrypted log set | (no order log) | (new OrderNote log) |

`Token_X` is `token_a` if `side == 0`, `token_b` if `side == 1`. Nothing about the user, their amount, or their price is publicly visible — only the aggregate public balance of the orderbook on the relevant token increments, and only the encrypted-log entry is broadcast.

### 5.4 Failure modes (all atomic — full tx reverts)

| Failure | Where caught |
|---|---|
| `epoch.state != OPEN` | `submit_order` assertion |
| Insufficient input notes / balance | inside `Token.transfer_private_to_public` |
| `amount_in == 0` or `limit_price == 0` | `submit_order` assertion (guard against degenerate orders) |
| `input_notes` length 0 | propagates as zero-sum balance failure inside Token |

### 5.5 What `submit_order` does NOT do in Week 2

- **No reveal publishing.** The aggregator reveal flow lives in Week 9 with the off-chain aggregator client. Week 2's `submit_order` only commits the encrypted note on-chain.
- **No epoch-bound checks beyond `state == OPEN`.** The "expired epoch" check (`block_number() >= closes_at_block`) is **not** enforced in Week 2; epoch transitions are Week 3+. The first epoch stays OPEN indefinitely as far as Week 2 is concerned.
- **No FIFO selection.** Orders accumulate without any constraint on count. The 128-order cap from the parent MVP spec is a clearing-circuit constraint, not a submission constraint, and arrives with the clearing work.

---

## 6. Test strategy

### 6.1 Noir TXE tests (`contracts/orderbook/src/test.nr`)

| Test | What it verifies |
|---|---|
| `constructor_sets_initial_epoch` | After deploy: `epoch_id == 0`, `state == 0` (OPEN), `closes_at_block == opened_at_block + 100`. |
| `constructor_records_token_addrs` | `token_a_addr`, `token_b_addr`, `clearing_addr` readable as the values passed in. |
| `order_note_serialization_round_trip` | An `OrderNote` constructed in-test serializes and deserializes to the same fields. |
| `order_note_unique_nullifier` | Two notes with same content but different `nonce` produce different nullifiers. |
| `submit_order_rejects_when_not_open` | TXE harness sets `EpochState::state = 1` via direct storage write; subsequent `submit_order` reverts. |
| `submit_order_commits_note_to_set` | After a successful submit (TXE mocks Token cross-call), the `orders` `PrivateSet` contains exactly one note with the expected fields. |

TXE here means in-process Noir tests using `dep::aztec::test::helpers::test_environment::TestEnvironment`. Cross-contract calls in TXE require deploying the Token contract too — see §6.2 for whether to attempt this or push to integration tests.

**Decision: TXE attempts cross-contract Token deploy for `submit_order_commits_note_to_set`.** The Aztec TXE helpers support `env.deploy(...)` for arbitrary contracts. If this turns out to be costly or flaky during implementation, fall back to integration coverage for that single assertion.

### 6.2 TypeScript integration tests (`tests/integration/orderbook.test.ts`)

Run against the live dev stack (`scripts/dev.sh`):

| Scenario | Setup → Assertion |
|---|---|
| `submit single order, all balances reflect escrow` | Deploy `Token` ×2 + `Orderbook`. Mint 1000 tUSDC to Alice. Alice calls `submit_order(side=0, amount_in=100, limit_price=...)`. Assert: Alice's private tUSDC balance = 900; Orderbook's public tUSDC balance = 100; Alice's PXE shows 1 OrderNote with `amount_in=100`, `side=0`. |
| `submit fails when amount_in exceeds balance` | Alice has 50 tUSDC. Submit with `amount_in=100`. Expect: tx reverts; no OrderNote committed; balances unchanged. |
| `submit on opposite side uses opposite token` | Alice has 5 tETH. Submit with `side=1, amount_in=2_000_000_000_000_000_000n` (= 2 tETH). Assert: tUSDC balances untouched; Alice's tETH balance = 3 tETH; Orderbook's public tETH balance = 2 tETH; OrderNote has `side=1`. |
| `two orders from same user accumulate` | Alice submits two orders. Assert: Alice's PXE shows 2 OrderNotes; Orderbook's public balance reflects sum of both `amount_in`. |
| `nonce uniqueness across orders` | Two identical-parameter submits from Alice produce two notes with different nullifiers (i.e. both can coexist). |

### 6.3 What's NOT tested in Week 2

- Cancel flow (Week 3)
- Epoch transitions (Week 3+)
- FIFO selection across many submitters (clearing circuit weeks)
- Concurrent submitters racing on the same Orderbook (not a functional issue in Week 2; orders are independent inserts)

---

## 7. Repository delta after Week 2

```
aztec-project/
├── contracts/
│   ├── orderbook/                  ← NEW
│   │   ├── Nargo.toml
│   │   └── src/{main.nr,test.nr}
│   └── token/                      ← RENAMED from token-a; token-b deleted
│       ├── Nargo.toml
│       └── src/{main.nr,test.nr}
├── scripts/
│   ├── codegen.sh                  ← updated (one codegen call instead of two)
│   ├── compile-all.sh              ← unchanged (already globs contracts/*/)
│   ├── dev.sh                      ← unchanged
│   └── deploy-tokens.ts            ← rewritten: deploy Token×2 + Orderbook
├── tests/integration/
│   ├── tokens.test.ts              ← updated: uses single TokenContract
│   ├── orderbook.test.ts           ← NEW
│   └── helpers/                    ← unchanged
└── docs/superpowers/
    ├── specs/2026-05-14-zswap-aztec-week-02-orderbook-design.md  ← THIS DOC
    └── plans/2026-05-14-zswap-aztec-week-02-orderbook.md         ← TO BE WRITTEN
```

Deleted: `contracts/token-a/`, `contracts/token-b/`.

---

## 8. Implementation phases (preview of the plan)

The forthcoming Week 2 implementation plan will sequence the work roughly as:

1. **Token unification refactor.** Create `contracts/token/` from a copy of token-a, drop the global brand constants, delete token-a + token-b directories.
2. **Update codegen + deploy-tokens + tokens.test.ts** to use the single Token contract.
3. **Verify Week 1 acceptance still passes** (`pnpm compile`, `pnpm test:noir`, `pnpm test`).
4. **OrderbookContract scaffold.** `Nargo.toml` + empty `main.nr` that compiles.
5. **OrderNote type + nullifier.** `Serialize`/`Deserialize` derives; TXE test for round-trip.
6. **Storage + constructor.** TXE test for constructor invariants.
7. **`submit_order` private function** with the escrow call.
8. **TXE tests for `submit_order`.**
9. **Integration tests.** Deploy + submit + balance assertions.
10. **Acceptance run** and Week 2 milestone tag.

The plan will give each step concrete files, code, and verification commands.

---

## 9. Risks specific to Week 2

| Risk | Likelihood | Mitigation |
|---|---|---|
| `Token.transfer_private_to_public` does not exist with the signature documented in Week 1's prior review | Low | Verified during Week 1; signature is `(from, to, amount, nonce)`. Will re-verify against vendored source on first attempt. |
| TXE cross-contract calls (deploying Token from inside Orderbook's test environment) hit unsupported API surface | Medium | Fallback: cover the cross-contract assertion in integration tests instead. TXE still covers in-contract invariants. |
| `BoundedVec<Field, 8>` cap on input notes is too tight for realistic test transfers | Low | 8 input notes per submit is generous for unit tests; mint logic produces a single note per mint call. If tests exhibit problems, bump the cap. |
| Token constructor signature has subtleties (str<31> padding) that break the new deploy script | Medium | Mirror the exact padding pattern used in the existing Week 1 `deploy-tokens.ts`. |
| Aztec 4.x lacks `PublicImmutable.initialize(...)` semantics matching v3-era documentation | Medium | Verify with the codebase at v4.2.0 source on first compile attempt. Fall back to `PublicMutable` if needed. |

---

## 10. Acceptance criteria

Week 2 is complete when ALL of the following hold on a fresh clone:

1. `pnpm compile` succeeds for `contracts/token` and `contracts/orderbook`.
2. `pnpm test:noir` succeeds and reports ≥ 6 passing TXE tests (4 Token from §3.3 + ≥ 2 newly added Orderbook tests).
3. `pnpm codegen` produces both `Token.ts` and `Orderbook.ts` bindings.
4. `pnpm test` (with dev stack running) succeeds with ≥ 5 passing integration tests (existing + new from §6.2).
5. `scripts/deploy-tokens.ts` deploys two `Token` instances plus the `Orderbook` (taking the deployer as `clearing_addr` placeholder).
6. Git tag `week-02-orderbook-submit` exists at HEAD.

---

## 11. Open questions deferred to implementation

These will be resolved during the plan's execution (likely raised by subagent implementers):

- **PXE randomness API for `nonce`.** Aztec 4.x may expose `context.next_random_field()` or similar. Verify on first compile.
- **Whether `MAX_INPUT_NOTES` should be configurable.** Hard-coded at 8 for now; revisit if tests show real cases needing more.
- **Whether `Orderbook.constructor` should accept `EPOCH_LENGTH` as a parameter** vs. hard-coded global. Hard-coded for Week 2 simplicity; can revisit when ClearingContract lands.

These are not blockers — they're concrete questions answered by reading code or running compile.
