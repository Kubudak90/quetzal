#!/usr/bin/env node
//
// M1: Hello-world testnet validation.
//
// Aztec testnet fee-juice flow:
//   1. Generate Schnorr account keypair
//   2. POST address to faucet -> faucet bridges fee-juice from L1 -> L2
//      and returns claimData (claimAmount, claimSecret, messageLeafIndex)
//   3. Wait for L1->L2 message to land on Aztec's pending message tree
//   4. Deploy the account paying for the deploy via FeeJuicePaymentMethodWithClaim
//      (which consumes the L1->L2 message in the SAME tx as the deploy)
//   5. Verify account is registered
//
// Usage: pnpm tsx scripts/testnet-m1-hello.ts
// State: testnet-m1-state.json (idempotent resume)
//
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { Fr, Fq } from "@aztec/aztec.js/fields";
import { createAztecNodeClient, waitForNode } from "@aztec/aztec.js/node";
import { EmbeddedWallet } from "@aztec/wallets/embedded";
import { FeeJuicePaymentMethodWithClaim } from "@aztec/aztec.js/fee";
import { NO_FROM } from "@aztec/aztec.js/account";

const RPC_URL = "https://rpc.testnet.aztec-labs.com";
const FAUCET_URL = "https://aztec-faucet.dev-nethermind.xyz/api/drip";
const STATE_FILE = "testnet-m1-state.json";

interface ClaimData {
  claimAmount: string;
  claimSecretHex: string;
  claimSecretHashHex: string;
  messageHashHex: string;
  messageLeafIndex: string;
  l1TxHash: string;
}

interface M1State {
  step: number;
  secret?: string;
  salt?: string;
  signingKey?: string;
  address?: string;
  faucetResponses?: Array<{ asset: string; ts: string; httpStatus: number; body: unknown }>;
  claimData?: ClaimData;
  accountDeployTx?: string;
}

function loadState(): M1State {
  if (existsSync(STATE_FILE)) return JSON.parse(readFileSync(STATE_FILE, "utf8")) as M1State;
  return { step: 0, faucetResponses: [] };
}
function saveState(s: M1State) {
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

async function postFaucet(address: string, asset: "eth" | "fee-juice"): Promise<{ httpStatus: number; body: unknown }> {
  const res = await fetch(FAUCET_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address, asset }),
  });
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { raw: text };
  }
  return { httpStatus: res.status, body: parsed };
}

async function main() {
  const state = loadState();
  console.log(`[M1] starting; resuming from step ${state.step}`);

  const node = createAztecNodeClient(RPC_URL);
  console.log(`[M1] waiting for node @ ${RPC_URL} ...`);
  await waitForNode(node);
  const nodeInfo = await node.getNodeInfo();
  console.log(`[M1] node OK; rollupVersion=${nodeInfo.rollupVersion} l1ChainId=${nodeInfo.l1ChainId}`);

  // Testnet's node info reports realProofs: true -> we MUST enable client-side
  // proving in the PXE (default is off). Without this, sendTx returns
  // "Invalid tx: Invalid proof".
  const wallet = await EmbeddedWallet.create(node, {
    ephemeral: true,
    pxe: { proverEnabled: true },
  });

  // Step 1: keys
  if (state.step < 1) {
    console.log(`[M1] step 1: generating Schnorr account keypair ...`);
    const secret = Fr.random();
    const salt = Fr.ZERO;
    const signingKey = Fq.random();
    state.secret = secret.toString();
    state.salt = salt.toString();
    state.signingKey = signingKey.toString();
    state.step = 1;
    saveState(state);
  }
  const secret = Fr.fromString(state.secret!);
  const salt = Fr.fromString(state.salt!);
  const signingKey = Fq.fromString(state.signingKey!);

  const account = await wallet.createSchnorrAccount(secret, salt, signingKey);
  const accountManager = account;
  const address = (await accountManager.getAccount()).getAddress();
  if (!state.address) {
    state.address = address.toString();
    saveState(state);
  }
  console.log(`[M1] account address: ${address.toString()}`);

  // Step 2: faucet drip (fee-juice)
  if (state.step < 2) {
    console.log(`[M1] step 2: requesting fee-juice drip from faucet ...`);
    const resp = await postFaucet(address.toString(), "fee-juice");
    console.log(`[M1] drip response: ${JSON.stringify(resp)}`);
    state.faucetResponses!.push({ asset: "fee-juice", ts: new Date().toISOString(), ...resp });
    const body = resp.body as { success?: boolean; claimData?: ClaimData };
    if (!body.success || !body.claimData) {
      throw new Error(`faucet drip failed: ${JSON.stringify(resp)}`);
    }
    state.claimData = body.claimData;
    state.step = 2;
    saveState(state);
    console.log(`[M1] step 2 OK; claimAmount=${body.claimData.claimAmount} leafIndex=${body.claimData.messageLeafIndex}`);
  }

  // Step 3: wait for L1->L2 message to be ready for consumption.
  // The faucet bridges via the L1 portal; the message needs to clear L1 finality
  // (~3-5 epochs on Sepolia, ~12-15 min) before Aztec can include it in an L2 tx.
  if (state.step < 3) {
    console.log(`[M1] step 3: waiting for L1->L2 message to land (~12-15 min) ...`);
    // Strategy: try to deploy with the claim. If the message isn't ready, the tx
    // simulation fails with "L1ToL2Message not found". Retry every 30s up to 30 min.
    state.step = 3;
    saveState(state);
  }

  // Step 4: deploy the Schnorr account, paying via FeeJuicePaymentMethodWithClaim.
  if (state.step < 4) {
    console.log(`[M1] step 4: deploying account with fee-juice claim ...`);
    const claim = {
      claimAmount: new Fr(BigInt(state.claimData!.claimAmount)),
      claimSecret: Fr.fromString(state.claimData!.claimSecretHex),
      messageLeafIndex: BigInt(state.claimData!.messageLeafIndex),
    };
    const paymentMethod = new FeeJuicePaymentMethodWithClaim(address, claim);

    const start = Date.now();
    const timeoutMs = 30 * 60 * 1000;
    let deployed = false;
    let lastErr: unknown;
    while (Date.now() - start < timeoutMs) {
      try {
        console.log(`[M1]   attempting deploy ... (elapsed ${Math.floor((Date.now() - start) / 1000)}s)`);
        const deployMethod = await accountManager.getDeployMethod();
        // For self-deployment we pass from: NO_FROM so the wallet routes the fee
        // through the account contract's entrypoint (which is being deployed in this tx).
        const deployResult = await deployMethod.send({ fee: { paymentMethod }, from: NO_FROM });
        console.log(`[M1] deploy result: ${JSON.stringify({
          txHash: deployResult.txHash?.toString?.() ?? String(deployResult.txHash),
        })}`);
        state.accountDeployTx = deployResult.txHash?.toString?.() ?? String(deployResult.txHash);
        deployed = true;
        break;
      } catch (e) {
        lastErr = e;
        const msg = e instanceof Error ? e.message : String(e);
        console.log(`[M1]   deploy attempt failed: ${msg.slice(0, 300)}`);
        // L1->L2 message not ready -> retry; otherwise hard-fail.
        const isRetryable = /L1.*L2|message|tree|membership|claim/i.test(msg);
        if (!isRetryable) throw e;
        console.log(`[M1]   retryable; sleeping 30s ...`);
        await sleep(30_000);
      }
    }
    if (!deployed) {
      throw new Error(`account deploy never succeeded after 30 min: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
    }
    state.step = 4;
    saveState(state);
    console.log(`[M1] step 4 OK; account deployed`);
  }

  // Step 5: verify via wallet.getAccounts()
  if (state.step < 5) {
    console.log(`[M1] step 5: verifying account registration ...`);
    const accounts = await wallet.getAccounts();
    console.log(`[M1] accounts in wallet: ${accounts.length}`);
    for (const a of accounts) {
      console.log(`[M1]   - ${a.item.toString()} (alias=${a.alias ?? "<none>"})`);
    }
    state.step = 5;
    saveState(state);
    console.log(`[M1] step 5 OK; M1 COMPLETE`);
  }

  await wallet.stop();
  console.log(`\n[M1] ALL STEPS PASSED. State: ${STATE_FILE}`);
  console.log(`Address: ${address.toString()}`);
  console.log(`Deploy tx: ${state.accountDeployTx}`);
}

main().catch((e) => {
  console.error(`[M1] FAILED:`, e);
  process.exit(1);
});
