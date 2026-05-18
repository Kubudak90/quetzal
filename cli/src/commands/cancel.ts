import type { Command } from "commander";

export function registerCancel(program: Command): void {
  program
    .command("cancel")
    .description("cancel a resting order and reclaim its escrow")
    .requiredOption("--nonce <field>", "order-identity nonce (from `zswap order` / `zswap orders`)")
    .action(() => {
      throw new Error("not implemented yet");
    });
}
