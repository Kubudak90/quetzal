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
import {
  computeClearing,
  clearingAt,
  selectBatch,
  type ClearingOrder,
  type ClearingResult,
} from "../../aggregator/src/clearing.js";

const ONE_USDC = 10n ** 6n;
const ONE_ETH = 10n ** 18n;
// The epoch must stay OPEN through the rest of `before()` (token mints + the LP
// deposit each mine a block) and the two `submit_order` calls in the test body,
// then the test deliberately mines past expiry before `close_epoch_and_clear`.
// 20 blocks is comfortable headroom.
const EPOCH_LEN = 20;
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

/** Pool reserves as the contract exposes them (snake_case). */
interface PoolStateRaw {
  reserve_a: bigint | number;
  reserve_b: bigint | number;
  lp_supply: bigint | number;
  cum_fee_a_per_share: bigint | number;
  cum_fee_b_per_share: bigint | number;
}

/**
 * Translate the aggregator's `ClearingResult` into the contract's `ClearingSwap`
 * (the ten u128 fields `apply_clearing` consumes), following design-spec sec 5.1.
 *
 * The aggregator's `ClearingResult` does not directly carry the AMM's gross token
 * flows, so we re-derive them: `clearingAt(pool, selectBatch(orders), P*)` returns
 * a `PriceEval` whose `.swap` is the `NetSwap` for the net imbalance. Its
 * `ammAIn` / `ammBIn` / `ammAOut` / `ammBOut` are exactly the physical token
 * moves (`*_to_pool` / `*_from_pool`). The reserve-accounting deltas are
 * `newReserve - oldReserve`, split into an `add` or a `sub` by sign (the fee is
 * withheld from reserves, so the `add` side is the after-fee input, smaller than
 * `*_to_pool`). The fee-per-share increments come straight off the result.
 */
function buildClearingSwap(
  poolState: PoolStateRaw,
  orders: ClearingOrder[],
  result: ClearingResult,
) {
  const oldReserveA = BigInt(poolState.reserve_a);
  const oldReserveB = BigInt(poolState.reserve_b);

  const ev = clearingAt(
    {
      reserveA: oldReserveA,
      reserveB: oldReserveB,
      lpSupply: BigInt(poolState.lp_supply),
    },
    selectBatch(orders),
    result.clearingPrice,
  );
  const { swap } = ev;

  const deltaA = result.newReserveA - oldReserveA;
  const deltaB = result.newReserveB - oldReserveB;

  return {
    a_to_pool: swap.ammAIn,
    b_to_pool: swap.ammBIn,
    a_from_pool: swap.ammAOut,
    b_from_pool: swap.ammBOut,
    reserve_a_add: deltaA > 0n ? deltaA : 0n,
    reserve_a_sub: deltaA < 0n ? -deltaA : 0n,
    reserve_b_add: deltaB > 0n ? deltaB : 0n,
    reserve_b_sub: deltaB < 0n ? -deltaB : 0n,
    fee_a_per_share_increment: result.feeAPerShareIncrement,
    fee_b_per_share_increment: result.feeBPerShareIncrement,
  };
}

async function readPrivateBalance(
  token: TokenContract,
  owner: AztecAddress,
): Promise<bigint> {
  const sim = await token.methods.balance_of_private(owner).simulate({ from: owner });
  return BigInt(sim.result as bigint | number);
}

describe("clearing (live integration)", () => {
  let node: AztecNode;
  let wallet: EmbeddedWallet;
  let admin: AztecAddress;     // minter, clearing authority, and the liquidity provider
  let alice: AztecAddress;     // a buyer
  let bob: AztecAddress;       // a seller
  let lp: AztecAddress;        // the liquidity provider (== admin: the local-network
                               // seeds only 3 test accounts, so admin doubles as LP)
  let tUSDC: TokenContract;
  let tETH: TokenContract;
  let pool: LiquidityPoolContract;
  let orderbook: OrderbookContract;

  before(async () => {
    node = await connectToSandbox();
    const env = await getTestWallets(node, 3);
    wallet = env.wallet;
    admin = env.accounts[0]!;
    alice = env.accounts[1]!;
    bob = env.accounts[2]!;
    lp = admin;

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

    // LP deposits a balanced 100k tUSDC : 100k tETH pool. The book is 1:1-priced,
    // so we deposit equal *scaled* sides: spot = reserveA*1e18/reserveB = 1.0.
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
    // A buy-heavy book so the net imbalance genuinely routes through the AMM:
    // alice buys 2000 tUSDC @ limit 2.0, bob sells 500 (1e6-unit, 1:1 book) @ limit 0.5.
    // They cross around spot 1.0; netA > 0 -> token A swaps into the pool.
    const aliceIn = 2_000n * ONE_USDC;
    const bobIn = 500n * ONE_USDC; // bob's tETH amount, same 1e6 unit scale for a 1:1 book
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

    // Translate the ClearingResult into the contract arguments.
    const fills = result.fills.map((f) => ({ order_nonce: f.orderNonce, amount_out: f.amountOut }));
    const swap = buildClearingSwap(poolState, orders, result);

    // Mine past epoch expiry, then the authority clears.
    const epoch = (await orderbook.methods.get_epoch().simulate({ from: admin })).result;
    while ((await currentBlock(node)) < Number(epoch.closes_at_block)) {
      await tUSDC.methods.mint_to_public(admin, 1n).send({ from: admin });
    }
    await orderbook.methods.close_epoch_and_clear(fills, swap).send({ from: admin });

    // The pool reserves moved exactly as the aggregator computed.
    const after = (await pool.methods.get_pool_state().simulate({ from: admin })).result;
    assert.equal(BigInt(after.reserve_a), result.newReserveA, "pool reserve A matches the clearing");
    assert.equal(BigInt(after.reserve_b), result.newReserveB, "pool reserve B matches the clearing");

    // Each filled maker claims. Alice (a buy) receives tETH; Bob (a sell) tUSDC.
    const aliceFill = BigInt((await orderbook.methods.get_fill(aliceNonce).simulate({ from: alice })).result);
    const bobFill = BigInt((await orderbook.methods.get_fill(bobNonce).simulate({ from: bob })).result);
    assert.ok(aliceFill > 0n && bobFill > 0n, "both orders recorded as filled");

    const aliceEthBefore = await readPrivateBalance(tETH, alice);
    await orderbook.methods.claim_fill(aliceNonce, aliceFill).send({ from: alice });
    const aliceEthAfter = await readPrivateBalance(tETH, alice);
    assert.equal(aliceEthAfter - aliceEthBefore, aliceFill, "alice received her token B fill");

    const bobUsdcBefore = await readPrivateBalance(tUSDC, bob);
    await orderbook.methods.claim_fill(bobNonce, bobFill).send({ from: bob });
    const bobUsdcAfter = await readPrivateBalance(tUSDC, bob);
    assert.equal(bobUsdcAfter - bobUsdcBefore, bobFill, "bob received his token A fill");

    // The claimed orders are gone; a re-claim fails.
    await assert.rejects(
      orderbook.methods.claim_fill(aliceNonce, aliceFill).send({ from: alice }),
      /order not found/i,
      "a claimed order cannot be claimed again",
    );
  });
});
