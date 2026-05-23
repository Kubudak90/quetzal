import { Fr } from "@aztec/aztec.js/fields";
import { createAztecNodeClient } from "@aztec/aztec.js/node";
import { TxHash } from "@aztec/aztec.js/tx";

/**
 * Sub-5b: L2→L1 Outbox proof retrieval interface.
 *
 * After a maker calls aUSDC.exit_to_l1_*, they need three values to
 * call USDCBridge.withdraw on L1:
 *   - l2Epoch: the rollup epoch containing the L2→L1 message
 *   - leafIndex: the leaf position in that epoch's Outbox tree
 *   - siblingPath: Merkle proof from leaf to Outbox root
 *
 * D2 status: the lookup half (find epoch + leafIndex) is wired against
 * aztec.js's getL2ToL1Messages + getTxEffect APIs. The siblingPath
 * construction needs Aztec's internal merkle-tree-builder; we surface
 * the partial result and instruct the operator to invoke the testnet
 * runner (which vendors the helper) for the full proof.
 */

export interface OutboxLookup {
  /** L2 rollup epoch containing the L2→L1 message. */
  l2Epoch: bigint;

  /** Flat leaf index across the epoch's outbox tree (matches IOutbox.consume's _leafIndex). */
  leafIndex: bigint;

  /** Hex-encoded 32-byte content hash committed on L2. */
  content: string;
}

export interface OutboxProof extends OutboxLookup {
  /** Hex-encoded sibling hashes from leaf to Outbox root. */
  siblingPath: string[];
}

/**
 * Look up which (l2Epoch, leafIndex) holds a specific L2→L1 message.
 *
 * Implements the search via two aztec.js node calls:
 *   1. getTxEffect(txHash) → epoch number for the tx
 *   2. getL2ToL1Messages(epoch) → nested Fr[][][][] of message hashes
 *      indexed by [checkpoint][block][tx][message]. The Aztec
 *      Outbox flattens this into a single leaf-indexed tree per epoch.
 *
 * @param nodeUrl          Aztec node RPC URL
 * @param l2TxHash         L2 tx hash of the exit_to_l1_* call (0x-prefixed)
 * @param expectedContent  0x-prefixed bytes32 the maker computed locally
 * @returns OutboxLookup or throws if not found
 */
export async function lookupOutboxMessage(
  nodeUrl: string,
  l2TxHash: string,
  expectedContent: string,
): Promise<OutboxLookup> {
  if (!l2TxHash.startsWith("0x")) {
    throw new Error(`l2TxHash must be 0x-prefixed, got: ${l2TxHash}`);
  }
  if (!expectedContent.startsWith("0x") || expectedContent.length !== 66) {
    throw new Error(
      `expectedContent must be a 0x-prefixed 32-byte hash (66 chars total), got: ${expectedContent}`,
    );
  }

  const node = createAztecNodeClient(nodeUrl);
  // Cast through unknown — TxHash.fromString is the canonical constructor;
  // if aztec.js renames it across versions, surface the failure clearly.
  const txHash = (TxHash as unknown as { fromString: (s: string) => TxHash }).fromString(l2TxHash);

  // 1. Find which epoch contained the tx
  const effect = await (node as unknown as {
    getTxEffect: (h: TxHash) => Promise<
      { data?: { l2ToL1Msgs?: Fr[] }; l2BlockNumber?: number; epochNumber?: number } | undefined
    >;
  }).getTxEffect(txHash);

  if (!effect) {
    throw new Error(`L2 tx ${l2TxHash} not found (not yet mined? wrong node URL?)`);
  }

  // The IndexedTxEffect type wraps a TxEffect with DataInBlock metadata.
  // The exact field shape varies across aztec.js versions; cast and probe.
  const epochField =
    (effect as unknown as { epochNumber?: number; epoch?: number; data?: { epoch?: number } });
  const epoch = epochField.epochNumber ?? epochField.epoch ?? epochField.data?.epoch;
  if (epoch === undefined || epoch === null) {
    throw new Error(
      `getTxEffect returned no epoch info for ${l2TxHash}. ` +
      `Cannot determine which epoch's outbox holds the L2→L1 message.`,
    );
  }
  const l2Epoch = BigInt(epoch);

  // 2. Enumerate all L2→L1 messages in that epoch
  const messages = await (node as unknown as {
    getL2ToL1Messages: (epoch: number | bigint) => Promise<Fr[][][][]>;
  }).getL2ToL1Messages(Number(l2Epoch));

  // 3. Flatten + locate our content hash
  // messages[checkpointIdx][blockIdx][txIdx][msgIdx] → Fr
  // The Outbox tree is constructed by flattening in [checkpoint][block][tx][msg] order.
  const expectedLower = expectedContent.toLowerCase();
  let flatLeafIndex = 0n;
  let found = false;
  outer: for (const checkpoint of messages) {
    for (const block of checkpoint) {
      for (const tx of block) {
        for (const msg of tx) {
          const msgHex = (msg as Fr).toString().toLowerCase();
          if (msgHex === expectedLower) {
            found = true;
            break outer;
          }
          flatLeafIndex += 1n;
        }
      }
    }
  }

  if (!found) {
    throw new Error(
      `L2→L1 message with content ${expectedContent} not found in epoch ${l2Epoch}. ` +
      `Either (a) the L2 tx hasn't been included in a finalized epoch yet (wait), ` +
      `(b) the content hash you computed locally doesn't match what L2 emitted ` +
      `(re-derive via sha256_to_field(abi.encode(l1_recipient, amount, WITHDRAW_PUBLIC_TAG))), or ` +
      `(c) the node is out of sync. ` +
      `Tx receipt blockNumber + epoch: ${JSON.stringify({ epoch: l2Epoch.toString() })}.`,
    );
  }

  return { l2Epoch, leafIndex: flatLeafIndex, content: expectedContent };
}

/**
 * Full proof builder. Returns { l2Epoch, leafIndex, siblingPath, content }.
 *
 * As of Sub-5b D2, the siblingPath construction requires Aztec's internal
 * merkle-tree-builder which is not exposed through aztec.js's public API.
 * This function performs the lookup (returns the OutboxLookup) and then
 * throws with explicit instructions for completing the proof manually via
 * the testnet runner.
 *
 * @param nodeUrl          Aztec node RPC URL
 * @param l2TxHash         L2 tx hash of the exit_to_l1_* call
 * @param expectedContent  0x-prefixed bytes32 content hash
 * @returns OutboxProof (when siblingPath path is implemented in a future task)
 */
export async function buildOutboxProof(
  nodeUrl: string,
  l2TxHash: string,
  expectedContent: string,
): Promise<OutboxProof> {
  const lookup = await lookupOutboxMessage(nodeUrl, l2TxHash, expectedContent);
  throw new Error(
    `buildOutboxProof: lookup succeeded (l2Epoch=${lookup.l2Epoch} leafIndex=${lookup.leafIndex}) ` +
    `but siblingPath construction is not yet implemented in cli/src/bridge-helpers.ts. ` +
    `Aztec's outbox merkle-tree builder is not exposed via the public aztec.js API at v4.2.1; ` +
    `vendoring the helper is a follow-up. ` +
    `For now: use 'zswap bridge claim-l1-partial' to get the lookup values, then construct the ` +
    `siblingPath via Aztec's L1 portal manager helper (see node_modules/@aztec/aztec.js/dest/ethereum/portal_manager.js).`,
  );
}

/**
 * Format an OutboxProof as a ready-to-run 'cast send' command for the L1
 * TokenBridge.withdraw call. Lets the maker paste it directly into Foundry
 * without manually building calldata.
 *
 * @param proof          OutboxProof from buildOutboxProof
 * @param bridgeAddress  L1 portal address (USDCBridge / WETHBridge)
 * @param amount         token amount (smallest unit)
 * @param l1Recipient    0x-prefixed L1 recipient address
 */
export function formatProofForCastSend(
  proof: OutboxProof,
  bridgeAddress: string,
  amount: bigint,
  l1Recipient: string,
): string {
  if (!bridgeAddress.startsWith("0x") || bridgeAddress.length !== 42) {
    throw new Error(`bridgeAddress must be a 0x-prefixed 20-byte address, got: ${bridgeAddress}`);
  }
  if (!l1Recipient.startsWith("0x") || l1Recipient.length !== 42) {
    throw new Error(`l1Recipient must be a 0x-prefixed 20-byte address, got: ${l1Recipient}`);
  }
  const siblingArray = `[${proof.siblingPath.join(",")}]`;
  return [
    `cast send ${bridgeAddress} \\`,
    `  "withdraw(uint256,address,uint256,uint256,bytes32[])" \\`,
    `  ${amount} ${l1Recipient} ${proof.l2Epoch} ${proof.leafIndex} '${siblingArray}'`,
  ].join("\n");
}
