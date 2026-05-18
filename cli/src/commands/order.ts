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
        console.log(`cancel later with: zswap cancel --nonce 0x${orderNonce.toString(16)}`);
      } finally {
        await ctx.stop();
      }
    });
}
