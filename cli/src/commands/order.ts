import type { Command } from "commander";

export function registerOrder(program: Command): void {
  program
    .command("order")
    .description("submit a private order")
    .requiredOption("--side <buy|sell>", "buy = deposit tUSDC, sell = deposit tETH")
    .requiredOption("--amount <n>", "input amount in the token's smallest unit")
    .requiredOption("--limit <price>", "limit price, Q-format scaled to 1e18")
    .action(() => {
      throw new Error("not implemented yet");
    });
}
