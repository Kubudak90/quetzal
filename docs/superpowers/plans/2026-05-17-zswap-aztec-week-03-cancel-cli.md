# Quetzal — Week 3: `cancel_order` + CLI scaffold Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `cancel_order` (escrow returned to the maker's private balance) and a `get_orders` getter to `OrderbookContract`, and ship a `cli/` package with `quetzal order` / `cancel` / `orders`.

**Architecture:** `cancel_order` is the exact inverse of Week 2's `submit_order`: it pops the maker's resting `OrderNote` by its identity nonce (which nullifies it) and calls `Token.transfer_public_to_private` to move the escrow from the Orderbook's public balance back to the maker's private balance. The CLI is a thin `commander` wrapper over `@aztec/aztec.js`, reading contract addresses from `quetzal.config.json`.

**Tech Stack:** Noir / aztec-nr v4.2.0, Aztec 4.2.1, TypeScript (Node 22), `commander`, `node:test` + `tsx`, pnpm workspaces.

**Spec:** `docs/superpowers/specs/2026-05-17-zswap-aztec-week-03-cancel-cli-design.md`

---

## File Structure (delta over Week 2)

| File | Responsibility | Action |
|---|---|---|
| `contracts/orderbook/src/main.nr` | Add `cancel_order` private fn + `get_orders` utility getter | Modify |
| `contracts/orderbook/src/test.nr` | Add TXE tests for the paths that fire before any cross-contract call | Modify |
| `tests/integration/orderbook.test.ts` | Add 5 cancel/`get_orders` integration tests | Modify |
| `tests/integration/cli.test.ts` | CLI smoke test (`order` → `orders` → `cancel` → `orders`) | Create |
| `cli/package.json` | `@quetzal/cli` workspace package manifest | Create |
| `cli/tsconfig.json` | TS config for the CLI package | Create |
| `cli/src/index.ts` | `commander` entry — registers the three subcommands | Create |
| `cli/src/config.ts` | Load + validate `quetzal.config.json` | Create |
| `cli/src/wallet.ts` | Node client + `EmbeddedWallet` + account selection | Create |
| `cli/src/field.ts` | `randomField()` + hex `Field` parsing helpers | Create |
| `cli/src/commands/order.ts` | `quetzal order` implementation | Create |
| `cli/src/commands/cancel.ts` | `quetzal cancel` implementation | Create |
| `cli/src/commands/orders.ts` | `quetzal orders` implementation | Create |
| `scripts/deploy-tokens.ts` | Also write `quetzal.config.json` | Modify |
| `.gitignore` | Ignore `quetzal.config.json` | Modify |
| `README.md` | Status line + CLI quickstart | Modify |

`pnpm-workspace.yaml` already lists `cli` — no change needed; `pnpm install` picks it up once `cli/package.json` exists.

## Pre-flight

- [ ] Confirm `git status` is clean and HEAD is at the Week 2 milestone (`git log --oneline -1` shows the Week 2 docs commit; `git tag -l | grep week-02` shows `week-02-orderbook-submit`).
- [ ] Confirm Docker is running (`docker info`) — needed for `pnpm compile` / `pnpm codegen` / `pnpm test:noir`.
- [ ] Read the Week 2 contract to refresh the conventions: `contracts/orderbook/src/main.nr` (note `submit_order`, `_assert_epoch_open`, the `Owned<PrivateSet<OrderNote>>` storage accessed via `self.storage.orders.at(maker)`, and `side == false → token_a`, `side == true → token_b`).

---

## Task 1: `cancel_order` + `get_orders` on `OrderbookContract`

**Dispatch with model: opus** — novel aztec-nr API surface (`PrivateSet` note retrieval / `NoteGetterOptions`).

**Files:**
- Modify: `contracts/orderbook/src/main.nr`

- [ ] **Step 1: API discovery — PrivateSet note retrieval**

Before writing code, determine the exact aztec-nr v4.2.0 API for selecting and removing a note from a `PrivateSet`. Sources, in order of preference:

1. The aztec-nr source for tag `v4.2.0`: `noir-projects/aztec-nr/aztec/src/state_vars/private_set.nr` and `noir-projects/aztec-nr/aztec/src/note/note_getter_options.nr` on GitHub (`https://github.com/AztecProtocol/aztec-packages/tree/v4.2.0`).
2. Inspect the resolved dependency inside the build container:
   ```bash
   docker run --rm --entrypoint bash -v "$PWD:/work" -w /work aztecprotocol/aztec:4.2.1 \
     -c 'find / -path "*aztec-nr/aztec/src/state_vars/private_set.nr" 2>/dev/null | head -1 | xargs cat'
   ```

Confirm specifically:
- The method that retrieves **and nullifies** matching notes in one call (expected: `pop_notes(options)` returning a `BoundedVec<Note, MAX>`).
- How `NoteGetterOptions` selects by a struct field (expected: `NoteGetterOptions::new().select(<property selector>, <comparator>, <value>)` plus `.set_limit(n)`).
- How a `#[note]` struct exposes its field selectors (expected: a generated `OrderNote::properties()` accessor, e.g. `OrderNote::properties().nonce`).
- The comparator value for equality (expected: a `Comparator` enum/const, `EQ`).

The code blocks below are the **expected** shape; adjust names/signatures to whatever the v4.2.0 source actually exposes. The compile step (Step 5) is the source of truth.

- [ ] **Step 2: Add the required imports**

In `contracts/orderbook/src/main.nr`, extend the existing `use aztec::{ ... }` block to bring in the note-getter API. Add these entries alongside the current imports (exact paths to be confirmed in Step 1):

```rust
        note::note_getter_options::NoteGetterOptions,
```

If `Comparator` (or an equivalent equality selector) lives in a separate module, add that import too, as discovered in Step 1.

- [ ] **Step 3: Implement `cancel_order`**

Insert this private function immediately **after** `_assert_epoch_open` and **before** the `// === UNCONSTRAINED GETTERS ===` section in `contracts/orderbook/src/main.nr`:

```rust
    // ============================ ORDER CANCELLATION ============================

    /// Cancel a resting order and return its escrow to the maker's PRIVATE balance.
    ///
    /// Flow:
    /// 1. Retrieve (and nullify) the caller's `OrderNote` whose identity nonce equals
    ///    `order_nonce`. Exactly one note must match.
    /// 2. Read the escrowed token address from public-immutable storage, decided by the
    ///    note's `side` (false -> token A, true -> token B) — identical to `submit_order`.
    /// 3. Call `Token.transfer_public_to_private` to move `amount_in` of that token from
    ///    the orderbook's PUBLIC balance back into the maker's PRIVATE balance. Because
    ///    `from` is this contract and this contract is the caller, the Token's
    ///    `authorize_once("from", _nonce)` guard passes without an authwit.
    /// 4. Enqueue the `_assert_epoch_open` callback so the whole tx reverts if the epoch
    ///    is no longer OPEN at mine time.
    ///
    /// # Arguments
    /// - `order_nonce`: the per-order identity nonce embedded in the target `OrderNote`
    ///   (the same value passed as `order_nonce` to `submit_order`).
    /// - `nonce`: authwit nonce for the inner `Token.transfer_public_to_private` call.
    #[external("private")]
    fn cancel_order(order_nonce: Field, nonce: Field) {
        let maker = self.msg_sender();

        // Retrieve + nullify the maker's resting order matching `order_nonce`.
        let options =
            NoteGetterOptions::new().select(OrderNote::properties().nonce, Comparator.EQ, order_nonce).set_limit(1);
        let notes = self.storage.orders.at(maker).pop_notes(options);
        assert(notes.len() == 1, "order not found");
        let order = notes.get(0);

        // Defence-in-depth: the per-owner PrivateSet already scopes retrieval to `maker`.
        assert(order.owner == maker, "not order owner");

        let token_addr: AztecAddress = if order.side {
            self.storage.token_b_addr.read()
        } else {
            self.storage.token_a_addr.read()
        };

        // Return the escrow: orderbook PUBLIC balance -> maker PRIVATE balance.
        self.call(Token::at(token_addr).transfer_public_to_private(
            self.address,
            maker,
            order.amount_in,
            nonce,
        ));

        // Defer the OPEN-state check to public execution (PublicMutable is not readable
        // from private context), atomic with the rest of the tx.
        self.enqueue_self._assert_epoch_open();
    }
```

If Step 1 found that `pop_notes` / `select` / `properties()` / `Comparator.EQ` differ, adapt this body — the *behaviour* (find one note by nonce, nullify it, return escrow, gate on OPEN) is fixed; the API spelling is not.

- [ ] **Step 4: Implement `get_orders`**

Add this getter inside the `// === UNCONSTRAINED GETTERS ===` section, next to the existing `get_epoch` / `get_token_a_addr` getters:

```rust
    /// Return the resting orders owned by `owner` (up to MAX_INPUT_NOTES). `owner` is
    /// passed explicitly rather than read from `msg_sender` because utility functions are
    /// simulated, and only the owner's PXE holds the encrypted notes to resolve.
    #[external("utility")]
    unconstrained fn get_orders(owner: AztecAddress) -> BoundedVec<OrderNote, MAX_INPUT_NOTES> {
        self.storage.orders.at(owner).get_notes(NoteGetterOptions::new())
    }
```

If `get_notes` in v4.2.0 returns a different max-length generic, set the return type's length parameter to match (Step 1 confirms this). `MAX_INPUT_NOTES` is the global already declared at the top of the contract (`= 8`).

- [ ] **Step 5: Compile**

Run: `pnpm compile`
Expected: `All contracts compiled.` with no errors. Iterate on Steps 2–4 until the orderbook compiles. The most likely fixes are import paths and the `pop_notes`/`select` spelling.

- [ ] **Step 6: Commit**

```bash
git add contracts/orderbook/src/main.nr
git commit -m "feat(orderbook): cancel_order returns escrow + get_orders getter"
```

---

## Task 2: TXE tests for the cancel paths that need no Token

**Dispatch with model: sonnet.**

Only paths that fail **before** the cross-contract `Token` call can run in pure TXE (a real `Token` is not deployed in the orderbook's TXE harness — same constraint Week 2 hit with `submit_order`). That is: cancelling when no order exists, and `get_orders` on an account with no orders. The happy path, non-owner, and double-cancel are covered by integration tests in Task 3.

**Files:**
- Modify: `contracts/orderbook/src/test.nr`

- [ ] **Step 1: Add the two TXE tests**

Append to `contracts/orderbook/src/test.nr`:

```rust
#[test(should_fail_with = "order not found")]
unconstrained fn cancel_order_rejects_unknown_nonce() {
    let mut env = TestEnvironment::new();
    let deployer = env.create_light_account();

    // Placeholder addresses are fine: the "order not found" assertion fires during note
    // retrieval, before any token-contract call is attempted.
    let orderbook = deploy_orderbook(&mut env, deployer, deployer, deployer, deployer);

    let maker = env.create_light_account();

    // No orders were ever submitted, so cancelling any nonce must revert.
    env.call_private(maker, Orderbook::at(orderbook).cancel_order(0x1234, 0));
}

#[test]
unconstrained fn get_orders_empty_for_fresh_account() {
    let mut env = TestEnvironment::new();
    let deployer = env.create_light_account();

    let orderbook = deploy_orderbook(&mut env, deployer, deployer, deployer, deployer);

    let owner = env.create_light_account();
    let orders = env.execute_utility(Orderbook::at(orderbook).get_orders(owner));

    assert(orders.len() == 0, "a fresh account must have no resting orders");
}
```

- [ ] **Step 2: Run the TXE suite**

Run: `pnpm test:noir`
Expected: all token tests pass (4), all orderbook tests pass (now 8: the prior 6 + the 2 new). Look for `8 tests passed` under `[orderbook]`.

- [ ] **Step 3: Commit**

```bash
git add contracts/orderbook/src/test.nr
git commit -m "test(orderbook): TXE tests for cancel_order + get_orders"
```

---

## Task 3: Cancel integration tests

**Dispatch with model: sonnet.**

**Files:**
- Modify: `tests/integration/orderbook.test.ts`

- [ ] **Step 1: Regenerate bindings so `cancel_order` / `get_orders` are available**

Run: `pnpm codegen`
Expected: `Orderbook.ts` regenerated; `find tests/integration/generated -name Orderbook.ts` shows the file. The generated `OrderbookContract` now has `cancel_order` and `get_orders` methods.

- [ ] **Step 2: Add a `cancel_order` + `get_orders` test block**

Append a new `describe` block to `tests/integration/orderbook.test.ts` (after the existing `describe("orderbook (live integration)", ...)`). It re-uses the file's existing helpers (`randomField`, `readPrivateBalance`, `readPublicBalance`, `connectToSandbox`, `getTestWallets`) and constants (`SIDE_A_TO_B`, `SIDE_B_TO_A`, `PRICE_2`, `ONE_TUSDC`, `ONE_TETH`).

```ts
describe("orderbook cancel_order (live integration)", () => {
  let node: AztecNode;
  let wallet: EmbeddedWallet;
  let admin: AztecAddress;
  let alice: AztecAddress;
  let bob: AztecAddress;
  let tUSDC: TokenContract;
  let tETH: TokenContract;
  let orderbook: OrderbookContract;

  const MINT = 1_000n * ONE_TUSDC;
  const MINT_ETH = 10n * ONE_TETH;
  const ORDER_USDC = 100n * ONE_TUSDC;
  const ORDER_ETH = 3n * ONE_TETH;

  before(async () => {
    node = await connectToSandbox();
    const env = await getTestWallets(node, 3);
    wallet = env.wallet;
    admin = env.accounts[0]!;
    alice = env.accounts[1]!;
    bob = env.accounts[2]!;

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
      wallet, tUSDC.address, tETH.address, admin,
    ).send({ from: admin });
    orderbook = dOB.contract;

    await tUSDC.methods.mint_to_private(alice, MINT).send({ from: admin });
    await tETH.methods.mint_to_private(alice, MINT_ETH).send({ from: admin });
  });

  after(async () => {
    const stop = (wallet as unknown as { stop?: () => Promise<void> }).stop;
    if (typeof stop === "function") await stop.call(wallet);
  });

  it("submit then cancel restores alice's private balance", { timeout: 600_000 }, async () => {
    const before = await readPrivateBalance(tUSDC, alice);
    const orderNonce = randomField();

    await orderbook.methods
      .submit_order(SIDE_A_TO_B, ORDER_USDC, PRICE_2, randomField(), orderNonce)
      .send({ from: alice });

    assert.equal(await readPrivateBalance(tUSDC, alice), before - ORDER_USDC, "escrowed");

    await orderbook.methods
      .cancel_order(orderNonce, randomField())
      .send({ from: alice });

    assert.equal(await readPrivateBalance(tUSDC, alice), before, "private balance fully restored");
    assert.equal(
      await readPublicBalance(tUSDC, orderbook.address, admin), 0n,
      "orderbook public escrow drained back to zero",
    );
  });

  it("cancel returns the correct token on the ask side", { timeout: 600_000 }, async () => {
    const beforeETH = await readPrivateBalance(tETH, alice);
    const beforeUSDC = await readPrivateBalance(tUSDC, alice);
    const orderNonce = randomField();

    await orderbook.methods
      .submit_order(SIDE_B_TO_A, ORDER_ETH, PRICE_2, randomField(), orderNonce)
      .send({ from: alice });
    await orderbook.methods
      .cancel_order(orderNonce, randomField())
      .send({ from: alice });

    assert.equal(await readPrivateBalance(tETH, alice), beforeETH, "tETH restored");
    assert.equal(await readPrivateBalance(tUSDC, alice), beforeUSDC, "tUSDC untouched");
  });

  it("cancelling one of two orders leaves the other resting", { timeout: 600_000 }, async () => {
    const keepNonce = randomField();
    const dropNonce = randomField();

    await orderbook.methods
      .submit_order(SIDE_A_TO_B, ORDER_USDC, PRICE_2, randomField(), keepNonce)
      .send({ from: alice });
    await orderbook.methods
      .submit_order(SIDE_A_TO_B, ORDER_USDC, PRICE_2, randomField(), dropNonce)
      .send({ from: alice });

    const escrowBoth = await readPublicBalance(tUSDC, orderbook.address, admin);
    assert.equal(escrowBoth, 2n * ORDER_USDC, "both orders escrowed");

    await orderbook.methods
      .cancel_order(dropNonce, randomField())
      .send({ from: alice });

    assert.equal(
      await readPublicBalance(tUSDC, orderbook.address, admin), ORDER_USDC,
      "exactly one order's escrow remains",
    );

    const remaining = await orderbook.methods.get_orders(alice).simulate({ from: alice });
    const nonces = extractNonces(remaining);
    assert.ok(nonces.includes(keepNonce), "the kept order is still listed");
    assert.ok(!nonces.includes(dropNonce), "the cancelled order is gone");
  });

  it("double cancel of the same order fails", { timeout: 600_000 }, async () => {
    const orderNonce = randomField();
    await orderbook.methods
      .submit_order(SIDE_A_TO_B, ORDER_USDC, PRICE_2, randomField(), orderNonce)
      .send({ from: alice });
    await orderbook.methods
      .cancel_order(orderNonce, randomField())
      .send({ from: alice });

    await assert.rejects(
      orderbook.methods.cancel_order(orderNonce, randomField()).send({ from: alice }),
      /order not found/i,
      "second cancel of the same order must revert",
    );
  });

  it("a non-owner cannot cancel another maker's order", { timeout: 600_000 }, async () => {
    const orderNonce = randomField();
    await orderbook.methods
      .submit_order(SIDE_A_TO_B, ORDER_USDC, PRICE_2, randomField(), orderNonce)
      .send({ from: alice });

    await assert.rejects(
      orderbook.methods.cancel_order(orderNonce, randomField()).send({ from: bob }),
      /order not found/i,
      "bob cannot cancel alice's order (her PrivateSet yields no match for him)",
    );

    // Clean up so the suite leaves no resting escrow.
    await orderbook.methods.cancel_order(orderNonce, randomField()).send({ from: alice });
  });
});
```

- [ ] **Step 3: Add the `extractNonces` helper**

The `get_orders` getter returns a Noir `BoundedVec<OrderNote, 8>`. The exact TypeScript shape of that return value depends on codegen — inspect `tests/integration/generated/Orderbook.ts` for the `get_orders` return type. Add this helper near the top-of-file helpers (after `randomField`), and adapt the body to the actual shape (a `BoundedVec` typically codegens to `{ storage: OrderNote[]; len: bigint }`, or to a plain array):

```ts
// `get_orders` returns a Noir BoundedVec<OrderNote, 8>. Normalise it to the list of
// order-identity nonces. Adapt the destructuring to the codegen'd shape if it differs.
function extractNonces(boundedVec: unknown): bigint[] {
  const bv = boundedVec as { storage?: unknown[]; len?: bigint } | unknown[];
  const arr = Array.isArray(bv) ? bv : (bv.storage ?? []);
  const len = Array.isArray(bv) ? bv.length : Number(bv.len ?? arr.length);
  return arr.slice(0, len).map((o) => BigInt((o as { nonce: bigint | number }).nonce));
}
```

If the generated type makes the shape obvious, simplify this helper to match exactly rather than guessing.

- [ ] **Step 4: Run the integration suite**

Start the dev stack in another terminal: `bash scripts/dev.sh` (wait until the aztec node answers on `http://localhost:8080`).

Run: `pnpm test`
Expected: `pass 11` — the 6 prior integration tests (4 orderbook + 2 token) plus the 5 new cancel tests. `fail 0`.

Stop the dev stack when done: `bash scripts/dev.sh --down`.

- [ ] **Step 5: Commit**

```bash
git add tests/integration/orderbook.test.ts
git commit -m "test(orderbook): cancel_order escrow-return integration tests"
```

---

## Task 4: `cli/` workspace package scaffold

**Dispatch with model: sonnet.**

**Files:**
- Create: `cli/package.json`, `cli/tsconfig.json`, `cli/src/config.ts`, `cli/src/wallet.ts`, `cli/src/field.ts`, `cli/src/index.ts`

- [ ] **Step 1: `cli/package.json`**

```json
{
  "name": "@quetzal/cli",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "bin": { "zswap": "src/index.ts" },
  "scripts": {
    "zswap": "tsx src/index.ts",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@aztec/aztec.js": "4.2.1",
    "@aztec/accounts": "4.2.1",
    "@aztec/wallets": "4.2.1",
    "commander": "^12.1.0"
  },
  "devDependencies": {
    "@types/node": "^22.7.0",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0"
  }
}
```

- [ ] **Step 2: `cli/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 3: `cli/src/field.ts`**

```ts
import { webcrypto } from "node:crypto";

/** A random BN254 field element (31 random bytes stay under the field modulus). */
export function randomField(): bigint {
  const buf = new Uint8Array(31);
  webcrypto.getRandomValues(buf);
  let n = 0n;
  for (const byte of buf) n = (n << 8n) | BigInt(byte);
  return n;
}

/** Parse a CLI-supplied field value: accepts decimal or `0x`-prefixed hex. */
export function parseField(raw: string): bigint {
  const v = raw.trim();
  return v.startsWith("0x") || v.startsWith("0X") ? BigInt(v) : BigInt(v);
}
```

- [ ] **Step 4: `cli/src/config.ts`**

```ts
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface QuetzalConfig {
  nodeUrl: string;
  tUSDC: string;
  tETH: string;
  orderbook: string;
  admin: string;
}

const REQUIRED: (keyof QuetzalConfig)[] = ["nodeUrl", "tUSDC", "tETH", "orderbook", "admin"];

/** Load and validate quetzal.config.json (written by scripts/deploy-tokens.ts). */
export function loadConfig(path = "quetzal.config.json"): QuetzalConfig {
  const abs = resolve(process.cwd(), path);
  let parsed: Partial<QuetzalConfig>;
  try {
    parsed = JSON.parse(readFileSync(abs, "utf8")) as Partial<QuetzalConfig>;
  } catch (e) {
    throw new Error(
      `could not read config at ${abs} — run \`pnpm tsx scripts/deploy-tokens.ts\` first ` +
        `(or pass --config): ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  for (const key of REQUIRED) {
    if (typeof parsed[key] !== "string") {
      throw new Error(`config at ${abs} is missing required string field "${key}"`);
    }
  }
  return parsed as QuetzalConfig;
}
```

- [ ] **Step 5: `cli/src/wallet.ts`**

```ts
import { createAztecNodeClient, waitForNode } from "@aztec/aztec.js/node";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { EmbeddedWallet } from "@aztec/wallets/embedded";
import { registerInitialLocalNetworkAccountsInWallet } from "@aztec/wallets/testing";
import type { QuetzalConfig } from "./config.js";

export interface CliContext {
  wallet: EmbeddedWallet;
  account: AztecAddress;
  config: QuetzalConfig;
  stop: () => Promise<void>;
}

/**
 * Connect to the Aztec node from `config`, build an ephemeral wallet, register the
 * local-network test accounts, and select account `accountIndex` as the actor.
 */
export async function openCli(config: QuetzalConfig, accountIndex: number): Promise<CliContext> {
  const node = createAztecNodeClient(config.nodeUrl);
  await waitForNode(node);

  const wallet = await EmbeddedWallet.create(node, {
    ephemeral: true,
    pxe: { proverEnabled: false },
  });
  const accounts = await registerInitialLocalNetworkAccountsInWallet(wallet);
  const account = accounts[accountIndex];
  if (!account) {
    throw new Error(
      `account index ${accountIndex} out of range — ${accounts.length} test accounts available`,
    );
  }

  const stop = async () => {
    const s = (wallet as unknown as { stop?: () => Promise<void> }).stop;
    if (typeof s === "function") await s.call(wallet);
  };
  return { wallet, account, config, stop };
}
```

- [ ] **Step 6: `cli/src/index.ts` (entry with subcommands stubbed to Task 5)**

```ts
#!/usr/bin/env node
import { Command } from "commander";
import { registerOrder } from "./commands/order.js";
import { registerCancel } from "./commands/cancel.js";
import { registerOrders } from "./commands/orders.js";

const program = new Command();
program
  .name("zswap")
  .description("Quetzal CLI — submit, list, and cancel private orders")
  .option("-c, --config <path>", "path to quetzal.config.json", "quetzal.config.json")
  .option("-a, --account <index>", "test account index to act as", "0");

registerOrder(program);
registerCancel(program);
registerOrders(program);

program.parseAsync(process.argv).catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
```

- [ ] **Step 7: Create placeholder command modules so the entry compiles**

Create `cli/src/commands/order.ts`, `cli/src/commands/cancel.ts`, `cli/src/commands/orders.ts`, each with a stub registration (Task 5 fills the bodies):

`cli/src/commands/order.ts`:
```ts
import type { Command } from "commander";

export function registerOrder(program: Command): void {
  program
    .command("order")
    .description("submit a private order")
    .requiredOption("--side <buy|sell>", "buy = deposit tUSDC, sell = deposit tETH")
    .requiredOption("--amount <n>", "input amount in the token's smallest unit")
    .requiredOption("--limit <price>", "limit price, Q-format scaled to 1e18")
    .action(() => {
      throw new Error("not implemented yet");
    });
}
```

`cli/src/commands/cancel.ts`:
```ts
import type { Command } from "commander";

export function registerCancel(program: Command): void {
  program
    .command("cancel")
    .description("cancel a resting order and reclaim its escrow")
    .requiredOption("--nonce <field>", "order-identity nonce (from `quetzal order` / `quetzal orders`)")
    .action(() => {
      throw new Error("not implemented yet");
    });
}
```

`cli/src/commands/orders.ts`:
```ts
import type { Command } from "commander";

export function registerOrders(program: Command): void {
  program
    .command("orders")
    .description("list the account's resting orders")
    .action(() => {
      throw new Error("not implemented yet");
    });
}
```

- [ ] **Step 8: Install and typecheck**

Run: `pnpm install` (picks up the new `cli` workspace member), then `pnpm --filter @quetzal/cli typecheck`.
Expected: install succeeds; `tsc --noEmit` reports no errors.

- [ ] **Step 9: Commit**

```bash
git add cli/ pnpm-lock.yaml
git commit -m "feat(cli): @quetzal/cli package scaffold (config, wallet, commander entry)"
```

---

## Task 5: CLI commands — `order`, `cancel`, `orders`

**Dispatch with model: sonnet.**

**Files:**
- Modify: `cli/src/commands/order.ts`, `cli/src/commands/cancel.ts`, `cli/src/commands/orders.ts`

The generated bindings are imported across packages with a relative path — the same way `scripts/deploy-tokens.ts` imports `../tests/integration/generated/Token.js`. From `cli/src/commands/` that path is `../../../tests/integration/generated/Orderbook.js`.

Each command reads the program-level `--config` / `--account` options via `command.optsWithGlobals()`.

- [ ] **Step 1: `cli/src/commands/order.ts`**

```ts
import type { Command } from "commander";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { OrderbookContract } from "../../../tests/integration/generated/Orderbook.js";
import { loadConfig } from "../config.js";
import { openCli } from "../wallet.js";
import { randomField } from "../field.js";

export function registerOrder(program: Command): void {
  program
    .command("order")
    .description("submit a private order")
    .requiredOption("--side <buy|sell>", "buy = deposit tUSDC, sell = deposit tETH")
    .requiredOption("--amount <n>", "input amount in the token's smallest unit")
    .requiredOption("--limit <price>", "limit price, Q-format scaled to 1e18")
    .action(async (_opts, cmd: Command) => {
      const opts = cmd.optsWithGlobals();
      const side = String(opts.side).toLowerCase();
      if (side !== "buy" && side !== "sell") {
        throw new Error(`--side must be "buy" or "sell", got "${opts.side}"`);
      }
      const sideFlag = side === "sell"; // false = bid (tUSDC), true = ask (tETH)
      const amount = BigInt(opts.amount);
      const limit = BigInt(opts.limit);

      const config = loadConfig(opts.config);
      const ctx = await openCli(config, Number(opts.account));
      try {
        const orderbook = await OrderbookContract.at(
          AztecAddress.fromString(config.orderbook),
          ctx.wallet,
        );
        const orderNonce = randomField();
        await orderbook.methods
          .submit_order(sideFlag, amount, limit, randomField(), orderNonce)
          .send({ from: ctx.account });

        console.log(`order submitted (${side}, amount ${amount}, limit ${limit})`);
        console.log(`order nonce: 0x${orderNonce.toString(16)}`);
        console.log(`cancel later with: quetzal cancel --nonce 0x${orderNonce.toString(16)}`);
      } finally {
        await ctx.stop();
      }
    });
}
```

- [ ] **Step 2: `cli/src/commands/cancel.ts`**

```ts
import type { Command } from "commander";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { OrderbookContract } from "../../../tests/integration/generated/Orderbook.js";
import { loadConfig } from "../config.js";
import { openCli } from "../wallet.js";
import { randomField, parseField } from "../field.js";

export function registerCancel(program: Command): void {
  program
    .command("cancel")
    .description("cancel a resting order and reclaim its escrow")
    .requiredOption("--nonce <field>", "order-identity nonce (from `quetzal order` / `quetzal orders`)")
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
        await orderbook.methods
          .cancel_order(orderNonce, randomField())
          .send({ from: ctx.account });

        console.log(`order 0x${orderNonce.toString(16)} cancelled; escrow returned to your private balance`);
      } finally {
        await ctx.stop();
      }
    });
}
```

- [ ] **Step 3: `cli/src/commands/orders.ts`**

The `get_orders` getter returns a Noir `BoundedVec<OrderNote, 8>`. Inspect `tests/integration/generated/Orderbook.ts` for the `get_orders` return shape and adapt the `normalise` helper below (a `BoundedVec` usually codegens to `{ storage: OrderNote[]; len: bigint }`).

```ts
import type { Command } from "commander";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { OrderbookContract } from "../../../tests/integration/generated/Orderbook.js";
import { loadConfig } from "../config.js";
import { openCli } from "../wallet.js";

interface OrderRow {
  nonce: bigint;
  side: boolean;
  amount_in: bigint;
  limit_price: bigint;
  submitted_at_block: bigint;
}

// Adapt to the codegen'd BoundedVec shape if it differs from { storage, len }.
function normalise(boundedVec: unknown): OrderRow[] {
  const bv = boundedVec as { storage?: unknown[]; len?: bigint } | unknown[];
  const arr = Array.isArray(bv) ? bv : (bv.storage ?? []);
  const len = Array.isArray(bv) ? bv.length : Number(bv.len ?? arr.length);
  return arr.slice(0, len).map((o) => {
    const r = o as Record<string, bigint | number | boolean>;
    return {
      nonce: BigInt(r.nonce as bigint),
      side: Boolean(r.side),
      amount_in: BigInt(r.amount_in as bigint),
      limit_price: BigInt(r.limit_price as bigint),
      submitted_at_block: BigInt(r.submitted_at_block as bigint),
    };
  });
}

export function registerOrders(program: Command): void {
  program
    .command("orders")
    .description("list the account's resting orders")
    .action(async (_opts, cmd: Command) => {
      const opts = cmd.optsWithGlobals();
      const config = loadConfig(opts.config);
      const ctx = await openCli(config, Number(opts.account));
      try {
        const orderbook = await OrderbookContract.at(
          AztecAddress.fromString(config.orderbook),
          ctx.wallet,
        );
        const sim = await orderbook.methods
          .get_orders(ctx.account)
          .simulate({ from: ctx.account });
        const rows = normalise((sim as { result?: unknown }).result ?? sim);

        if (rows.length === 0) {
          console.log("no resting orders");
          return;
        }
        console.log(`resting orders for account ${opts.account}:`);
        for (const r of rows) {
          console.log(
            `  nonce=0x${r.nonce.toString(16)}  side=${r.side ? "sell" : "buy"}  ` +
              `amount=${r.amount_in}  limit=${r.limit_price}  block=${r.submitted_at_block}`,
          );
        }
      } finally {
        await ctx.stop();
      }
    });
}
```

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @quetzal/cli typecheck`
Expected: no errors. If the generated `get_orders` return type makes `normalise`/`sim.result` access ill-typed, adjust to the actual shape.

- [ ] **Step 5: Manual smoke against the dev stack**

Start `bash scripts/dev.sh` in another terminal; then:
```bash
pnpm tsx scripts/deploy-tokens.ts          # writes quetzal.config.json once Task 6 lands;
                                            # until then, hand-write quetzal.config.json
pnpm --filter @quetzal/cli quetzal orders       # -> "no resting orders"
```
(Full end-to-end is covered by the automated smoke test in Task 6 — this step just confirms the command wiring runs. Skip if Task 6 is done in the same session.)

Stop the dev stack: `bash scripts/dev.sh --down`.

- [ ] **Step 6: Commit**

```bash
git add cli/src/commands/
git commit -m "feat(cli): order, cancel, and orders commands"
```

---

## Task 6: `deploy-tokens.ts` writes config + CLI smoke test

**Dispatch with model: sonnet.**

**Files:**
- Modify: `scripts/deploy-tokens.ts`, `.gitignore`
- Create: `tests/integration/cli.test.ts`

- [ ] **Step 1: `deploy-tokens.ts` also writes `quetzal.config.json`**

In `scripts/deploy-tokens.ts`, add the `node:fs` import at the top, near the other imports:

```ts
import { writeFileSync } from "node:fs";
```

Then, in `main()`, replace the single `console.log(JSON.stringify(...))` block with a version that builds the object once, writes it, and prints it:

```ts
  const result = {
    nodeUrl: NODE_URL,
    tUSDC: tokenA.contract.address.toString(),
    tETH: tokenB.contract.address.toString(),
    orderbook: deployedOB.contract.address.toString(),
    admin: admin.toString(),
  };

  writeFileSync("quetzal.config.json", JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
```

(Keep the existing variable names — `tokenA`, `tokenB`, `deployedOB`, `admin`, `NODE_URL` — exactly as they already appear in the file. The only behavioural change is adding the `quetzal.config.json` write and including `nodeUrl` in the object.)

- [ ] **Step 2: `.gitignore` — ignore the generated config**

Add to `.gitignore`, under a fitting section:

```
# CLI runtime config (environment-specific contract addresses, written by deploy-tokens.ts)
quetzal.config.json
```

- [ ] **Step 3: Create `tests/integration/cli.test.ts`**

The smoke test deploys its own Token×2 + Orderbook, mints tUSDC to account 0, writes a dedicated `quetzal.config.cli-test.json`, then drives the CLI as a child process: `order` → `orders` (asserts the order is listed) → `cancel` → `orders` (asserts empty).

```ts
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync, rmSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { AztecAddress } from "@aztec/aztec.js/addresses";
import type { AztecNode } from "@aztec/aztec.js/node";
import type { EmbeddedWallet } from "@aztec/wallets/embedded";

import { connectToSandbox } from "./helpers/sandbox.js";
import { getTestWallets } from "./helpers/wallets.js";
import { TokenContract } from "./generated/Token.js";
import { OrderbookContract } from "./generated/Orderbook.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../..");
const CLI_ENTRY = resolve(REPO_ROOT, "cli/src/index.ts");
const CONFIG_PATH = resolve(REPO_ROOT, "quetzal.config.cli-test.json");

const ONE_TUSDC = 10n ** 6n;
const MINT = 1_000n * ONE_TUSDC;
const ORDER_AMOUNT = 100n * ONE_TUSDC;
const PRICE_2 = 2_000_000_000_000_000_000n;

/** Run the CLI as a child process from the repo root; return its stdout. */
function zswap(...args: string[]): string {
  return execFileSync(
    process.execPath,
    ["--import", "tsx", CLI_ENTRY, "--config", CONFIG_PATH, ...args],
    { cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
}

describe("cli smoke (live integration)", () => {
  let node: AztecNode;
  let wallet: EmbeddedWallet;
  let admin: AztecAddress;
  let tUSDC: TokenContract;
  let tETH: TokenContract;
  let orderbook: OrderbookContract;

  before(async () => {
    node = await connectToSandbox();
    const env = await getTestWallets(node, 1);
    wallet = env.wallet;
    admin = env.accounts[0]!;

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
      wallet, tUSDC.address, tETH.address, admin,
    ).send({ from: admin });
    orderbook = dOB.contract;

    await tUSDC.methods.mint_to_private(admin, MINT).send({ from: admin });

    writeFileSync(
      CONFIG_PATH,
      JSON.stringify(
        {
          nodeUrl: process.env.PXE_URL ?? process.env.AZTEC_NODE_URL ?? "http://localhost:8080",
          tUSDC: tUSDC.address.toString(),
          tETH: tETH.address.toString(),
          orderbook: orderbook.address.toString(),
          admin: admin.toString(),
        },
        null,
        2,
      ),
    );
  });

  after(async () => {
    rmSync(CONFIG_PATH, { force: true });
    const stop = (wallet as unknown as { stop?: () => Promise<void> }).stop;
    if (typeof stop === "function") await stop.call(wallet);
  });

  it("order -> orders -> cancel -> orders round-trip", { timeout: 600_000 }, () => {
    const orderOut = zswap(
      "order", "--side", "buy", "--amount", ORDER_AMOUNT.toString(), "--limit", PRICE_2.toString(),
    );
    const nonceMatch = orderOut.match(/order nonce:\s*(0x[0-9a-fA-F]+)/);
    assert.ok(nonceMatch, `\`quetzal order\` should print an order nonce; got:\n${orderOut}`);
    const nonce = nonceMatch![1]!;

    const listed = zswap("orders");
    assert.match(listed, new RegExp(nonce, "i"), "the new order must appear in `quetzal orders`");

    const cancelOut = zswap("cancel", "--nonce", nonce);
    assert.match(cancelOut, /cancelled/i, "`quetzal cancel` should confirm cancellation");

    const afterCancel = zswap("orders");
    assert.match(afterCancel, /no resting orders/i, "the order list must be empty after cancel");
  });
});
```

- [ ] **Step 4: Run the full integration suite**

Start `bash scripts/dev.sh` in another terminal; wait until ready.

Run: `pnpm test`
Expected: `pass 12` — 4 orderbook + 2 token + 5 cancel + 1 CLI smoke. `fail 0`.

Stop the dev stack: `bash scripts/dev.sh --down`.

- [ ] **Step 5: Commit**

```bash
git add scripts/deploy-tokens.ts .gitignore tests/integration/cli.test.ts
git commit -m "feat(cli): deploy-tokens writes quetzal.config.json + CLI smoke test"
```

---

## Task 7: Final clean rebuild + Week 3 milestone

**Dispatch with model: sonnet.**

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Clean rebuild from scratch**

```bash
rm -rf node_modules contracts/*/target tests/integration/generated tests/node_modules cli/node_modules codegenCache.json quetzal.config.json
pnpm install
pnpm compile
pnpm codegen
pnpm test:noir
```

Expected:
- compile: `All contracts compiled.`
- codegen: `Token.ts` and `Orderbook.ts` generated.
- noir tests: `4 tests passed` (token) + `8 tests passed` (orderbook).

- [ ] **Step 2: Integration smoke**

Start `bash scripts/dev.sh` in another terminal; wait until ready.

```bash
pnpm test
pnpm tsx scripts/deploy-tokens.ts
```

Expected:
- `pnpm test`: `pass 12`, `fail 0`.
- `deploy-tokens.ts`: prints JSON with `tUSDC`/`tETH`/`orderbook`/`admin`/`nodeUrl`, and `quetzal.config.json` now exists (`ls quetzal.config.json`).

Stop the dev stack: `bash scripts/dev.sh --down`.

- [ ] **Step 3: Update README**

In `README.md`, replace the `**Status:**` line with:

```
**Status:** Week 3 complete. `OrderbookContract` supports `submit_order` and `cancel_order` (escrow returned to the maker's private balance); a `quetzal` CLI submits, lists, and cancels orders. 12 integration tests + 8 TXE tests green. Week 4 adds epoch transitions and the `ClearingContract`.
```

In the `## Quickstart` section, add a CLI block after the `pnpm test` block:

```
# Use the CLI (after deploy-tokens.ts has written quetzal.config.json)
pnpm tsx scripts/deploy-tokens.ts
pnpm --filter @quetzal/cli quetzal order --side buy --amount 100000000 --limit 2000000000000000000
pnpm --filter @quetzal/cli quetzal orders
pnpm --filter @quetzal/cli quetzal cancel --nonce <order-nonce-from-above>
```

In the `## Documentation` section, add:

```
- [Week 3 cancel + CLI Design](docs/superpowers/specs/2026-05-17-zswap-aztec-week-03-cancel-cli-design.md)
- [Week 3 Implementation Plan](docs/superpowers/plans/2026-05-17-zswap-aztec-week-03-cancel-cli.md)
```

- [ ] **Step 4: Milestone commit and tag**

```bash
git add README.md
git commit -m "docs: mark Week 3 (cancel_order + CLI) complete"
git tag week-03-cancel-cli
git tag -l | grep week-03
```

Expected: `week-03-cancel-cli`.

---

## Definition of Done for Week 3

- `cancel_order` and `get_orders` compile; `pnpm compile` and `pnpm codegen` succeed for both contracts.
- All Week 2 tests still pass; 2 new cancel TXE tests, 5 new cancel integration tests, and the CLI smoke test pass (`8` TXE orderbook tests, `12` integration tests total).
- `quetzal order` / `quetzal orders` / `quetzal cancel` work end-to-end against the dev stack after `deploy-tokens.ts` writes `quetzal.config.json`.
- A submitted order can be cancelled and the maker's **private** balance is fully restored — verified on-chain by `readPrivateBalance`.
- `git tag` shows `week-03-cancel-cli`.

## Hand-off to Week 4

Week 4 introduces the `ClearingContract` and the `EpochState OPEN → CLOSING → SETTLED` transitions (`_advance_epoch` gated to `clearing_addr`). `cancel_order`'s OPEN-state gate (already wired via `_assert_epoch_open`) becomes load-bearing then.

## Risk Notes

- **PrivateSet note-retrieval API (Task 1).** The exact `pop_notes` / `NoteGetterOptions` / `OrderNote::properties()` / `Comparator` spelling for aztec-nr v4.2.0 must be confirmed against source — Task 1 Step 1 is a mandatory discovery step. Behaviour is fixed; API spelling is not.
- **`get_orders` return shape (Tasks 3 & 5).** A Noir `BoundedVec<OrderNote, 8>` codegens to a TypeScript shape that must be read off the generated `Orderbook.ts`; the `extractNonces` / `normalise` helpers carry a documented "adapt to actual shape" note.
- **Cross-package import of generated bindings.** `cli/src/commands/*` import `../../../tests/integration/generated/Orderbook.js` — the same cross-package relative-path pattern `scripts/deploy-tokens.ts` already uses. `tsx` resolves it; `tsc --noEmit` will catch a wrong path.
