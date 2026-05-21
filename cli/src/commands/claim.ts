import type { Command } from "commander";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { Fr } from "@aztec/aztec.js/fields";
import { OrderbookContract } from "../../../tests/integration/generated/Orderbook.js";
import { loadConfig } from "../config.js";
import { openCli } from "../wallet.js";
import { parseField } from "../field.js";
import { readSnapshot, findEpochForNonce } from "../../../aggregator/src/snapshot.js";

const DEFAULT_SNAPSHOT_DIR = process.env.ZSWAP_SNAPSHOT_DIR ?? "aggregator/snapshots";

export function registerClaim(program: Command): void {
  program
    .command("claim")
    .description("claim the output of a filled order via Merkle inclusion proof")
    .requiredOption("--nonce <field>", "order-identity nonce of the filled order")
    .option("--epoch <num>", "epoch_id the order was filled in (auto-discovered if omitted)")
    .option(
      "--snapshots <dir>",
      "directory containing aggregator/snapshots/epoch-<N>.json (default: aggregator/snapshots; override via $ZSWAP_SNAPSHOT_DIR)",
      DEFAULT_SNAPSHOT_DIR,
    )
    .action(async (_opts, cmd: Command) => {
      const opts = cmd.optsWithGlobals();
      // parseField returns bigint; wrap in Fr so .toString() yields the 0x-hex
      // form that matches snapshot map keys written by buildFillsTree / writeSnapshot.
      const orderNonce = new Fr(parseField(String(opts.nonce)));
      const snapshotsDir: string = opts.snapshots as string;

      // Resolve the epoch the maker's nonce was filled in.
      const nonceHex = orderNonce.toString();
      const epochId: number | null = opts.epoch !== undefined
        ? Number(opts.epoch)
        : findEpochForNonce(snapshotsDir, nonceHex);
      if (epochId === null) {
        throw new Error(
          `could not locate a snapshot file containing nonce ${nonceHex} under ${snapshotsDir}. ` +
          `Pass --epoch <N> explicitly, or check the aggregator wrote a snapshot for that epoch.`,
        );
      }

      const snap = readSnapshot(snapshotsDir, epochId);
      const path = snap.paths.get(nonceHex);
      if (!path) {
        throw new Error(`snapshot epoch-${epochId}.json does not contain a path for nonce ${nonceHex}`);
      }

      const leafJson = snap.leaves.find((l) => l.order_nonce === nonceHex);
      if (!leafJson || leafJson.amount_out === "0") {
        throw new Error(
          `order ${nonceHex} appears in epoch-${epochId}.json but with amount_out = 0 (not filled). ` +
          `Use cancel_order during the next OPEN epoch instead.`,
        );
      }
      const amountOut = BigInt(leafJson.amount_out);

      const config = loadConfig(opts.config);
      const ctx = await openCli(config, Number(opts.account));
      try {
        const orderbook = await OrderbookContract.at(
          AztecAddress.fromString(config.orderbook),
          ctx.wallet,
        );

        // The generated bindings may be stale relative to the new claim_fill signature
        // until pnpm codegen runs. Cast through `any` (same pattern as close-epoch.ts).
        const orderbookDyn = orderbook as unknown as {
          methods: {
            claim_fill: (
              orderNonce: Fr,
              claimedAmountOut: bigint,
              epochId: number,
              siblings: Fr[],
              leafIndex: number,
            ) => { send: (args: { from: AztecAddress }) => Promise<unknown> };
          };
        };

        await orderbookDyn.methods
          .claim_fill(orderNonce, amountOut, epochId, path.siblings, path.leaf_index)
          .send({ from: ctx.account });

        console.log(
          `claimed ${amountOut} output tokens for order ${nonceHex} (epoch ${epochId}, leaf_index ${path.leaf_index})`,
        );
      } finally {
        await ctx.stop();
      }
    });
}
