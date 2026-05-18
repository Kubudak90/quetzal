import type { Command } from "commander";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { LiquidityPoolContract } from "../../../tests/integration/generated/LiquidityPool.js";
import { loadConfig } from "../config.js";
import { openCli } from "../wallet.js";
import { parseField } from "../field.js";
import { readPoolHint } from "../pool-hint.js";

export function registerWithdraw(program: Command): void {
  program
    .command("withdraw")
    .description("burn an LP position and reclaim its liquidity")
    .requiredOption("--nonce <field>", "position nonce (from `zswap deposit` / `zswap positions`)")
    .action(async (_opts, cmd: Command) => {
      const opts = cmd.optsWithGlobals();
      const positionNonce = parseField(String(opts.nonce));

      const config = loadConfig(opts.config);
      const ctx = await openCli(config, Number(opts.account));
      try {
        const pool = await LiquidityPoolContract.at(
          AztecAddress.fromString(config.pool),
          ctx.wallet,
        );
        const hint = await readPoolHint(pool, ctx.account);

        await pool.methods.withdraw(positionNonce, hint).send({ from: ctx.account });
        console.log(`position 0x${positionNonce.toString(16)} withdrawn; liquidity returned`);
      } finally {
        await ctx.stop();
      }
    });
}
