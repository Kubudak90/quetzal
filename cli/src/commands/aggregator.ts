import type { Command } from "commander";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { Fr } from "@aztec/aztec.js/fields";
import { AggregatorRegistryContract } from "../../../tests/integration/generated/AggregatorRegistry.js";
import { loadConfig } from "../config.js";
import { openCli } from "../wallet.js";
import { hashUrl } from "../reveal.js";

export function registerAggregator(program: Command): void {
  const agg = program.command("aggregator").description("manage aggregator registration");

  agg
    .command("register")
    .description("register the current account as a bonded aggregator")
    .requiredOption("--bond <amount>", "tUSDC bond amount (smallest units)")
    .requiredOption("--url <https-url>", "HTTPS reveal endpoint URL")
    .action(async (_opts, cmd: Command) => {
      const opts = cmd.optsWithGlobals();
      const config = loadConfig(opts.config);
      if (!config.aggregatorRegistry) {
        throw new Error("config.aggregatorRegistry not set - run scripts/deploy-tokens.ts to deploy Sub-3 contracts");
      }
      const ctx = await openCli(config, Number(opts.account));
      try {
        const url = String(opts.url);
        const endpointHash = await hashUrl(url);
        const registry = await AggregatorRegistryContract.at(
          AztecAddress.fromString(config.aggregatorRegistry),
          ctx.wallet,
        );
        const nonce = Fr.random();
        await registry.methods.register(endpointHash, nonce).send({ from: ctx.account });
        console.log(`registered as aggregator with URL ${url} (endpoint hash ${endpointHash.toString()})`);
      } finally {
        await ctx.stop();
      }
    });

  agg
    .command("list")
    .description("list all registered aggregators (id, address, endpoint hash)")
    .action(async (_opts, cmd: Command) => {
      const opts = cmd.optsWithGlobals();
      const config = loadConfig(opts.config);
      if (!config.aggregatorRegistry) {
        throw new Error("config.aggregatorRegistry not set");
      }
      const ctx = await openCli(config, Number(opts.account));
      try {
        const r = await AggregatorRegistryContract.at(
          AztecAddress.fromString(config.aggregatorRegistry),
          ctx.wallet,
        );
        const countSim = await r.methods.get_aggregator_count().simulate({ from: ctx.account });
        const count = Number((countSim as { result: bigint }).result);
        if (count === 0) {
          console.log("(no aggregators registered)");
          return;
        }
        for (let id = 1; id <= count; id++) {
          const addrSim = await r.methods.get_aggregator_by_id(id).simulate({ from: ctx.account });
          const addrField = (addrSim as { result: { inner?: bigint } | bigint }).result;
          const addrBigInt = typeof addrField === "bigint" ? addrField : (addrField as { inner: bigint }).inner;
          if (addrBigInt === 0n) continue;
          const addr = AztecAddress.fromBigInt(addrBigInt);
          const hashSim = await r.methods.get_endpoint_hash(addr).simulate({ from: ctx.account });
          const hash = (hashSim as { result: bigint }).result;
          console.log(`id=${id} addr=${addr.toString()} endpoint_hash=0x${hash.toString(16)}`);
        }
      } finally {
        await ctx.stop();
      }
    });

  agg
    .command("unregister")
    .description("unregister the current account and reclaim the bond")
    .action(async (_opts, cmd: Command) => {
      const opts = cmd.optsWithGlobals();
      const config = loadConfig(opts.config);
      if (!config.aggregatorRegistry) {
        throw new Error("config.aggregatorRegistry not set");
      }
      const ctx = await openCli(config, Number(opts.account));
      try {
        const r = await AggregatorRegistryContract.at(
          AztecAddress.fromString(config.aggregatorRegistry),
          ctx.wallet,
        );
        await r.methods.unregister(new Fr(0n)).send({ from: ctx.account });
        console.log("unregistered + bond returned");
      } finally {
        await ctx.stop();
      }
    });
}
