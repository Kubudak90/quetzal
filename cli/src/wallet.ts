import { createAztecNodeClient, waitForNode } from "@aztec/aztec.js/node";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { EmbeddedWallet } from "@aztec/wallets/embedded";
import { registerInitialLocalNetworkAccountsInWallet } from "@aztec/wallets/testing";
import { OrderbookContract } from "../../tests/integration/generated/Orderbook.js";
import { TokenContract } from "../../tests/integration/generated/Token.js";
import type { ZswapConfig } from "./config.js";

export interface CliContext {
  wallet: EmbeddedWallet;
  account: AztecAddress;
  config: ZswapConfig;
  stop: () => Promise<void>;
}

/**
 * Connect to the Aztec node from `config`, build an ephemeral wallet, register the
 * local-network test accounts, register the deployed ZSwap contracts, and select
 * account `accountIndex` as the actor.
 *
 * A fresh PXE syncs contract classes/instances from the node but NOT their artifacts
 * (artifacts are off-chain). Interacting with an already-deployed contract therefore
 * requires registering it explicitly: fetch the on-chain instance via
 * `node.getContract` and pair it with the codegen'd artifact. The two Token contracts
 * are registered too because `submit_order` / `cancel_order` make nested calls into
 * them that the PXE must be able to simulate.
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

  const contracts: [string, "orderbook" | "tUSDC" | "tETH"][] = [
    [config.orderbook, "orderbook"],
    [config.tUSDC, "tUSDC"],
    [config.tETH, "tETH"],
  ];
  for (const [addr, label] of contracts) {
    const instance = await node.getContract(AztecAddress.fromString(addr));
    if (!instance) {
      throw new Error(`${label} contract not found on-chain at ${addr} — is the config stale?`);
    }
    const artifact = label === "orderbook" ? OrderbookContract.artifact : TokenContract.artifact;
    await wallet.registerContract(instance, artifact);
  }

  const stop = async () => {
    const s = (wallet as unknown as { stop?: () => Promise<void> }).stop;
    if (typeof s === "function") await s.call(wallet);
  };
  return { wallet, account, config, stop };
}
