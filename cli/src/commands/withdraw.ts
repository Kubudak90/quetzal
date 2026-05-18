import type { Command } from "commander";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { LiquidityPoolContract } from "../../../tests/integration/generated/LiquidityPool.js";
import { loadConfig } from "../config.js";
import { openCli } from "../wallet.js";
import { parseField } from "../field.js";

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
        const sim = await pool.methods.get_pool_state().simulate({ from: ctx.account });
        const hint = (sim as { result: { reserve_a: bigint; reserve_b: bigint; lp_supply: bigint; cum_fee_a_per_share: bigint; cum_fee_b_per_share: bigint } }).result;

        await pool.methods.withdraw(positionNonce, hint).send({ from: ctx.account });
        console.log(`position 0x${positionNonce.toString(16)} withdrawn; liquidity returned`);
      } finally {
        await ctx.stop();
      }
    });
}
