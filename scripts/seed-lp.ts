#!/usr/bin/env node
//
// Sub-8.2a: LP seed script — bootstrap initial liquidity into Quetzal's
// testnet pool 0 (tUSDC/tETH) so user orders have something to match against.
//
// State-persisted (idempotent): re-runs see "already seeded; skipping".
//
// Steps:
//   1. Load admin wallet from testnet-m1-state.json
//   2. Re-create admin Schnorr account; verify it matches quetzal.config.json
//      → admin (and that admin IS the minter for tUSDC + tETH).
//   3. Sanity-check admin's tUSDC private balance vs SEED_USDC; if short, mint
//      shortfall via mint_to_private (admin is minter, no authwit needed).
//      Same for tETH if we decide to escrow non-zero amount_b.
//   4. Read pool's get_pool_state() + get_bucket(TARGET_BUCKET) for hints.
//   5. Pre-compute the V3 deposit math via aggregator/src/buckets.ts so the
//      operator can see what'll happen BEFORE the on-chain submit. For a
//      fresh pool (current_sqrt_price = p_min_sqrt = bucket 0's sqrt_lower),
//      `sqrt_p <= sqrt_lower` holds for ANY bucket id ≥ 0 → math falls into
//      `computeDepositBelowRange` → used_a = amount_a, used_b = 0.
//      That is: only token A counts at fresh-pool state. We DEPOSIT ONLY
//      token A (amount_b = 0) to avoid a futile escrow + refund round-trip.
//   6. Call pool.deposit(...) with the prepared args.
//   7. Verify: re-read pool/bucket state + admin's PositionNote count. Confirm
//      bucket[TARGET_BUCKET].liquidity > 0 and admin has a fresh position.
//   8. Persist state.txHash + amounts + position_nonce + l_used to
//      seed-lp-state.json.
//
// SAFETY: refuses to run unless AZTEC_NODE_URL contains 'testnet'.
//
// Usage:
//   AZTEC_NODE_URL=https://rpc.testnet.aztec-labs.com pnpm tsx scripts/seed-lp.ts
//
// State file: seed-lp-state.json (gitignored)
//
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { Fr, Fq } from "@aztec/aztec.js/fields";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { createAztecNodeClient, waitForNode } from "@aztec/aztec.js/node";
import { EmbeddedWallet } from "@aztec/wallets/embedded";
import { TokenContract } from "../tests/integration/generated/Token.js";
import { LiquidityPoolContract } from "../tests/integration/generated/LiquidityPool.js";
import { computeDeposit, SCALE } from "../aggregator/src/buckets.js";

// ─── Config ───────────────────────────────────────────────────────────────

const NODE_URL = process.env.AZTEC_NODE_URL ?? "https://rpc.testnet.aztec-labs.com";
if (!NODE_URL.includes("testnet")) {
  throw new Error(
    `AZTEC_NODE_URL must contain 'testnet' (safety check). Got: ${NODE_URL}`,
  );
}

const M1_STATE  = "testnet-m1-state.json";
const CONFIG    = "quetzal.config.json";
const STATE     = "seed-lp-state.json";
// PXE dir. Defaults to Sub-9 testnet-m4-pxe (post-clean-slate redeploy).
// Override via SEED_LP_PXE_DIR to re-use a different PXE (e.g. testnet-m3-pxe).
const PXE_DIR   = process.env.SEED_LP_PXE_DIR ?? "./testnet-m4-pxe";

// Seed amounts. tUSDC has 6 decimals, tETH 18 decimals.
const ONE_TUSDC = 10n ** 6n;
const ONE_TETH  = 10n ** 18n;
const SEED_USDC = 5_000n * ONE_TUSDC;  // 5K tUSDC
const SEED_ETH  = 2n     * ONE_TETH;   // 2 tETH  (passed for spec completeness;
                                       //          math will refund all of it
                                       //          on a fresh pool — see step 5.)

// V3 bucket target. For a fresh pool (sqrt_p == p_min_sqrt), every bucket ≥ 0
// has sqrt_lower ≥ sqrt_p → math falls into BelowRange → token A only. Bucket
// 8 is a mid-range pick: if a future swap moves the pool sqrt_price up, this
// bucket starts to contribute on-range liquidity.
const TARGET_BUCKET = 8;

// ─── Types ────────────────────────────────────────────────────────────────

interface SeedState {
  step: number;
  txHash?: string;
  bucketId?: number;
  amountADeposited?: string;     // bigint as decimal string
  amountBDeposited?: string;
  lUsedExpected?: string;        // math-predicted l_used (bigint)
  positionNonce?: string;        // 0x-hex
  poolStateBefore?: {
    reserve_a: string;
    reserve_b: string;
    current_sqrt_price: string;
  };
  bucketStateBefore?: {
    reserve_a: string;
    reserve_b: string;
    liquidity: string;
    cum_fee_a_per_share: string;
    cum_fee_b_per_share: string;
  };
  poolStateAfter?: SeedState["poolStateBefore"];
  bucketStateAfter?: SeedState["bucketStateBefore"];
  positionCountAfter?: number;
  notes?: string[];
}

interface M1State {
  step: number;
  secret: string;
  salt: string;
  signingKey: string;
  address: string;
}

interface QuetzalConfig {
  nodeUrl: string;
  admin: string;
  tUSDC: string;
  tETH: string;
  pools: Array<{ pool_id: number; token_a: string; token_b: string; address: string }>;
  bucketPMinSqrt: string;
  bucketGrowthNum: string;
}

// ─── State helpers ────────────────────────────────────────────────────────

function loadState(): SeedState {
  if (existsSync(STATE)) return JSON.parse(readFileSync(STATE, "utf8")) as SeedState;
  return { step: 0, notes: [] };
}
function saveState(s: SeedState): void {
  writeFileSync(STATE, JSON.stringify(s, null, 2));
}
function noteAdd(s: SeedState, msg: string): void {
  s.notes = s.notes ?? [];
  s.notes.push(`${new Date().toISOString()} ${msg}`);
}

// ─── Pool / bucket helpers ────────────────────────────────────────────────

interface PoolStateHint {
  reserve_a: bigint;
  reserve_b: bigint;
  current_sqrt_price: bigint;
}
interface BucketStateHint {
  reserve_a: bigint;
  reserve_b: bigint;
  liquidity: bigint;
  cum_fee_a_per_share: bigint;
  cum_fee_b_per_share: bigint;
}

async function readPoolHint(
  pool: LiquidityPoolContract, from: AztecAddress,
): Promise<PoolStateHint> {
  const sim = await pool.methods.get_pool_state().simulate({ from });
  const r = (sim as { result: Record<string, bigint | number | undefined> }).result;
  return {
    reserve_a: BigInt(r.reserve_a as bigint | number),
    reserve_b: BigInt(r.reserve_b as bigint | number),
    current_sqrt_price: BigInt(r.current_sqrt_price as bigint | number),
  };
}

async function readBucketHint(
  pool: LiquidityPoolContract, bucketId: number, from: AztecAddress,
): Promise<BucketStateHint> {
  const sim = await pool.methods.get_bucket(bucketId).simulate({ from });
  const r = (sim as { result: Record<string, bigint | number | undefined> }).result;
  return {
    reserve_a: BigInt(r.reserve_a as bigint | number),
    reserve_b: BigInt(r.reserve_b as bigint | number),
    liquidity: BigInt(r.liquidity as bigint | number),
    cum_fee_a_per_share: BigInt(r.cum_fee_a_per_share as bigint | number),
    cum_fee_b_per_share: BigInt(r.cum_fee_b_per_share as bigint | number),
  };
}

// Mirrors contracts/pool/src/main.nr::compute_bucket_bounds.
function computeBucketBounds(
  pMinSqrt: bigint, growthNum: bigint, bucketId: number,
): { sqrt_lower: bigint; sqrt_upper: bigint } {
  let sqrtLower = pMinSqrt;
  for (let i = 0; i < bucketId; i++) {
    sqrtLower = (sqrtLower * growthNum) / SCALE;
  }
  const sqrtUpper = (sqrtLower * growthNum) / SCALE;
  return { sqrt_lower: sqrtLower, sqrt_upper: sqrtUpper };
}

async function readPrivateBalance(
  token: TokenContract, owner: AztecAddress,
): Promise<bigint> {
  const sim = await token.methods.balance_of_private(owner).simulate({ from: owner });
  return BigInt((sim as { result: bigint | number }).result);
}

// ─── Main ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // ── Preconditions ──────────────────────────────────────────────────────
  if (!existsSync(M1_STATE)) {
    throw new Error(`${M1_STATE} not found — bootstrap admin wallet first (testnet-m1-hello.ts)`);
  }
  if (!existsSync(CONFIG)) {
    throw new Error(`${CONFIG} not found — deploy core contracts first`);
  }

  const m1 = JSON.parse(readFileSync(M1_STATE, "utf8")) as M1State;
  if (m1.step < 5) {
    throw new Error(`M1 not complete (step=${m1.step}); admin wallet not deployed`);
  }
  const config = JSON.parse(readFileSync(CONFIG, "utf8")) as QuetzalConfig;
  const poolEntry = config.pools[0];
  if (!poolEntry) throw new Error("config.pools[0] missing");

  const state = loadState();
  console.log(`[seed-lp] starting; resuming from step ${state.step}`);
  console.log(`[seed-lp] node=${NODE_URL}`);
  console.log(`[seed-lp] pool=${poolEntry.address} (id=${poolEntry.pool_id})`);
  console.log(`[seed-lp] tokens: tUSDC=${config.tUSDC} tETH=${config.tETH}`);
  console.log(`[seed-lp] seed: ${SEED_USDC} tUSDC atomic + ${SEED_ETH} tETH atomic → bucket ${TARGET_BUCKET}`);

  if (state.step >= 7 && state.txHash) {
    console.log(`[seed-lp] ALREADY SEEDED at txHash=${state.txHash}; bucket=${state.bucketId} amountA=${state.amountADeposited} amountB=${state.amountBDeposited}`);
    console.log("[seed-lp] delete seed-lp-state.json to re-seed.");
    return;
  }

  // ── Step 1: connect node + load admin wallet (non-ephemeral PXE) ──────
  const node = createAztecNodeClient(NODE_URL);
  console.log(`[seed-lp] step 1: connecting to node @ ${NODE_URL} ...`);
  await waitForNode(node);
  const nodeInfo = await node.getNodeInfo();
  console.log(`[seed-lp]   node OK; rollupVersion=${nodeInfo.rollupVersion} l1ChainId=${nodeInfo.l1ChainId}`);

  // Re-use the M3 PXE so contract classes/instances (tUSDC, tETH, pool) are
  // already registered. M3 deployed all three through this same PXE store.
  const wallet = await EmbeddedWallet.create(node, {
    ephemeral: false,
    pxe: {
      proverEnabled: true,
      dataDirectory: PXE_DIR,
    },
  });

  const secret    = Fr.fromString(m1.secret);
  const salt      = Fr.fromString(m1.salt);
  const signingKey = Fq.fromString(m1.signingKey);
  const adminManager = await wallet.createSchnorrAccount(secret, salt, signingKey);
  const admin = (await adminManager.getAccount()).getAddress();
  console.log(`[seed-lp]   admin recreated: ${admin.toString()}`);

  // Verify admin matches config.
  if (admin.toString() !== m1.address) {
    throw new Error(`admin address mismatch vs M1: ${admin.toString()} vs ${m1.address}`);
  }
  if (admin.toString().toLowerCase() !== config.admin.toLowerCase()) {
    throw new Error(
      `admin address mismatch vs config: ${admin.toString()} vs ${config.admin}`,
    );
  }
  console.log(`[seed-lp]   admin matches config.admin ✓`);

  // Construct contract handles. Use AztecAddress (strict type) for the
  // ContractClass.at() bindings.
  const tUSDCAddr = AztecAddress.fromString(config.tUSDC);
  const tETHAddr  = AztecAddress.fromString(config.tETH);
  const poolAddr  = AztecAddress.fromString(poolEntry.address);

  const tUSDC = await TokenContract.at(tUSDCAddr, wallet);
  const tETH  = await TokenContract.at(tETHAddr, wallet);
  const pool  = await LiquidityPoolContract.at(poolAddr, wallet);

  // ── Step 2: check + top up admin's tUSDC PRIVATE balance ───────────────
  if (state.step < 2) {
    console.log(`[seed-lp] step 2: checking admin's tUSDC PRIVATE balance ...`);
    const usdcBal = await readPrivateBalance(tUSDC, admin);
    console.log(`[seed-lp]   admin tUSDC private balance: ${usdcBal}`);
    if (usdcBal < SEED_USDC) {
      const shortfall = SEED_USDC - usdcBal;
      console.log(`[seed-lp]   shortfall ${shortfall} tUSDC atomic → mint_to_private(admin, shortfall) ...`);
      const t0 = Date.now();
      await tUSDC.methods.mint_to_private(admin, shortfall).send({ from: admin });
      console.log(`[seed-lp]   mint OK (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
      noteAdd(state, `minted ${shortfall} tUSDC to admin private (had ${usdcBal})`);
    } else {
      console.log(`[seed-lp]   sufficient balance; no mint needed`);
    }
    state.step = 2;
    saveState(state);
  } else {
    console.log(`[seed-lp] step 2 cached`);
  }

  // ── Step 3: same for tETH (only if we elect to send amount_b > 0) ─────
  // For a fresh pool the math discards amount_b. We still expose this step
  // because a re-seed at a non-fresh pool (sqrt_p moved) may need tETH.
  if (state.step < 3) {
    if (SEED_ETH > 0n) {
      console.log(`[seed-lp] step 3: checking admin's tETH PRIVATE balance ...`);
      const ethBal = await readPrivateBalance(tETH, admin);
      console.log(`[seed-lp]   admin tETH private balance: ${ethBal}`);
      if (ethBal < SEED_ETH) {
        const shortfall = SEED_ETH - ethBal;
        console.log(`[seed-lp]   shortfall ${shortfall} tETH atomic → mint_to_private(admin, shortfall) ...`);
        const t0 = Date.now();
        await tETH.methods.mint_to_private(admin, shortfall).send({ from: admin });
        console.log(`[seed-lp]   mint OK (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
        noteAdd(state, `minted ${shortfall} tETH to admin private (had ${ethBal})`);
      } else {
        console.log(`[seed-lp]   sufficient balance; no mint needed`);
      }
    } else {
      console.log(`[seed-lp] step 3 skipped (SEED_ETH=0)`);
    }
    state.step = 3;
    saveState(state);
  } else {
    console.log(`[seed-lp] step 3 cached`);
  }

  // ── Step 4: read pool + bucket state (hints) ──────────────────────────
  console.log(`[seed-lp] step 4: reading pool + bucket ${TARGET_BUCKET} state for hints ...`);
  const poolHint   = await readPoolHint(pool, admin);
  const bucketHint = await readBucketHint(pool, TARGET_BUCKET, admin);
  console.log(`[seed-lp]   pool.current_sqrt_price: ${poolHint.current_sqrt_price}`);
  console.log(`[seed-lp]   pool.reserve_a: ${poolHint.reserve_a}`);
  console.log(`[seed-lp]   pool.reserve_b: ${poolHint.reserve_b}`);
  console.log(`[seed-lp]   bucket[${TARGET_BUCKET}].liquidity: ${bucketHint.liquidity}`);
  state.poolStateBefore = {
    reserve_a: poolHint.reserve_a.toString(),
    reserve_b: poolHint.reserve_b.toString(),
    current_sqrt_price: poolHint.current_sqrt_price.toString(),
  };
  state.bucketStateBefore = {
    reserve_a: bucketHint.reserve_a.toString(),
    reserve_b: bucketHint.reserve_b.toString(),
    liquidity: bucketHint.liquidity.toString(),
    cum_fee_a_per_share: bucketHint.cum_fee_a_per_share.toString(),
    cum_fee_b_per_share: bucketHint.cum_fee_b_per_share.toString(),
  };
  saveState(state);

  // ── Step 5: pre-compute V3 deposit math (off-chain dry-run) ───────────
  const pMinSqrt = BigInt(config.bucketPMinSqrt);
  const growthNum = BigInt(config.bucketGrowthNum);
  const bounds = computeBucketBounds(pMinSqrt, growthNum, TARGET_BUCKET);
  console.log(`[seed-lp] step 5: dry-running deposit math ...`);
  console.log(`[seed-lp]   bucket[${TARGET_BUCKET}].sqrt_lower: ${bounds.sqrt_lower}`);
  console.log(`[seed-lp]   bucket[${TARGET_BUCKET}].sqrt_upper: ${bounds.sqrt_upper}`);
  console.log(`[seed-lp]   pool.current_sqrt_price        : ${poolHint.current_sqrt_price}`);

  let depositAmountB = SEED_ETH;
  let regime: "below" | "in-range" | "above";
  if (poolHint.current_sqrt_price <= bounds.sqrt_lower) {
    regime = "below";
    console.log(`[seed-lp]   regime: BelowRange — only token A counts; tETH would be fully refunded`);
    console.log(`[seed-lp]   ⇒ setting amount_b=0 to skip a futile escrow + refund round-trip`);
    depositAmountB = 0n;
  } else if (poolHint.current_sqrt_price >= bounds.sqrt_upper) {
    regime = "above";
    console.log(`[seed-lp]   regime: AboveRange — only token B counts; tUSDC would be fully refunded`);
    // Not the seed-script's expected path, but handle for correctness:
    // we don't override amounts here because operator was explicit about both.
  } else {
    regime = "in-range";
    console.log(`[seed-lp]   regime: InRange — both tokens deposited proportionally`);
  }

  const math = computeDeposit(SEED_USDC, depositAmountB, poolHint.current_sqrt_price, bounds);
  console.log(`[seed-lp]   math.l_used: ${math.l_used}`);
  console.log(`[seed-lp]   math.used_a: ${math.used_a}`);
  console.log(`[seed-lp]   math.used_b: ${math.used_b}`);
  if (math.l_used === 0n) {
    throw new Error(
      `dry-run computed l_used == 0; the deposit would revert. ` +
      `regime=${regime} amount_a=${SEED_USDC} amount_b=${depositAmountB}. ` +
      `Pick a different bucket or amount.`,
    );
  }
  state.lUsedExpected = math.l_used.toString();
  saveState(state);

  // ── Step 6: submit pool.deposit ───────────────────────────────────────
  if (state.step < 6) {
    console.log(`[seed-lp] step 6: pool.deposit(${TARGET_BUCKET}, ${SEED_USDC}, ${depositAmountB}, ...) ...`);
    const nonceA = Fr.random();
    // Use Fr.ZERO for the unused nonce — the contract's
    // `if amount_b > 0` guard skips the transfer when amount_b == 0.
    const nonceB = depositAmountB > 0n ? Fr.random() : Fr.ZERO;
    const positionNonce = Fr.random();
    state.positionNonce = positionNonce.toString();
    state.bucketId = TARGET_BUCKET;
    state.amountADeposited = SEED_USDC.toString();
    state.amountBDeposited = depositAmountB.toString();
    saveState(state);

    const t0 = Date.now();
    let lastErr: unknown;
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        console.log(`[seed-lp]   attempt ${attempt}/${maxAttempts} ...`);
        // Re-read hints on retry — sequencer may have applied a clearing
        // between dry-run and submit, which would shift pool/bucket state.
        const ph = await readPoolHint(pool, admin);
        const bh = await readBucketHint(pool, TARGET_BUCKET, admin);

        const tx = pool.methods.deposit(
          TARGET_BUCKET,
          SEED_USDC,
          depositAmountB,
          {
            reserve_a: ph.reserve_a,
            reserve_b: ph.reserve_b,
            current_sqrt_price: ph.current_sqrt_price,
          },
          {
            reserve_a: bh.reserve_a,
            reserve_b: bh.reserve_b,
            liquidity: bh.liquidity,
            cum_fee_a_per_share: bh.cum_fee_a_per_share,
            cum_fee_b_per_share: bh.cum_fee_b_per_share,
          },
          nonceA,
          nonceB,
          positionNonce,
        );
        const sent = await tx.send({ from: admin });
        // txHash is exposed on the mined result at runtime even though
        // TxSendResultMined's public type doesn't declare it; mirrors the
        // pattern in scripts/lib/aztec-wallet-bootstrap.ts.
        const sentAny = sent as unknown as { txHash?: { toString(): string } | string };
        const txHashStr = typeof sentAny.txHash === "object"
          ? (sentAny.txHash?.toString() ?? String(sentAny.txHash))
          : String(sentAny.txHash);
        console.log(`[seed-lp]   deposit submitted; txHash=${txHashStr} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
        state.txHash = txHashStr;
        state.step = 6;
        saveState(state);
        break;
      } catch (e) {
        lastErr = e;
        const msg = e instanceof Error ? e.message : String(e);
        console.log(`[seed-lp]   attempt ${attempt} failed: ${msg.slice(0, 400)}`);
        const isRetryable = /pool_state changed|bucket_state changed|hint|retry|tag|nonce|sequencer/i.test(msg);
        if (!isRetryable || attempt === maxAttempts) {
          noteAdd(state, `deposit failed after ${attempt} attempts: ${msg.slice(0, 200)}`);
          saveState(state);
          throw e;
        }
        console.log(`[seed-lp]   retryable; sleeping 20s + re-reading hints ...`);
        await sleep(20_000);
      }
    }
    if (!state.txHash) {
      throw new Error(`deposit never succeeded; last error: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
    }
  } else {
    console.log(`[seed-lp] step 6 cached; txHash=${state.txHash}`);
  }

  // ── Step 7: verify ────────────────────────────────────────────────────
  if (state.step < 7) {
    console.log(`[seed-lp] step 7: verifying on-chain state ...`);
    const phAfter = await readPoolHint(pool, admin);
    const bhAfter = await readBucketHint(pool, TARGET_BUCKET, admin);

    // PositionNote count — guarded since some PXE versions return slightly
    // different shapes. We tolerate missing data.
    let positionCount = -1;
    try {
      const posSim = await pool.methods.get_positions(admin).simulate({ from: admin });
      const bv = (posSim as { result: { storage: unknown[]; len: bigint | number } }).result;
      positionCount = Number(bv.len);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.log(`[seed-lp]   WARN: get_positions failed (${msg.slice(0, 120)}); skipping count check`);
    }

    state.poolStateAfter = {
      reserve_a: phAfter.reserve_a.toString(),
      reserve_b: phAfter.reserve_b.toString(),
      current_sqrt_price: phAfter.current_sqrt_price.toString(),
    };
    state.bucketStateAfter = {
      reserve_a: bhAfter.reserve_a.toString(),
      reserve_b: bhAfter.reserve_b.toString(),
      liquidity: bhAfter.liquidity.toString(),
      cum_fee_a_per_share: bhAfter.cum_fee_a_per_share.toString(),
      cum_fee_b_per_share: bhAfter.cum_fee_b_per_share.toString(),
    };
    state.positionCountAfter = positionCount;
    state.step = 7;
    saveState(state);

    console.log(`SEED VERIFIED:`);
    console.log(`  pool.current_sqrt_price: ${phAfter.current_sqrt_price}`);
    console.log(`  pool.reserve_a (total):  ${phAfter.reserve_a}`);
    console.log(`  pool.reserve_b (total):  ${phAfter.reserve_b}`);
    console.log(`  bucket[${TARGET_BUCKET}].liquidity:    ${bhAfter.liquidity}`);
    console.log(`  bucket[${TARGET_BUCKET}].reserve_a:    ${bhAfter.reserve_a}`);
    console.log(`  bucket[${TARGET_BUCKET}].reserve_b:    ${bhAfter.reserve_b}`);
    if (positionCount >= 0) {
      console.log(`  admin.position_count:    ${positionCount}`);
    }

    if (bhAfter.liquidity === 0n) {
      throw new Error(
        `verify failed: bucket[${TARGET_BUCKET}].liquidity is still 0 after deposit ` +
        `(expected ~${state.lUsedExpected}). On-chain state did not update.`,
      );
    }
  } else {
    console.log(`[seed-lp] step 7 cached`);
  }

  // ── Summary ───────────────────────────────────────────────────────────
  console.log("");
  console.log(`[seed-lp] ALL STEPS PASSED.`);
  console.log(`[seed-lp]   pool:        ${poolEntry.address}`);
  console.log(`[seed-lp]   bucket:      ${state.bucketId}`);
  console.log(`[seed-lp]   amount_a:    ${state.amountADeposited} tUSDC atomic`);
  console.log(`[seed-lp]   amount_b:    ${state.amountBDeposited} tETH atomic`);
  console.log(`[seed-lp]   l_used:      ${state.lUsedExpected} (expected, math)`);
  console.log(`[seed-lp]   position:    ${state.positionNonce}`);
  console.log(`[seed-lp]   txHash:      ${state.txHash}`);
  console.log(`[seed-lp]   explorer:    https://aztecscan.xyz/tx-effects/${state.txHash}`);

  await wallet.stop();
}

main().catch((e) => {
  console.error(`[seed-lp] FAILED:`, e);
  console.error(`[seed-lp] partial state persisted to ${STATE}; re-run to resume.`);
  process.exit(1);
});
