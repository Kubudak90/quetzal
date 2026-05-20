#!/usr/bin/env node
//
// Deploy tUSDC and tETH to a running Aztec local-network and print the
// resulting contract addresses + admin address as JSON.
//
// Pre-requisites:
//   - dev stack is up: `scripts/dev.sh` (anvil + aztec start --local-network)
//   - contracts are compiled: `pnpm compile`
//   - bindings are generated under tests/integration/generated/ (see Task 9)
//   - VK hash written: circuits/clearing/target/vk.bin/vk_hash
//     (`pnpm compile` runs `bb write_vk` which produces vk + vk_hash alongside each other)
//
// Usage:
//   pnpm tsx scripts/deploy-tokens.ts
//
import { writeFileSync, readFileSync } from "node:fs";
import { Fr } from "@aztec/aztec.js/fields";

/** Read the clearing-circuit VK hash from the compiled artifact.
 * Only the hash is stored on-chain; the full VK is provided as calldata
 * to `close_epoch_and_clear_verified` and verified against this stored hash.
 */
function readVkHash(): Fr {
  const hashBuf = readFileSync("circuits/clearing/target/vk.bin/vk_hash");
  if (hashBuf.length !== 32) {
    throw new Error(`expected 32-byte vk_hash, got ${hashBuf.length}`);
  }
  return Fr.fromBuffer(hashBuf as Buffer);
}

import { createAztecNodeClient, waitForNode } from "@aztec/aztec.js/node";
import { EmbeddedWallet } from "@aztec/wallets/embedded";
import { registerInitialLocalNetworkAccountsInWallet } from "@aztec/wallets/testing";

import { TokenContract } from "../tests/integration/generated/Token.js";
import { OrderbookContract } from "../tests/integration/generated/Orderbook.js";
import { LiquidityPoolContract } from "../tests/integration/generated/LiquidityPool.js";

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

  const deployedPool = await LiquidityPoolContract.deploy(
    wallet, tokenA.contract.address, tokenB.contract.address,
  ).send({ from: admin });

  // 100-block epochs in deployed environments. Store only the VK hash on-chain;
  // the full VK is provided as calldata at clearing time and verified against this hash.
  const vkHash = readVkHash();
  const deployedOB = await OrderbookContract.deploy(
    wallet,
    tokenA.contract.address,
    tokenB.contract.address,
    100,
    deployedPool.contract.address,
    vkHash,
  ).send({ from: admin });

  // Wire the pool to the orderbook (one-shot).
  await deployedPool.contract.methods
    .set_orderbook(deployedOB.contract.address)
    .send({ from: admin });

  const result = {
    nodeUrl: NODE_URL,
    tUSDC: tokenA.contract.address.toString(),
    tETH: tokenB.contract.address.toString(),
    orderbook: deployedOB.contract.address.toString(),
    pool: deployedPool.contract.address.toString(),
    admin: admin.toString(),
  };

  // Persist for the CLI (zswap reads zswap.config.json by default).
  writeFileSync("zswap.config.json", JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));

  await wallet.stop();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
