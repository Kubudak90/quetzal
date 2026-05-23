import { setTimeout as sleep } from "node:timers/promises";
import {
  createPublicClient,
  createWalletClient,
  http,
  type Hex,
  type Address,
} from "viem";
import { mainnet, sepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { buildOutboxProof, type OutboxProof } from "../../cli/src/bridge-helpers.js";
import { loadConfig } from "../../cli/src/config.js";
import { TreasuryContract } from "../../tests/integration/generated/Treasury.js";
import { openCli } from "../../cli/src/wallet.js";
import { AztecAddress } from "@aztec/aztec.js/addresses";

const TOKEN_BRIDGE_WITHDRAW_ABI = [
  {
    name: "withdraw",
    inputs: [
      { name: "amount", type: "uint256" },
      { name: "recipient", type: "address" },
      { name: "l2Epoch", type: "uint256" },
      { name: "leafIndex", type: "uint256" },
      { name: "siblingPath", type: "bytes32[]" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    name: "withdrawPrivate",
    inputs: [
      { name: "amount", type: "uint256" },
      { name: "recipient", type: "address" },
      { name: "l2Epoch", type: "uint256" },
      { name: "leafIndex", type: "uint256" },
      { name: "siblingPath", type: "bytes32[]" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

export interface RelayerConfig {
  /** Aztec node RPC URL (read Treasury queue + build outbox proofs) */
  aztecNodeUrl: string;
  /** L1 RPC URL for viem writeContract calls */
  l1RpcUrl: string;
  /** Relayer's L1 private key for withdraw tx submission */
  l1PrivateKey: Hex;
  /** L2 Treasury contract address */
  treasuryAddr: string;
  /** Map: L1 bridge address (lowercased) → token identifier */
  bridgesByAddress: Record<string, "USDC" | "WETH" | "wBTC">;
  /** Aztec account index in the wallet (for simulating treasury reads) */
  accountIndex?: number;
}

interface PendingClaim {
  id: bigint;
  l2TxHash: string;
  expectedContent: string;
  l1Recipient: string;
  amount: bigint;
  fee: bigint;
  bridgeAddr: string;
  isPrivate: boolean;
}

/**
 * Sub-5c D2: relayer daemon loop.
 *
 * Polls Treasury.pending_relayer_claims every 60s. For each claim:
 *   1. Build L2→L1 outbox proof via the subprocess binary (A3)
 *   2. Submit L1 TokenBridge.withdraw[Private] via viem
 *   3. Consume the claim on L2 → Treasury pays the fee out of tracked_balance
 *
 * Anyone can call consume_relayer_claim; the L1 withdraw is the gating step
 * (only succeeds once per (epoch, leafIndex) due to Outbox replay guard).
 * First relayer to land the L1 tx wins the fee.
 *
 * Activation: set RELAYER_MODE=1 + L1_RPC_URL + L1_PRIVATE_KEY env vars
 * before starting the aggregator daemon.
 */
export async function runRelayerLoop(cfg: RelayerConfig): Promise<void> {
  console.log("relayer-mode: starting loop");
  console.log(`  aztec node: ${cfg.aztecNodeUrl}`);
  console.log(`  l1 rpc:     ${cfg.l1RpcUrl}`);
  console.log(`  treasury:   ${cfg.treasuryAddr}`);

  const chain = cfg.l1RpcUrl.includes("sepolia") ? sepolia : mainnet;
  const relayerAccount = privateKeyToAccount(cfg.l1PrivateKey);
  const walletClient = createWalletClient({
    chain,
    transport: http(cfg.l1RpcUrl),
    account: relayerAccount,
  });
  const publicClient = createPublicClient({
    chain,
    transport: http(cfg.l1RpcUrl),
  });

  // Open Aztec L2 connection (for Treasury simulate calls)
  const fullConfig = loadConfig();
  const ctx = await openCli(fullConfig, cfg.accountIndex ?? 0);

  try {
    while (true) {
      try {
        const queue = await fetchPendingClaims(ctx, cfg.treasuryAddr);
        if (queue.length > 0) {
          console.log(`relayer-mode: ${queue.length} pending claim(s)`);
        }
        for (const claim of queue) {
          try {
            await processClaim(claim, cfg, publicClient, walletClient, ctx);
          } catch (e) {
            console.error(
              `relayer-mode: claim ${claim.id} failed:`,
              e instanceof Error ? e.message : String(e),
            );
            // Don't break the outer loop on one claim failure
          }
        }
      } catch (e) {
        console.error(
          "relayer-mode: poll iteration failed:",
          e instanceof Error ? e.message : String(e),
        );
      }
      await sleep(60_000);
    }
  } finally {
    await ctx.stop();
  }
}

async function fetchPendingClaims(
  ctx: Awaited<ReturnType<typeof openCli>>,
  treasuryAddr: string,
): Promise<PendingClaim[]> {
  const treasury = await TreasuryContract.at(
    AztecAddress.fromString(treasuryAddr),
    ctx.wallet,
  );

  // Cast through any: D1 added queue_relayer_claim + consume_relayer_claim +
  // get_pending_relayer_claims_count but codegen bindings have not been
  // regenerated yet (Treasury.ts still reflects the pre-D1 state).
  const treasuryDyn = treasury as unknown as {
    methods: {
      get_pending_relayer_claims_count: () => { simulate: () => Promise<bigint> };
    };
  };

  const count = await treasuryDyn.methods.get_pending_relayer_claims_count().simulate();
  if (count === 0n) return [];

  // For each slot 0..count, read the claim via a per-slot view function.
  // NOTE: if D1 didn't add `get_pending_relayer_claim_at(u32) -> RelayerClaim`
  // to the Treasury contract, add it now:
  //
  //   #[aztec(public)] #[aztec(view)]
  //   fn get_pending_relayer_claim_at(index: u32) -> RelayerClaim {
  //     storage.pending_relayer_claims.at(index).read()
  //   }
  //
  // Until that view function is present, we log a warning and idle harmlessly.
  const treasuryWithSlot = treasury as unknown as {
    methods: {
      get_pending_relayer_claim_at: (index: bigint) => {
        simulate: () => Promise<{
          id: bigint;
          l2_tx_hash: string;
          expected_content: string;
          l1_recipient: string;
          amount: bigint;
          fee: bigint;
          bridge_addr: string;
          is_private: boolean;
        }>;
      };
    };
  };

  // Check whether the per-slot view exists by probing the methods object.
  if (
    !(
      "get_pending_relayer_claim_at" in
      (treasuryWithSlot.methods as unknown as Record<string, unknown>)
    )
  ) {
    console.warn(
      `relayer-mode: get_pending_relayer_claim_at(u32) view not yet wired in Treasury. ` +
        `Queue has ${count} claim(s) but daemon cannot read details. ` +
        `Add the view function in a follow-up + re-run.`,
    );
    return [];
  }

  const claims: PendingClaim[] = [];
  for (let i = 0n; i < count; i++) {
    try {
      const raw = await treasuryWithSlot.methods
        .get_pending_relayer_claim_at(i)
        .simulate();
      claims.push({
        id: raw.id,
        l2TxHash: raw.l2_tx_hash,
        expectedContent: raw.expected_content,
        l1Recipient: raw.l1_recipient,
        amount: raw.amount,
        fee: raw.fee,
        bridgeAddr: raw.bridge_addr,
        isPrivate: raw.is_private,
      });
    } catch (e) {
      console.error(
        `relayer-mode: failed to read claim at slot ${i}:`,
        e instanceof Error ? e.message : String(e),
      );
    }
  }
  return claims;
}

async function processClaim(
  claim: PendingClaim,
  cfg: RelayerConfig,
  publicClient: ReturnType<typeof createPublicClient>,
  walletClient: ReturnType<typeof createWalletClient>,
  ctx: Awaited<ReturnType<typeof openCli>>,
): Promise<void> {
  // 1. Build outbox proof via the subprocess binary
  let proof: OutboxProof;
  try {
    proof = await buildOutboxProof(
      cfg.aztecNodeUrl,
      claim.l2TxHash,
      claim.expectedContent,
    );
  } catch (e) {
    console.error(
      `  claim ${claim.id}: proof build failed:`,
      e instanceof Error ? e.message : String(e),
    );
    return;
  }

  // 2. Submit L1 withdraw or withdrawPrivate
  const functionName = claim.isPrivate ? "withdrawPrivate" : "withdraw";
  console.log(
    `  claim ${claim.id}: submitting L1 ${functionName} to ${claim.bridgeAddr}`,
  );

  const txHash = await (walletClient as ReturnType<typeof createWalletClient> & {
    writeContract: (args: unknown) => Promise<Hex>;
  }).writeContract({
    address: claim.bridgeAddr as Address,
    abi: TOKEN_BRIDGE_WITHDRAW_ABI,
    functionName,
    args: [
      claim.amount,
      claim.l1Recipient as Address,
      proof.l2Epoch,
      proof.leafIndex,
      proof.siblingPath as readonly Hex[],
    ],
  } as any);

  // Wait for L1 inclusion
  await publicClient.waitForTransactionReceipt({ hash: txHash });
  console.log(`  claim ${claim.id}: L1 ${functionName} mined at ${txHash}`);

  // 3. Consume the claim on L2 (Treasury pays the fee to this relayer)
  const treasury = await TreasuryContract.at(
    AztecAddress.fromString(cfg.treasuryAddr),
    ctx.wallet,
  );
  const treasuryDyn = treasury as unknown as {
    methods: {
      consume_relayer_claim: (id: bigint) => {
        send: (args: { from: AztecAddress }) => Promise<unknown>;
      };
    };
  };
  await treasuryDyn.methods.consume_relayer_claim(claim.id).send({ from: ctx.account });
  console.log(
    `  claim ${claim.id}: consumed; fee ${claim.fee} paid to relayer`,
  );
}
