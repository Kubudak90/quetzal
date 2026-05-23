import type { Command } from "commander";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { Fr } from "@aztec/aztec.js/fields";
import { OrderbookContract } from "../../../tests/integration/generated/Orderbook.js";
import { loadConfig } from "../config.js";
import { openCli } from "../wallet.js";
import { parseField } from "../field.js";
import { listDecoys, loadDecoyRegistry, saveDecoyRegistry } from "../orders/decoy-registry.js";

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

export function registerCancelDecoys(program: Command): void {
  program
    .command("cancel-decoys")
    .description("batch-cancel all decoy orders from the maker-local registry (refunds escrows)")
    .requiredOption("--epoch <n>", "epoch id (informational; cancel_order uses order_nonce only)")
    .action(async (_opts, cmd: Command) => {
      const opts = cmd.optsWithGlobals();
      const config = loadConfig(opts.config);
      const ctx = await openCli(config, Number(opts.account));
      try {
        const decoys = listDecoys(ctx.account.toString());
        if (decoys.length === 0) {
          console.log("No decoys recorded in registry. Nothing to cancel.");
          return;
        }
        console.log(`Cancelling ${decoys.length} decoy orders...`);
        const orderbook = await OrderbookContract.at(
          AztecAddress.fromString(config.orderbook),
          ctx.wallet,
        );
        // Codegen may lag; cast through any.
        // cancel_order(order_nonce: Field, nonce: Field) — nonce MUST be 0n (self-call authorize_once)
        const orderbookDyn = orderbook as unknown as {
          methods: {
            cancel_order: (orderNonce: bigint, nonce: bigint) => {
              send: (args: { from: AztecAddress }) => Promise<unknown>;
            };
          };
        };
        const succeeded: string[] = [];
        for (const nonceHex of decoys) {
          try {
            await orderbookDyn.methods
              .cancel_order(Fr.fromString(nonceHex).toBigInt(), 0n)
              .send({ from: ctx.account });
            console.log(`  cancelled ${nonceHex}`);
            succeeded.push(nonceHex);
          } catch (e) {
            console.error(`  failed ${nonceHex}: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
        // Clean registry of successfully-cancelled nonces
        const reg = loadDecoyRegistry(ctx.account.toString());
        for (const n of succeeded) delete reg[n];
        saveDecoyRegistry(ctx.account.toString(), reg);
        console.log(`Done. Cancelled ${succeeded.length}/${decoys.length}; registry cleaned.`);
      } finally {
        await ctx.stop();
      }
    });
}
