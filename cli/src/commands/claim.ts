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
