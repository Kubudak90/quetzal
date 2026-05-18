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
