import { createAztecNodeClient, waitForNode } from "@aztec/aztec.js/node";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { EmbeddedWallet } from "@aztec/wallets/embedded";
import { registerInitialLocalNetworkAccountsInWallet } from "@aztec/wallets/testing";
import type { ZswapConfig } from "./config.js";

export interface CliContext {
  wallet: EmbeddedWallet;
  account: AztecAddress;
  config: ZswapConfig;
  stop: () => Promise<void>;
}

/**
 * Connect to the Aztec node from `config`, build an ephemeral wallet, register the
 * local-network test accounts, and select account `accountIndex` as the actor.
 */
export async function openCli(config: ZswapConfig, accountIndex: number): Promise<CliContext> {
  const node = createAztecNodeClient(config.nodeUrl);
  await waitForNode(node);

  const wallet = await EmbeddedWallet.create(node, {
    ephemeral: true,
    pxe: { proverEnabled: false },
  });
  const accounts = await registerInitialLocalNetworkAccountsInWallet(wallet);
  const account = accounts[accountIndex];
  if (!account) {
    throw new Error(
      `account index ${accountIndex} out of range — ${accounts.length} test accounts available`,
    );
  }

  const stop = async () => {
    const s = (wallet as unknown as { stop?: () => Promise<void> }).stop;
    if (typeof s === "function") await s.call(wallet);
  };
  return { wallet, account, config, stop };
}
