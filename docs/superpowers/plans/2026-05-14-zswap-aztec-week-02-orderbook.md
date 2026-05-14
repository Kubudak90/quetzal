# ZSwap-on-Aztec — Week 2: Token Unification + Orderbook `submit_order` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse the two test-token contracts into one `Token` with deploy-time brand args, scaffold `OrderbookContract` with private order storage + epoch state, implement `submit_order` with cross-contract escrow via `Token.transfer_private_to_public`, prove the flow end-to-end with TXE + integration tests, and tag `week-02-orderbook-submit`.

**Architecture:** One Noir contract per concern: `Token` (vendored from `defi-wonderland/aztec-standards@v4.2.0`, brand passed as constructor args) and `Orderbook` (new, holds `PrivateSet<OrderNote>` + `PublicMutable<EpochState>`). `submit_order` is a private function that calls `Token.transfer_private_to_public` to escrow user tokens into Orderbook's public balance on the relevant Token contract, then commits an encrypted `OrderNote`. Cross-contract test coverage primarily lives in TypeScript integration tests against the live dev stack; TXE handles in-contract invariants.

**Tech Stack:** Aztec `v4.2.1` runtime + `aztec-packages@v4.2.0` Noir libs (pinned in `.aztec-version` + `Nargo.toml`), Node 22, pnpm 10, TypeScript 5.6+, `node:test` + `tsx`.

**Reference spec:** `docs/superpowers/specs/2026-05-14-zswap-aztec-week-02-orderbook-design.md`

**Preceding state:** Branch `main` at commit `fd29967` (Week 1 polish complete). Tag `week-01-foundation` at `6435b8c`.

---

## File Structure (delta over Week 1)

```
aztec-project/
├── contracts/
│   ├── token/                          ← NEW (renamed from token-a; brand globals removed)
│   │   ├── Nargo.toml                  # package name: "token"
│   │   └── src/
│   │       ├── main.nr                 # pub contract Token — 425 vendored lines without TOKEN_* globals
│   │       └── test.nr                 # mint + transfer TXE tests (parameterized over brand)
│   ├── token-a/                        ← DELETED
│   ├── token-b/                        ← DELETED
│   └── orderbook/                      ← NEW
│       ├── Nargo.toml                  # package name: "orderbook"
│       └── src/
│           ├── main.nr                 # pub contract Orderbook
│           └── test.nr                 # in-contract TXE tests
├── scripts/
│   ├── codegen.sh                      ← MODIFIED (loops over contracts/*/)
│   └── deploy-tokens.ts                ← REWRITTEN (Token×2 + Orderbook)
└── tests/integration/
    ├── tokens.test.ts                  ← REWRITTEN (uses single TokenContract)
    └── orderbook.test.ts               ← NEW
```

---

## Pre-flight

- [ ] **Step 0: Verify host state**

```bash
cd /Users/huseyinarslan/Desktop/aztec-project
git rev-parse HEAD                # should print fd29967 or a descendant
git status                        # should be clean
cat .aztec-version                # should print 4.2.1
docker images aztecprotocol/aztec | grep -E "(4\.2\.1|REPOSITORY)"   # 4.2.1 should be present
which anvil                       # should exist
pnpm --version                    # 9 or 10
```

If `git status` reports uncommitted work, stop and resolve before proceeding.

---

## Task 1: Token unification — refactor to a single Noir contract

**Files:**
- Create: `contracts/token/Nargo.toml`
- Create: `contracts/token/src/main.nr`
- Create: `contracts/token/src/test.nr`
- Delete: `contracts/token-a/` (entire directory)
- Delete: `contracts/token-b/` (entire directory)

- [ ] **Step 1: Copy `contracts/token-a/` to `contracts/token/`**

```bash
cp -R contracts/token-a contracts/token
```

- [ ] **Step 2: Update `contracts/token/Nargo.toml`**

Edit the `[package]` section so `name = "token"` (was `"token_a"`). Keep all dependencies identical.

Read the existing `contracts/token/Nargo.toml`. Change only the `name =` line. Exact new content:

```toml
[package]
name = "token"
type = "contract"
authors = [""]
compiler_version = ">=0.40.0"

[dependencies]
aztec = { git = "https://github.com/AztecProtocol/aztec-packages", tag = "v4.2.0", directory = "noir-projects/aztec-nr/aztec" }
uint_note = { git = "https://github.com/AztecProtocol/aztec-packages", tag = "v4.2.0", directory = "noir-projects/aztec-nr/uint-note" }
balance_set = { git = "https://github.com/AztecProtocol/aztec-packages", tag = "v4.2.0", directory = "noir-projects/aztec-nr/balance-set" }
compressed_string = { git = "https://github.com/AztecProtocol/aztec-packages", tag = "v4.2.0", directory = "noir-projects/aztec-nr/compressed-string" }
```

(If your existing token-a Nargo.toml has different dep paths or extras, preserve them — just update `name`.)

- [ ] **Step 3: Remove brand globals from `contracts/token/src/main.nr`**

Open `contracts/token/src/main.nr`. Near the top (within the `pub contract Token` body — but **renamed from `TokenA` to `Token`** in this same edit), there will be three lines like:

```rust
global TOKEN_NAME: str<5> = "tUSDC";
global TOKEN_SYMBOL: str<5> = "tUSDC";
global TOKEN_DECIMALS: u8 = 6;
```

(Exact wording depends on what's currently in token-a/src/main.nr — read it first.)

**Both edits in one pass:**
1. Rename `pub contract TokenA` → `pub contract Token`
2. Delete the three `TOKEN_*` global lines entirely

These globals existed only as deploy hints; the constructor accepts `name`, `symbol`, `decimals` as parameters and persists them in storage. Removing the globals cannot break any internal reference because none exists — verify with:

```bash
grep -n "TOKEN_NAME\|TOKEN_SYMBOL\|TOKEN_DECIMALS" contracts/token/src/main.nr
```

After the deletions, this should report zero matches.

- [ ] **Step 4: Update `contracts/token/src/test.nr` to parameterize brand**

The existing tests deploy `TokenA` with hardcoded 6-decimal assumptions. Generalize them to test both 6-decimal (tUSDC) and 18-decimal (tETH) brand parameters under one contract.

Read the current `contracts/token/src/test.nr`. Find the helper that deploys the contract (likely calling `env.deploy(...).call(admin, "constructor_with_minter", "tUSDC"...)` or similar). Rewrite to:

```rust
use dep::aztec::test::helpers::test_environment::TestEnvironment;
use dep::aztec::prelude::AztecAddress;
use crate::Token;

fn deploy_token(env: &mut TestEnvironment, admin: AztecAddress, name: str<31>, symbol: str<31>, decimals: u8) -> AztecAddress {
    let contract = env.deploy("./target/token-Token.json").call_with(
        admin,
        "constructor_with_minter",
        (name, symbol, decimals, admin),
    );
    contract.address()
}

#[test]
unconstrained fn mint_to_private_balance_tusdc() {
    let mut env = TestEnvironment::new();
    let admin = env.create_light_account(1);
    env.impersonate(admin);

    let addr = deploy_token(&mut env, admin,
        "tUSDC                          ",   // padded to str<31>
        "tUSDC                          ",
        6);
    let token = Token::at(addr);
    token.mint_to_private(admin, 1_000_000_000_000).call(&mut env.private());
    let balance = token.balance_of_private(admin).simulate(&mut env);
    assert(balance == 1_000_000_000_000, "tUSDC: minted balance mismatch");
}

#[test]
unconstrained fn mint_to_private_balance_teth() {
    let mut env = TestEnvironment::new();
    let admin = env.create_light_account(1);
    env.impersonate(admin);

    let addr = deploy_token(&mut env, admin,
        "tETH                           ",
        "tETH                           ",
        18);
    let token = Token::at(addr);
    token.mint_to_private(admin, 1_000_000_000_000_000_000).call(&mut env.private());
    let balance = token.balance_of_private(admin).simulate(&mut env);
    assert(balance == 1_000_000_000_000_000_000, "tETH: minted balance mismatch");
}

#[test]
unconstrained fn private_transfer_moves_balance_tusdc() {
    let mut env = TestEnvironment::new();
    let alice = env.create_light_account(1);
    let bob = env.create_light_account(2);
    env.impersonate(alice);

    let addr = deploy_token(&mut env, alice,
        "tUSDC                          ",
        "tUSDC                          ",
        6);
    let token = Token::at(addr);

    token.mint_to_private(alice, 100_000_000).call(&mut env.private());
    token.transfer_private_to_private(alice, bob, 30_000_000, 0).call(&mut env.private());

    assert(token.balance_of_private(alice).simulate(&mut env) == 70_000_000, "alice should have 70 tUSDC");
    assert(token.balance_of_private(bob).simulate(&mut env) == 30_000_000, "bob should have 30 tUSDC");
}

#[test]
unconstrained fn private_transfer_moves_balance_teth() {
    let mut env = TestEnvironment::new();
    let alice = env.create_light_account(1);
    let bob = env.create_light_account(2);
    env.impersonate(alice);

    let addr = deploy_token(&mut env, alice,
        "tETH                           ",
        "tETH                           ",
        18);
    let token = Token::at(addr);

    token.mint_to_private(alice, 5_000_000_000_000_000_000).call(&mut env.private());
    token.transfer_private_to_private(alice, bob, 2_500_000_000_000_000_000, 0).call(&mut env.private());

    assert(token.balance_of_private(alice).simulate(&mut env) == 2_500_000_000_000_000_000, "alice should have 2.5 tETH");
    assert(token.balance_of_private(bob).simulate(&mut env) == 2_500_000_000_000_000_000, "bob should have 2.5 tETH");
}
```

**Important:** The exact TXE API names (`call_with`, `simulate`, `transfer_private_to_private`) were verified in Week 1 via direct nargo. If a method-name mismatch surfaces during compile, mirror what the prior Week-1 test code did — read `git show 853c851:contracts/token-b/src/test.nr` for the working pattern.

- [ ] **Step 5: Delete `contracts/token-a/` and `contracts/token-b/`**

```bash
rm -rf contracts/token-a contracts/token-b
```

- [ ] **Step 6: Compile the new Token contract**

```bash
bash scripts/compile-all.sh
```

Expected output last lines:
```
→ Compiling contracts/orderbook/   (if orderbook scaffold already there — likely not yet)
→ Compiling contracts/token/
... Compilation complete!
All contracts compiled.
```

If `contracts/orderbook/` doesn't exist yet (it shouldn't — that's Task 4), only the token line appears.

- [ ] **Step 7: Run TXE tests**

```bash
pnpm test:noir
```

Expected: 4 tests pass (2 per brand), exit 0.

- [ ] **Step 8: Commit**

```bash
git add contracts/
git commit -m "refactor(token): collapse TokenA/TokenB into single Token contract"
```

---

## Task 2: Update codegen + integration tests for unified Token

**Files:**
- Modify: `scripts/codegen.sh`
- Modify: `tests/integration/tokens.test.ts`
- Modify: `tests/integration/generated/` (regenerated, gitignored)

- [ ] **Step 1: Verify `scripts/codegen.sh` iterates `contracts/*/`**

Read it. If it already loops over `contracts/*/`, no change needed — the deletion of token-a/token-b and creation of token/ handles it. If it has hardcoded paths to token-a / token-b, update to iterate.

Likely it already iterates correctly; that's how Week 1's polish was written. Confirm by reading.

- [ ] **Step 2: Delete stale generated bindings and regenerate**

```bash
rm -rf tests/integration/generated
pnpm codegen
ls tests/integration/generated/
```

Expected: A single `Token.ts` file. (`TokenA.ts`, `TokenB.ts` should NOT exist.)

- [ ] **Step 3: Rewrite `tests/integration/tokens.test.ts`**

Replace the entire file content with:

```ts
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { connectToSandbox } from "./helpers/sandbox.js";
import { getTestWallets } from "./helpers/wallets.js";
import { TokenContract } from "./generated/Token.js";
import type { AztecNode } from "@aztec/aztec.js/node";
import type { EmbeddedWallet } from "@aztec/wallets/embedded";

describe("tokens (live integration)", () => {
  let node: AztecNode;
  let wallet: EmbeddedWallet;
  let adminAddr: ReturnType<typeof toAddress>;
  let aliceAddr: ReturnType<typeof toAddress>;

  before(async () => {
    node = await connectToSandbox();
    const { wallet: w, accounts } = await getTestWallets(node, 2);
    wallet = w;
    adminAddr = accounts[0]!;
    aliceAddr = accounts[1]!;
  });

  after(async () => {
    await wallet.stop();
  });

  test("deploys tUSDC (6 decimals), mints 1M to admin privately, balance matches", async () => {
    const tUSDC = await TokenContract.deployWithOpts(
      { wallet, method: "constructor_with_minter" },
      pad31("tUSDC"),
      pad31("tUSDC"),
      6n,
      adminAddr,
    ).send().deployed();

    const handle = tUSDC.withWallet(wallet);
    await handle.methods.mint_to_private(adminAddr, 1_000_000_000_000n).send().wait();

    const balance = await handle.methods.balance_of_private(adminAddr).simulate({ from: adminAddr });
    assert.equal(balance, 1_000_000_000_000n);
  });

  test("deploys tETH (18 decimals), mints 5 tETH to admin, transfers 2 tETH private->private to alice", async () => {
    const tETH = await TokenContract.deployWithOpts(
      { wallet, method: "constructor_with_minter" },
      pad31("tETH"),
      pad31("tETH"),
      18n,
      adminAddr,
    ).send().deployed();

    const handle = tETH.withWallet(wallet);
    await handle.methods.mint_to_private(adminAddr, 5_000_000_000_000_000_000n).send().wait();
    await handle.methods.transfer_private_to_private(adminAddr, aliceAddr, 2_000_000_000_000_000_000n, 0n).send().wait();

    const adminBalance = await handle.methods.balance_of_private(adminAddr).simulate({ from: adminAddr });
    const aliceBalance = await handle.methods.balance_of_private(aliceAddr).simulate({ from: aliceAddr });
    assert.equal(adminBalance, 3_000_000_000_000_000_000n);
    assert.equal(aliceBalance, 2_000_000_000_000_000_000n);
  });
});

function pad31(s: string): string {
  // Aztec str<31> argument needs the string padded with null bytes to exactly 31 chars
  if (s.length > 31) throw new Error(`brand string '${s}' exceeds 31 chars`);
  return s.padEnd(31, "\0");
}

function toAddress(x: unknown) {
  // Type-only helper so adminAddr / aliceAddr have a concrete type derived from getTestWallets's return
  return x as ReturnType<typeof Object>;
}
```

**Verify against existing code:** the helper APIs (`connectToSandbox`, `getTestWallets`) and the `EmbeddedWallet.stop()`, `withWallet`, `.send().wait()` patterns were established in Week 1 commit `48c58bd`. Match those signatures exactly. If your existing helpers' return type for accounts differs from `ReturnType<typeof toAddress>`, replace that helper with the real type imported from `@aztec/aztec.js` (likely `AztecAddress`).

- [ ] **Step 4: Start dev stack and run integration tests**

In one terminal:

```bash
bash scripts/dev.sh
```

Wait for the sequencer-started log line (~30–60s).

In another terminal:

```bash
pnpm --filter @zswap/tests test
```

Expected: 2 tests pass.

Stop the dev stack (Ctrl+C in the first terminal) when done.

- [ ] **Step 5: Commit**

```bash
git add scripts/codegen.sh tests/integration/tokens.test.ts
git commit -m "refactor(tests): tokens integration uses single TokenContract"
```

---

## Task 3: Verify Week 1 acceptance still passes (regression gate)

This task is a checkpoint, not new code. Before adding the Orderbook, confirm the refactor didn't regress anything Week 1 promised.

- [ ] **Step 1: Clean rebuild**

```bash
rm -rf node_modules contracts/*/target tests/integration/generated tests/node_modules codegenCache.json
pnpm install
pnpm compile
```

Expected: clean build of `contracts/token/` (only).

- [ ] **Step 2: TXE smoke**

```bash
pnpm test:noir
```

Expected: 4/4 tests pass.

- [ ] **Step 3: Integration smoke**

In one terminal: `bash scripts/dev.sh`. Wait for ready.

```bash
pnpm test
```

Expected: 2/2 tests pass.

Stop dev stack.

- [ ] **Step 4: No commit — checkpoint only**

If all green, proceed to Task 4. If any test fails, **stop** and investigate before adding the Orderbook on top of broken foundations.

---

## Task 4: OrderbookContract scaffold (empty contract compiles)

**Files:**
- Create: `contracts/orderbook/Nargo.toml`
- Create: `contracts/orderbook/src/main.nr`
- Create: `contracts/orderbook/src/test.nr` (empty stub for now)

- [ ] **Step 1: Create `contracts/orderbook/Nargo.toml`**

```toml
[package]
name = "orderbook"
type = "contract"
authors = [""]
compiler_version = ">=0.40.0"

[dependencies]
aztec = { git = "https://github.com/AztecProtocol/aztec-packages", tag = "v4.2.0", directory = "noir-projects/aztec-nr/aztec" }
```

- [ ] **Step 2: Create `contracts/orderbook/src/main.nr` (skeleton that compiles)**

```rust
use dep::aztec::macros::aztec;

#[aztec]
pub contract Orderbook {
    pub mod test;
}
```

- [ ] **Step 3: Create empty test stub**

```rust
// contracts/orderbook/src/test.nr
// Tests are added in subsequent tasks.
```

- [ ] **Step 4: Compile**

```bash
bash scripts/compile-all.sh
```

Expected: both `contracts/token/` and `contracts/orderbook/` compile. The orderbook artifact `contracts/orderbook/target/orderbook-Orderbook.json` exists.

- [ ] **Step 5: Commit**

```bash
git add contracts/orderbook/
git commit -m "feat(orderbook): empty contract scaffold (compiles)"
```

---

## Task 5: `OrderNote` type + nullifier + TXE round-trip test

**Files:**
- Modify: `contracts/orderbook/src/main.nr`
- Modify: `contracts/orderbook/src/test.nr`

- [ ] **Step 1: Add `OrderNote` to `main.nr`**

Replace `contracts/orderbook/src/main.nr` with:

```rust
use dep::aztec::macros::aztec;

#[aztec]
pub contract Orderbook {
    use dep::aztec::{
        macros::notes::note,
        prelude::AztecAddress,
        protocol_types::traits::{Serialize, Deserialize},
    };

    #[note]
    pub struct OrderNote {
        submitted_at_block: u32,
        side:               bool,
        amount_in:          u128,
        limit_price:        u128,
        nonce:              Field,
        owner:              AztecAddress,
    }

    pub mod test;
}
```

**API caveat:** The `#[note]` macro and `protocol_types::traits` paths are inferred from prior work in `defi-wonderland/aztec-standards@v4.2.0` (see vendored `contracts/token/src/main.nr` `UintNote` declaration for reference). If they don't compile, search the aztec-packages v4.2.0 source for the actual macro path — likely `dep::aztec::macros::notes::note` or `dep::aztec_nr::note`. Match the pattern the vendored Token contract uses.

- [ ] **Step 2: Add TXE round-trip test**

Replace `contracts/orderbook/src/test.nr` with:

```rust
use dep::aztec::prelude::AztecAddress;
use crate::Orderbook::OrderNote;

#[test]
unconstrained fn order_note_serialization_round_trip() {
    let note = OrderNote {
        submitted_at_block: 42,
        side: false,
        amount_in: 1_000_000_000,                  // 1000 with 6 decimals
        limit_price: 2_000_000_000_000_000_000,    // 2 (1e18 scaled)
        nonce: 0x1234567890abcdef,
        owner: AztecAddress::from_field(0xdeadbeef),
    };

    let bytes = note.serialize();
    let back = OrderNote::deserialize(bytes);

    assert(back.submitted_at_block == note.submitted_at_block, "submitted_at_block mismatch");
    assert(back.side == note.side, "side mismatch");
    assert(back.amount_in == note.amount_in, "amount_in mismatch");
    assert(back.limit_price == note.limit_price, "limit_price mismatch");
    assert(back.nonce == note.nonce, "nonce mismatch");
    assert(back.owner == note.owner, "owner mismatch");
}

#[test]
unconstrained fn order_note_different_nonce_different_hash() {
    let base = OrderNote {
        submitted_at_block: 100,
        side: true,
        amount_in: 50,
        limit_price: 1_000_000_000_000_000_000,
        nonce: 0x1,
        owner: AztecAddress::from_field(0xa),
    };
    let other = OrderNote { nonce: 0x2, ..base };

    // Identical fields except nonce → different hashes (and thus different nullifiers).
    // OrderNote inherits a hash function from #[note]; the exact method name in
    // 4.2.0 is `compute_note_hash` — verify against the Token contract's UintNote
    // for the canonical pattern.
    assert(base.compute_note_hash() != other.compute_note_hash(), "same nonce-only delta should yield different hashes");
}
```

(If `compute_note_hash` isn't the right method name in v4.2.0, the implementer should grep the vendored `UintNote` in `contracts/token/src/main.nr` to find what `#[note]`-derived hash method is called and use it.)

- [ ] **Step 3: Compile**

```bash
bash scripts/compile-all.sh
```

If compile fails on macro/trait paths, that's the expected case where you adapt to v4.2.0's actual API surface. Fix and retry.

- [ ] **Step 4: Run TXE tests**

```bash
pnpm test:noir
```

Expected: at least 6 tests pass — 4 Token + 2 Orderbook. The exact orderbook test count is 2 in this task.

- [ ] **Step 5: Commit**

```bash
git add contracts/orderbook/src/
git commit -m "feat(orderbook): OrderNote type + serialization TXE tests"
```

---

## Task 6: Orderbook storage + constructor + TXE invariant tests

**Files:**
- Modify: `contracts/orderbook/src/main.nr`
- Modify: `contracts/orderbook/src/test.nr`

- [ ] **Step 1: Add Storage struct, EpochState, and constructor to `main.nr`**

Replace `contracts/orderbook/src/main.nr` with:

```rust
use dep::aztec::macros::aztec;

#[aztec]
pub contract Orderbook {
    use dep::aztec::{
        macros::{notes::note, storage::storage},
        prelude::{AztecAddress, PrivateSet, PublicMutable, PublicImmutable},
        protocol_types::traits::{Serialize, Deserialize, Eq},
    };

    pub global EPOCH_LENGTH: u32 = 100;

    #[note]
    pub struct OrderNote {
        submitted_at_block: u32,
        side:               bool,
        amount_in:          u128,
        limit_price:        u128,
        nonce:              Field,
        owner:              AztecAddress,
    }

    #[derive(Serialize, Deserialize, Eq)]
    pub struct EpochState {
        epoch_id:        u32,
        state:           u8,   // 0=OPEN, 1=CLOSING, 2=SETTLED (Week 2 only writes OPEN)
        opened_at_block: u32,
        closes_at_block: u32,
    }

    #[storage]
    struct Storage<Context> {
        orders:        PrivateSet<OrderNote, Context>,
        current_epoch: PublicMutable<EpochState, Context>,
        token_a_addr:  PublicImmutable<AztecAddress, Context>,
        token_b_addr:  PublicImmutable<AztecAddress, Context>,
        clearing_addr: PublicImmutable<AztecAddress, Context>,
    }

    #[public]
    #[initializer]
    fn constructor(token_a: AztecAddress, token_b: AztecAddress, clearing: AztecAddress) {
        let block = self.context.block_number() as u32;
        self.storage.current_epoch.write(EpochState {
            epoch_id: 0,
            state: 0,                                  // OPEN
            opened_at_block: block,
            closes_at_block: block + EPOCH_LENGTH,
        });
        self.storage.token_a_addr.initialize(token_a);
        self.storage.token_b_addr.initialize(token_b);
        self.storage.clearing_addr.initialize(clearing);
    }

    pub mod test;
}
```

**API caveats:** `PublicImmutable.initialize()` and the `#[initializer]` macro patterns are inferred. If `initialize` is not the right method (it could be `.write()` or similar in v4.2.0), match what the vendored Token's constructor does in `contracts/token/src/main.nr`. The skeleton stays the same — only the method name on `PublicImmutable` may need adjustment.

- [ ] **Step 2: Add constructor invariant TXE tests**

Append to `contracts/orderbook/src/test.nr`:

```rust
use dep::aztec::test::helpers::test_environment::TestEnvironment;
use crate::Orderbook;
use crate::Orderbook::{EpochState, EPOCH_LENGTH};

fn deploy_orderbook(env: &mut TestEnvironment, deployer: AztecAddress) -> AztecAddress {
    // Use deployer as placeholder for token_a, token_b, clearing — Week 2 only.
    let contract = env.deploy("./target/orderbook-Orderbook.json").call_with(
        deployer,
        "constructor",
        (deployer, deployer, deployer),
    );
    contract.address()
}

#[test]
unconstrained fn constructor_sets_initial_epoch_state() {
    let mut env = TestEnvironment::new();
    let deployer = env.create_light_account(1);
    env.impersonate(deployer);

    let addr = deploy_orderbook(&mut env, deployer);
    let orderbook = Orderbook::at(addr);

    let epoch: EpochState = orderbook.storage_read_epoch().simulate(&mut env);
    assert(epoch.epoch_id == 0, "epoch_id should be 0");
    assert(epoch.state == 0, "epoch state should be OPEN (0)");
    assert(epoch.closes_at_block == epoch.opened_at_block + EPOCH_LENGTH, "epoch length mismatch");
}

#[test]
unconstrained fn constructor_records_contract_addresses() {
    let mut env = TestEnvironment::new();
    let deployer = env.create_light_account(1);
    env.impersonate(deployer);

    let addr = deploy_orderbook(&mut env, deployer);
    let orderbook = Orderbook::at(addr);

    // Storage accessor for token_a_addr. The exact method name comes from the
    // PublicImmutable derive — likely `token_a_addr().simulate(&mut env)` or
    // similar. Match the pattern used in the Token contract's view function tests.
    let a = orderbook.token_a_addr().simulate(&mut env);
    let b = orderbook.token_b_addr().simulate(&mut env);
    let c = orderbook.clearing_addr().simulate(&mut env);
    assert(a == deployer && b == deployer && c == deployer, "token/clearing addresses not recorded");
}
```

**API caveat:** The `storage_read_epoch()` view function above doesn't exist on the contract yet. Either:
- Add a `#[view]` (or `#[utility]`) public function `fn get_epoch() -> EpochState` to `main.nr` that reads and returns `self.storage.current_epoch.read()`, then call that from the test, OR
- Use the TXE's direct storage access if v4.2.0 exposes one (search the vendored Token tests for a `storage_*` accessor pattern).

Recommend the first approach — add a `get_epoch` view to `main.nr`. Same for `token_a_addr`, `token_b_addr`, `clearing_addr` — add small getter functions. This is a clean pattern; later tasks may rely on them too.

Add to `main.nr` inside the `pub contract Orderbook { ... }` body (after the constructor):

```rust
#[utility]
unconstrained fn get_epoch() -> EpochState {
    self.storage.current_epoch.read()
}

#[utility]
unconstrained fn get_token_a_addr() -> AztecAddress {
    self.storage.token_a_addr.read()
}

#[utility]
unconstrained fn get_token_b_addr() -> AztecAddress {
    self.storage.token_b_addr.read()
}

#[utility]
unconstrained fn get_clearing_addr() -> AztecAddress {
    self.storage.clearing_addr.read()
}
```

Update the tests above to call `orderbook.get_epoch()`, `get_token_a_addr()`, etc.

- [ ] **Step 3: Compile + test**

```bash
bash scripts/compile-all.sh
pnpm test:noir
```

Expected: orderbook compiles; the test count grows to 4 orderbook tests (2 from Task 5 + 2 here).

- [ ] **Step 4: Commit**

```bash
git add contracts/orderbook/src/
git commit -m "feat(orderbook): storage + constructor with epoch state machine"
```

---

## Task 7: `submit_order` private function with escrow

**Files:**
- Modify: `contracts/orderbook/src/main.nr`
- Modify: `contracts/orderbook/src/test.nr`

- [ ] **Step 1: Add Token dep to orderbook's Nargo.toml**

`submit_order` calls into the Token contract. Add to `contracts/orderbook/Nargo.toml`:

```toml
token = { path = "../token" }
```

The full `[dependencies]` section becomes:

```toml
[dependencies]
aztec = { git = "https://github.com/AztecProtocol/aztec-packages", tag = "v4.2.0", directory = "noir-projects/aztec-nr/aztec" }
token = { path = "../token" }
```

- [ ] **Step 2: Add `submit_order` to `main.nr`**

Inside the `pub contract Orderbook { ... }` body, after the `get_*` view functions, add:

```rust
use dep::token::Token;

pub global MAX_INPUT_NOTES: u32 = 8;

#[private]
fn submit_order(
    side: bool,
    amount_in: u128,
    limit_price: u128,
    nonce: Field,             // user-provided nonce for the Token.transfer call (collision-resistant random)
    order_nonce: Field,       // user-provided nonce for the OrderNote (distinct from above)
) {
    assert(amount_in > 0, "amount_in must be positive");
    assert(limit_price > 0, "limit_price must be positive");

    // Read epoch state from public context via cross-call
    let epoch: EpochState = self.context.call_public_function(
        self.context.this_address(),
        comptime { selector!("get_epoch()") },
        []
    );
    assert(epoch.state == 0, "epoch not open");

    let sender = self.context.msg_sender();
    let block  = self.context.block_number() as u32;

    // Resolve token contract by side
    let token_addr: AztecAddress = if !side {
        self.context.call_public_function(
            self.context.this_address(),
            comptime { selector!("get_token_a_addr()") },
            []
        )
    } else {
        self.context.call_public_function(
            self.context.this_address(),
            comptime { selector!("get_token_b_addr()") },
            []
        )
    };

    // Escrow: move user's private balance to orderbook's public balance on Token_X
    let orderbook_addr = self.context.this_address();
    Token::at(token_addr)
        .transfer_private_to_public(sender, orderbook_addr, amount_in, nonce)
        .call(&mut self.context);

    // Mint OrderNote, encrypted to sender
    let order = OrderNote {
        submitted_at_block: block,
        side,
        amount_in,
        limit_price,
        nonce: order_nonce,
        owner: sender,
    };
    self.storage.orders.insert(order).emit(encode_and_encrypt_note(&mut self.context, sender, order));
}
```

**API caveats (multiple):**
1. The exact `call_public_function` API surface in v4.2.0 might be `self.context.public_call_or_simulate(...)` or wrapped differently. Find the canonical way to read `PublicMutable` and `PublicImmutable` from inside a `#[private]` function. The Token contract's private functions read public state too — read those for the pattern.
2. `comptime { selector!("...") }` for function selectors: may instead be `Selector::<T>::FN_NAME` or a generated typed accessor. Token's cross-calls in v4.2.0 show the pattern.
3. `encode_and_encrypt_note` may be named differently. The pattern from the vendored Token's `mint_to_private` (which encrypts an output note to a recipient) is the canonical reference.

**Recommended order of attack:**
- First, read `contracts/token/src/main.nr` end-to-end. The Token has private functions that read public state and emit encrypted notes — exact same shape as Orderbook's `submit_order`. Mirror those patterns.
- If reading public state from a private function turns out to require the caller to *pass it in* (rather than the contract reading it itself), then `submit_order` will need an extra parameter for the epoch state or token address, supplied by the caller's PXE. This is annoying but compilable. **Adapt rather than fight the model.**

- [ ] **Step 3: Add TXE tests for `submit_order`**

Append to `contracts/orderbook/src/test.nr`:

```rust
#[test]
unconstrained fn submit_order_rejects_when_amount_zero() {
    let mut env = TestEnvironment::new();
    let alice = env.create_light_account(1);
    env.impersonate(alice);

    let addr = deploy_orderbook(&mut env, alice);
    let orderbook = Orderbook::at(addr);

    // amount_in = 0 should revert (regardless of Token state)
    let result = orderbook.submit_order(
        false,                                      // side
        0,                                          // amount_in (invalid)
        1_000_000_000_000_000_000,                  // limit_price
        0x1,                                        // nonce
        0x2,                                        // order_nonce
    ).try_call(&mut env.private());
    assert(result.is_err(), "submit_order should revert on amount_in=0");
}

#[test]
unconstrained fn submit_order_rejects_when_epoch_not_open() {
    // Skipped in this task — exercising this path requires manipulating
    // public storage from inside the TXE, which is non-trivial. The
    // integration test in Task 8 exercises the non-trivial paths against
    // the live Token contract.
    //
    // Add this back once a TXE pattern for mutating public storage
    // outside the contract's own functions exists.
}
```

Note: We are NOT writing a happy-path TXE for `submit_order` here. That requires deploying the Token contract too and seeding Alice with a balance — a non-trivial multi-contract TXE flow. **All happy-path coverage moves to integration tests in Task 8.** This is intentional, per the spec §6.1 fallback plan.

- [ ] **Step 4: Compile + test**

```bash
bash scripts/compile-all.sh
pnpm test:noir
```

Expected: 5 orderbook tests pass (the negative tests run; the `submit_order_rejects_when_epoch_not_open` test body is a no-op stub for now). Total ≥ 9 tests (4 Token + 5 Orderbook).

- [ ] **Step 5: Commit**

```bash
git add contracts/orderbook/
git commit -m "feat(orderbook): submit_order with private->public escrow"
```

---

## Task 8: Integration tests for Orderbook

**Files:**
- Modify: `scripts/codegen.sh` (if it doesn't already loop over `contracts/*/`)
- Create: `tests/integration/orderbook.test.ts`

- [ ] **Step 1: Regenerate bindings (now picks up Orderbook)**

```bash
rm -rf tests/integration/generated
pnpm codegen
ls tests/integration/generated/
```

Expected: `Token.ts` AND `Orderbook.ts` both present.

- [ ] **Step 2: Create `tests/integration/orderbook.test.ts`**

```ts
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { connectToSandbox } from "./helpers/sandbox.js";
import { getTestWallets } from "./helpers/wallets.js";
import { TokenContract } from "./generated/Token.js";
import { OrderbookContract } from "./generated/Orderbook.js";

const SIDE_A_TO_B = false;
const SIDE_B_TO_A = true;
const PRICE_2 = 2_000_000_000_000_000_000n;    // 2.0 (1e18 scaled)

describe("orderbook (live integration)", () => {
  let node: Awaited<ReturnType<typeof connectToSandbox>>;
  let wallet: Awaited<ReturnType<typeof getTestWallets>>["wallet"];
  let adminAddr: any;
  let aliceAddr: any;
  let tUSDC: TokenContract;
  let tETH: TokenContract;
  let orderbook: OrderbookContract;

  before(async () => {
    node = await connectToSandbox();
    const { wallet: w, accounts } = await getTestWallets(node, 2);
    wallet = w;
    adminAddr = accounts[0];
    aliceAddr = accounts[1];

    tUSDC = await TokenContract.deployWithOpts(
      { wallet, method: "constructor_with_minter" },
      pad31("tUSDC"), pad31("tUSDC"), 6n, adminAddr,
    ).send().deployed();

    tETH = await TokenContract.deployWithOpts(
      { wallet, method: "constructor_with_minter" },
      pad31("tETH"), pad31("tETH"), 18n, adminAddr,
    ).send().deployed();

    orderbook = await OrderbookContract.deploy(
      wallet,
      tUSDC.address, tETH.address, adminAddr,    // clearing_addr placeholder = admin
    ).send().deployed();

    // Mint test balances to alice for both sides
    await tUSDC.withWallet(wallet).methods
      .mint_to_private(aliceAddr, 1_000_000_000n)         // 1000 tUSDC
      .send().wait();
    await tETH.withWallet(wallet).methods
      .mint_to_private(aliceAddr, 5_000_000_000_000_000_000n)   // 5 tETH
      .send().wait();
  });

  after(async () => {
    await wallet.stop();
  });

  test("submit_order(A→B) moves 100 tUSDC from alice private into orderbook public balance", async () => {
    const beforeAlice = await tUSDC.withWallet(wallet).methods
      .balance_of_private(aliceAddr).simulate({ from: aliceAddr });
    const beforeOrderbookPub = await tUSDC.withWallet(wallet).methods
      .balance_of_public(orderbook.address).simulate();

    await orderbook.withWallet(wallet).methods
      .submit_order(SIDE_A_TO_B, 100_000_000n, PRICE_2, randomField(), randomField())
      .send().wait();

    const afterAlice = await tUSDC.withWallet(wallet).methods
      .balance_of_private(aliceAddr).simulate({ from: aliceAddr });
    const afterOrderbookPub = await tUSDC.withWallet(wallet).methods
      .balance_of_public(orderbook.address).simulate();

    assert.equal(afterAlice, beforeAlice - 100_000_000n, "alice private down by 100");
    assert.equal(afterOrderbookPub, beforeOrderbookPub + 100_000_000n, "orderbook public up by 100");
  });

  test("submit_order(B→A) escrows tETH, not tUSDC", async () => {
    const beforeAliceETH = await tETH.withWallet(wallet).methods
      .balance_of_private(aliceAddr).simulate({ from: aliceAddr });
    const beforeAliceUSDC = await tUSDC.withWallet(wallet).methods
      .balance_of_private(aliceAddr).simulate({ from: aliceAddr });

    await orderbook.withWallet(wallet).methods
      .submit_order(SIDE_B_TO_A, 2_000_000_000_000_000_000n, PRICE_2, randomField(), randomField())
      .send().wait();

    const afterAliceETH = await tETH.withWallet(wallet).methods
      .balance_of_private(aliceAddr).simulate({ from: aliceAddr });
    const afterAliceUSDC = await tUSDC.withWallet(wallet).methods
      .balance_of_private(aliceAddr).simulate({ from: aliceAddr });

    assert.equal(afterAliceETH, beforeAliceETH - 2_000_000_000_000_000_000n, "alice tETH down by 2");
    assert.equal(afterAliceUSDC, beforeAliceUSDC, "alice tUSDC untouched");
  });

  test("submit_order with insufficient balance reverts", async () => {
    // After the two prior tests, alice has ~900 tUSDC. Submitting 5000 tUSDC should fail.
    const before = await tUSDC.withWallet(wallet).methods
      .balance_of_private(aliceAddr).simulate({ from: aliceAddr });

    await assert.rejects(
      orderbook.withWallet(wallet).methods
        .submit_order(SIDE_A_TO_B, 5_000_000_000n, PRICE_2, randomField(), randomField())
        .send().wait(),
      /balance|notes|insufficient/i,
    );

    const after = await tUSDC.withWallet(wallet).methods
      .balance_of_private(aliceAddr).simulate({ from: aliceAddr });
    assert.equal(after, before, "balance unchanged after revert");
  });

  test("two orders from same user accumulate in orderbook balance", async () => {
    const before = await tUSDC.withWallet(wallet).methods
      .balance_of_public(orderbook.address).simulate();

    await orderbook.withWallet(wallet).methods
      .submit_order(SIDE_A_TO_B, 50_000_000n, PRICE_2, randomField(), randomField())
      .send().wait();
    await orderbook.withWallet(wallet).methods
      .submit_order(SIDE_A_TO_B, 75_000_000n, PRICE_2, randomField(), randomField())
      .send().wait();

    const after = await tUSDC.withWallet(wallet).methods
      .balance_of_public(orderbook.address).simulate();
    assert.equal(after - before, 125_000_000n, "orderbook accumulates both order amounts");
  });
});

function pad31(s: string): string {
  if (s.length > 31) throw new Error(`brand string '${s}' exceeds 31 chars`);
  return s.padEnd(31, "\0");
}

function randomField(): bigint {
  // 31 random bytes packed into a BigInt — within Aztec's field size
  const buf = new Uint8Array(31);
  crypto.getRandomValues(buf);
  let n = 0n;
  for (const byte of buf) n = (n << 8n) | BigInt(byte);
  return n;
}
```

**API caveat:** `balance_of_public(address)` may not be the exact view name in the vendored Token. Look for the public-balance-readable function name in `contracts/token/src/main.nr` — likely `balance_of_public` or `total_public_supply` or similar. Match it.

- [ ] **Step 3: Run integration tests**

In one terminal: `bash scripts/dev.sh`. Wait for ready.

```bash
pnpm test
```

Expected: 6 integration tests pass (2 from `tokens.test.ts` + 4 from `orderbook.test.ts`).

Stop dev stack.

- [ ] **Step 4: Commit**

```bash
git add tests/integration/orderbook.test.ts
git commit -m "test(orderbook): submit_order escrow flow integration tests"
```

---

## Task 9: Update `deploy-tokens.ts` to also deploy Orderbook

**Files:**
- Modify: `scripts/deploy-tokens.ts`

- [ ] **Step 1: Rewrite to include Orderbook**

Replace `scripts/deploy-tokens.ts` content with:

```ts
#!/usr/bin/env node
/**
 * One-shot deployment to a running dev stack:
 *   1. Two Token instances (tUSDC, tETH)
 *   2. One Orderbook instance referencing both Tokens
 *
 * Prints {tUSDC, tETH, orderbook, admin} addresses as JSON.
 */
import { EmbeddedWallet } from "@aztec/wallets/embedded";
import { registerInitialLocalNetworkAccountsInWallet } from "@aztec/wallets/testing";
import { createAztecNodeClient, waitForNode } from "@aztec/aztec.js/node";
import { TokenContract } from "../tests/integration/generated/Token.js";
import { OrderbookContract } from "../tests/integration/generated/Orderbook.js";

const NODE_URL = process.env.AZTEC_NODE_URL ?? "http://localhost:8080";

async function main() {
  const node = createAztecNodeClient(NODE_URL);
  await waitForNode(node);
  const wallet = await EmbeddedWallet.create({ node });
  await registerInitialLocalNetworkAccountsInWallet(wallet);

  const accounts = await wallet.getRegisteredAccounts();
  const admin = accounts[0];
  if (!admin) throw new Error("no test wallets available");
  const adminAddr = admin.getAddress();

  const tUSDC = await TokenContract.deployWithOpts(
    { wallet, method: "constructor_with_minter" },
    pad31("tUSDC"), pad31("tUSDC"), 6n, adminAddr,
  ).send().deployed();

  const tETH = await TokenContract.deployWithOpts(
    { wallet, method: "constructor_with_minter" },
    pad31("tETH"), pad31("tETH"), 18n, adminAddr,
  ).send().deployed();

  const orderbook = await OrderbookContract.deploy(
    wallet,
    tUSDC.address, tETH.address, adminAddr,
  ).send().deployed();

  console.log(JSON.stringify({
    tUSDC: tUSDC.address.toString(),
    tETH: tETH.address.toString(),
    orderbook: orderbook.address.toString(),
    admin: adminAddr.toString(),
  }, null, 2));

  await wallet.stop();
}

function pad31(s: string): string {
  if (s.length > 31) throw new Error(`brand '${s}' too long`);
  return s.padEnd(31, "\0");
}

main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Smoke-test with running dev stack**

In one terminal: `bash scripts/dev.sh`. Wait for ready.

```bash
pnpm tsx scripts/deploy-tokens.ts
```

Expected: JSON output with 4 hex addresses (tUSDC, tETH, orderbook, admin).

Stop dev stack.

- [ ] **Step 3: Commit**

```bash
git add scripts/deploy-tokens.ts
git commit -m "feat(scripts): deploy-tokens also deploys Orderbook"
```

---

## Task 10: Final smoke + Week 2 milestone

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Clean rebuild from scratch**

```bash
rm -rf node_modules contracts/*/target tests/integration/generated tests/node_modules codegenCache.json
pnpm install
pnpm compile
pnpm codegen
ls tests/integration/generated/   # should show Token.ts and Orderbook.ts
pnpm test:noir
```

Expected:
- compile: both contracts compile cleanly
- noir tests: ≥ 9 pass (4 Token + ≥ 5 Orderbook)

- [ ] **Step 2: Integration smoke**

In one terminal: `bash scripts/dev.sh`. Wait for ready.

```bash
pnpm test
pnpm tsx scripts/deploy-tokens.ts
```

Expected:
- pnpm test: 6 integration tests pass (2 tokens + 4 orderbook)
- deploy-tokens JSON includes orderbook address

Stop dev stack (`bash scripts/dev.sh --down`).

- [ ] **Step 3: Update README status**

Read `README.md`. Find the Status line (currently mentions Week 1). Replace with:

```
**Status:** Week 2 complete. OrderbookContract scaffolded; `submit_order` escrows user tokens via Token.transfer_private_to_public; 6 integration tests + ≥5 TXE tests green. Week 3 adds cancel_order, epoch transitions, and CLI scaffold.
```

- [ ] **Step 4: Milestone commit and tag**

```bash
git add README.md
git commit -m "docs: mark Week 2 (orderbook submit_order) complete"
git tag week-02-orderbook-submit
```

Verify:

```bash
git tag -l | grep week-02
```

Expected: `week-02-orderbook-submit`.

---

## Definition of Done for Week 2

All checkboxes above are checked, and:

1. `pnpm compile` succeeds for both `contracts/token/` and `contracts/orderbook/`
2. `pnpm test:noir` succeeds; ≥ 9 TXE tests pass
3. `pnpm codegen` produces both `Token.ts` and `Orderbook.ts` bindings
4. `pnpm test` succeeds against the dev stack; 6 integration tests pass (2 tokens + 4 orderbook)
5. `pnpm tsx scripts/deploy-tokens.ts` prints JSON with `tUSDC`, `tETH`, `orderbook`, `admin` addresses
6. Git tag `week-02-orderbook-submit` exists at HEAD
7. README status line updated

## Hand-off to Week 3

Week 3 plan (`docs/superpowers/plans/2026-05-14-zswap-aztec-week-03-orderbook-cancel.md`) will be written after Week 2 is complete. Week 3 covers `cancel_order` (escrow return), epoch state transitions (`_advance_epoch` gated public function called by ClearingContract), and the `zswap order` CLI scaffold. Week 2's `submit_order` and Token-unification work are the foundations Week 3 builds on.

---

## Risk Notes

- **PXE randomness:** The plan generates nonces client-side via `crypto.getRandomValues`. The Token contract's `transfer_private_to_public` requires a unique nonce per call to prevent commitment collisions. 31-byte randomness is sufficient. **Do not** use a counter — that would leak ordering metadata.

- **`call_public_function` from private context:** This is the most-uncertain API in the plan. Aztec's docs and the vendored Token contract have the canonical pattern. If implementation hits friction, the fallback is to require the user's PXE to **pass in** the epoch state and token addresses as arguments to `submit_order`. That makes the function more verbose but skips the cross-context read. Adapt rather than fight.

- **TXE multi-contract:** Task 7 deliberately avoided cross-contract TXE for `submit_order`. If Aztec v4.2.0's TXE turns out to support multi-contract deployment cleanly, a future task can add the happy-path TXE test back. Not Week 2's concern.

- **`balance_of_public`:** The Token contract's public-balance read function may not be named exactly this. Read the vendored Token source — find the actual function that returns a public balance for a given address — and use that name in the integration tests.
