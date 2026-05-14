#!/usr/bin/env node
//
// Deploy tUSDC and tETH to a running Aztec local-network and print the
// resulting contract addresses + admin address as JSON.
//
// Pre-requisites:
//   - dev stack is up: `scripts/dev.sh` (anvil + aztec start --local-network)
//   - contracts are compiled: `pnpm compile`
//   - bindings are generated under tests/integration/generated/ (see Task 9)
//
// Usage:
//   pnpm tsx scripts/deploy-tokens.ts
//
import { createAztecNodeClient, waitForNode } from "@aztec/aztec.js/node";
import { EmbeddedWallet } from "@aztec/wallets/embedded";
import { registerInitialLocalNetworkAccountsInWallet } from "@aztec/wallets/testing";

import { TokenContract } from "../tests/integration/generated/Token.js";

const NODE_URL = process.env.PXE_URL ?? process.env.AZTEC_NODE_URL ?? "http://localhost:8080";

// Brand metadata (must match the contract globals; padded to str<31>).
const TUSDC_NAME = "tUSDC".padEnd(31, "\0");
const TUSDC_SYMBOL = "tUSDC".padEnd(31, "\0");
const TUSDC_DECIMALS = 6;

const TETH_NAME = "tETH".padEnd(31, "\0");
const TETH_SYMBOL = "tETH".padEnd(31, "\0");
const TETH_DECIMALS = 18;

async function main() {
  const node = createAztecNodeClient(NODE_URL);
  await waitForNode(node);

  const wallet = await EmbeddedWallet.create(node, {
    ephemeral: true,
    pxe: { proverEnabled: false },
  });

  const accounts = await registerInitialLocalNetworkAccountsInWallet(wallet);
  const admin = accounts[0];
  if (!admin) throw new Error("no test wallets available");

  const tokenA = await TokenContract.deployWithOpts(
    { wallet, method: "constructor_with_minter" },
    TUSDC_NAME,
    TUSDC_SYMBOL,
    TUSDC_DECIMALS,
    admin,
  ).send({ from: admin });

  const tokenB = await TokenContract.deployWithOpts(
    { wallet, method: "constructor_with_minter" },
    TETH_NAME,
    TETH_SYMBOL,
    TETH_DECIMALS,
    admin,
  ).send({ from: admin });

  console.log(
    JSON.stringify(
      {
        tUSDC: tokenA.contract.address.toString(),
        tETH: tokenB.contract.address.toString(),
        admin: admin.toString(),
      },
      null,
      2,
    ),
  );

  await wallet.stop();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
