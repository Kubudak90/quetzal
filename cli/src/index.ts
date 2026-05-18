#!/usr/bin/env node
import { Command } from "commander";
import { registerOrder } from "./commands/order.js";
import { registerCancel } from "./commands/cancel.js";
import { registerOrders } from "./commands/orders.js";

const program = new Command();
program
  .name("zswap")
  .description("ZSwap-on-Aztec CLI — submit, list, and cancel private orders")
  .option("-c, --config <path>", "path to zswap.config.json", "zswap.config.json")
  .option("-a, --account <index>", "test account index to act as", "0");

registerOrder(program);
registerCancel(program);
registerOrders(program);

program.parseAsync(process.argv).catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
