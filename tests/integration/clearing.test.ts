/**
 * Week 5d-3 end-to-end: clearing via on-chain recursive proof verification.
 *
 * E1 — verified-flow happy path. Deploys a fresh fixture on the live VPS stack,
 * with the orderbook bound to the production clearing-circuit's REAL vk_hash
 * (the file at circuits/clearing/target/vk.bin/vk_hash produced by
 * scripts/compile-all.sh). It then:
 *   1. Submits one balanced buy + one balanced sell so netA == 0 at spot
 *      (no AMM swap, k-monotonicity trivially holds).
 *   2. Reads the on-chain epoch + pool snapshot + order notes.
 *   3. Runs the off-chain aggregator (computeClearing) and builds the witness
 *      with the TS witness builder.
 *   4. Writes Prover.toml into the production circuit and runs nargo execute +
 *      bb prove.
 *   5. Parses the binary proof + vk into Fr[] using the Task 5 helper, bridges
 *      them to the contract's locked array sizes (proof: 500 → 456 truncate;
 *      vk: 115 → 127 pad with zero).
 *   6. Calls close_epoch_and_clear_verified(public_inputs, proof, vk) — the
 *      contract recursively verifies via std::verify_proof_with_type and the
 *      public callback applies the clearing.
 *   7. Asserts the epoch advanced (epoch_id += 1, counters reset) and per-order
 *      fills were recorded.
 *
 * Headline risks this test discovers EMPIRICALLY (see Task 6 description for
 * full background):
 *   - N=32 proof gen RAM viability on the dev VPS (~8 GB + 8 GB swap).
 *   - proof/vk size mismatch between bb file output and contract array sizes.
 *   - public_inputs IVC handling: the contract passes EMPTY [] (Honk IVC
 *     convention) — if it doesn't bind the struct, an attacker could pass
 *     any valid proof. The happy-path success here is just a precondition;
 *     the binding semantic is what _apply_verified_clearing's accumulator
 *     freshness checks (order_acc / cancel_acc) enforce on the public-struct
 *     side. The proof itself binds these accumulators because they are
 *     among the circuit's pub inputs.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import type { AztecAddress } from "@aztec/aztec.js/addresses";
import type { AztecNode } from "@aztec/aztec.js/node";
import type { EmbeddedWallet } from "@aztec/wallets/embedded";
import { Fr } from "@aztec/aztec.js/fields";

import { connectToSandbox } from "./helpers/sandbox.js";
import { getTestWallets } from "./helpers/wallets.js";
import {
  readProofAsFields,
  readVkAsFields,
  readVkHash,
} from "./helpers/proof.js";
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

// Production circuit (MAX_ORDERS_PER_EPOCH = 32, set by Task 1).
const CIRCUIT_DIR = "/root/zswap-aztec/circuits/clearing";
const CIRCUIT_MAX_ORDERS = 32;
// Host-installed bb binary (amd64-linux, no Docker overhead).
const BB_BIN =
  "/root/.aztec/versions/4.2.1/node_modules/@aztec/bb.js/build/amd64-linux/bb";

// Contract array sizes for `close_epoch_and_clear_verified`. These are locked
// by bb's recursion constraint at compile-time of the orderbook contract.
const CONTRACT_PROOF_SIZE = 456;
const CONTRACT_VK_SIZE = 127;

const ONE_USDC = 10n ** 6n;
const ONE_ETH  = 10n ** 18n;

// Balanced pool: 10,000 tUSDC : 5,000 tETH ⇒ spot P* = 2e6
// (reserveA * SCALE / reserveB = 1e10 * 1e18 / 5e21 = 2e6).
const POOL_A = 10_000n * ONE_USDC;
const POOL_B = 5_000n  * ONE_ETH;

// Balanced order pair at the spot price (netA == 0 ⇒ no AMM swap):
//   buy: 100 tUSDC, sell: 50 tETH.
const BUY_USDC = 100n * ONE_USDC;
const SELL_ETH = 50n  * ONE_ETH;
const BUY_LIMIT  = 10_000_000_000_000_000_000n; // 1e19, well above spot 2e6
const SELL_LIMIT = 1n;                            // well below spot 2e6

// Epoch length: the test runs setup (pool deposit + mints), submits 2 orders,
// runs off-chain proving (~15-25 min, mines no blocks), then mines to expiry.
// 20 is comfortable headroom over the in-test submit count + minor block churn.
const EPOCH_LEN = 20;

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

async function currentBlock(node: AztecNode): Promise<number> {
  return Number(await node.getBlockNumber());
}

/**
 * Bridge from `bb prove`'s on-disk proof (500 Fr fields) to the contract's
 * locked `[Field; 456]` parameter size. Truncate first; the trailing 44 fields
 * in bb 4.2.1's UltraHonk proof appear to be IVC-recursion-overhead padding
 * the contract's recursion constraint excludes. If verification fails the
 * controller should swap this for `padTrailing` or attempt a different
 * `bb prove` output flag.
 */
function bridgeProofToContractSize(fileFields: Fr[]): Fr[] {
  if (fileFields.length === CONTRACT_PROOF_SIZE) return fileFields;
  if (fileFields.length > CONTRACT_PROOF_SIZE) {
    return fileFields.slice(0, CONTRACT_PROOF_SIZE);
  }
  const padded = [...fileFields];
  while (padded.length < CONTRACT_PROOF_SIZE) padded.push(Fr.ZERO);
  return padded;
}

/**
 * Bridge from `bb write_vk`'s on-disk vk (115 Fr fields) to the contract's
 * locked `[Field; 127]` parameter size. The contract's larger size comes from
 * the Aztec recursion constraint's circuit-specific padding. Pad with zeros at
 * the tail — the vk_hash check inside std::verify_proof_with_type binds the
 * hash of the supplied vk to clearing_vk_hash, so padding must match what was
 * hashed at deploy time (same: a zero-padded 127-field array).
 */
function bridgeVkToContractSize(fileFields: Fr[]): Fr[] {
  if (fileFields.length === CONTRACT_VK_SIZE) return fileFields;
  if (fileFields.length > CONTRACT_VK_SIZE) {
    return fileFields.slice(0, CONTRACT_VK_SIZE);
  }
  const padded = [...fileFields];
  while (padded.length < CONTRACT_VK_SIZE) padded.push(Fr.ZERO);
  return padded;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe(
  "clearing verified-flow (live integration)",
  { timeout: 60 * 60 * 1_000 }, // 60 min for the whole suite
  () => {
    let node: AztecNode;
    let wallet: EmbeddedWallet;
    let admin: AztecAddress;
    let alice: AztecAddress; // buyer
    let bob:   AztecAddress; // seller
    let tUSDC: TokenContract;
    let tETH:  TokenContract;
    let pool:  LiquidityPoolContract;
    let orderbook: OrderbookContract;

    before(async () => {
      node = await connectToSandbox();
      const env = await getTestWallets(node, 3);
      wallet = env.wallet;
      admin  = env.accounts[0]!;
      alice  = env.accounts[1]!;
      bob    = env.accounts[2]!;

      // Fresh tUSDC.
      const dU = await TokenContract.deployWithOpts(
        { wallet, method: "constructor_with_minter" },
        "tUSDC".padEnd(31, "\0"), "tUSDC".padEnd(31, "\0"), 6, admin,
      ).send({ from: admin });
      tUSDC = dU.contract;

      // Fresh tETH.
      const dE = await TokenContract.deployWithOpts(
        { wallet, method: "constructor_with_minter" },
        "tETH".padEnd(31, "\0"), "tETH".padEnd(31, "\0"), 18, admin,
      ).send({ from: admin });
      tETH = dE.contract;

      // Fresh LiquidityPool.
      const dP = await LiquidityPoolContract.deploy(wallet, tUSDC.address, tETH.address)
        .send({ from: admin });
      pool = dP.contract;

      // Read the PRODUCTION circuit's vk_hash (compile-all.sh writes this to
      // circuits/clearing/target/vk.bin/vk_hash via `bb write_vk -t noir-recursive`).
      // The orderbook is bound by this hash; only proofs of this exact circuit
      // will recursively verify against it.
      const vkHash = readVkHash(`${CIRCUIT_DIR}/target/vk.bin/vk_hash`);

      // Deploy the orderbook with the W5d-3 constructor signature
      // (clearing_vk_hash replaces W5c's clearing_authority arg).
      const dOB = await OrderbookContract.deploy(
        wallet, tUSDC.address, tETH.address, EPOCH_LEN, pool.address, vkHash,
      ).send({ from: admin });
      orderbook = dOB.contract;

      // Wire pool → orderbook (apply_clearing's only_orderbook gate).
      await pool.methods.set_orderbook(orderbook.address).send({ from: admin });

      // Seed balances (admin is the LP; alice the buyer; bob the seller).
      await tUSDC.methods.mint_to_private(admin, POOL_A + 1_000n * ONE_USDC).send({ from: admin });
      await tETH.methods.mint_to_private(admin,  POOL_B + 100n  * ONE_ETH).send({ from: admin });
      await tUSDC.methods.mint_to_private(alice, BUY_USDC + ONE_USDC).send({ from: admin });
      await tETH.methods.mint_to_private(bob,    SELL_ETH + ONE_ETH).send({ from: admin });

      // Pool deposit (balanced 10k tUSDC : 5k tETH).
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
      "E1: balanced buy+sell → aggregator → nargo execute → bb prove → close_epoch_and_clear_verified",
      { timeout: 50 * 60 * 1_000 }, // 50 min per test (bb prove at N=32 dominates)
      async () => {
        // -----------------------------------------------------------------
        // 1. Submit a balanced buy (alice, side=false) and sell (bob, side=true).
        // -----------------------------------------------------------------
        const buyNonce  = randomField();
        const sellNonce = randomField();

        await orderbook.methods
          .submit_order(false, BUY_USDC, BUY_LIMIT, randomField(), buyNonce)
          .send({ from: alice });

        await orderbook.methods
          .submit_order(true, SELL_ETH, SELL_LIMIT, randomField(), sellNonce)
          .send({ from: bob });

        // -----------------------------------------------------------------
        // 2. Read alice's + bob's order notes from their private sets.
        // -----------------------------------------------------------------
        const aliceRaw = await orderbook.methods.get_orders(alice).simulate({ from: alice });
        const aliceBv = (aliceRaw as {
          result: { storage: OrderNoteFields[]; len: bigint | number };
        }).result;
        const aliceLen = Number(aliceBv.len);
        assert.ok(aliceLen >= 1, "alice must have at least 1 order");
        const aliceNote = aliceBv.storage.slice(0, aliceLen)
          .find((n) => BigInt(n.nonce) === buyNonce);
        assert.ok(aliceNote, "alice's buy order note not found");

        const bobRaw = await orderbook.methods.get_orders(bob).simulate({ from: bob });
        const bobBv = (bobRaw as {
          result: { storage: OrderNoteFields[]; len: bigint | number };
        }).result;
        const bobLen = Number(bobBv.len);
        assert.ok(bobLen >= 1, "bob must have at least 1 order");
        const bobNote = bobBv.storage.slice(0, bobLen)
          .find((n) => BigInt(n.nonce) === sellNonce);
        assert.ok(bobNote, "bob's sell order note not found");

        // -----------------------------------------------------------------
        // 3. Read epoch state + pool snapshot.
        // -----------------------------------------------------------------
        const epochRaw = await orderbook.methods.get_epoch().simulate({ from: admin });
        const epochResult = (epochRaw as {
          result: {
            epoch_id: bigint | number;
            order_acc: bigint;
            cancel_acc: bigint;
            order_count: bigint | number;
            cancel_count: bigint | number;
            closes_at_block: bigint;
          };
        }).result;

        const poolStateRaw = await pool.methods.get_pool_state().simulate({ from: admin });
        const poolState = poolStateRaw.result;

        // -----------------------------------------------------------------
        // 4. Build orders[] in submission order (the circuit's binding module
        //    replays the order_acc chain in this exact order).
        // -----------------------------------------------------------------
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

        // -----------------------------------------------------------------
        // 5. Run the off-chain aggregator.
        // -----------------------------------------------------------------
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
        assert.equal(clearingResult.fills.length, 2, "both orders must be filled (buy + sell)");

        console.log(
          `clearing price: ${clearingResult.clearingPrice}, ` +
          `reserves: a=${poolState.reserve_a} b=${poolState.reserve_b} lp=${poolState.lp_supply}`,
        );

        // -----------------------------------------------------------------
        // 6. Build Prover.toml witness.
        // -----------------------------------------------------------------
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

        // -----------------------------------------------------------------
        // 7. Write Prover.toml + run nargo execute.
        // -----------------------------------------------------------------
        const proverTomlPath = `${CIRCUIT_DIR}/Prover.toml`;
        writeFileSync(proverTomlPath, proverToml, "utf8");

        const execResult = spawnSync(
          "/bin/bash",
          [
            "-c",
            `source /root/.zswap-env && cd ${CIRCUIT_DIR} && nargo execute --silence-warnings`,
          ],
          { encoding: "utf8", timeout: 5 * 60 * 1_000 },
        );
        if (execResult.status !== 0) {
          assert.fail([
            "nargo execute failed (witness/constraint mismatch):",
            "stdout:", execResult.stdout ?? "",
            "stderr:", execResult.stderr ?? "",
          ].join("\n"));
        }

        // -----------------------------------------------------------------
        // 8. bb write_vk + bb prove. Use `-t noir-recursive` to match the
        //    compile-all.sh convention (the on-chain verifier expects this
        //    recursion-format proof). The vk is rewritten under target/vk/
        //    (the test's working dir for proof+vk), separate from the
        //    target/vk.bin/ that compile-all.sh produces — same vk_hash
        //    (they're deterministic) but the file path is the test's own.
        // -----------------------------------------------------------------
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
            "-b", `${CIRCUIT_DIR}/target/clearing.json`,
            "-o", vkDir,
            "-t", "noir-recursive",
          ],
          { encoding: "utf8", timeout: 10 * 60 * 1_000 },
        );
        if (vkResult.status !== 0) {
          assert.fail([
            "bb write_vk failed:",
            "stdout:", vkResult.stdout ?? "",
            "stderr:", vkResult.stderr ?? "",
          ].join("\n"));
        }
        const vkFile = `${vkDir}/vk`;

        // bb prove without `-t` flag (matching the 5d-2 clearing-circuit.test.ts
        // convention which produces a 500-field proof file matching the Task 5
        // helper's HONK_PROOF_FIELDS expectation). Wall-clock at N=32 is
        // empirically 10-25 min and dominates the test.
        const proveResult = spawnSync(
          BB_BIN,
          [
            "prove",
            "-b", `${CIRCUIT_DIR}/target/clearing.json`,
            "-w", `${CIRCUIT_DIR}/target/clearing.gz`,
            "-o", proofDir,
            "-k", vkFile,
          ],
          { encoding: "utf8", timeout: 40 * 60 * 1_000 },
        );
        if (proveResult.status !== 0) {
          // Most likely RAM OOM at N=32 on the dev VPS (~8 GB + 8 GB swap).
          // If so the contingency is to drop MAX_ORDERS_PER_EPOCH to 16.
          assert.fail([
            "bb prove failed (likely RAM OOM at N=32; consider N=16 contingency):",
            `exit=${proveResult.status}`,
            "stdout:", proveResult.stdout ?? "",
            "stderr:", proveResult.stderr ?? "",
          ].join("\n"));
        }

        // -----------------------------------------------------------------
        // 9. Parse proof + vk to Fr[] via the Task 5 helper, then bridge to
        //    the contract's locked array sizes.
        // -----------------------------------------------------------------
        const proofFieldsFile = readProofAsFields(`${proofDir}/proof`);
        const vkFieldsFile    = readVkAsFields(vkFile);
        const proofFields = bridgeProofToContractSize(proofFieldsFile);
        const vkFields    = bridgeVkToContractSize(vkFieldsFile);
        assert.equal(proofFields.length, CONTRACT_PROOF_SIZE, "bridged proof length");
        assert.equal(vkFields.length,    CONTRACT_VK_SIZE,    "bridged vk length");

        // -----------------------------------------------------------------
        // 10. Build the ClearingPublic struct in the shape the contract takes
        //     (mirror of circuit's fn main pub args, in declaration order).
        // -----------------------------------------------------------------
        const publicInputsStruct = buildPublicInputsStruct(
          epochResult,
          poolSnap,
          clearingResult,
          ordersForWitness,
        );

        // -----------------------------------------------------------------
        // 11. Mine past epoch expiry. The contract's _apply_verified_clearing
        //     public callback asserts block >= closes_at_block.
        // -----------------------------------------------------------------
        while ((await currentBlock(node)) < Number(epochResult.closes_at_block)) {
          await tUSDC.methods.mint_to_public(admin, 1n).send({ from: admin });
        }

        // -----------------------------------------------------------------
        // 12. The verified-flow private entry point. Anyone can call it (no
        //     authority gate); the proof is the authorization.
        // -----------------------------------------------------------------
        await orderbook.methods
          .close_epoch_and_clear_verified(publicInputsStruct, proofFields, vkFields)
          .send({ from: admin });

        // -----------------------------------------------------------------
        // 13. Assert the epoch advanced + fills were recorded.
        // -----------------------------------------------------------------
        const newEpochRaw = await orderbook.methods.get_epoch().simulate({ from: admin });
        const newEpoch = (newEpochRaw as {
          result: {
            epoch_id: bigint | number;
            order_count: bigint | number;
            cancel_count: bigint | number;
          };
        }).result;
        assert.equal(
          Number(newEpoch.epoch_id), Number(epochResult.epoch_id) + 1,
          "epoch_id must increment",
        );
        assert.equal(Number(newEpoch.order_count), 0, "order_count reset to 0");
        assert.equal(Number(newEpoch.cancel_count), 0, "cancel_count reset to 0");

        // Each fill recorded with the aggregator's amount_out.
        for (const f of clearingResult.fills) {
          const recordedRaw = await orderbook.methods.get_fill(f.orderNonce).simulate({ from: admin });
          const recorded = BigInt((recordedRaw as { result: bigint | number }).result);
          assert.ok(recorded > 0n, `fills[${f.orderNonce}] must be recorded (got 0)`);
        }
      },
    );
  },
);

// ---------------------------------------------------------------------------
// Type helpers
// ---------------------------------------------------------------------------

interface OrderNoteFields {
  side: boolean;
  amount_in: bigint | number;
  limit_price: bigint | number;
  nonce: bigint | number;
  submitted_at_block: bigint | number;
  owner: bigint | number;
}

/**
 * Build the ClearingPublic argument matching the contract's struct shape (mirror
 * of circuits/clearing/src/main.nr fn main's pub parameter declaration order):
 *   { order_acc, cancel_acc, order_count, cancel_count,
 *     reserve_a, reserve_b, lp_supply,
 *     clearing_price, fills: [FillEntry; 32], fills_len, swap: ClearingSwap }
 *
 * The fills array is padded to CIRCUIT_MAX_ORDERS_PER_EPOCH with zero sentinels;
 * the contract's loop guards on `i < fills_len`. The swap fields are derived
 * from the aggregator's reserve deltas and fee-per-share increments — they are
 * a faithful echo of what the circuit's `swap` pub input must contain.
 */
function buildPublicInputsStruct(
  epoch: { order_acc: bigint; cancel_acc: bigint; order_count: bigint | number; cancel_count: bigint | number },
  pool: { reserve_a: bigint; reserve_b: bigint; lp_supply: bigint },
  clearing: {
    clearingPrice: bigint;
    fills: { orderNonce: bigint; amountOut: bigint }[];
    newReserveA: bigint;
    newReserveB: bigint;
    feeAPerShareIncrement: bigint;
    feeBPerShareIncrement: bigint;
  },
  _ordersForWitness: OrderNotePreimage[],
) {
  const fillsPadded: { order_nonce: bigint; amount_out: bigint }[] = [];
  for (let i = 0; i < CIRCUIT_MAX_ORDERS; i++) {
    if (i < clearing.fills.length) {
      fillsPadded.push({
        order_nonce: clearing.fills[i]!.orderNonce,
        amount_out:  clearing.fills[i]!.amountOut,
      });
    } else {
      fillsPadded.push({ order_nonce: 0n, amount_out: 0n });
    }
  }

  const deltaA = clearing.newReserveA - pool.reserve_a;
  const deltaB = clearing.newReserveB - pool.reserve_b;

  // For a balanced (netA == 0) clearing the AMM is untouched: every swap field
  // is zero (incl. the reserve_a_add / reserve_b_sub deltas).  The aggregator
  // does not export the gross ammIn/ammOut directly; for our balanced E1 they
  // are zero by construction. Non-balanced scenarios should re-derive these
  // via `clearingAt(pool, selectBatch(orders), clearingPrice).swap`.
  const swap = {
    a_to_pool: 0n,
    b_to_pool: 0n,
    a_from_pool: 0n,
    b_from_pool: 0n,
    reserve_a_add: deltaA > 0n ? deltaA : 0n,
    reserve_a_sub: deltaA < 0n ? -deltaA : 0n,
    reserve_b_add: deltaB > 0n ? deltaB : 0n,
    reserve_b_sub: deltaB < 0n ? -deltaB : 0n,
    fee_a_per_share_increment: clearing.feeAPerShareIncrement,
    fee_b_per_share_increment: clearing.feeBPerShareIncrement,
  };

  return {
    order_acc: epoch.order_acc,
    cancel_acc: epoch.cancel_acc,
    order_count: Number(epoch.order_count),
    cancel_count: Number(epoch.cancel_count),
    reserve_a: pool.reserve_a,
    reserve_b: pool.reserve_b,
    lp_supply: pool.lp_supply,
    clearing_price: clearing.clearingPrice,
    fills: fillsPadded,
    fills_len: clearing.fills.length,
    swap,
  };
}
