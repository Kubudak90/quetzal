# ZSwap-on-Aztec — Week 4: Epoch transitions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the orderbook's epoch genuinely cycle — add a permissionless, time-gated `close_epoch` that advances `current_epoch` to a fresh epoch, make `EPOCH_LENGTH` a constructor parameter, and block `submit_order`/`cancel_order` once the epoch's window has expired.

**Architecture:** Epoch advancement lives on `OrderbookContract` itself (no separate `ClearingContract` this week). `close_epoch` is a no-op advance: it rewrites `current_epoch` and touches nothing else, so resting orders carry over untouched. The constructor signature changes (drop the dead `clearing` arg, add `epoch_length`), which ripples to every deploy site.

**Tech Stack:** Noir / aztec-nr v4.2.0, Aztec 4.2.1, TypeScript (Node 22), `commander`, `node:test` + `tsx`, pnpm workspaces.

**Spec:** `docs/superpowers/specs/2026-05-18-zswap-aztec-week-04-epoch-transitions-design.md`

---

## File Structure (delta over Week 3)

| File | Responsibility | Action |
|---|---|---|
| `contracts/orderbook/src/main.nr` | Constructor (epoch_length param, drop clearing), storage, `close_epoch`, expiry guard | Modify |
| `contracts/orderbook/src/test.nr` | Update `deploy_orderbook` helper + affected tests; add `close_epoch` / guard TXE tests | Modify |
| `tests/integration/orderbook.test.ts` | Update existing deploys for the new signature; add epoch-transition `describe` block | Modify |
| `tests/integration/cli.test.ts` | Update deploy for the new signature; add `close-epoch` smoke case | Modify |
| `cli/src/commands/close-epoch.ts` | `zswap close-epoch` command | Create |
| `cli/src/index.ts` | Register the `close-epoch` command | Modify |
| `scripts/deploy-tokens.ts` | Pass `epoch_length` (100) to the Orderbook constructor | Modify |
| `README.md` | Status line + CLI command list | Modify |

## Pre-flight

- [ ] Confirm `git status` is clean and `git tag -l | grep week-03` shows `week-03-cancel-cli`.
- [ ] Confirm Docker is running (`docker info`) — needed for `pnpm compile` / `pnpm codegen` / `pnpm test:noir`.
- [ ] Read `contracts/orderbook/src/main.nr` to refresh the conventions: the constructor, `EpochState`, the `_assert_epoch_open` only-self callback enqueued by `submit_order`/`cancel_order`, the `#[external("utility")]` getters.

---

## Task 1: Constructor + storage refactor — `epoch_length` in, `clearing_addr` out

This is an atomic signature change: the constructor goes from `(token_a, token_b, clearing)` to `(token_a, token_b, epoch_length: u32)`. Every deploy site must change in lockstep.

**Dispatch with model: sonnet.**

**Files:**
- Modify: `contracts/orderbook/src/main.nr`, `contracts/orderbook/src/test.nr`, `tests/integration/orderbook.test.ts`, `tests/integration/cli.test.ts`, `scripts/deploy-tokens.ts`

- [ ] **Step 1: `main.nr` — remove the `EPOCH_LENGTH` global**

Delete these three lines (the `global EPOCH_LENGTH` declaration and its doc comment) near the top of the contract:

```rust
    /// Number of L2 blocks per epoch. Each freshly opened epoch closes
    /// `EPOCH_LENGTH` blocks after its opening block.
    global EPOCH_LENGTH: u32 = 100;
```

- [ ] **Step 2: `main.nr` — storage: drop `clearing_addr`, add `epoch_length`**

In the `#[storage] struct Storage<Context>`, replace the `clearing_addr` line:

```rust
        clearing_addr: PublicImmutable<AztecAddress, Context>,
```

with:

```rust
        epoch_length: PublicImmutable<u32, Context>,
```

- [ ] **Step 3: `main.nr` — new constructor**

Replace the entire `constructor` function (and its doc comment) with:

```rust
    /// Deploy-time initializer.
    ///
    /// - Records the two tradable token addresses.
    /// - Stores `epoch_length` (number of L2 blocks an epoch stays OPEN).
    /// - Opens epoch 0 at the current block, closing `epoch_length` blocks later.
    #[external("public")]
    #[initializer]
    fn constructor(token_a: AztecAddress, token_b: AztecAddress, epoch_length: u32) {
        self.storage.token_a_addr.initialize(token_a);
        self.storage.token_b_addr.initialize(token_b);
        self.storage.epoch_length.initialize(epoch_length);

        let block: u32 = self.context.block_number();
        self.storage.current_epoch.write(EpochState {
            epoch_id: 0,
            state: EPOCH_STATE_OPEN,
            opened_at_block: block,
            closes_at_block: block + epoch_length,
        });
    }
```

- [ ] **Step 4: `main.nr` — remove the `get_clearing_addr` getter**

Delete this getter (it reads the now-removed `clearing_addr`):

```rust
    #[external("utility")]
    unconstrained fn get_clearing_addr() -> AztecAddress {
        self.storage.clearing_addr.read()
    }
```

- [ ] **Step 5: `main.nr` — add a `get_epoch_length` getter**

So TXE tests can read back the stored value, add this getter next to `get_token_b_addr`:

```rust
    #[external("utility")]
    unconstrained fn get_epoch_length() -> u32 {
        self.storage.epoch_length.read()
    }
```

- [ ] **Step 6: `test.nr` — update the import and the `deploy_orderbook` helper**

In `contracts/orderbook/src/test.nr`, the import line currently reads:

```rust
use crate::Orderbook::{EpochState, OrderNote, EPOCH_LENGTH};
```

Change it to (drop the removed `EPOCH_LENGTH`):

```rust
use crate::Orderbook::{EpochState, OrderNote};
```

Replace the `deploy_orderbook` helper with this version (it takes `epoch_length` instead of `clearing`):

```rust
// Helper: deploy a fresh Orderbook with the given token addresses and epoch length,
// returning the deployed address. The `deployer` light account pushes the public
// initializer.
unconstrained fn deploy_orderbook(
    env: &mut TestEnvironment,
    deployer: AztecAddress,
    token_a: AztecAddress,
    token_b: AztecAddress,
    epoch_length: u32,
) -> AztecAddress {
    let initializer_call = Orderbook::interface().constructor(token_a, token_b, epoch_length);
    env.deploy("Orderbook").with_public_initializer(deployer, initializer_call)
}
```

- [ ] **Step 7: `test.nr` — update every `deploy_orderbook` caller**

Five existing tests call `deploy_orderbook` with a 5th address argument. Update each call's 5th argument from an address to a `u32` epoch length. Use `100` everywhere except where noted:

In `constructor_sets_initial_epoch_state`:
```rust
    let orderbook = deploy_orderbook(&mut env, deployer, deployer, deployer, 100);
```
and update its final assertion to compare against the literal `100`:
```rust
    assert(
        epoch.closes_at_block == epoch.opened_at_block + 100,
        "epoch must close epoch_length blocks after it opened",
    );
```

In `submit_order_rejects_amount_zero` and `submit_order_rejects_limit_price_zero`:
```rust
    let orderbook = deploy_orderbook(&mut env, deployer, deployer, deployer, 100);
```

In `cancel_order_rejects_unknown_nonce` and `get_orders_empty_for_fresh_account`:
```rust
    let orderbook = deploy_orderbook(&mut env, deployer, deployer, deployer, 100);
```

- [ ] **Step 8: `test.nr` — rewrite `constructor_records_contract_addresses`**

It currently deploys with 3 distinct placeholder addresses and checks `get_clearing_addr`. `clearing_addr` is gone. Replace the whole test with a version that checks the two token addresses and the stored epoch length:

```rust
#[test]
unconstrained fn constructor_records_token_addrs_and_epoch_length() {
    let mut env = TestEnvironment::new();
    let deployer = env.create_light_account();

    // Two distinct placeholder addresses so the test catches an accidental token-arg swap.
    let token_a = env.create_light_account();
    let token_b = env.create_light_account();
    assert(token_a != token_b, "token_a and token_b must be distinct");

    let orderbook = deploy_orderbook(&mut env, deployer, token_a, token_b, 42);

    let stored_a: AztecAddress = env.execute_utility(Orderbook::at(orderbook).get_token_a_addr());
    let stored_b: AztecAddress = env.execute_utility(Orderbook::at(orderbook).get_token_b_addr());
    let stored_len: u32 = env.execute_utility(Orderbook::at(orderbook).get_epoch_length());

    assert(stored_a == token_a, "stored token_a must round-trip");
    assert(stored_b == token_b, "stored token_b must round-trip");
    assert(stored_len == 42, "stored epoch_length must round-trip");
}
```

- [ ] **Step 9: Update the integration-test deploy calls**

In `tests/integration/orderbook.test.ts` there are TWO `OrderbookContract.deploy(...)` calls (one per `describe` block). Each currently reads:

```ts
    const dOB = await OrderbookContract.deploy(
      wallet, tUSDC.address, tETH.address, admin,
    ).send({ from: admin });
```

Change the 4th argument from `admin` to `100` in BOTH:

```ts
    const dOB = await OrderbookContract.deploy(
      wallet, tUSDC.address, tETH.address, 100,
    ).send({ from: admin });
```

In `tests/integration/cli.test.ts` there is one `OrderbookContract.deploy(...)` call. Set its 4th argument to `8` (not `100`): the CLI smoke test gains a `close-epoch` case in Task 4 that must reach epoch expiry cheaply, and `8` leaves enough headroom for the existing order round-trip (which mines only ~2 blocks) while keeping the later mine-to-expiry loop short:

```ts
    const dOB = await OrderbookContract.deploy(
      wallet, tUSDC.address, tETH.address, 8,
    ).send({ from: admin });
```

- [ ] **Step 10: Update `scripts/deploy-tokens.ts`**

The Orderbook deploy currently reads:

```ts
  const deployedOB = await OrderbookContract.deploy(
    wallet,
    tokenA.contract.address,
    tokenB.contract.address,
    admin,
  ).send({ from: admin });
```

Change the 4th argument from `admin` to `100` (a sub-comment helps):

```ts
  // 100-block epochs in deployed environments; tests deploy with a short epoch.
  const deployedOB = await OrderbookContract.deploy(
    wallet,
    tokenA.contract.address,
    tokenB.contract.address,
    100,
  ).send({ from: admin });
```

- [ ] **Step 11: Compile, codegen, run TXE tests**

```bash
pnpm compile
pnpm codegen
pnpm test:noir
```

Expected:
- compile: `All contracts compiled.`
- codegen: `Token.ts` and `Orderbook.ts` regenerated.
- `pnpm test:noir`: `[orderbook] 8 tests passed`, `[token] 4 tests passed` (same 8 orderbook tests as Week 3, with `constructor_records_contract_addresses` now named `constructor_records_token_addrs_and_epoch_length`).

The integration tests are updated for consistency but are verified later (Task 3 runs the full suite).

- [ ] **Step 12: Commit**

```bash
git add contracts/orderbook/src/main.nr contracts/orderbook/src/test.nr tests/integration/orderbook.test.ts tests/integration/cli.test.ts scripts/deploy-tokens.ts
git commit -m "refactor(orderbook): epoch_length constructor param, drop clearing_addr"
```

---

## Task 2: `close_epoch` + the expiry guard

**Dispatch with model: opus** — the TXE block-advancing API is novel surface that needs discovery.

**Files:**
- Modify: `contracts/orderbook/src/main.nr`, `contracts/orderbook/src/test.nr`

- [ ] **Step 1: `main.nr` — add `close_epoch`**

Insert this function immediately after `_assert_epoch_open` and before the `// === ORDER CANCELLATION ===` section:

```rust
    // ============================ EPOCH TRANSITIONS ============================

    /// Advance the orderbook to a fresh epoch once the current epoch's time window
    /// has elapsed.
    ///
    /// Permissionless and time-gated: anyone may call it, but it reverts unless the
    /// current epoch has expired (`block >= closes_at_block`). It only advances a
    /// counter - there is nothing to abuse - so permissionless triggering is purely
    /// a liveness win (no dependency on a trusted aggregator).
    ///
    /// Week 4 performs NO clearing: the `orders` PrivateSet is untouched, so every
    /// resting order carries into the new epoch. Filling/settlement arrive with the
    /// clearing circuit (Week 6+).
    #[external("public")]
    fn close_epoch() {
        let current = self.storage.current_epoch.read();
        let block: u32 = self.context.block_number();
        assert(block >= current.closes_at_block, "epoch has not expired yet");

        let epoch_length = self.storage.epoch_length.read();
        self.storage.current_epoch.write(EpochState {
            epoch_id: current.epoch_id + 1,
            state: EPOCH_STATE_OPEN,
            opened_at_block: block,
            closes_at_block: block + epoch_length,
        });
    }
```

- [ ] **Step 2: `main.nr` — add the expiry guard to `_assert_epoch_open`**

Replace the body of `_assert_epoch_open` with:

```rust
    /// Public callback used by `submit_order` / `cancel_order` to enforce that the
    /// current epoch is OPEN *and* its time window has not elapsed. `only_self`
    /// ensures the callback can only be invoked by this contract via `enqueue_self`.
    #[external("public")]
    #[only_self]
    fn _assert_epoch_open() {
        let epoch = self.storage.current_epoch.read();
        assert(epoch.state == EPOCH_STATE_OPEN, "epoch is not OPEN");
        let block: u32 = self.context.block_number();
        assert(block < epoch.closes_at_block, "epoch has expired; awaiting close_epoch");
    }
```

- [ ] **Step 3: Compile**

Run: `pnpm compile`
Expected: `All contracts compiled.`

- [ ] **Step 4: API discovery — advancing L2 block height in TXE**

The TXE tests need to push the L2 block height past `closes_at_block`. Determine the aztec-nr v4.2.0 `TestEnvironment` API for this. Sources, in order:

1. The aztec-nr v4.2.0 source on GitHub: `noir-projects/aztec-nr/aztec/src/test/helpers/test_environment.nr` at tag `v4.2.0` (`https://github.com/AztecProtocol/aztec-packages/tree/v4.2.0`). Look for methods like `mine_block`, `advance_block_by`, `set_next_block_number`, or similar.
2. Cross-check against how other aztec-nr contract tests advance blocks.

Confirm the exact method name and signature. The code in Step 5 uses `env.advance_block_by(n)` as a placeholder — adjust it to whatever the source actually exposes. Also confirm how a `#[external("public")]` function is called in TXE — expected `env.call_public(caller, Orderbook::at(addr).close_epoch())` (the existing tests use `env.call_private` and `env.execute_utility`; `call_public` is the public-context analogue).

- [ ] **Step 5: `test.nr` — add the `close_epoch` / guard TXE tests**

Append to `contracts/orderbook/src/test.nr`. Adjust `advance_block_by` / `call_public` to the API confirmed in Step 4:

```rust
// ============================ EPOCH TRANSITIONS ============================

#[test]
unconstrained fn close_epoch_advances_to_next_epoch() {
    let mut env = TestEnvironment::new();
    let deployer = env.create_light_account();

    // Short epoch so we can cheaply advance past it.
    let orderbook = deploy_orderbook(&mut env, deployer, deployer, deployer, 3);

    let before: EpochState = env.execute_utility(Orderbook::at(orderbook).get_epoch());

    // Advance the L2 block height past `closes_at_block`, then close the epoch.
    env.advance_block_by(4);
    env.call_public(deployer, Orderbook::at(orderbook).close_epoch());

    let after: EpochState = env.execute_utility(Orderbook::at(orderbook).get_epoch());
    assert(after.epoch_id == before.epoch_id + 1, "epoch_id must increment");
    assert(after.state == 0, "new epoch must be OPEN");
    assert(
        after.closes_at_block == after.opened_at_block + 3,
        "new epoch must close epoch_length blocks after opening",
    );
    assert(after.opened_at_block >= before.closes_at_block, "new epoch opens at/after the old close");
}

#[test(should_fail_with = "epoch has not expired yet")]
unconstrained fn close_epoch_rejects_before_expiry() {
    let mut env = TestEnvironment::new();
    let deployer = env.create_light_account();

    // Long epoch; we do NOT advance, so the epoch is still open and close must revert.
    let orderbook = deploy_orderbook(&mut env, deployer, deployer, deployer, 100);

    env.call_public(deployer, Orderbook::at(orderbook).close_epoch());
}
```

(`submit_order` being blocked after expiry is covered by an integration test in Task 3 — it lives in the enqueued `_assert_epoch_open` callback and needs a real Token deployed, which is integration-test territory, the same fallback Weeks 2-3 used.)

- [ ] **Step 6: Run the TXE suite**

Run: `pnpm test:noir`
Expected: `[orderbook] 10 tests passed` (the 8 from Task 1 + the 2 new), `[token] 4 tests passed`.

- [ ] **Step 7: Commit**

```bash
git add contracts/orderbook/src/main.nr contracts/orderbook/src/test.nr
git commit -m "feat(orderbook): close_epoch + epoch-expiry guard on submit/cancel"
```

---

## Task 3: Integration tests for epoch transitions

**Dispatch with model: sonnet.**

**Files:**
- Modify: `tests/integration/orderbook.test.ts`

- [ ] **Step 1: Regenerate bindings**

Run: `pnpm codegen`
Expected: `Orderbook.ts` regenerated; `OrderbookContract` now has a `close_epoch` method.

- [ ] **Step 2: Add a block-mining helper**

Near the top-of-file helpers in `tests/integration/orderbook.test.ts` (after `randomField`), add a helper that advances the L2 chain by sending cheap transactions until the chain reaches a target block height. Each sent transaction mines at least one block; the loop is robust to batching.

```ts
// Advance the L2 chain until its block height reaches `target`, by sending cheap
// txs (each mints 1 unit to `minter`, mining at least one block). `node.getBlockNumber`
// is the standard Aztec node RPC for the current height.
async function mineUntilBlock(
  node: AztecNode,
  token: TokenContract,
  minter: AztecAddress,
  target: number,
): Promise<void> {
  let guard = 0;
  while (Number(await node.getBlockNumber()) < target) {
    await token.methods.mint_to_private(minter, 1n).send({ from: minter });
    if (++guard > 50) throw new Error("mineUntilBlock: exceeded 50 txs without reaching target");
  }
}
```

- [ ] **Step 3: Add the epoch-transition `describe` block**

Append to `tests/integration/orderbook.test.ts` (after the existing `describe` blocks). It deploys the orderbook with a short `epoch_length` (`12` — small enough to mine past cheaply, with enough headroom that the "reverts before expiry" test runs while the epoch is still genuinely open right after `before()`), and reuses the file's existing helpers/constants (`randomField`, `readPublicBalance`, `connectToSandbox`, `getTestWallets`, `SIDE_A_TO_B`, `PRICE_2`, `ONE_TUSDC`):

```ts
describe("orderbook epoch transitions (live integration)", () => {
  let node: AztecNode;
  let wallet: EmbeddedWallet;
  let admin: AztecAddress;
  let alice: AztecAddress;
  let tUSDC: TokenContract;
  let tETH: TokenContract;
  let orderbook: OrderbookContract;

  const EPOCH_LEN = 12;
  const MINT = 1_000n * ONE_TUSDC;
  const ORDER_USDC = 100n * ONE_TUSDC;

  before(async () => {
    node = await connectToSandbox();
    const env = await getTestWallets(node, 2);
    wallet = env.wallet;
    admin = env.accounts[0]!;
    alice = env.accounts[1]!;

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

    const dOB = await OrderbookContract.deploy(
      wallet, tUSDC.address, tETH.address, EPOCH_LEN,
    ).send({ from: admin });
    orderbook = dOB.contract;

    await tUSDC.methods.mint_to_private(alice, MINT).send({ from: admin });
  });

  after(async () => {
    const stop = (wallet as unknown as { stop?: () => Promise<void> }).stop;
    if (typeof stop === "function") await stop.call(wallet);
  });

  it("close_epoch reverts before the epoch has expired", { timeout: 600_000 }, async () => {
    const epoch = await orderbook.methods.get_epoch().simulate({ from: admin });
    const e = (epoch as { result: { closes_at_block: bigint } }).result;
    assert.ok(
      Number(await node.getBlockNumber()) < Number(e.closes_at_block),
      "precondition: epoch not yet expired",
    );
    await assert.rejects(
      orderbook.methods.close_epoch().send({ from: admin }),
      /epoch has not expired/i,
      "close_epoch must revert before closes_at_block",
    );
  });

  it("close_epoch advances the epoch once it has expired", { timeout: 600_000 }, async () => {
    const before = (await orderbook.methods.get_epoch().simulate({ from: admin })) as {
      result: { epoch_id: bigint; closes_at_block: bigint };
    };
    await mineUntilBlock(node, tUSDC, admin, Number(before.result.closes_at_block));

    await orderbook.methods.close_epoch().send({ from: admin });

    const after = (await orderbook.methods.get_epoch().simulate({ from: admin })) as {
      result: { epoch_id: bigint; opened_at_block: bigint; closes_at_block: bigint };
    };
    assert.equal(
      after.result.epoch_id, before.result.epoch_id + 1n,
      "epoch_id must increment",
    );
    assert.equal(
      after.result.closes_at_block - after.result.opened_at_block, BigInt(EPOCH_LEN),
      "new epoch closes EPOCH_LEN blocks after opening",
    );
  });

  it("submit_order is blocked in the expired window, then works in the new epoch", { timeout: 600_000 }, async () => {
    // Drive the current epoch to expiry.
    const epoch = (await orderbook.methods.get_epoch().simulate({ from: admin })) as {
      result: { closes_at_block: bigint };
    };
    await mineUntilBlock(node, tUSDC, admin, Number(epoch.result.closes_at_block));

    // submit_order must revert while the epoch is expired-but-not-closed.
    await assert.rejects(
      orderbook.methods
        .submit_order(SIDE_A_TO_B, ORDER_USDC, PRICE_2, randomField(), randomField())
        .send({ from: alice }),
      /epoch has expired/i,
      "submit_order must revert once the epoch window has elapsed",
    );

    // Close the epoch, then submit_order works again in the fresh epoch.
    await orderbook.methods.close_epoch().send({ from: admin });
    await orderbook.methods
      .submit_order(SIDE_A_TO_B, ORDER_USDC, PRICE_2, randomField(), randomField())
      .send({ from: alice });
  });

  it("resting orders survive an epoch boundary", { timeout: 600_000 }, async () => {
    // One order rests in the current (fresh) epoch.
    const orderNonce = randomField();
    await orderbook.methods
      .submit_order(SIDE_A_TO_B, ORDER_USDC, PRICE_2, randomField(), orderNonce)
      .send({ from: alice });

    const escrowBefore = await readPublicBalance(tUSDC, orderbook.address, admin);

    // Expire and close the epoch.
    const epoch = (await orderbook.methods.get_epoch().simulate({ from: admin })) as {
      result: { closes_at_block: bigint };
    };
    await mineUntilBlock(node, tUSDC, admin, Number(epoch.result.closes_at_block));
    await orderbook.methods.close_epoch().send({ from: admin });

    // The order's escrow is untouched by the epoch advance.
    const escrowAfter = await readPublicBalance(tUSDC, orderbook.address, admin);
    assert.equal(escrowAfter, escrowBefore, "close_epoch must not touch resting escrow");
  });
});
```

- [ ] **Step 4: Run the integration suite**

Start the dev stack in another terminal: `bash scripts/dev.sh` (wait until `http://localhost:8080/status` answers).

Run: `pnpm test`
Expected: `pass 16` — the 12 prior integration tests (4 orderbook + 5 cancel + 2 token + 1 CLI smoke) plus the 4 new epoch-transition tests. `fail 0`.

Stop the dev stack: `bash scripts/dev.sh --down`.

- [ ] **Step 5: Commit**

```bash
git add tests/integration/orderbook.test.ts
git commit -m "test(orderbook): epoch-transition integration tests"
```

---

## Task 4: `zswap close-epoch` CLI command

**Dispatch with model: sonnet.**

**Files:**
- Create: `cli/src/commands/close-epoch.ts`
- Modify: `cli/src/index.ts`, `tests/integration/cli.test.ts`

- [ ] **Step 1: Create `cli/src/commands/close-epoch.ts`**

Mirrors the existing `cli/src/commands/orders.ts` structure (cross-package import path `../../../tests/integration/generated/Orderbook.js`, `optsWithGlobals`, `loadConfig` + `openCli`):

```ts
import type { Command } from "commander";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { OrderbookContract } from "../../../tests/integration/generated/Orderbook.js";
import { loadConfig } from "../config.js";
import { openCli } from "../wallet.js";

export function registerCloseEpoch(program: Command): void {
  program
    .command("close-epoch")
    .description("advance the orderbook to the next epoch (only works once the current epoch has expired)")
    .action(async (_opts, cmd: Command) => {
      const opts = cmd.optsWithGlobals();
      const config = loadConfig(opts.config);
      const ctx = await openCli(config, Number(opts.account));
      try {
        const orderbook = await OrderbookContract.at(
          AztecAddress.fromString(config.orderbook),
          ctx.wallet,
        );
        await orderbook.methods.close_epoch().send({ from: ctx.account });

        const sim = await orderbook.methods.get_epoch().simulate({ from: ctx.account });
        const epoch = (sim as { result: { epoch_id: bigint; closes_at_block: bigint } }).result;
        console.log(
          `epoch advanced: now epoch ${epoch.epoch_id}, closes at block ${epoch.closes_at_block}`,
        );
      } finally {
        await ctx.stop();
      }
    });
}
```

- [ ] **Step 2: Register the command in `cli/src/index.ts`**

Add the import alongside the others:

```ts
import { registerCloseEpoch } from "./commands/close-epoch.js";
```

And register it alongside the other `register*` calls:

```ts
registerOrder(program);
registerCancel(program);
registerOrders(program);
registerCloseEpoch(program);
```

- [ ] **Step 3: Typecheck the CLI**

Run: `pnpm --filter @zswap/cli typecheck`
Expected: no errors.

- [ ] **Step 4: Add a `close-epoch` case to the CLI smoke test**

`tests/integration/cli.test.ts` already deploys the orderbook with `epoch_length = 8` (set in Task 1 Step 9). Add a `mineUntilBlock` helper and a new test case — no deploy change needed.

Add this helper inside the `describe` block (after `before`/`after`), so it closes over the `describe`-scoped `node`, `tUSDC`, `admin`:

```ts
// Advance the L2 chain to `target` by sending cheap mint txs (each mines >=1 block).
async function mineUntilBlock(target: number): Promise<void> {
  let guard = 0;
  while (Number(await node.getBlockNumber()) < target) {
    await tUSDC.methods.mint_to_private(admin, 1n).send({ from: admin });
    if (++guard > 50) throw new Error("mineUntilBlock: exceeded 50 txs");
  }
}
```

Add this test case inside the `describe("cli smoke (live integration)", ...)` block, after the existing round-trip test:

```ts
  it("close-epoch advances the epoch once it has expired", { timeout: 600_000 }, async () => {
    const before = (await orderbook.methods.get_epoch().simulate({ from: admin })) as {
      result: { epoch_id: bigint; closes_at_block: bigint };
    };
    await mineUntilBlock(Number(before.result.closes_at_block));

    const out = zswap("close-epoch");
    assert.match(out, /epoch advanced/i, "`zswap close-epoch` should confirm the advance");

    const after = (await orderbook.methods.get_epoch().simulate({ from: admin })) as {
      result: { epoch_id: bigint };
    };
    assert.equal(after.result.epoch_id, before.result.epoch_id + 1n, "epoch_id must increment");
  });
```

- [ ] **Step 5: Run the integration suite**

Start the dev stack (`bash scripts/dev.sh`), wait until ready.

Run: `pnpm test`
Expected: `pass 17` — 16 from Task 3 plus the new `close-epoch` CLI case. `fail 0`.

Stop the dev stack: `bash scripts/dev.sh --down`.

- [ ] **Step 6: Commit**

```bash
git add cli/src/commands/close-epoch.ts cli/src/index.ts tests/integration/cli.test.ts
git commit -m "feat(cli): zswap close-epoch command"
```

---

## Task 5: Final clean rebuild + Week 4 milestone

**Dispatch with model: sonnet.**

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Clean rebuild from scratch**

```bash
rm -rf node_modules contracts/*/target tests/integration/generated tests/node_modules cli/node_modules codegenCache.json zswap.config.json
pnpm install
pnpm compile
pnpm codegen
pnpm test:noir
```

Expected:
- compile: `All contracts compiled.`
- codegen: `Token.ts` and `Orderbook.ts` generated.
- `pnpm test:noir`: `[orderbook] 10 tests passed`, `[token] 4 tests passed`.

- [ ] **Step 2: Integration smoke**

Start `bash scripts/dev.sh` in another terminal; wait until ready.

```bash
pnpm test
pnpm tsx scripts/deploy-tokens.ts
```

Expected:
- `pnpm test`: `pass 17`, `fail 0`.
- `deploy-tokens.ts`: prints JSON with `nodeUrl`/`tUSDC`/`tETH`/`orderbook`/`admin`; `zswap.config.json` is written.

Stop the dev stack: `bash scripts/dev.sh --down`.

- [ ] **Step 3: Update README**

In `README.md`, replace the `**Status:**` line with:

```
**Status:** Week 4 complete. The orderbook epoch now cycles: `close_epoch` advances to a fresh epoch once the time window expires, and `submit_order` / `cancel_order` are blocked in the expired window. `EPOCH_LENGTH` is a constructor parameter. 17 integration tests + 10 TXE tests green. Week 5+ adds the `ClearingContract` and the clearing circuit.
```

In the `## Quickstart` CLI block, add the `close-epoch` command after the `cancel` line:

```
pnpm --filter @zswap/cli zswap close-epoch
```

In the `## Documentation` section, add:

```
- [Week 4 Epoch Transitions Design](docs/superpowers/specs/2026-05-18-zswap-aztec-week-04-epoch-transitions-design.md)
- [Week 4 Implementation Plan](docs/superpowers/plans/2026-05-18-zswap-aztec-week-04-epoch-transitions.md)
```

- [ ] **Step 4: Milestone commit and tag**

```bash
git add README.md
git commit -m "docs: mark Week 4 (epoch transitions) complete"
git tag week-04-epoch-transitions
git tag -l | grep week-04
```

Expected: `week-04-epoch-transitions`.

---

## Definition of Done for Week 4

- `close_epoch`, the new constructor, and the expiry guard compile; `pnpm compile` and `pnpm codegen` succeed.
- All prior tests still pass (updated for the constructor change); the 2 new `close_epoch` TXE tests and the 4 new integration epoch-transition tests and the CLI `close-epoch` case pass — `10` TXE orderbook tests, `17` integration tests total.
- An epoch deployed with `epoch_length = E` advances via `close_epoch` only after `block >= closes_at_block`, and `submit_order` is blocked in the expired-but-not-closed window — both verified on-chain.
- `zswap close-epoch` advances the epoch end-to-end against the dev stack.
- `git tag` shows `week-04-epoch-transitions`.

## Hand-off to Week 5+

Week 4 ends with an epoch that cycles but never clears. The next sub-project introduces the `ClearingContract` and the clearing circuit: orders get *filled* at a uniform price, the no-op `close_epoch` becomes a real `close_epoch_and_clear`, and the `EpochState` `CLOSING` / `SETTLED` values finally get persisted. The `ClearingContract` will wire to the orderbook via a post-deploy setter (not a constructor arg — the two contracts reference each other).

## Risk Notes

- **TXE block-advancing API (Task 2).** The exact `TestEnvironment` method to advance L2 block height (`advance_block_by` / `mine_block` / etc.) and the public-call entrypoint (`call_public`) must be confirmed against aztec-nr v4.2.0 source — Task 2 Step 4 is a mandatory discovery step. Behaviour is fixed; API spelling is not.
- **Integration block mining (Tasks 3 & 4).** `mineUntilBlock` advances the chain by sending mint txs, relying on `node.getBlockNumber()`. If that RPC name differs, adjust it. A short `epoch_length` (3-4) keeps the mining loop cheap; the `guard > 50` cap prevents an infinite loop if mining behaves unexpectedly.
- **Constructor signature churn (Task 1).** The change touches five deploy sites. Task 1 updates all of them atomically; the integration sites are only *run* in Task 3, so a mistake there surfaces one task later — Task 3 Step 4 is the safety net.
