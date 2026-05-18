import type { Command } from "commander";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { OrderbookContract } from "../../../tests/integration/generated/Orderbook.js";
import { loadConfig } from "../config.js";
import { openCli } from "../wallet.js";

interface OrderRow {
  nonce: bigint;
  side: boolean;
  amount_in: bigint;
  limit_price: bigint;
  submitted_at_block: bigint;
}

// `get_orders` returns a Noir BoundedVec<OrderNote, 10>. The Aztec ABI decoder
// yields it as { storage: OrderNote[], len: bigint }; `.simulate()` wraps the
// return value in { result }.
function normalise(result: unknown): OrderRow[] {
  const bv = result as { storage?: unknown[]; len?: bigint | number };
  const arr = bv.storage ?? [];
  const len = Number(bv.len ?? arr.length);
  return arr.slice(0, len).map((o) => {
    const r = o as Record<string, bigint | number | boolean>;
    return {
      nonce: BigInt(r.nonce as bigint),
      side: Boolean(r.side),
      amount_in: BigInt(r.amount_in as bigint),
      limit_price: BigInt(r.limit_price as bigint),
      submitted_at_block: BigInt(r.submitted_at_block as bigint),
    };
  });
}

export function registerOrders(program: Command): void {
  program
    .command("orders")
    .description("list the account's resting orders")
    .action(async (_opts, cmd: Command) => {
      const opts = cmd.optsWithGlobals();
      const config = loadConfig(opts.config);
      const ctx = await openCli(config, Number(opts.account));
      try {
        const orderbook = await OrderbookContract.at(
          AztecAddress.fromString(config.orderbook),
          ctx.wallet,
        );
        const sim = await orderbook.methods
          .get_orders(ctx.account)
          .simulate({ from: ctx.account });
        const rows = normalise((sim as { result?: unknown }).result ?? sim);

        if (rows.length === 0) {
          console.log("no resting orders");
          return;
        }
        console.log(`resting orders for account ${opts.account}:`);
        for (const r of rows) {
          console.log(
            `  nonce=0x${r.nonce.toString(16)}  side=${r.side ? "sell" : "buy"}  ` +
              `amount=${r.amount_in}  limit=${r.limit_price}  block=${r.submitted_at_block}`,
          );
        }
      } finally {
        await ctx.stop();
      }
    });
}
