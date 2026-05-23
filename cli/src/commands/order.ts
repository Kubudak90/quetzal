import type { Command } from "commander";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { Fr } from "@aztec/aztec.js/fields";
import { OrderbookContract } from "../../../tests/integration/generated/Orderbook.js";
import { AggregatorRegistryContract } from "../../../tests/integration/generated/AggregatorRegistry.js";
import { loadConfig } from "../config.js";
import { openCli } from "../wallet.js";
import { randomField } from "../field.js";
import { broadcastReveal, type RevealPayload } from "../reveal.js";
import { parsePath } from "../path.js";
import { recordDecoyBatch } from "../orders/decoy-registry.js";

export function registerOrder(program: Command): void {
  program
    .command("order")
    .description("submit a private order")
    .requiredOption("--side <buy|sell>", "buy = deposit tUSDC, sell = deposit tETH")
    .requiredOption("--amount <n>", "input amount in the token's smallest unit")
    .requiredOption("--limit <price>", "limit price, Q-format scaled to 1e18")
    .option("--path <comma-list>", "Token path, e.g. 'tUSDC,tETH' or 'tUSDC,tETH,tBTC'", "tUSDC,tETH")
    .option(
      "--decoys <n>",
      "number of decoy orders to submit alongside the real order (0-8; default 0 = no privacy padding). " +
        "Each decoy escrows the same amount but uses an unfillable limit_price so it doesn't fill at clearing. " +
        "Anonymity set per real order = decoys+1.",
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

      const config = loadConfig(opts.config);
      const ctx = await openCli(config, Number(opts.account));
      try {
        const orderbook = await OrderbookContract.at(
          AztecAddress.fromString(config.orderbook),
          ctx.wallet,
        );
        const orderNonce = randomField();
        // Sub-4: resolve --path option against config-driven alias map.
        // tBTC is optional — only present in Sub-4+ deploys.
        const aliases: Record<string, string> = {
          tUSDC: config.tUSDC,
          tETH: config.tETH,
          ...(config.tBTC ? { tBTC: config.tBTC } : {}),
        };
        const { path_len: realPathLen, path } = parsePath(opts.path as string, aliases);
        const realPath: [Fr, Fr, Fr] = [
          Fr.fromString(path[0]),
          Fr.fromString(path[1]),
          Fr.fromString(path[2]),
        ];

        // Sub-6a B2: --decoys bulk-submit path
        const decoyCount = Number(opts.decoys);
        if (!Number.isInteger(decoyCount) || decoyCount < 0 || decoyCount > 8) {
          throw new Error(`--decoys must be an integer in [0, 8], got: ${opts.decoys}`);
        }

        if (decoyCount > 0) {
          // Build 9 parallel arrays (MAX_ORDERS_PER_BULK = 9)
          const SLOTS = 9;
          const sides: boolean[] = new Array(SLOTS).fill(false);
          const amounts: bigint[] = new Array(SLOTS).fill(0n);
          const limits: bigint[] = new Array(SLOTS).fill(0n);
          const nonces: bigint[] = new Array(SLOTS).fill(0n);
          const orderNonces: bigint[] = new Array(SLOTS).fill(0n);
          const pathLens: number[] = new Array(SLOTS).fill(0);
          const pathArrays: [Fr, Fr, Fr][] = new Array(SLOTS).fill([Fr.ZERO, Fr.ZERO, Fr.ZERO]);

          // Slot 0: real order
          sides[0] = realSide;
          amounts[0] = realAmount;
          limits[0] = realLimitPrice;
          nonces[0] = randomField();
          orderNonces[0] = randomField();
          pathLens[0] = realPathLen;
          pathArrays[0] = realPath;

          // Slots 1..decoyCount: decoys with unfillable limit_price
          // sell (realSide=true): price=u128::MAX is unfillable (no one buys at MAX)
          // buy (realSide=false): price=1 is unfillable in practice (pool sqrt_price >> 1
          //   for any real pair, so the decoy's "1 wei per output unit" demand never
          //   meets the market).
          const UNFILLABLE_HIGH = (1n << 128n) - 1n; // u128::MAX
          // UNFILLABLE_LOW = 1n (NOT 0n): the orderbook helper asserts
          // limit_price > 0, so 0 would revert the bulk tx. 1 wei is the minimum
          // positive value + unfillable in practice (pool sqrt_price >> 1 for
          // any real pair, so the decoy's "1 wei per output unit" demand never
          // meets the market).
          const UNFILLABLE_LOW = 1n;
          for (let i = 1; i <= decoyCount; i++) {
            sides[i] = realSide;
            amounts[i] = realAmount;
            limits[i] = realSide ? UNFILLABLE_HIGH : UNFILLABLE_LOW;
            nonces[i] = randomField();
            orderNonces[i] = randomField();
            pathLens[i] = realPathLen;
            pathArrays[i] = realPath;
          }

          // Submit bulk via cast-through-any (codegen bindings may lag)
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const bulkOrderbook = orderbook as unknown as {
            methods: {
              submit_order_bulk: (
                side: boolean[],
                amount_in: bigint[],
                limit_price: bigint[],
                nonce: bigint[],
                order_nonce: bigint[],
                path_len: number[],
                path: [Fr, Fr, Fr][],
              ) => { send: (args: { from: AztecAddress }) => Promise<unknown> };
            };
          };
          await bulkOrderbook.methods.submit_order_bulk(
            sides,
            amounts,
            limits,
            nonces,
            orderNonces,
            pathLens,
            pathArrays,
          ).send({ from: ctx.account });

          // Record all K+1 nonces in maker-local registry
          const entries: Array<{ nonce: string; isDecoy: boolean }> = [
            { nonce: `0x${orderNonces[0].toString(16)}`, isDecoy: false },
          ];
          for (let i = 1; i <= decoyCount; i++) {
            entries.push({ nonce: `0x${orderNonces[i].toString(16)}`, isDecoy: true });
          }
          recordDecoyBatch(ctx.account.toString(), entries);

          console.log(`Submitted: 1 real + ${decoyCount} decoy order(s) via submit_order_bulk`);
          console.log(`  Real order_nonce: 0x${orderNonces[0].toString(16)}`);
          console.log(`  Decoy order_nonces:`);
          for (let i = 1; i <= decoyCount; i++) {
            console.log(`    0x${orderNonces[i].toString(16)}`);
          }
          console.log(`  Cancel decoys after clearing: quetzal cancel-decoys --epoch <N>`);
          return;
        }

        // decoyCount === 0: fall through to existing single submit_order path.
        // Cast to `any` to bridge the stale generated type (5 args) and the
        // actual Noir signature added in Sub-4 (7 args: +path_len, +path).
        // The generated Orderbook.ts is gitignored and will be regenerated by
        // `pnpm codegen` once the contracts are recompiled with Docker.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const tx = await (orderbook.methods.submit_order as any)(
          realSide, realAmount, realLimitPrice, randomField(), orderNonce,
          BigInt(realPathLen), realPath)
          .send({ from: ctx.account });
        const receipt: unknown = await (tx as { wait?: () => Promise<unknown> }).wait?.();

        console.log(`order submitted (${side}, amount ${realAmount}, limit ${realLimitPrice})`);
        console.log(`order nonce: 0x${orderNonce.toString(16)}`);
        console.log(`cancel later with: quetzal cancel --nonce 0x${orderNonce.toString(16)}`);

        // Sub-3: broadcast reveal to all bonded aggregators. Best-effort; if the
        // aggregator registry isn't deployed yet (Sub-1 MVP config), skip silently.
        if (!config.aggregatorRegistry) {
          return;
        }
        try {
          const epochSim = await orderbook.methods.get_epoch().simulate({ from: ctx.account });
          const epoch = (epochSim as { result: { epoch_id: bigint } }).result;
          const epochId = Number(epoch.epoch_id);
          // submitted_at_block: best-guess from the receipt (if available) or 0.
          // The aggregator daemon's validateReveals will reject if this doesn't
          // fold to the on-chain order_acc, so a wrong guess just costs the
          // submitter a re-broadcast.
          const blockNum =
            (receipt as { blockNumber?: bigint | number })?.blockNumber ?? 0;
          const payload: RevealPayload = {
            epoch_id: epochId,
            order_nonce: new Fr(orderNonce).toString(),
            side: realSide,
            amount_in: realAmount.toString(),
            limit_price: realLimitPrice.toString(),
            submitted_at_block: Number(blockNum),
            owner: ctx.account.toString(),
          };
          const registry = await AggregatorRegistryContract.at(
            AztecAddress.fromString(config.aggregatorRegistry),
            ctx.wallet,
          );
          const result = await broadcastReveal(payload, registry, ctx.account);
          console.log(
            `reveal broadcast: ${result.pushed} aggregators reached, ${result.skipped} unreachable`,
          );
        } catch (e) {
          console.warn(`reveal broadcast failed: ${(e as Error).message}`);
        }
      } finally {
        await ctx.stop();
      }
    });
}
