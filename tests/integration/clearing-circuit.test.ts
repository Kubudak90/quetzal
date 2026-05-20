/**
 * E1 — clearing circuit end-to-end happy path.
 *
 * Deploys a fresh fixture on the live VPS stack, submits a perfectly-balanced
 * set of orders (1 buy + 1 sell at exact spot price balance, so netA == 0
 * and no AMM swap is needed). This design guarantees the AMM k-monotonicity
 * assertion in the circuit passes trivially (reserves unchanged).
 *
 * Order scenario:
 *   Pool:  10,000 tUSDC : 5,000 tETH (spot P* = 2e6, i.e. 2 * 1e6 tETH-units per tUSDC-unit)
 *   Buy:   100 tUSDC (1e8 raw units), limit_price = 1e19 (well above spot)
 *   Sell:  50 tETH  (5e19 raw units), limit_price = 1    (well below spot)
 *   netA:  1e8 - floor(5e19 * 2e6 / 1e18) = 1e8 - 1e8 = 0  → no AMM swap
 *
 * After clearing, the witness is written to the VPS, then nargo execute +
 * bb prove --verify are run. The test asserts proof verification.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import type { AztecAddress } from "@aztec/aztec.js/addresses";
import type { AztecNode } from "@aztec/aztec.js/node";
import type { EmbeddedWallet } from "@aztec/wallets/embedded";

import { connectToSandbox } from "./helpers/sandbox.js";
import { getTestWallets } from "./helpers/wallets.js";
import { TokenContract } from "./generated/Token.js";
import { OrderbookContract } from "./generated/Orderbook.js";
import { LiquidityPoolContract } from "./generated/LiquidityPool.js";

import {
  computeClearing,
  type ClearingOrder,
} from "../../aggregator/src/clearing.js";
import {
  buildClearingWitness,
  type OrderNotePreimage,
  type EpochState,
  type PoolSnapshotForCircuit,
} from "../../aggregator/src/witness.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Use the smaller test circuit (MAX_ORDERS_PER_EPOCH=4) to stay within VPS memory limits.
// The full circuit (MAX=128, ~904K gates) requires >8GB RAM to prove; the test circuit
// (MAX=4, ~13K gates) is structurally identical and proves in seconds.
const CIRCUIT_DIR = "/root/zswap-aztec/circuits/clearing-test";
const CIRCUIT_MAX_ORDERS = 4;  // Must match clearing-test/src/types.nr MAX_ORDERS_PER_EPOCH
// The host-installed bb binary (amd64-linux, no Docker overhead).
const BB_BIN =
  "/root/.aztec/versions/4.2.1/node_modules/@aztec/bb.js/build/amd64-linux/bb";

const ONE_USDC = 10n ** 6n;
const ONE_ETH = 10n ** 18n;

// Pool: 10,000 tUSDC : 5,000 tETH → spot = reserveA * SCALE / reserveB
//   = (10000 * 1e6) * 1e18 / (5000 * 1e18) = 10e9 / 5e3 = 2_000_000 = 2e6
// So the spot price is 2e6 (in the circuit's 1e18-scaled tETH-per-tUSDC units).
const POOL_A = 10_000n * ONE_USDC;   // 10,000 tUSDC = 1e10 raw units
const POOL_B = 5_000n * ONE_ETH;     // 5,000 tETH  = 5e21 raw units

// Balanced order pair at spot P* = 2e6:
//   gross_buy_in_a = 100 tUSDC = 1e8 raw units
//   gross_sell_in_b = 50 tETH  = 5e19 raw units
//   netA = 1e8 - floor(5e19 * 2e6 / 1e18) = 1e8 - 1e8 = 0  (exact balance)
const BUY_USDC  = 100n * ONE_USDC;   // 100 tUSDC = 1e8 raw units
const SELL_ETH  = 50n * ONE_ETH;     // 50 tETH   = 5e19 raw units
// spot = 2_000_000n (reserveA * SCALE / reserveB); clearing price converges near this value.

// Limit prices: generous limits so both orders are eligible at spot.
const BUY_LIMIT  = 10_000_000_000_000_000_000n;  // 1e19 (buy limit >> spot 2e6 → eligible)
const SELL_LIMIT = 1n;                            // 1    (sell limit << spot 2e6 → eligible)

// Epoch length large enough to survive all submits before we expire it.
const EPOCH_LEN = 10_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function randomField(): bigint {
  const buf = new Uint8Array(31);
  webcrypto.getRandomValues(buf);
  let n = 0n;
  for (const b of buf) n = (n << 8n) | BigInt(b);
  return n;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe(
  "clearing circuit E2E (live integration)",
  { timeout: 30 * 60 * 1_000 }, // 30 min total
  () => {
    let node: AztecNode;
    let wallet: EmbeddedWallet;
    let admin: AztecAddress;
    let alice: AztecAddress;   // buyer
    let bob: AztecAddress;     // seller
    let tUSDC: TokenContract;
    let tETH: TokenContract;
    let pool: LiquidityPoolContract;
    let orderbook: OrderbookContract;

    before(async () => {
      node = await connectToSandbox();
      // 3 accounts: admin (minter + LP + clearing authority), alice (buyer), bob (seller)
      const env = await getTestWallets(node, 3);
      wallet = env.wallet;
      admin = env.accounts[0]!;
      alice = env.accounts[1]!;
      bob   = env.accounts[2]!;

      // Deploy fresh tUSDC token.
      const dU = await TokenContract.deployWithOpts(
        { wallet, method: "constructor_with_minter" },
        "tUSDC".padEnd(31, "\0"), "tUSDC".padEnd(31, "\0"), 6, admin,
      ).send({ from: admin });
      tUSDC = dU.contract;

      // Deploy fresh tETH token.
      const dE = await TokenContract.deployWithOpts(
        { wallet, method: "constructor_with_minter" },
        "tETH".padEnd(31, "\0"), "tETH".padEnd(31, "\0"), 18, admin,
      ).send({ from: admin });
      tETH = dE.contract;

      // Deploy LiquidityPool.
      const dP = await LiquidityPoolContract.deploy(wallet, tUSDC.address, tETH.address)
        .send({ from: admin });
      pool = dP.contract;

      // Deploy Orderbook with admin as clearing_authority.
      const dOB = await OrderbookContract.deploy(
        wallet, tUSDC.address, tETH.address, EPOCH_LEN, pool.address, admin,
      ).send({ from: admin });
      orderbook = dOB.contract;

      // Wire pool → orderbook (apply_clearing checks msg_sender == orderbook_addr).
      await pool.methods.set_orderbook(orderbook.address).send({ from: admin });

      // Seed admin (LP) with tUSDC + tETH for the pool deposit.
      await tUSDC.methods.mint_to_private(admin, POOL_A + 1_000n * ONE_USDC).send({ from: admin });
      await tETH.methods.mint_to_private(admin, POOL_B + 100n * ONE_ETH).send({ from: admin });

      // Seed alice (buyer) with tUSDC.
      await tUSDC.methods.mint_to_private(alice, BUY_USDC + ONE_USDC).send({ from: admin });
      // Seed bob (seller) with tETH.
      await tETH.methods.mint_to_private(bob, SELL_ETH + ONE_ETH).send({ from: admin });

      // Admin deposits POOL_A tUSDC + POOL_B tETH into the pool.
      const hint0 = (await pool.methods.get_pool_state().simulate({ from: admin })).result;
      await pool.methods
        .deposit(POOL_A, POOL_B, hint0, randomField(), randomField(), randomField())
        .send({ from: admin });
    });

    after(async () => {
      const stop = (wallet as unknown as { stop?: () => Promise<void> }).stop;
      if (typeof stop === "function") await stop.call(wallet);
    });

    it(
      "E1: balanced buy+sell epoch → nargo execute + bb prove --verify",
      { timeout: 28 * 60 * 1_000 }, // 28 min per test
      async () => {
        // ---------------------------------------------------------------
        // 1. Submit one buy (alice) and one sell (bob)
        //    Both have generous limits → eligible at spot P*=2e6.
        //    netA = BUY_USDC - floor(SELL_ETH * SPOT / 1e18) = 1e8 - 1e8 = 0.
        // ---------------------------------------------------------------
        const buyNonce  = randomField();
        const sellNonce = randomField();

        await orderbook.methods
          .submit_order(false, BUY_USDC, BUY_LIMIT, randomField(), buyNonce)
          .send({ from: alice });

        await orderbook.methods
          .submit_order(true, SELL_ETH, SELL_LIMIT, randomField(), sellNonce)
          .send({ from: bob });

        // ---------------------------------------------------------------
        // 2. Read alice's and bob's order notes
        // ---------------------------------------------------------------
        const aliceRaw = await orderbook.methods.get_orders(alice).simulate({ from: alice });
        const aliceBv = (aliceRaw as {
          result: { storage: OrderNoteFields[]; len: bigint | number };
        }).result;
        const aliceLen = Number(aliceBv.len);
        assert.ok(aliceLen >= 1, "alice should have at least 1 order");
        const aliceNote = aliceBv.storage.slice(0, aliceLen)
          .find((n) => BigInt(n.nonce) === buyNonce);
        assert.ok(aliceNote, "alice's buy order note not found");

        const bobRaw = await orderbook.methods.get_orders(bob).simulate({ from: bob });
        const bobBv = (bobRaw as {
          result: { storage: OrderNoteFields[]; len: bigint | number };
        }).result;
        const bobLen = Number(bobBv.len);
        assert.ok(bobLen >= 1, "bob should have at least 1 order");
        const bobNote = bobBv.storage.slice(0, bobLen)
          .find((n) => BigInt(n.nonce) === sellNonce);
        assert.ok(bobNote, "bob's sell order note not found");

        // ---------------------------------------------------------------
        // 3. Read epoch state and pool snapshot
        // ---------------------------------------------------------------
        const epochRaw = await orderbook.methods.get_epoch().simulate({ from: admin });
        const epochResult = (epochRaw as {
          result: {
            order_acc: bigint;
            cancel_acc: bigint;
            order_count: bigint | number;
            cancel_count: bigint | number;
            closes_at_block: bigint;
          };
        }).result;

        const poolStateRaw = await pool.methods.get_pool_state().simulate({ from: admin });
        const poolState = poolStateRaw.result;

        // ---------------------------------------------------------------
        // 4. Build orders[] sorted by submission order (submitted_at_block, then nonce)
        //    — the circuit's binding module replays the order_acc chain in this order.
        // ---------------------------------------------------------------
        const ordersForWitness: OrderNotePreimage[] = [
          {
            side: false,
            amount_in: BigInt(aliceNote.amount_in),
            limit_price: BigInt(aliceNote.limit_price),
            order_nonce: buyNonce,
            submitted_at_block: Number(aliceNote.submitted_at_block),
            owner: BigInt(aliceNote.owner),
          },
          {
            side: true,
            amount_in: BigInt(bobNote.amount_in),
            limit_price: BigInt(bobNote.limit_price),
            order_nonce: sellNonce,
            submitted_at_block: Number(bobNote.submitted_at_block),
            owner: BigInt(bobNote.owner),
          },
        ].sort((a, b) => {
          if (a.submitted_at_block !== b.submitted_at_block)
            return a.submitted_at_block - b.submitted_at_block;
          return a.order_nonce < b.order_nonce ? -1 : a.order_nonce > b.order_nonce ? 1 : 0;
        });

        // ---------------------------------------------------------------
        // 5. Run the off-chain aggregator
        // ---------------------------------------------------------------
        const clearingOrders: ClearingOrder[] = ordersForWitness.map((o) => ({
          side: o.side,
          amountIn: o.amount_in,
          limitPrice: o.limit_price,
          submittedAtBlock: o.submitted_at_block,
          orderNonce: o.order_nonce,
        }));

        const clearingResult = computeClearing(
          {
            reserveA: BigInt(poolState.reserve_a),
            reserveB: BigInt(poolState.reserve_b),
            lpSupply: BigInt(poolState.lp_supply),
          },
          clearingOrders,
        );

        assert.equal(clearingResult.cleared, true, "aggregator must find a clearing price");
        assert.equal(
          clearingResult.fills.length, 2,
          "both orders (buy + sell) must be filled",
        );

        // Log the clearing price for diagnostics (netA=0 → should equal spot ~2e6,
        // but we don't assert exact equality in case of small rounding at pool margins).
        console.log(`clearing price: ${clearingResult.clearingPrice}, pool reserves: a=${poolState.reserve_a} b=${poolState.reserve_b} lp=${poolState.lp_supply}`);

        // ---------------------------------------------------------------
        // 6. Build the Prover.toml witness
        // ---------------------------------------------------------------
        const epoch: EpochState = {
          order_acc: epochResult.order_acc,
          cancel_acc: epochResult.cancel_acc,
          order_count: Number(epochResult.order_count),
          cancel_count: Number(epochResult.cancel_count),
        };
        const poolSnap: PoolSnapshotForCircuit = {
          reserve_a: BigInt(poolState.reserve_a),
          reserve_b: BigInt(poolState.reserve_b),
          lp_supply: BigInt(poolState.lp_supply),
        };

        const { proverToml } = buildClearingWitness({
          epoch,
          pool: poolSnap,
          orders: ordersForWitness,
          cancellationIndices: [],
          clearing: clearingResult,
          maxOrders: CIRCUIT_MAX_ORDERS,
        });

        // ---------------------------------------------------------------
        // 7. Write Prover.toml directly to the circuit directory
        // ---------------------------------------------------------------
        const proverTomlPath = `${CIRCUIT_DIR}/Prover.toml`;
        writeFileSync(proverTomlPath, proverToml, "utf8");
        console.log(`Wrote Prover.toml to ${proverTomlPath}`);

        // ---------------------------------------------------------------
        // 8. Run nargo execute directly (env sourced via shell -c)
        // ---------------------------------------------------------------
        const execResult = spawnSync(
          "/bin/bash",
          [
            "-c",
            `source /root/.zswap-env && cd ${CIRCUIT_DIR} && nargo execute --silence-warnings`,
          ],
          { encoding: "utf8", timeout: 5 * 60 * 1_000 },
        );
        if (execResult.status !== 0) {
          const msg = [
            "nargo execute failed (likely witness/constraint mismatch):",
            "stdout:", execResult.stdout ?? "",
            "stderr:", execResult.stderr ?? "",
          ].join("\n");
          assert.fail(msg);
        }

        // ---------------------------------------------------------------
        // 9a. Write the verification key
        //   write_vk -o <dir> writes <dir>/vk and <dir>/vk_hash.
        //   We recreate the vk dir to ensure a clean state.
        // ---------------------------------------------------------------
        const vkDir    = `${CIRCUIT_DIR}/target/vk`;
        const proofDir = `${CIRCUIT_DIR}/target/proofdir`;
        rmSync(vkDir,    { recursive: true, force: true });
        mkdirSync(vkDir, { recursive: true });
        rmSync(proofDir, { recursive: true, force: true });
        mkdirSync(proofDir, { recursive: true });

        const vkResult = spawnSync(
          BB_BIN,
          [
            "write_vk",
            "-b", `${CIRCUIT_DIR}/target/clearing_test.json`,
            "-o", vkDir,
          ],
          { encoding: "utf8", timeout: 5 * 60 * 1_000 },
        );
        if (vkResult.status !== 0) {
          const msg = [
            "bb write_vk failed:",
            "stdout:", vkResult.stdout ?? "",
            "stderr:", vkResult.stderr ?? "",
          ].join("\n");
          assert.fail(msg);
        }
        // bb write_vk writes <vkDir>/vk; use that exact file for prove/verify.
        const vkFile = `${vkDir}/vk`;

        // ---------------------------------------------------------------
        // 9b. Generate the proof
        //   prove -o <dir> -k <vk-file> writes <dir>/proof and <dir>/public_inputs.
        // ---------------------------------------------------------------
        const proveResult = spawnSync(
          BB_BIN,
          [
            "prove",
            "-b", `${CIRCUIT_DIR}/target/clearing_test.json`,
            "-w", `${CIRCUIT_DIR}/target/clearing_test.gz`,
            "-o", proofDir,
            "-k", vkFile,
          ],
          { encoding: "utf8", timeout: 20 * 60 * 1_000 },
        );
        if (proveResult.status !== 0) {
          const msg = [
            "bb prove failed:",
            "stdout:", proveResult.stdout ?? "",
            "stderr:", proveResult.stderr ?? "",
          ].join("\n");
          assert.fail(msg);
        }

        // ---------------------------------------------------------------
        // 9c. Verify the proof
        //   verify -k <vk-file> -p <proof-file> -i <public_inputs-file>
        // ---------------------------------------------------------------
        const verifyResult = spawnSync(
          BB_BIN,
          [
            "verify",
            "-k", vkFile,
            "-p", `${proofDir}/proof`,
            "-i", `${proofDir}/public_inputs`,
          ],
          { encoding: "utf8", timeout: 5 * 60 * 1_000 },
        );
        if (verifyResult.status !== 0) {
          const msg = [
            "bb verify failed:",
            "stdout:", verifyResult.stdout ?? "",
            "stderr:", verifyResult.stderr ?? "",
          ].join("\n");
          assert.fail(msg);
        }

        // Proof verified successfully.
        assert.ok(true, "bb verify exited 0 — proof is valid");
      },
    );
  },
);

// ---------------------------------------------------------------------------
// Type helpers (avoid repeating the complex cast inline)
// ---------------------------------------------------------------------------

interface OrderNoteFields {
  side: boolean;
  amount_in: bigint | number;
  limit_price: bigint | number;
  nonce: bigint | number;
  submitted_at_block: bigint | number;
  owner: bigint | number;
}
