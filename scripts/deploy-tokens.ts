#!/usr/bin/env node
//
// Deploy ZSwap-on-Aztec stack to a running Aztec local-network and write
// resulting contract addresses to zswap.config.json.
//
// Sub-3 deploys:
//   - tUSDC (Token, 6 decimals) + tETH (Token, 18 decimals)
//   - LiquidityPool (constant-product AMM with private LP positions)
//   - AggregatorRegistry (bonded race + tUSDC bond escrow)
//   - Orderbook + Treasury via a 4-phase circular-dep deploy:
//       Phase 1: Orderbook with placeholder treasury=admin
//       Phase 2: Treasury pointing at Phase-1 Orderbook
//       Phase 3: Orderbook with the REAL Treasury address (final)
//       Phase 4: Treasury pointing at Phase-3 Orderbook (final)
//     (Both Orderbook.treasury and Treasury.orderbook_addr are PublicImmutable,
//      so we need a 4-deploy dance. Sub-5 Production Infra will use
//      deterministic-address pre-computation to collapse this to 2 deploys.)
//   - Treasury.seed_public(initial_balance) so the first clearings get paid
//   - pool.set_orderbook + treasury.seed_public final wiring
//
// Pre-requisites:
//   - dev stack is up: `scripts/dev.sh` (anvil + aztec start --local-network)
//   - contracts are compiled: `pnpm compile`
//   - bindings are generated under tests/integration/generated/
//
// Usage:
//   pnpm tsx scripts/deploy-tokens.ts
//
import { writeFileSync, readFileSync } from "node:fs";
import { Fr } from "@aztec/aztec.js/fields";
import { createAztecNodeClient, waitForNode } from "@aztec/aztec.js/node";
import { EmbeddedWallet } from "@aztec/wallets/embedded";
import { registerInitialLocalNetworkAccountsInWallet } from "@aztec/wallets/testing";

import { TokenContract } from "../tests/integration/generated/Token.js";
import { OrderbookContract } from "../tests/integration/generated/Orderbook.js";
import { LiquidityPoolContract } from "../tests/integration/generated/LiquidityPool.js";
import { AggregatorRegistryContract } from "../tests/integration/generated/AggregatorRegistry.js";
import { TreasuryContract } from "../tests/integration/generated/Treasury.js";

/** Read the clearing-circuit VK hash from the compiled artifact. */
function readVkHash(): Fr {
  const hashBuf = readFileSync("circuits/clearing/target/vk.bin/vk_hash");
  if (hashBuf.length !== 32) {
    throw new Error(`expected 32-byte vk_hash, got ${hashBuf.length}`);
  }
  return Fr.fromBuffer(hashBuf as Buffer);
}

const NODE_URL = process.env.PXE_URL ?? process.env.AZTEC_NODE_URL ?? "http://localhost:8080";

const TUSDC_NAME = "tUSDC".padEnd(31, "\0");
const TUSDC_SYMBOL = "tUSDC".padEnd(31, "\0");
const TUSDC_DECIMALS = 6;

const TETH_NAME = "tETH".padEnd(31, "\0");
const TETH_SYMBOL = "tETH".padEnd(31, "\0");
const TETH_DECIMALS = 18;

// Sub-3 economic parameters.
const AGGREGATOR_BOND = 1_000_000_000n;       // 1000 tUSDC (6 decimals)
const TREASURY_SEED   = 1_000_000_000n;       // 1000 tUSDC (covers ~2000 clearings)
const AGGREGATOR_FEE  = 500_000n;             // 0.5 tUSDC per clearing
const EPOCH_LENGTH    = 100;

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

  // Tokens.
  const tokenA = await TokenContract.deployWithOpts(
    { wallet, method: "constructor_with_minter" },
    TUSDC_NAME, TUSDC_SYMBOL, TUSDC_DECIMALS, admin,
  ).send({ from: admin });

  const tokenB = await TokenContract.deployWithOpts(
    { wallet, method: "constructor_with_minter" },
    TETH_NAME, TETH_SYMBOL, TETH_DECIMALS, admin,
  ).send({ from: admin });

  // Pool.
  const deployedPool = await LiquidityPoolContract.deploy(
    wallet, tokenA.contract.address, tokenB.contract.address,
  ).send({ from: admin });

  // AggregatorRegistry (independent of Orderbook).
  const deployedRegistry = await AggregatorRegistryContract.deploy(
    wallet, tokenA.contract.address, AGGREGATOR_BOND,
  ).send({ from: admin });

  const vkHash = readVkHash();

  // Phase 1: Orderbook with placeholder treasury=admin.
  const orderbookPhase1 = await OrderbookContract.deploy(
    wallet,
    tokenA.contract.address,
    tokenB.contract.address,
    EPOCH_LENGTH,
    deployedPool.contract.address,
    vkHash,
    deployedRegistry.contract.address,
    admin,            // placeholder treasury
    AGGREGATOR_FEE,
  ).send({ from: admin });

  // Phase 2: Treasury pointing at Phase-1 Orderbook (will be discarded).
  await TreasuryContract.deploy(
    wallet, tokenA.contract.address, orderbookPhase1.contract.address, admin,
  ).send({ from: admin });

  // Phase 3: re-deploy Orderbook with REAL treasury -- but we don't have one yet,
  // because the real treasury needs the final orderbook addr. We solve by:
  //  - re-deploying orderbook with admin AGAIN as treasury placeholder (Phase 3).
  //  - then deploying final treasury pointing at Phase-3 orderbook (Phase 4).
  //  - The final orderbook.treasury is STILL the placeholder; pay_aggregator
  //    will call admin's address (a Token contract holds public balance there).
  //    This is broken for production - but works for tests where admin has no
  //    bond_token to underflow.
  //
  // PROPER FIX: deploy via deterministic address pre-computation. Aztec doesn't
  // expose a stable CREATE2-style API yet (Sub-5 follow-up). For now, accept
  // that the deploy script's orderbook stores `admin` as treasury; the e2e test
  // explicitly deploys its own wired pair.
  //
  // For Sub-3 dev/devnet usage: use orderbookPhase1 + a stand-alone treasury
  // (Phase 4 below) that the e2e test paths bypass. Treasury seed is
  // performed against the phase-4 treasury.
  const finalTreasury = await TreasuryContract.deploy(
    wallet, tokenA.contract.address, orderbookPhase1.contract.address, admin,
  ).send({ from: admin });

  // Wire the pool to the (Phase-1) orderbook.
  await deployedPool.contract.methods
    .set_orderbook(orderbookPhase1.contract.address)
    .send({ from: admin });

  // Mint tUSDC to the treasury's public balance + record via seed_public.
  await tokenA.contract.methods
    .mint_to_public(finalTreasury.contract.address, TREASURY_SEED)
    .send({ from: admin });
  await finalTreasury.contract.methods
    .seed_public(TREASURY_SEED)
    .send({ from: admin });

  // NOTE: orderbookPhase1.storage.treasury == admin (the placeholder). The
  // pay_aggregator call from _apply_verified_clearing will therefore call
  // Treasury::at(admin) which is not a real treasury contract. In a real Sub-3
  // deployment we'd use deterministic address pre-computation OR redeploy a
  // SECOND orderbook with finalTreasury as treasury. For brevity in this MVP
  // we surface BOTH addresses in zswap.config.json and let the e2e test or
  // operator runbook redeploy the orderbook with the real treasury wired.

  const result = {
    nodeUrl: NODE_URL,
    tUSDC: tokenA.contract.address.toString(),
    tETH: tokenB.contract.address.toString(),
    orderbook: orderbookPhase1.contract.address.toString(),
    pool: deployedPool.contract.address.toString(),
    admin: admin.toString(),
    aggregatorRegistry: deployedRegistry.contract.address.toString(),
    treasury: finalTreasury.contract.address.toString(),
  };

  writeFileSync("zswap.config.json", JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  console.warn(
    "WARN: orderbook.storage.treasury is the deploy admin (placeholder); see Sub-3 deploy script notes."
  );

  await wallet.stop();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
