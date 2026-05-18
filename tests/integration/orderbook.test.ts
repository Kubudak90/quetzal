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

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// `side` semantics inside the Orderbook contract:
//   false (bid) => deposit token A (tUSDC) - we call this "A->B"
//   true  (ask) => deposit token B (tETH)  - we call this "B->A"
const SIDE_A_TO_B = false;
const SIDE_B_TO_A = true;

// Q-format quote-per-base price scaled to 1e18. We use 2.0 throughout (the value is
// not checked for sanity by submit_order beyond being > 0, so any positive value works).
const PRICE_2 = 2_000_000_000_000_000_000n;

const TUSDC_NAME = "tUSDC".padEnd(31, "\0");
const TUSDC_SYMBOL = "tUSDC".padEnd(31, "\0");
const TUSDC_DECIMALS = 6;
const ONE_TUSDC = 10n ** BigInt(TUSDC_DECIMALS);

const TETH_NAME = "tETH".padEnd(31, "\0");
const TETH_SYMBOL = "tETH".padEnd(31, "\0");
const TETH_DECIMALS = 18;
const ONE_TETH = 10n ** BigInt(TETH_DECIMALS);

// Initial mints to alice. tUSDC is the only token alice will spend across the suite,
// so we keep a tight budget on her to make the "insufficient balance" test meaningful.
const MINT_ALICE_TUSDC = 1_000n * ONE_TUSDC;  // 1,000 tUSDC == 1_000_000_000
const MINT_ALICE_TETH  = 5n * ONE_TETH;       // 5 tETH    == 5_000_000_000_000_000_000

// Order amounts.
const ORDER1_USDC = 100n * ONE_TUSDC;         // 100 tUSDC
const ORDER2_ETH  = 2n * ONE_TETH;            // 2 tETH
const ORDER3_USDC_HUGE = 5_000n * ONE_TUSDC;  // 5,000 tUSDC (exceeds remaining balance)
const ORDER4A_USDC = 50n * ONE_TUSDC;         // 50 tUSDC
const ORDER4B_USDC = 75n * ONE_TUSDC;         // 75 tUSDC

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function randomField(): bigint {
  // 31 random bytes fit safely under BN254 field modulus.
  const buf = new Uint8Array(31);
  webcrypto.getRandomValues(buf);
  let n = 0n;
  for (const byte of buf) n = (n << 8n) | BigInt(byte);
  return n;
}

// `get_orders` returns a Noir BoundedVec<OrderNote, 10>. The ABI decoder
// deserialises it as { storage: OrderNote[10], len: bigint }.  Pass
// `sim.result` (the unwrapped simulation return value) directly here.
function extractNonces(boundedVec: unknown): bigint[] {
  const bv = boundedVec as { storage: { nonce: bigint | number }[]; len: bigint | number };
  const len = Number(bv.len);
  return bv.storage.slice(0, len).map((o) => BigInt(o.nonce));
}

async function readPrivateBalance(
  token: TokenContract,
  owner: AztecAddress,
): Promise<bigint> {
  const sim = await token.methods.balance_of_private(owner).simulate({ from: owner });
  return BigInt(sim.result as bigint | number);
}

async function readPublicBalance(
  token: TokenContract,
  owner: AztecAddress,
  from: AztecAddress,
): Promise<bigint> {
  // public `#[view]` reads do not require the caller to own private state, but the
  // simulate path still needs a `from`. Reuse the test's admin/alice to drive it.
  const sim = await token.methods.balance_of_public(owner).simulate({ from });
  return BigInt(sim.result as bigint | number);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("orderbook (live integration)", () => {
  let node: AztecNode;
  let wallet: EmbeddedWallet;
  let admin: AztecAddress;
  let alice: AztecAddress;
  let tUSDC: TokenContract;
  let tETH: TokenContract;
  let orderbook: OrderbookContract;

  before(async () => {
    node = await connectToSandbox();
    const env = await getTestWallets(node, 2);
    wallet = env.wallet;
    admin = env.accounts[0]!;
    alice = env.accounts[1]!;

    // Deploy two unified Token contracts. Admin is the minter so the suite can seed alice.
    const deployedUSDC = await TokenContract.deployWithOpts(
      { wallet, method: "constructor_with_minter" },
      TUSDC_NAME,
      TUSDC_SYMBOL,
      TUSDC_DECIMALS,
      admin,
    ).send({ from: admin });
    tUSDC = deployedUSDC.contract;

    const deployedETH = await TokenContract.deployWithOpts(
      { wallet, method: "constructor_with_minter" },
      TETH_NAME,
      TETH_SYMBOL,
      TETH_DECIMALS,
      admin,
    ).send({ from: admin });
    tETH = deployedETH.contract;

    // Deploy the orderbook bound to (tUSDC, tETH).
    const deployedOB = await OrderbookContract.deploy(
      wallet,
      tUSDC.address,
      tETH.address,
      100,
    ).send({ from: admin });
    orderbook = deployedOB.contract;

    // Seed alice with both tokens, privately.
    await tUSDC.methods.mint_to_private(alice, MINT_ALICE_TUSDC).send({ from: admin });
    await tETH.methods.mint_to_private(alice, MINT_ALICE_TETH).send({ from: admin });
  });

  after(async () => {
    // EmbeddedWallet may or may not expose .stop(); guard so we don't crash the suite teardown.
    const stop = (wallet as unknown as { stop?: () => Promise<void> }).stop;
    if (typeof stop === "function") {
      await stop.call(wallet);
    }
  });

  it("submit_order(A->B): 100 tUSDC moves from alice private to orderbook public balance", { timeout: 600_000 }, async () => {
    const beforeAlice = await readPrivateBalance(tUSDC, alice);
    const beforeOrderbook = await readPublicBalance(tUSDC, orderbook.address, admin);

    await orderbook.methods
      .submit_order(SIDE_A_TO_B, ORDER1_USDC, PRICE_2, randomField(), randomField())
      .send({ from: alice });

    const afterAlice = await readPrivateBalance(tUSDC, alice);
    const afterOrderbook = await readPublicBalance(tUSDC, orderbook.address, admin);

    assert.equal(beforeAlice - afterAlice, ORDER1_USDC, "alice private down by 100 tUSDC");
    assert.equal(afterOrderbook - beforeOrderbook, ORDER1_USDC, "orderbook public up by 100 tUSDC");
  });

  it("submit_order(B->A): escrows tETH, not tUSDC", { timeout: 600_000 }, async () => {
    const beforeETH = await readPrivateBalance(tETH, alice);
    const beforeUSDC = await readPrivateBalance(tUSDC, alice);
    const beforeOrderbookETH = await readPublicBalance(tETH, orderbook.address, admin);
    const beforeOrderbookUSDC = await readPublicBalance(tUSDC, orderbook.address, admin);

    await orderbook.methods
      .submit_order(SIDE_B_TO_A, ORDER2_ETH, PRICE_2, randomField(), randomField())
      .send({ from: alice });

    const afterETH = await readPrivateBalance(tETH, alice);
    const afterUSDC = await readPrivateBalance(tUSDC, alice);
    const afterOrderbookETH = await readPublicBalance(tETH, orderbook.address, admin);
    const afterOrderbookUSDC = await readPublicBalance(tUSDC, orderbook.address, admin);

    assert.equal(beforeETH - afterETH, ORDER2_ETH, "alice tETH down by 2");
    assert.equal(afterOrderbookETH - beforeOrderbookETH, ORDER2_ETH, "orderbook tETH up by 2");
    assert.equal(afterUSDC, beforeUSDC, "alice tUSDC untouched");
    assert.equal(afterOrderbookUSDC, beforeOrderbookUSDC, "orderbook tUSDC untouched");
  });

  it("submit_order rejects when amount exceeds private balance", { timeout: 600_000 }, async () => {
    // After the first test alice has 1000 - 100 = 900 tUSDC. Submitting 5000 must revert.
    const before = await readPrivateBalance(tUSDC, alice);
    assert.ok(before < ORDER3_USDC_HUGE, "precondition: alice cannot cover the huge order");

    await assert.rejects(
      orderbook.methods
        .submit_order(SIDE_A_TO_B, ORDER3_USDC_HUGE, PRICE_2, randomField(), randomField())
        .send({ from: alice }),
      /balance|notes|insufficient|too low/i,
      "submit_order should revert when private balance is insufficient",
    );

    const after = await readPrivateBalance(tUSDC, alice);
    assert.equal(after, before, "alice balance unchanged after revert");
  });

  it("two orders from same user accumulate orderbook balance", { timeout: 600_000 }, async () => {
    const beforeOrderbook = await readPublicBalance(tUSDC, orderbook.address, admin);
    const beforeAlice = await readPrivateBalance(tUSDC, alice);

    await orderbook.methods
      .submit_order(SIDE_A_TO_B, ORDER4A_USDC, PRICE_2, randomField(), randomField())
      .send({ from: alice });

    await orderbook.methods
      .submit_order(SIDE_A_TO_B, ORDER4B_USDC, PRICE_2, randomField(), randomField())
      .send({ from: alice });

    const afterOrderbook = await readPublicBalance(tUSDC, orderbook.address, admin);
    const afterAlice = await readPrivateBalance(tUSDC, alice);

    assert.equal(
      afterOrderbook - beforeOrderbook,
      ORDER4A_USDC + ORDER4B_USDC,
      "orderbook accumulates both order amounts",
    );
    assert.equal(
      beforeAlice - afterAlice,
      ORDER4A_USDC + ORDER4B_USDC,
      "alice private balance drained by the sum of both orders",
    );
  });
});

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
      wallet, tUSDC.address, tETH.address, 100,
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

    // nonce MUST be 0n: cancel_order calls Token.transfer_public_to_private with
    // from=orderbook.address; because from == msg_sender (self-call), the
    // authorize_once macro requires nonce == 0.
    await orderbook.methods
      .cancel_order(orderNonce, 0n)
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
      .cancel_order(orderNonce, 0n)
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
      .cancel_order(dropNonce, 0n)
      .send({ from: alice });

    assert.equal(
      await readPublicBalance(tUSDC, orderbook.address, admin), ORDER_USDC,
      "exactly one order's escrow remains",
    );

    const sim = await orderbook.methods.get_orders(alice).simulate({ from: alice });
    const nonces = extractNonces(sim.result);
    assert.ok(nonces.includes(keepNonce), "the kept order is still listed");
    assert.ok(!nonces.includes(dropNonce), "the cancelled order is gone");
  });

  it("double cancel of the same order fails", { timeout: 600_000 }, async () => {
    const orderNonce = randomField();
    await orderbook.methods
      .submit_order(SIDE_A_TO_B, ORDER_USDC, PRICE_2, randomField(), orderNonce)
      .send({ from: alice });
    await orderbook.methods
      .cancel_order(orderNonce, 0n)
      .send({ from: alice });

    await assert.rejects(
      orderbook.methods.cancel_order(orderNonce, 0n).send({ from: alice }),
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
      orderbook.methods.cancel_order(orderNonce, 0n).send({ from: bob }),
      /order not found/i,
      "bob cannot cancel alice's order (her PrivateSet yields no match for him)",
    );

    // Clean up so the suite leaves no resting escrow.
    await orderbook.methods.cancel_order(orderNonce, 0n).send({ from: alice });
  });
});
