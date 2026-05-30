import type { Command } from "commander";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { Fr } from "@aztec/aztec.js/fields";
import { AggregatorRegistryContract } from "../../../tests/integration/generated/AggregatorRegistry.js";
import { loadConfig } from "../config.js";
import { openCli } from "../wallet.js";
import { broadcastReveal, type RevealPayload } from "../reveal.js";
import {
  classifyAmount,
  formatAdvisory,
  resolveTokenDecimals,
} from "@quetzal/sdk/privacy/amount-heuristic";

export function registerOrder(program: Command): void {
  program
    .command("order")
    .description("submit a private order")
    .requiredOption("--side <buy|sell>", "buy = deposit tUSDC, sell = deposit tETH")
    .requiredOption("--amount <n>", "input amount in the token's smallest unit")
    .requiredOption("--limit <price>", "limit price, Q-format scaled to 1e18")
    .option(
      "--path <comma-list>",
      "Token path, e.g. 'tUSDC,tETH' or 'tUSDC,tETH,tBTC'",
      "tUSDC,tETH",
    )
    .option("--ack-round", "acknowledge round-amount fingerprint warning + proceed with order")
    .option(
      "--decoys <n>",
      "number of decoy orders to submit alongside the real order (0-4; default 0 = no privacy padding). " +
        "Each decoy escrows the same amount but uses an unfillable limit_price so it doesn't fill at clearing. " +
        "Anonymity set per real order = decoys+1. " +
        "Range capped at 4 per A5 (2026-05-23) gate measurement; K=5 = 312K gates.",
      "0",
    )
    .action(async (_opts, cmd: Command) => {
      const opts = cmd.optsWithGlobals();
      const side = String(opts.side).toLowerCase();
      if (side !== "buy" && side !== "sell") {
        throw new Error(`--side must be "buy" or "sell", got "${opts.side}"`);
      }
      const realSide = side === "sell"; // false = bid (tUSDC), true = ask (tETH)
      const realAmount = BigInt(opts.amount);
      const realLimitPrice = BigInt(opts.limit);
      const decoyCount = Number(opts.decoys);
      if (!Number.isInteger(decoyCount) || decoyCount < 0 || decoyCount > 4) {
        throw new Error(`--decoys must be an integer in [0, 4], got: ${opts.decoys}`);
      }

      // D2: amount-pattern fingerprint advisory (CLI-side surface; SDK validators
      // throw on round amounts for bridge exits but place_order leaves the
      // advisory + ack-flow to the caller layer)
      const pathParts = (opts.path as string)
        .split(",")
        .map((p: string) => p.trim())
        .filter(Boolean);
      const inputTokenAlias = realSide ? pathParts[pathParts.length - 1]! : pathParts[0]!;
      const decimals = resolveTokenDecimals(inputTokenAlias);
      const heuristic = classifyAmount(realAmount, decimals);
      if (heuristic.classification !== "natural") {
        const advisory = formatAdvisory(heuristic, decimals, inputTokenAlias.toUpperCase());
        console.warn(advisory);
        if (opts.ackRound !== true) {
          console.warn(
            "Pass --ack-round to acknowledge + proceed, or rerun with a perturbed amount.",
          );
          process.exit(1);
        }
      }

      const config = loadConfig(opts.config);
      const { client } = await openCli(config, Number(opts.account));
      try {
        if (decoyCount > 0) {
          const result = await client.orders.placeOrderBulk({
            side: side as "buy" | "sell",
            amount: realAmount,
            limitPrice: realLimitPrice,
            path: pathParts,
            decoyCount,
          });
          console.log(`Submitted: 1 real + ${decoyCount} decoy order(s) via submit_order_bulk`);
          console.log(`  Real order_nonce: 0x${result.realNonce.toString(16)}`);
          console.log(`  Decoy order_nonces:`);
          for (const n of result.decoyNonces) console.log(`    0x${n.toString(16)}`);
          console.log(`  Cancel decoys after clearing: quetzal cancel-decoys --epoch <N>`);
          return;
        }

        // decoyCount === 0: single submit_order path
        const result = await client.orders.placeOrder({
          side: side as "buy" | "sell",
          amount: realAmount,
          limitPrice: realLimitPrice,
          path: pathParts,
        });

        console.log(`order submitted (${side}, amount ${realAmount}, limit ${realLimitPrice})`);
        console.log(`order nonce: 0x${result.orderNonce.toString(16)}`);
        console.log(
          `cancel later with: quetzal cancel --nonce 0x${result.orderNonce.toString(16)}`,
        );

        // Sub-3: broadcast reveal to all bonded aggregators. Best-effort.
        if (!config.aggregatorRegistry) return;
        try {
          const payload: RevealPayload = {
            epoch_id: result.epoch,
            order_nonce: new Fr(result.orderNonce).toString(),
            side: realSide,
            amount_in: realAmount.toString(),
            limit_price: realLimitPrice.toString(),
            submitted_at_block: 0, // best-guess; aggregator re-folds against on-chain order_acc.
            owner: client.address.toString(),
            // Audit #11: forward the canonical path so the aggregator recomputes c_i
            // against the same path the contract bound (needed for multi-hop orders).
            path_len: result.path_len,
            path: result.path,
          };
          const registry = await AggregatorRegistryContract.at(
            AztecAddress.fromString(config.aggregatorRegistry),
            client.wallet,
          );
          const bcast = await broadcastReveal(payload, registry, client.address);
          console.log(
            `reveal broadcast: ${bcast.pushed} aggregators reached, ${bcast.skipped} unreachable`,
          );
        } catch (e) {
          console.warn(`reveal broadcast failed: ${(e as Error).message}`);
        }
      } finally {
        await client.stop();
      }
    });
}
