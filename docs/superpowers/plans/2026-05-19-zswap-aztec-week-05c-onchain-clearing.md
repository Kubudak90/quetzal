# ZSwap-on-Aztec — Week 5c: On-chain trusted clearing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put clearing on-chain (trusted): an authority-gated `close_epoch_and_clear` on the Orderbook applies one epoch's clearing (AMM net swap against the Pool, fill recording, epoch advance), and `claim_fill` lets a filled maker nullify their order and receive their output.

**Architecture:** No new contract — `close_epoch_and_clear` / `claim_fill` are added to `OrderbookContract`; the Orderbook calls the `LiquidityPool` once per clearing for the net AMM swap. The Orderbook constructor gains `pool_addr` + `clearing_authority`; the Pool gains a one-shot `set_orderbook` and a gated `apply_clearing`. `claim_fill` uses the hint-validate pattern (the maker supplies the payout, an enqueued public callback validates it against the recorded fill).

**Tech Stack:** Noir / aztec-nr v4.2.0, Aztec 4.2.1, TypeScript (Node 22), `commander`, `node:test` + `tsx`, pnpm workspaces.

**Spec:** `docs/superpowers/specs/2026-05-19-zswap-aztec-week-05c-onchain-clearing-design.md`

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `contracts/pool/src/main.nr` | `ClearingSwap` type, `orderbook_addr` storage, `set_orderbook`, `apply_clearing` | Modify |
| `contracts/pool/src/test.nr` | `set_orderbook` / `apply_clearing` TXE tests | Modify |
| `contracts/orderbook/Nargo.toml` | add the `pool` path dependency | Modify |
| `contracts/orderbook/src/main.nr` | constructor + storage; `FillEntry`; `close_epoch_and_clear`; `claim_fill` + `_assert_fill` + `get_fill` | Modify |
| `contracts/orderbook/src/test.nr` | update the deploy helper; clearing / claim TXE tests | Modify |
| `tests/integration/clearing.test.ts` | the full close_epoch_and_clear → claim round trip | Create |
| `tests/integration/orderbook.test.ts` | update Orderbook deploys for the new constructor | Modify |
| `tests/integration/cli.test.ts` | update deploys; `zswap claim` smoke case | Modify |
| `cli/src/commands/claim.ts` | `zswap claim` | Create |
| `cli/src/index.ts` | register `claim` | Modify |
| `scripts/deploy-tokens.ts` | new deploy order + Orderbook constructor args + `set_orderbook` | Modify |
| `README.md` | status line + CLI list + docs links | Modify |

`tests/integration/pool.test.ts` is unchanged — the Pool constructor does not change, and its deposit/withdraw tests do not exercise `apply_clearing`.

## Pre-flight

- [ ] Confirm `git status` clean, `git tag -l | grep week-05b` shows `week-05b-clearing-aggregator`.
- [ ] Confirm Docker is running.
- [ ] Read `contracts/orderbook/src/main.nr` and `contracts/pool/src/main.nr` — the new code mirrors their established patterns (`submit_order`/`cancel_order` escrow + `pop_notes`; `close_epoch`; the `_assert_epoch_open` enqueued callback; `_apply_deposit` for the public-mutate pattern).

---

## Task 1: Pool — `ClearingSwap`, `set_orderbook`, `apply_clearing`

**Dispatch with model: sonnet.**

**Files:** Modify `contracts/pool/src/main.nr`, `contracts/pool/src/test.nr`

- [ ] **Step 1: `main.nr` — add `FromField` to the imports**

`contracts/pool/src/main.nr`'s `use aztec::{ ... }` block imports
`protocol::{address::AztecAddress, traits::{Deserialize, Packable, Serialize}}`.
Add `FromField` to that traits list:

```rust
        protocol::{
            address::AztecAddress,
            traits::{Deserialize, FromField, Packable, Serialize},
        },
```

- [ ] **Step 2: `main.nr` — add the `ClearingSwap` struct**

Insert after the `PositionNote` struct and before the `#[storage]` struct:

```rust
    /// The aggregate net AMM swap for one epoch's clearing, pre-computed by the
    /// off-chain aggregator and relayed verbatim (trusted slice). The physical
    /// token moves (`*_to_pool` / `*_from_pool`) and the reserve-accounting deltas
    /// (`reserve_*_add` / `reserve_*_sub`) are passed separately: the fee is
    /// withheld from reserves, so the Pool receives the full net input but only
    /// `reserve_*_add` of it counts as reserve.
    #[derive(Deserialize, Eq, Packable, Serialize)]
    pub struct ClearingSwap {
        pub a_to_pool: u128,
        pub b_to_pool: u128,
        pub a_from_pool: u128,
        pub b_from_pool: u128,
        pub reserve_a_add: u128,
        pub reserve_a_sub: u128,
        pub reserve_b_add: u128,
        pub reserve_b_sub: u128,
        pub fee_a_per_share_increment: u128,
        pub fee_b_per_share_increment: u128,
    }
```

- [ ] **Step 3: `main.nr` — add `orderbook_addr` storage + initialize it**

In the `#[storage] struct Storage<Context>`, add a field:

```rust
        orderbook_addr: PublicMutable<AztecAddress, Context>,
```

In the `constructor`, after the `pool_state.write(...)` call, add:

```rust
        self.storage.orderbook_addr.write(AztecAddress::from_field(0));
```

- [ ] **Step 4: `main.nr` — add `set_orderbook` and `apply_clearing`**

Insert after the constructor, before the `// === DEPOSIT ===` section:

```rust
    // ============================ CLEARING WIRING ============================

    /// One-shot setter for the OrderbookContract address. The Pool is deployed
    /// before the Orderbook, so the address is wired in post-deploy. Settable
    /// exactly once (the stored value starts at the zero address), so it cannot
    /// be re-pointed later.
    #[external("public")]
    fn set_orderbook(orderbook: AztecAddress) {
        let current = self.storage.orderbook_addr.read();
        assert(current == AztecAddress::from_field(0), "orderbook already set");
        self.storage.orderbook_addr.write(orderbook);
    }

    /// Apply one epoch's net AMM swap. Called only by the OrderbookContract from
    /// within `close_epoch_and_clear`. The Orderbook has already transferred the
    /// net INPUT token into this pool; `apply_clearing` returns the net OUTPUT
    /// token and updates the pool accounting (reserves by the explicit deltas,
    /// the cumulative fee-per-share counters by the increments). `lp_supply` is
    /// unchanged - clearing never mints or burns LP shares.
    #[external("public")]
    fn apply_clearing(swap: ClearingSwap) {
        let orderbook = self.storage.orderbook_addr.read();
        assert(self.msg_sender() == orderbook, "not the orderbook");

        if swap.a_from_pool > 0 as u128 {
            self.call(Token::at(self.storage.token_a_addr.read()).transfer_public_to_public(
                self.address,
                orderbook,
                swap.a_from_pool,
                0,
            ));
        }
        if swap.b_from_pool > 0 as u128 {
            self.call(Token::at(self.storage.token_b_addr.read()).transfer_public_to_public(
                self.address,
                orderbook,
                swap.b_from_pool,
                0,
            ));
        }

        let s = self.storage.pool_state.read();
        self.storage.pool_state.write(PoolState {
            reserve_a: s.reserve_a + swap.reserve_a_add - swap.reserve_a_sub,
            reserve_b: s.reserve_b + swap.reserve_b_add - swap.reserve_b_sub,
            lp_supply: s.lp_supply,
            cum_fee_a_per_share: s.cum_fee_a_per_share + swap.fee_a_per_share_increment,
            cum_fee_b_per_share: s.cum_fee_b_per_share + swap.fee_b_per_share_increment,
        });
    }
```

`Token` is already imported (`use token::Token;`). `transfer_public_to_public` is
`#[authorize_once("from","_nonce")] #[external("public")]` — `from` is the Pool
itself, so the nonce is the literal `0`.

- [ ] **Step 5: Compile**

Run: `pnpm compile`
Expected: `All contracts compiled.`

- [ ] **Step 6: `test.nr` — add TXE tests**

Append to `contracts/pool/src/test.nr`. The happy path of `apply_clearing`
(token transfers) needs a real Token + Orderbook — integration territory; the
pure-TXE tests cover the pre-cross-call gates.

```rust
#[test]
unconstrained fn set_orderbook_can_be_set_once() {
    let mut env = TestEnvironment::new();
    let deployer = env.create_light_account();
    let pool = deploy_pool(&mut env, deployer, deployer, deployer);

    let orderbook = env.create_light_account();
    env.call_public(deployer, LiquidityPool::at(pool).set_orderbook(orderbook));
    // No revert == success; a follow-up read is covered by the integration suite.
}

#[test(should_fail_with = "orderbook already set")]
unconstrained fn set_orderbook_rejects_a_second_set() {
    let mut env = TestEnvironment::new();
    let deployer = env.create_light_account();
    let pool = deploy_pool(&mut env, deployer, deployer, deployer);

    let first = env.create_light_account();
    env.call_public(deployer, LiquidityPool::at(pool).set_orderbook(first));
    let second = env.create_light_account();
    env.call_public(deployer, LiquidityPool::at(pool).set_orderbook(second));
}

#[test(should_fail_with = "not the orderbook")]
unconstrained fn apply_clearing_rejects_non_orderbook_caller() {
    let mut env = TestEnvironment::new();
    let deployer = env.create_light_account();
    let pool = deploy_pool(&mut env, deployer, deployer, deployer);

    let orderbook = env.create_light_account();
    env.call_public(deployer, LiquidityPool::at(pool).set_orderbook(orderbook));

    // A caller that is not the wired orderbook must be rejected. An all-zero swap
    // is fine: the assertion fires before the swap body runs.
    let zero_swap = LiquidityPool::ClearingSwap {
        a_to_pool: 0 as u128, b_to_pool: 0 as u128, a_from_pool: 0 as u128, b_from_pool: 0 as u128,
        reserve_a_add: 0 as u128, reserve_a_sub: 0 as u128, reserve_b_add: 0 as u128,
        reserve_b_sub: 0 as u128, fee_a_per_share_increment: 0 as u128, fee_b_per_share_increment: 0 as u128,
    };
    let stranger = env.create_light_account();
    env.call_public(stranger, LiquidityPool::at(pool).apply_clearing(zero_swap));
}
```

(`deploy_pool` is the existing test helper; `LiquidityPool::ClearingSwap` is the
struct path inside the contract's test module — if the compiler wants a different
path, adjust to what `crate::LiquidityPool::ClearingSwap` resolves to, mirroring
how `test.nr` already names `PoolState` / `PositionNote`.)

- [ ] **Step 7: Run TXE tests**

Run: `pnpm test:noir`
Expected: `[pool] 10 tests passed` (the 7 from Week 5 + 3 new), `[orderbook] 10`, `[token] 4`.

- [ ] **Step 8: Commit**

```bash
git add contracts/pool/src/main.nr contracts/pool/src/test.nr
git commit -m "feat(pool): ClearingSwap + set_orderbook + apply_clearing"
```

---

## Task 2: Orderbook constructor + storage + deploy-site rewiring

**Dispatch with model: sonnet.**

An atomic signature change: the Orderbook constructor goes from
`(token_a, token_b, epoch_length)` to
`(token_a, token_b, epoch_length, pool_addr, clearing_authority)`. Every deploy
site changes, and the deploy order changes (the Pool must exist before the
Orderbook).

**Files:** Modify `contracts/orderbook/Nargo.toml`, `contracts/orderbook/src/main.nr`, `contracts/orderbook/src/test.nr`, `tests/integration/orderbook.test.ts`, `tests/integration/cli.test.ts`, `scripts/deploy-tokens.ts`

- [ ] **Step 1: `contracts/orderbook/Nargo.toml` — add the `pool` dependency**

The `[dependencies]` section currently has `aztec` and `token`. Add `pool`:

```toml
[dependencies]
aztec = { git = "https://github.com/AztecProtocol/aztec-packages", tag = "v4.2.0", directory = "noir-projects/aztec-nr/aztec" }
token = { path = "../token" }
pool = { path = "../pool" }
```

- [ ] **Step 2: `main.nr` — import `Map` and the pool interface**

In the `use aztec::{ ... }` block, add `Map` to the `state_vars` list:

```rust
        state_vars::{Map, Owned, PrivateSet, PublicImmutable, PublicMutable},
```

After `use token::Token;`, add:

```rust
    use pool::LiquidityPool;
```

(`LiquidityPool` is unused until Task 3's `close_epoch_and_clear` — an unused
import is a warning, not an error; leave it.)

- [ ] **Step 3: `main.nr` — extend the storage struct**

Add three fields to `#[storage] struct Storage<Context>`:

```rust
        pool_addr: PublicImmutable<AztecAddress, Context>,
        clearing_authority: PublicImmutable<AztecAddress, Context>,
        fills: Map<Field, PublicMutable<u128, Context>, Context>,
```

- [ ] **Step 4: `main.nr` — new constructor**

Replace the `constructor` (keep its doc comment, extended):

```rust
    /// Deploy-time initializer.
    ///
    /// - Records the two tradable token addresses.
    /// - Records `pool_addr` (the LiquidityPool the net clearing flow swaps through)
    ///   and `clearing_authority` (the only address allowed to call
    ///   `close_epoch_and_clear`).
    /// - Stores `epoch_length`; opens epoch 0.
    #[external("public")]
    #[initializer]
    fn constructor(
        token_a: AztecAddress,
        token_b: AztecAddress,
        epoch_length: u32,
        pool_addr: AztecAddress,
        clearing_authority: AztecAddress,
    ) {
        self.storage.token_a_addr.initialize(token_a);
        self.storage.token_b_addr.initialize(token_b);
        self.storage.epoch_length.initialize(epoch_length);
        self.storage.pool_addr.initialize(pool_addr);
        self.storage.clearing_authority.initialize(clearing_authority);

        let block: u32 = self.context.block_number();
        self.storage.current_epoch.write(EpochState {
            epoch_id: 0,
            state: EPOCH_STATE_OPEN,
            opened_at_block: block,
            closes_at_block: block + epoch_length,
        });
    }
```

- [ ] **Step 5: `main.nr` — add two getters**

Next to the existing getters, add (so tests/CLI can read the wiring):

```rust
    #[external("utility")]
    unconstrained fn get_pool_addr() -> AztecAddress {
        self.storage.pool_addr.read()
    }

    #[external("utility")]
    unconstrained fn get_clearing_authority() -> AztecAddress {
        self.storage.clearing_authority.read()
    }
```

- [ ] **Step 6: `test.nr` — update the `deploy_orderbook` helper**

`contracts/orderbook/src/test.nr`'s `deploy_orderbook` helper currently passes
`(token_a, token_b, epoch_length)`. Add two address parameters:

```rust
unconstrained fn deploy_orderbook(
    env: &mut TestEnvironment,
    deployer: AztecAddress,
    token_a: AztecAddress,
    token_b: AztecAddress,
    epoch_length: u32,
    pool_addr: AztecAddress,
    clearing_authority: AztecAddress,
) -> AztecAddress {
    let initializer_call =
        Orderbook::interface().constructor(token_a, token_b, epoch_length, pool_addr, clearing_authority);
    env.deploy("Orderbook").with_public_initializer(deployer, initializer_call)
}
```

Every existing `deploy_orderbook(&mut env, deployer, ..., 100)` call gains two
trailing arguments. For tests that do not exercise clearing, pass `deployer` for
both `pool_addr` and `clearing_authority` (placeholders — never read by those
tests). Update every call site in `test.nr` accordingly, e.g.:

```rust
    let orderbook = deploy_orderbook(&mut env, deployer, deployer, deployer, 100, deployer, deployer);
```

The `constructor_records_token_addrs_and_epoch_length` test additionally checks
the two new getters — extend it: deploy with two distinct placeholder addresses
for `pool_addr` / `clearing_authority` and assert `get_pool_addr` /
`get_clearing_authority` round-trip them.

- [ ] **Step 7: Update the integration-test Orderbook deploys**

In `tests/integration/orderbook.test.ts`, every `OrderbookContract.deploy(...)`
call now needs a Pool deployed first and two extra constructor args. In each
`describe`'s `before`, add a `LiquidityPoolContract` deploy before the Orderbook
deploy and pass its address + a clearing-authority account:

```ts
import { LiquidityPoolContract } from "./generated/LiquidityPool.js";
// ...
const dPool = await LiquidityPoolContract.deploy(wallet, tUSDC.address, tETH.address)
  .send({ from: admin });
const pool = dPool.contract;

const dOB = await OrderbookContract.deploy(
  wallet, tUSDC.address, tETH.address, <epoch_length>, pool.address, admin,
).send({ from: admin });
```

`admin` is the clearing authority placeholder in these suites (they do not call
`close_epoch_and_clear`). Apply the same change to the `OrderbookContract.deploy`
in `tests/integration/cli.test.ts` (it already deploys a pool — reuse that pool's
address; ensure the pool is deployed before the Orderbook).

These integration files are run in Task 5; Task 2 only needs them to be
internally consistent.

- [ ] **Step 8: `scripts/deploy-tokens.ts` — reorder the deploys + wire**

`deploy-tokens.ts` currently deploys tUSDC, tETH, Orderbook, then the Pool.
Reorder so the Pool is deployed before the Orderbook, pass the new constructor
args, and call `set_orderbook` afterward. The deploy section becomes:

```ts
  // tUSDC, tETH deployed above as tokenA, tokenB.

  const deployedPool = await LiquidityPoolContract.deploy(
    wallet, tokenA.contract.address, tokenB.contract.address,
  ).send({ from: admin });

  // 100-block epochs in deployed environments; admin stands in as the clearing
  // authority (the off-chain aggregator's role).
  const deployedOB = await OrderbookContract.deploy(
    wallet,
    tokenA.contract.address,
    tokenB.contract.address,
    100,
    deployedPool.contract.address,
    admin,
  ).send({ from: admin });

  // Wire the pool to the orderbook (one-shot).
  await deployedPool.contract.methods
    .set_orderbook(deployedOB.contract.address)
    .send({ from: admin });
```

Keep the `result` object writing all of `nodeUrl`, `tUSDC`, `tETH`, `orderbook`,
`pool`, `admin` to `zswap.config.json` (the `pool` field already exists as of
Week 5).

- [ ] **Step 9: Compile, codegen, run TXE tests**

```bash
pnpm compile
pnpm codegen
pnpm test:noir
```

Expected: `All contracts compiled.`; codegen regenerates the three bindings;
`[orderbook] 10 tests passed`, `[pool] 10`, `[token] 4` (the orderbook count is
unchanged — the constructor test was updated, not added to).

- [ ] **Step 10: Commit**

```bash
git add contracts/orderbook/Nargo.toml contracts/orderbook/src/main.nr contracts/orderbook/src/test.nr tests/integration/orderbook.test.ts tests/integration/cli.test.ts scripts/deploy-tokens.ts
git commit -m "refactor(orderbook): constructor takes pool_addr + clearing_authority; clearing storage"
```

---

## Task 3: `close_epoch_and_clear`

**Dispatch with model: opus** — novel cross-contract call + `BoundedVec` argument + the `Map` write loop.

**Files:** Modify `contracts/orderbook/src/main.nr`, `contracts/orderbook/src/test.nr`

- [ ] **Step 1: Discovery — the cross-contract struct + the `BoundedVec` argument**

Confirm two v4.2.0 spellings before coding:
1. **Importing `ClearingSwap` from the pool contract.** `close_epoch_and_clear`
   takes a `ClearingSwap` and passes it to `LiquidityPool::at(pool).apply_clearing(swap)`.
   Try `use pool::LiquidityPool::ClearingSwap;`. If a contract's `pub struct`
   cannot be imported across the dep boundary, the fallback is to define a
   structurally-identical `ClearingSwap` in the orderbook (same field order +
   `#[derive(Deserialize, Eq, Packable, Serialize)]`) — cross-contract calls
   serialize structurally. Use whichever the compiler accepts.
2. **Iterating a `BoundedVec` in a constrained function.** Noir `for` loops need
   a compile-time bound; iterate `for i in 0..MAX_FILLS { if i < fills.len() { ... } }`,
   reading entries with `fills.get(i)`. Confirm `BoundedVec::get` / `len` spelling.

- [ ] **Step 2: `main.nr` — add `MAX_FILLS` and `FillEntry`**

Add the global next to `MAX_INPUT_NOTES`:

```rust
    /// Maximum filled orders applied in one clearing (the epoch order cap).
    pub global MAX_FILLS: u32 = 128;
```

Add the struct next to `EpochState`:

```rust
    /// One filled order in a clearing - the aggregator's per-order payout.
    #[derive(Deserialize, Eq, Packable, Serialize)]
    pub struct FillEntry {
        pub order_nonce: Field,
        pub amount_out: u128,
    }
```

- [ ] **Step 3: `main.nr` — add `close_epoch_and_clear`**

Insert after `close_epoch` and before the `// === ORDER CANCELLATION ===`
section. Adjust the `ClearingSwap` import / `BoundedVec` iteration to the
discovery in Step 1.

```rust
    // ============================ CLEARING ============================

    /// Apply one epoch's clearing on-chain. Authority-gated and trusted: the
    /// `clearing_authority` (the off-chain aggregator) submits the per-order
    /// `fills` and the aggregate net `swap`; this function relays them without
    /// re-deriving (the Week-5d ZK proof will replace that trust). It performs
    /// the net AMM swap against the Pool, records each fill, and advances the
    /// epoch. `close_epoch` remains as the permissionless zero-fill fallback.
    #[external("public")]
    fn close_epoch_and_clear(fills: BoundedVec<FillEntry, MAX_FILLS>, swap: ClearingSwap) {
        assert(self.msg_sender() == self.storage.clearing_authority.read(), "not clearing authority");

        let current = self.storage.current_epoch.read();
        let block: u32 = self.context.block_number();
        assert(block >= current.closes_at_block, "epoch has not expired yet");

        // Net AMM swap: send the net input token to the Pool, then apply_clearing
        // returns the net output token and updates the pool accounting.
        let pool = self.storage.pool_addr.read();
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

        // Record each fill. Reject a zero payout and a duplicate (an order that
        // already has a recorded, unclaimed fill).
        for i in 0..MAX_FILLS {
            if i < fills.len() {
                let e = fills.get(i);
                assert(e.amount_out > 0 as u128, "fill amount must be positive");
                assert(
                    self.storage.fills.at(e.order_nonce).read() == 0 as u128,
                    "order already filled",
                );
                self.storage.fills.at(e.order_nonce).write(e.amount_out);
            }
        }

        // Advance the epoch (identical to close_epoch).
        let epoch_length = self.storage.epoch_length.read();
        self.storage.current_epoch.write(EpochState {
            epoch_id: current.epoch_id + 1,
            state: EPOCH_STATE_OPEN,
            opened_at_block: block,
            closes_at_block: block + epoch_length,
        });
    }
```

- [ ] **Step 4: Compile**

Run: `pnpm compile`
Expected: `All contracts compiled.`

- [ ] **Step 5: `test.nr` — add TXE tests**

The happy path needs real Token + Pool — integration (Task 5). Pure-TXE covers
the two gates that fire before any cross-contract call. Append to `test.nr`.
A `ClearingSwap` value and a `BoundedVec<FillEntry, MAX_FILLS>` are needed; build
an all-zero swap and an empty fills vec.

```rust
#[test(should_fail_with = "not clearing authority")]
unconstrained fn close_epoch_and_clear_rejects_non_authority() {
    let mut env = TestEnvironment::new();
    let deployer = env.create_light_account();
    let authority = env.create_light_account();
    // pool_addr placeholder = deployer; clearing_authority = `authority`.
    let orderbook = deploy_orderbook(&mut env, deployer, deployer, deployer, 100, deployer, authority);

    let stranger = env.create_light_account();
    let empty_fills: BoundedVec<crate::Orderbook::FillEntry, crate::Orderbook::MAX_FILLS> = BoundedVec::new();
    let zero_swap = crate::Orderbook::ClearingSwap { /* all ten fields 0 as u128 */ };
    env.call_public(stranger, Orderbook::at(orderbook).close_epoch_and_clear(empty_fills, zero_swap));
}

#[test(should_fail_with = "epoch has not expired yet")]
unconstrained fn close_epoch_and_clear_rejects_before_expiry() {
    let mut env = TestEnvironment::new();
    let deployer = env.create_light_account();
    let authority = env.create_light_account();
    // Long epoch; the authority calls immediately, before expiry.
    let orderbook = deploy_orderbook(&mut env, deployer, deployer, deployer, 100, deployer, authority);

    let empty_fills: BoundedVec<crate::Orderbook::FillEntry, crate::Orderbook::MAX_FILLS> = BoundedVec::new();
    let zero_swap = crate::Orderbook::ClearingSwap { /* all ten fields 0 as u128 */ };
    env.call_public(authority, Orderbook::at(orderbook).close_epoch_and_clear(empty_fills, zero_swap));
}
```

Fill in the `ClearingSwap { ... }` literal with all ten fields set to `0 as u128`
(`a_to_pool`, `b_to_pool`, `a_from_pool`, `b_from_pool`, `reserve_a_add`,
`reserve_a_sub`, `reserve_b_add`, `reserve_b_sub`, `fee_a_per_share_increment`,
`fee_b_per_share_increment`). Adjust the `ClearingSwap` / `FillEntry` /
`MAX_FILLS` paths to whatever Step 1 settled (the orderbook-local definitions if
the cross-dep import was not used). The `not clearing authority` assert fires
first; the `epoch has not expired` test passes the authority gate and trips the
deadline gate — neither reaches a cross-contract call.

- [ ] **Step 6: Run TXE tests**

Run: `pnpm test:noir`
Expected: `[orderbook] 12 tests passed` (10 + 2 new), `[pool] 10`, `[token] 4`.

- [ ] **Step 7: Commit**

```bash
git add contracts/orderbook/src/main.nr contracts/orderbook/src/test.nr
git commit -m "feat(orderbook): close_epoch_and_clear — trusted on-chain clearing"
```

---

## Task 4: `claim_fill` + `_assert_fill` + `get_fill`

**Dispatch with model: sonnet** — mirrors `cancel_order` (pop_notes) and the deposit hint-validate pattern.

**Files:** Modify `contracts/orderbook/src/main.nr`, `contracts/orderbook/src/test.nr`

- [ ] **Step 1: `main.nr` — add `claim_fill`, `_assert_fill`, `get_fill`**

Insert `claim_fill` + `_assert_fill` after `close_epoch_and_clear` (in the
clearing section); add `get_fill` next to the other getters.

```rust
    /// Claim the output of a filled order. The maker nullifies their `OrderNote`
    /// and receives `claimed_amount_out` of the output token (token B for a buy,
    /// token A for a sell). `claimed_amount_out` is read off-chain from `get_fill`
    /// and validated on-chain: the enqueued `_assert_fill` callback asserts it
    /// equals the recorded fill, so a wrong amount reverts the whole tx.
    ///
    /// (The payout `transfer_public_to_private` is a private Token function and
    /// must run here, in private context; the authoritative fill amount lives in
    /// the `fills` PublicMutable which a private context cannot read - hence the
    /// caller supplies it and the public callback validates it.)
    #[external("private")]
    fn claim_fill(order_nonce: Field, claimed_amount_out: u128) {
        let maker = self.msg_sender();

        // Retrieve + nullify the maker's filled OrderNote (the cancel_order pattern;
        // the nullifier is the double-claim guard).
        let options = NoteGetterOptions::new().select(
            OrderNote::properties().nonce,
            Comparator.EQ,
            order_nonce,
        ).set_limit(1);
        let notes = self.storage.orders.at(maker).pop_notes(options);
        assert(notes.len() == 1, "order not found");
        let order = notes.get(0);
        assert(order.owner == maker, "not order owner");

        // A buy (side=false) is owed token B; a sell (side=true) is owed token A.
        let token: AztecAddress = if order.side {
            self.storage.token_a_addr.read()
        } else {
            self.storage.token_b_addr.read()
        };

        // Pay out the claimed amount; `from` is this contract (a self-call), so the
        // authwit nonce is the literal 0.
        self.call(Token::at(token).transfer_public_to_private(
            self.address,
            maker,
            claimed_amount_out,
            0,
        ));

        // Validate the claimed amount against the recorded fill, atomically.
        self.enqueue_self._assert_fill(order_nonce, claimed_amount_out);
    }

    /// Public callback for `claim_fill`: assert the claimed payout matches the
    /// recorded fill and that the order was actually filled. `only_self`.
    #[external("public")]
    #[only_self]
    fn _assert_fill(order_nonce: Field, claimed_amount_out: u128) {
        let recorded = self.storage.fills.at(order_nonce).read();
        assert(recorded == claimed_amount_out, "claimed amount does not match the recorded fill");
        assert(recorded > 0 as u128, "order not filled");
    }
```

And the getter, next to `get_epoch` / `get_orders`:

```rust
    /// The recorded clearing payout for `order_nonce` (0 == not filled). A maker
    /// reads this to pass as `claimed_amount_out` to `claim_fill`.
    #[external("utility")]
    unconstrained fn get_fill(order_nonce: Field) -> u128 {
        self.storage.fills.at(order_nonce).read()
    }
```

- [ ] **Step 2: Compile**

Run: `pnpm compile`
Expected: `All contracts compiled.`

- [ ] **Step 3: `test.nr` — add TXE tests**

`claim_fill` with no matching note reverts before any cross-contract call;
`get_fill` on an unknown nonce returns 0. Append:

```rust
#[test(should_fail_with = "order not found")]
unconstrained fn claim_fill_rejects_unknown_order() {
    let mut env = TestEnvironment::new();
    let deployer = env.create_light_account();
    let orderbook = deploy_orderbook(&mut env, deployer, deployer, deployer, 100, deployer, deployer);

    let maker = env.create_light_account();
    // No order was ever submitted, so claiming any nonce reverts at note retrieval.
    env.call_private(maker, Orderbook::at(orderbook).claim_fill(0x4242, 1 as u128));
}

#[test]
unconstrained fn get_fill_is_zero_for_unknown_order() {
    let mut env = TestEnvironment::new();
    let deployer = env.create_light_account();
    let orderbook = deploy_orderbook(&mut env, deployer, deployer, deployer, 100, deployer, deployer);

    let recorded: u128 = env.execute_utility(Orderbook::at(orderbook).get_fill(0x4242));
    assert(recorded == 0 as u128, "an unrecorded order must report a zero fill");
}
```

- [ ] **Step 4: Run TXE tests**

Run: `pnpm test:noir`
Expected: `[orderbook] 14 tests passed` (12 + 2 new), `[pool] 10`, `[token] 4`.

- [ ] **Step 5: Commit**

```bash
git add contracts/orderbook/src/main.nr contracts/orderbook/src/test.nr
git commit -m "feat(orderbook): claim_fill + _assert_fill + get_fill"
```

---

## Task 5: Integration — the clearing round trip

**Dispatch with model: opus** — assembles the aggregator + the on-chain contracts end-to-end.

**Files:** Create `tests/integration/clearing.test.ts`

- [ ] **Step 1: Regenerate bindings**

Run: `pnpm codegen`
Expected: `Token.ts`, `Orderbook.ts`, `LiquidityPool.ts` regenerated with the new functions (`close_epoch_and_clear`, `claim_fill`, `get_fill`, `apply_clearing`, `set_orderbook`).

- [ ] **Step 2: Create `tests/integration/clearing.test.ts`**

A live-dev-stack suite exercising the full path: deploy the wired contracts,
seed LP liquidity and a crossing pair of orders, run the Week-5b `computeClearing`
to derive the on-chain arguments, mine past epoch expiry, `close_epoch_and_clear`,
then `claim_fill` for each filled maker.

The suite imports `computeClearing` from the aggregator via a relative
cross-package path — `../../aggregator/src/clearing.js` (the same relative-import
style the CLI uses for the generated bindings; no `tests/package.json` change and
no `exports` map needed) — and translates its `ClearingResult` into the
contract's `FillEntry[]` / `ClearingSwap`. `connectToSandbox` / `getTestWallets`
come from `./helpers/`; `randomField`, `currentBlock`, `readPrivateBalanceEth`
and `buildClearingSwap` are defined inline in this file (the code block below
includes the first two; the implementer adds the latter two).

```ts
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import type { AztecAddress } from "@aztec/aztec.js/addresses";
import type { AztecNode } from "@aztec/aztec.js/node";
import type { EmbeddedWallet } from "@aztec/wallets/embedded";

import { connectToSandbox } from "./helpers/sandbox.js";
import { getTestWallets } from "./helpers/wallets.js";
import { TokenContract } from "./generated/Token.js";
import { OrderbookContract } from "./generated/Orderbook.js";
import { LiquidityPoolContract } from "./generated/LiquidityPool.js";
import { computeClearing, type ClearingOrder } from "../../aggregator/src/clearing.js";

const ONE_USDC = 10n ** 6n;
const ONE_ETH = 10n ** 18n;
const EPOCH_LEN = 6;
const PRICE_1 = 1_000_000_000_000_000_000n; // 1.0, 1e18-scaled

function randomField(): bigint {
  const buf = new Uint8Array(31);
  webcrypto.getRandomValues(buf);
  let n = 0n;
  for (const b of buf) n = (n << 8n) | BigInt(b);
  return n;
}

async function currentBlock(node: AztecNode): Promise<number> {
  return Number(await node.getBlockNumber());
}

describe("clearing (live integration)", () => {
  let node: AztecNode;
  let wallet: EmbeddedWallet;
  let admin: AztecAddress;     // also the clearing authority
  let alice: AztecAddress;     // a buyer
  let bob: AztecAddress;       // a seller
  let lp: AztecAddress;        // the liquidity provider
  let tUSDC: TokenContract;
  let tETH: TokenContract;
  let pool: LiquidityPoolContract;
  let orderbook: OrderbookContract;

  before(async () => {
    node = await connectToSandbox();
    const env = await getTestWallets(node, 4);
    wallet = env.wallet;
    admin = env.accounts[0]!;
    alice = env.accounts[1]!;
    bob = env.accounts[2]!;
    lp = env.accounts[3]!;

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

    const dP = await LiquidityPoolContract.deploy(wallet, tUSDC.address, tETH.address)
      .send({ from: admin });
    pool = dP.contract;
    const dOB = await OrderbookContract.deploy(
      wallet, tUSDC.address, tETH.address, EPOCH_LEN, pool.address, admin,
    ).send({ from: admin });
    orderbook = dOB.contract;
    await pool.methods.set_orderbook(orderbook.address).send({ from: admin });

    // Seed balances: the LP, alice (buyer, pays tUSDC), bob (seller, pays tETH).
    await tUSDC.methods.mint_to_private(lp, 1_000_000n * ONE_USDC).send({ from: admin });
    await tETH.methods.mint_to_private(lp, 1_000n * ONE_ETH).send({ from: admin });
    await tUSDC.methods.mint_to_private(alice, 100_000n * ONE_USDC).send({ from: admin });
    await tETH.methods.mint_to_private(bob, 100n * ONE_ETH).send({ from: admin });

    // LP deposits a balanced 100k tUSDC : 100 tETH pool (spot price 1000 USDC/ETH...
    // for the test we use a 1:1-priced book, so deposit equal *scaled* sides).
    const hint0 = (await pool.methods.get_pool_state().simulate({ from: admin })).result;
    await pool.methods
      .deposit(100_000n * ONE_USDC, 100_000n * ONE_USDC, hint0, randomField(), randomField(), randomField())
      .send({ from: lp });
  });

  after(async () => {
    const stop = (wallet as unknown as { stop?: () => Promise<void> }).stop;
    if (typeof stop === "function") await stop.call(wallet);
  });

  it("an epoch of crossing orders clears and both makers claim their fills", { timeout: 900_000 }, async () => {
    // Alice buys: 1000 tUSDC in, limit price 2.0. Bob sells: 1000 (1e6-unit) tETH-side
    // in, limit price 0.5. They cross around 1.0.
    const aliceIn = 1_000n * ONE_USDC;
    const bobIn = 1_000n * ONE_USDC; // bob's tETH amount, in the same 1e6 unit scale for a 1:1 book
    const aliceNonce = randomField();
    const bobNonce = randomField();

    await orderbook.methods
      .submit_order(false, aliceIn, 2n * PRICE_1, randomField(), aliceNonce)
      .send({ from: alice });
    await orderbook.methods
      .submit_order(true, bobIn, PRICE_1 / 2n, randomField(), bobNonce)
      .send({ from: bob });

    // Run the off-chain aggregator on the live pool + order snapshot.
    const poolState = (await pool.methods.get_pool_state().simulate({ from: admin })).result;
    const orders: ClearingOrder[] = [
      { side: false, amountIn: aliceIn, limitPrice: 2n * PRICE_1, submittedAtBlock: 1, orderNonce: aliceNonce },
      { side: true, amountIn: bobIn, limitPrice: PRICE_1 / 2n, submittedAtBlock: 2, orderNonce: bobNonce },
    ];
    const result = computeClearing(
      { reserveA: BigInt(poolState.reserve_a), reserveB: BigInt(poolState.reserve_b),
        lpSupply: BigInt(poolState.lp_supply) },
      orders,
    );
    assert.equal(result.cleared, true, "the aggregator should clear this crossing book");

    // Translate the ClearingResult into the contract arguments. (The plan's
    // implementer derives the ClearingSwap fields from result.newReserveA/B,
    // the fee increments, and the net token flows — see the design spec sec 5.1.
    // Build `fills` from result.fills and `swap` accordingly.)
    const fills = result.fills.map((f) => ({ order_nonce: f.orderNonce, amount_out: f.amountOut }));
    const swap = buildClearingSwap(poolState, result); // helper defined in this file

    // Mine past epoch expiry, then the authority clears.
    const epoch = (await orderbook.methods.get_epoch().simulate({ from: admin })).result;
    while ((await currentBlock(node)) < Number(epoch.closes_at_block)) {
      await tUSDC.methods.mint_to_public(admin, 1n).send({ from: admin });
    }
    await orderbook.methods.close_epoch_and_clear(fills, swap).send({ from: admin });

    // The pool reserves + cum_fee moved as the aggregator computed.
    const after = (await pool.methods.get_pool_state().simulate({ from: admin })).result;
    assert.equal(BigInt(after.reserve_a), result.newReserveA, "pool reserve A matches the clearing");
    assert.equal(BigInt(after.reserve_b), result.newReserveB, "pool reserve B matches the clearing");

    // Each filled maker claims. Alice (a buy) receives tETH; Bob (a sell) tUSDC.
    const aliceFill = BigInt((await orderbook.methods.get_fill(aliceNonce).simulate({ from: alice })).result);
    const bobFill = BigInt((await orderbook.methods.get_fill(bobNonce).simulate({ from: bob })).result);
    assert.ok(aliceFill > 0n && bobFill > 0n, "both orders recorded as filled");

    const aliceEthBefore = await readPrivateBalanceEth(tETH, alice);
    await orderbook.methods.claim_fill(aliceNonce, aliceFill).send({ from: alice });
    const aliceEthAfter = await readPrivateBalanceEth(tETH, alice);
    assert.equal(aliceEthAfter - aliceEthBefore, aliceFill, "alice received her token B fill");

    await orderbook.methods.claim_fill(bobNonce, bobFill).send({ from: bob });

    // The claimed orders are gone; a re-claim fails.
    await assert.rejects(
      orderbook.methods.claim_fill(aliceNonce, aliceFill).send({ from: alice }),
      /order not found/i,
      "a claimed order cannot be claimed again",
    );
  });
});
```

The plan's implementer writes the two small helpers used above —
`buildClearingSwap(poolState, result)` (derives the ten `ClearingSwap` fields
from the aggregator's `ClearingResult` per design spec section 5.1: the net token
flows, the reserve deltas `newReserve - oldReserve` split by sign, and the fee
increments) and `readPrivateBalanceEth` (a `balance_of_private` read) — following
the `readPrivateBalance` pattern already in `orderbook.test.ts`. Adjust the order
amounts / prices so the book genuinely crosses and the aggregator returns
`cleared: true`; verify against an actual run, not by guessing the magnitudes.

- [ ] **Step 3: Run the integration suite**

Start the dev stack (`bash scripts/dev.sh`), wait until ready.

Run: `pnpm test`
Expected: the aggregator unit tests (26) still pass, the prior integration tests
still pass, and the new `clearing` suite passes. `fail 0`.

Stop the dev stack: `bash scripts/dev.sh --down`.

- [ ] **Step 4: Commit**

```bash
git add tests/integration/clearing.test.ts
git commit -m "test(clearing): end-to-end close_epoch_and_clear + claim round trip"
```

---

## Task 6: CLI `zswap claim`

**Dispatch with model: sonnet.**

**Files:** Create `cli/src/commands/claim.ts`; Modify `cli/src/index.ts`, `tests/integration/cli.test.ts`

- [ ] **Step 1: `cli/src/commands/claim.ts`**

Mirrors `cli/src/commands/cancel.ts`. It reads the recorded fill via `get_fill`,
then calls `claim_fill`.

```ts
import type { Command } from "commander";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { OrderbookContract } from "../../../tests/integration/generated/Orderbook.js";
import { loadConfig } from "../config.js";
import { openCli } from "../wallet.js";
import { parseField } from "../field.js";

export function registerClaim(program: Command): void {
  program
    .command("claim")
    .description("claim the output of a filled order")
    .requiredOption("--nonce <field>", "order-identity nonce of the filled order")
    .action(async (_opts, cmd: Command) => {
      const opts = cmd.optsWithGlobals();
      const orderNonce = parseField(String(opts.nonce));

      const config = loadConfig(opts.config);
      const ctx = await openCli(config, Number(opts.account));
      try {
        const orderbook = await OrderbookContract.at(
          AztecAddress.fromString(config.orderbook),
          ctx.wallet,
        );
        const sim = await orderbook.methods.get_fill(orderNonce).simulate({ from: ctx.account });
        const amountOut = BigInt((sim as { result: bigint | number }).result);
        if (amountOut === 0n) {
          throw new Error(`order 0x${orderNonce.toString(16)} has no recorded fill (not cleared)`);
        }
        await orderbook.methods.claim_fill(orderNonce, amountOut).send({ from: ctx.account });
        console.log(`claimed ${amountOut} output tokens for order 0x${orderNonce.toString(16)}`);
      } finally {
        await ctx.stop();
      }
    });
}
```

- [ ] **Step 2: `cli/src/index.ts` — register the command**

Add the import alongside the others and `registerClaim(program);` after the
existing `register*` calls.

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @zswap/cli typecheck`
Expected: no errors.

- [ ] **Step 4: `tests/integration/cli.test.ts` — add a `claim` smoke case**

The CLI smoke test already deploys the wired contracts (Task 2 updated its
deploys). Add a test case that submits a crossing pair of orders as two CLI/wallet
actions, drives `close_epoch_and_clear` directly via the contract (the authority
is the smoke test's `admin`), then runs `zswap claim` for a filled order and
asserts the stdout reports a non-zero claimed amount. Reuse the
`buildClearingSwap` approach from `clearing.test.ts` (extract it to a shared
helper under `tests/integration/helpers/` if convenient, or duplicate the small
function). Keep the case self-contained and within the suite's existing
deploy/`mineUntilBlock` machinery.

- [ ] **Step 5: Run the integration suite**

Start the dev stack; run `pnpm test`.
Expected: `fail 0`, including the new CLI `claim` case.
Stop the dev stack.

- [ ] **Step 6: Commit**

```bash
git add cli/src/commands/claim.ts cli/src/index.ts tests/integration/cli.test.ts
git commit -m "feat(cli): zswap claim command"
```

---

## Task 7: Final clean rebuild + Week 5c milestone

**Dispatch with model: sonnet.**

**Files:** Modify `README.md`

- [ ] **Step 1: Clean rebuild**

```bash
rm -rf node_modules contracts/*/target tests/integration/generated tests/node_modules cli/node_modules aggregator/node_modules codegenCache.json zswap.config.json
pnpm install
pnpm compile
pnpm codegen
pnpm test:noir
```

Expected: `All contracts compiled.`; codegen emits the three bindings;
`pnpm test:noir` → `[orderbook] 14 tests passed`, `[pool] 10`, `[token] 4`.

- [ ] **Step 2: Integration smoke**

Start `bash scripts/dev.sh` in another terminal; wait until ready.

```bash
pnpm test
pnpm tsx scripts/deploy-tokens.ts
```

Expected: `pnpm test` — the aggregator unit tests + every integration suite pass,
`fail 0`. `deploy-tokens.ts` prints JSON with `nodeUrl`/`tUSDC`/`tETH`/`orderbook`/`pool`/`admin`
and writes `zswap.config.json`.

Stop the dev stack: `bash scripts/dev.sh --down`.

- [ ] **Step 3: Update README**

Replace the `**Status:**` line with:

```
**Status:** Week 5c complete. Clearing runs on-chain (trusted): an authority `close_epoch_and_clear` applies an epoch's clearing — the net AMM swap, fill recording, epoch advance — and `claim_fill` lets a filled maker redeem their output. 14 TXE orderbook tests + the clearing integration suite green. Week 5d replaces the authority trust with a ZK proof.
```

Add to the `## Quickstart` CLI block, after the `cancel` line:

```
pnpm --filter @zswap/cli zswap claim --nonce <order-nonce>
```

Add to `## Documentation`:

```
- [Week 5c On-chain Clearing Design](docs/superpowers/specs/2026-05-19-zswap-aztec-week-05c-onchain-clearing-design.md)
- [Week 5c Implementation Plan](docs/superpowers/plans/2026-05-19-zswap-aztec-week-05c-onchain-clearing.md)
```

- [ ] **Step 4: Milestone commit and tag**

```bash
git add README.md
git commit -m "docs: mark Week 5c (on-chain clearing) complete"
git tag week-05c-onchain-clearing
git tag -l | grep week-05c
```

Expected: `week-05c-onchain-clearing`.

---

## Definition of Done for Week 5c

- All five new functions (`Pool.set_orderbook`, `Pool.apply_clearing`,
  `Orderbook.close_epoch_and_clear`, `claim_fill`, `_assert_fill`) plus `get_fill`
  compile; `pnpm compile` / `pnpm codegen` succeed.
- All prior tests pass (updated for the constructor change); the new TXE tests
  (`[orderbook] 14`, `[pool] 10`) and the `clearing.test.ts` round trip pass.
- End-to-end on the dev stack: a crossing epoch is cleared by the authority, the
  pool reserves + `cum_fee_*` move as the aggregator computed, filled makers
  `claim_fill` and receive their output privately, a re-claim fails.
- `zswap claim` works against the dev stack.
- `git tag` shows `week-05c-onchain-clearing`.

## Hand-off to Week 5d

Clearing is trusted: `close_epoch_and_clear` relays the authority's numbers. Week
5d adds the Noir clearing circuit — the authority submits a proof that the fills
and the net swap are a correct clearing of the committed orders against the pool,
and `close_epoch_and_clear` verifies it instead of trusting the caller. The fill
`Map` becomes a Merkle root, and a persisted `CLOSING` epoch state freezes
deposits/withdraws during clearing (closing the stale-swap window in section 8 of
the spec).

## Risk Notes

- **Cross-contract `ClearingSwap` (Task 3).** Importing a `pub struct` across the
  pool→orderbook dep boundary may not be supported; the fallback (an
  identically-shaped local definition) is in Task 3 Step 1. Confirm at compile.
- **`BoundedVec<FillEntry, 128>` as a public-function argument (Task 3).** Large
  calldata; if it does not compile or is impractical, lower `MAX_FILLS` for the
  MVP (the spec permits this). Confirm with the empty-`fills` TXE tests first.
- **Constructor signature churn (Task 2).** Touches the TXE helper, two
  integration files, and `deploy-tokens.ts`, and reorders the deploy. Sequenced
  as Task 2 so Tasks 3-6 build on the wired contracts; the integration files are
  first actually run in Task 5.
- **The `clearing.test.ts` translation layer (Task 5).** Converting the
  aggregator's `ClearingResult` into `FillEntry[]` + `ClearingSwap` is the
  subtlest TS in this slice — the reserve-delta split and the net-flow fields
  must match design spec section 5.1 exactly, or `apply_clearing` underflows.
  Verify against a real run.
- **TXE coverage.** Happy-path clearing/claim need real Token + Pool; pure-TXE
  covers only the pre-cross-call gates. The round trip is integration-tested.
