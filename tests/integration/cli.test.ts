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
import { LiquidityPoolContract } from "./generated/LiquidityPool.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../..");
const CLI_ENTRY = resolve(REPO_ROOT, "cli/src/index.ts");
const CONFIG_PATH = resolve(REPO_ROOT, "zswap.config.cli-test.json");

const ONE_TUSDC = 10n ** 6n;
const ONE_TETH = 10n ** 18n;
const MINT = 1_000n * ONE_TUSDC;
const MINT_ETH = 10n * ONE_TETH; // 10 tETH — covers the 1 tETH deposit smoke test
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
  let pool: LiquidityPoolContract;

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

    const dP = await LiquidityPoolContract.deploy(
      wallet, tUSDC.address, tETH.address,
    ).send({ from: admin });
    pool = dP.contract;

    const dOB = await OrderbookContract.deploy(
      wallet, tUSDC.address, tETH.address, 8, pool.address, admin,
    ).send({ from: admin });
    orderbook = dOB.contract;

    await tUSDC.methods.mint_to_private(admin, MINT).send({ from: admin });
    await tETH.methods.mint_to_private(admin, MINT_ETH).send({ from: admin });

    writeFileSync(
      CONFIG_PATH,
      JSON.stringify(
        {
          nodeUrl: process.env.PXE_URL ?? process.env.AZTEC_NODE_URL ?? "http://localhost:8080",
          tUSDC: tUSDC.address.toString(),
          tETH: tETH.address.toString(),
          orderbook: orderbook.address.toString(),
          pool: pool.address.toString(),
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

  // Advance the L2 chain to `target` by sending cheap mint txs (each mines >=1 block).
  async function mineUntilBlock(target: number): Promise<void> {
    let guard = 0;
    while (Number(await node.getBlockNumber()) < target) {
      if (++guard > 50) throw new Error("mineUntilBlock: exceeded 50 txs");
      await tUSDC.methods.mint_to_public(admin, 1n).send({ from: admin });
    }
  }

  it("order -> orders -> cancel -> orders round-trip", { timeout: 600_000 }, () => {
    const orderOut = zswap(
      "order", "--side", "buy", "--amount", ORDER_AMOUNT.toString(), "--limit", PRICE_2.toString(),
    );
    const nonceMatch = orderOut.match(/order nonce:\s*(0x[0-9a-fA-F]+)/);
    assert.ok(nonceMatch, `\`zswap order\` should print an order nonce; got:\n${orderOut}`);
    const nonce = nonceMatch![1]!;

    const listed = zswap("orders");
    assert.match(listed, new RegExp(nonce, "i"), "the new order must appear in `zswap orders`");

    const cancelOut = zswap("cancel", "--nonce", nonce);
    assert.match(cancelOut, /cancelled/i, "`zswap cancel` should confirm cancellation");

    const afterCancel = zswap("orders");
    assert.match(afterCancel, /no resting orders/i, "the order list must be empty after cancel");
  });

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

  it("deposit -> positions -> withdraw round-trip", { timeout: 600_000 }, async () => {
    const depositOut = zswap(
      "deposit", "--amount-a", (1000n * 10n ** 6n).toString(), "--amount-b", (10n ** 18n).toString(),
    );
    const nonceMatch = depositOut.match(/position nonce:\s*(0x[0-9a-fA-F]+)/);
    assert.ok(nonceMatch, `\`zswap deposit\` should print a position nonce; got:\n${depositOut}`);
    const nonce = nonceMatch![1]!;

    const listed = zswap("positions");
    assert.match(listed, new RegExp(nonce, "i"), "the new position must appear in `zswap positions`");

    const withdrawOut = zswap("withdraw", "--nonce", nonce);
    assert.match(withdrawOut, /withdrawn/i, "`zswap withdraw` should confirm the withdrawal");

    const afterList = zswap("positions");
    assert.match(afterList, /no LP positions/i, "positions must be empty after withdraw");
  });
});
