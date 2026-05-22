import type { Command } from "commander";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { LiquidityPoolContract } from "../../../tests/integration/generated/LiquidityPool.js";
import { loadConfig } from "../config.js";
import { openCli } from "../wallet.js";
import { readPoolHint, readBucketHint } from "../pool-hint.js";

interface PositionRow {
  bucket_id: number;
  nonce: bigint;
  lp_share: bigint;
  cum_fee_a_per_share_at_deposit: bigint;
  cum_fee_b_per_share_at_deposit: bigint;
}

function normalise(result: unknown): PositionRow[] {
  const bv = result as { storage: unknown[]; len: bigint | number };
  const len = Number(bv.len);
  return bv.storage.slice(0, len).map((o) => {
    const r = o as Record<string, bigint | number>;
    return {
      bucket_id: Number(r.bucket_id),
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
    .description("list the account's LP positions (Sub-2: includes bucket info)")
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

        const poolHint = await readPoolHint(pool, ctx.account);

        console.log(`LP positions for account ${opts.account}:`);
        for (const r of rows) {
          const bucket = await readBucketHint(pool, r.bucket_id, ctx.account);
          // Compute bucket bounds from stored p_min + growth.
          const pMin = await pool.methods.get_p_min_sqrt().simulate({ from: ctx.account });
          const growth = await pool.methods.get_bucket_growth_num().simulate({ from: ctx.account });
          const pMinV = (pMin as { result: bigint }).result;
          const growthV = (growth as { result: bigint }).result;
          const SCALE = 1_000_000_000_000_000_000n;
          let sqrtLower = pMinV;
          for (let i = 0; i < r.bucket_id; i++) sqrtLower = (sqrtLower * growthV) / SCALE;
          const sqrtUpper = (sqrtLower * growthV) / SCALE;
          const inRange = poolHint.current_sqrt_price >= sqrtLower
                       && poolHint.current_sqrt_price < sqrtUpper;
          const status = bucket.liquidity === 0n ? "(empty bucket)"
                       : inRange ? "(in-range)" : "(out-of-range)";
          console.log(
            `  bucket=${r.bucket_id} ${status}  nonce=0x${r.nonce.toString(16)}  ` +
              `lp_share=${r.lp_share}  fee_snapshot=(${r.cum_fee_a_per_share_at_deposit}, ${r.cum_fee_b_per_share_at_deposit})`,
          );
        }
      } finally {
        await ctx.stop();
      }
    });
}
