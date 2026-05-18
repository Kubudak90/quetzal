import type { Command } from "commander";

export function registerOrders(program: Command): void {
  program
    .command("orders")
    .description("list the account's resting orders")
    .action(() => {
      throw new Error("not implemented yet");
    });
}
