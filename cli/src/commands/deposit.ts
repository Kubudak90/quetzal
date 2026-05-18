import type { Command } from "commander";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { LiquidityPoolContract } from "../../../tests/integration/generated/LiquidityPool.js";
import { loadConfig } from "../config.js";
import { openCli } from "../wallet.js";
import { randomField } from "../field.js";

export function registerDeposit(program: Command): void {
  program
    .command("deposit")
    .description("supply liquidity to the pool")
    .requiredOption("--amount-a <n>", "max token A to supply (smallest unit)")
    .requiredOption("--amount-b <n>", "max token B to supply (smallest unit)")
    .action(async (_opts, cmd: Command) => {
      const opts = cmd.optsWithGlobals();
      const amountA = BigInt(opts.amountA);
      const amountB = BigInt(opts.amountB);

      const config = loadConfig(opts.config);
      const ctx = await openCli(config, Number(opts.account));
      try {
        const pool = await LiquidityPoolContract.at(
          AztecAddress.fromString(config.pool),
          ctx.wallet,
        );
        const sim = await pool.methods.get_pool_state().simulate({ from: ctx.account });
        const hint = (sim as { result: { reserve_a: bigint; reserve_b: bigint; lp_supply: bigint; cum_fee_a_per_share: bigint; cum_fee_b_per_share: bigint } }).result;

        const positionNonce = randomField();
        await pool.methods
          .deposit(amountA, amountB, hint, randomField(), randomField(), positionNonce)
          .send({ from: ctx.account });

        console.log(`liquidity deposited (max A ${amountA}, max B ${amountB})`);
        console.log(`position nonce: 0x${positionNonce.toString(16)}`);
        console.log(`withdraw later with: zswap withdraw --nonce 0x${positionNonce.toString(16)}`);
      } finally {
        await ctx.stop();
      }
    });
}
