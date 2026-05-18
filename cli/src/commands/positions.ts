import type { Command } from "commander";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { LiquidityPoolContract } from "../../../tests/integration/generated/LiquidityPool.js";
import { loadConfig } from "../config.js";
import { openCli } from "../wallet.js";

interface PositionRow {
  nonce: bigint;
  lp_share: bigint;
  cum_fee_a_per_share_at_deposit: bigint;
  cum_fee_b_per_share_at_deposit: bigint;
}

// `get_positions` returns a Noir BoundedVec<PositionNote, 10> -> { storage, len }.
function normalise(result: unknown): PositionRow[] {
  const bv = result as { storage: unknown[]; len: bigint | number };
  const len = Number(bv.len);
  return bv.storage.slice(0, len).map((o) => {
    const r = o as Record<string, bigint | number>;
    return {
      nonce: BigInt(r.nonce),
      lp_share: BigInt(r.lp_share),
      cum_fee_a_per_share_at_deposit: BigInt(r.cum_fee_a_per_share_at_deposit),
      cum_fee_b_per_share_at_deposit: BigInt(r.cum_fee_b_per_share_at_deposit),
    };
  });
}

export function registerPositions(program: Command): void {
  program
    .command("positions")
    .description("list the account's LP positions")
    .action(async (_opts, cmd: Command) => {
      const opts = cmd.optsWithGlobals();
      const config = loadConfig(opts.config);
      const ctx = await openCli(config, Number(opts.account));
      try {
        const pool = await LiquidityPoolContract.at(
          AztecAddress.fromString(config.pool),
          ctx.wallet,
        );
        const sim = await pool.methods.get_positions(ctx.account).simulate({ from: ctx.account });
        const rows = normalise((sim as { result: unknown }).result);

        if (rows.length === 0) {
          console.log("no LP positions");
          return;
        }
        console.log(`LP positions for account ${opts.account}:`);
        for (const r of rows) {
          console.log(`  nonce=0x${r.nonce.toString(16)}  lp_share=${r.lp_share}`);
        }
      } finally {
        await ctx.stop();
      }
    });
}
