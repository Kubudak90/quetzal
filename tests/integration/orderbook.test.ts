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

    // Deploy the orderbook bound to (tUSDC, tETH). clearing_addr is just a placeholder
    // for now - we use admin's address so it is a valid AztecAddress; nothing reads it
    // in the submit_order path.
    const deployedOB = await OrderbookContract.deploy(
      wallet,
      tUSDC.address,
      tETH.address,
      admin,
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
