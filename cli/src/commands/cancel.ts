import type { Command } from "commander";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { OrderbookContract } from "../../../tests/integration/generated/Orderbook.js";
import { loadConfig } from "../config.js";
import { openCli } from "../wallet.js";
import { parseField } from "../field.js";

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
        // The authwit nonce MUST be 0n: cancel_order calls
        // Token.transfer_public_to_private with from = orderbook.address; because
        // from == msg_sender (a self-call), the authorize_once macro requires nonce == 0.
        await orderbook.methods
          .cancel_order(orderNonce, 0n)
          .send({ from: ctx.account });

        console.log(`order 0x${orderNonce.toString(16)} cancelled; escrow returned to your private balance`);
      } finally {
        await ctx.stop();
      }
    });
}
