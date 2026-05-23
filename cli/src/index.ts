#!/usr/bin/env node
import { Command } from "commander";
import { registerOrder } from "./commands/order.js";
import { registerCancel } from "./commands/cancel.js";
import { registerClaim } from "./commands/claim.js";
import { registerOrders } from "./commands/orders.js";
import { registerCloseEpoch } from "./commands/close-epoch.js";
import { registerDeposit } from "./commands/deposit.js";
import { registerWithdraw } from "./commands/withdraw.js";
import { registerPositions } from "./commands/positions.js";
import { registerAggregator } from "./commands/aggregator.js";
import { registerPoolsCommand } from "./commands/pools.js";
import { registerBridge } from "./commands/bridge.js";

const program = new Command();
program
  .name("zswap")
  .description("ZSwap-on-Aztec CLI — submit, list, and cancel private orders")
  .option("-c, --config <path>", "path to zswap.config.json", "zswap.config.json")
  .option("-a, --account <index>", "test account index to act as", "0");

registerOrder(program);
registerCancel(program);
registerClaim(program);
registerOrders(program);
registerCloseEpoch(program);
registerDeposit(program);
registerWithdraw(program);
registerPositions(program);
registerAggregator(program);
registerPoolsCommand(program);
registerBridge(program);

program.parseAsync(process.argv).catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
