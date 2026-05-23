/**
 * Sub-5c A3: L2→L1 Outbox proof builder.
 *
 * Discovered Aztec 4.2.1 outbox-tree mechanics (from Step 1 inspection of
 * @aztec/stdlib/dest/messaging/l2_to_l1_membership.js and portal_manager.js):
 *
 * The L2→L1 message tree is a 4-level hierarchical unbalanced Merkle tree:
 *   Epoch → Checkpoints → Blocks → Transactions → Messages
 *
 * Each level uses UnbalancedMerkleTreeCalculator (from @aztec/foundation/trees),
 * with SHA-256-truncation as the leaf hash and compressed (zero-skipping) semantics
 * at the Block and Checkpoint levels. Specifically:
 *
 *   Level 1 — Message Tree (TX out hash):
 *     Leaves: individual Fr L2→L1 messages per tx; unbalanced, NOT compressed
 *   Level 2 — Block Tree:
 *     Leaves: TX out hashes (sha256-truncated to Fr) per block; unbalanced, compressed
 *   Level 3 — Checkpoint Tree:
 *     Leaves: Block out hashes per checkpoint; unbalanced, compressed
 *   Level 4 — Epoch Tree:
 *     Leaves: Checkpoint out hashes padded to OUT_HASH_TREE_LEAF_COUNT zeros; unbalanced, NOT compressed
 *
 * The combined sibling path is the concatenation (in this order):
 *   [message siblings] + [tx siblings] + [block siblings] + [checkpoint siblings]
 *
 * The canonical builder is computeL2ToL1MembershipWitness from @aztec/stdlib/messaging.
 * It calls node.getTxReceipt(txHash) for epoch+block, then node.getL2ToL1Messages(epoch)
 * for the Fr[][][][] message array, plus node.getBlock and node.getCheckpointsDataForEpoch
 * to resolve checkpoint/block/tx indices. It returns:
 *   { epochNumber, root: Fr, leafIndex: bigint, siblingPath: SiblingPath<number> }
 *
 * The siblingPath.toBufferArray() gives Buffer[] which we hex-encode as 0x-prefixed strings.
 * The message passed to computeL2ToL1MembershipWitness must be Fr.fromHexString(expectedContent).
 */

import { createAztecNodeClient } from "@aztec/aztec.js/node";
import { Fr } from "@aztec/aztec.js/fields";
import { TxHash } from "@aztec/aztec.js/tx";
import { computeL2ToL1MembershipWitness } from "@aztec/stdlib/messaging";

export interface OutboxProof {
  l2Epoch: string;
  leafIndex: string;
  siblingPath: string[];
  content: string;
}

export async function buildOutboxProof(
  nodeUrl: string,
  l2TxHash: string,
  expectedContent: string,
): Promise<OutboxProof> {
  if (!l2TxHash.startsWith("0x")) {
    throw new Error(`l2TxHash must be 0x-prefixed, got: ${l2TxHash}`);
  }
  if (!expectedContent.startsWith("0x") || expectedContent.length !== 66) {
    throw new Error(
      `expectedContent must be 0x + 32 bytes (66 chars), got: ${expectedContent}`,
    );
  }

  const node = createAztecNodeClient(nodeUrl);
  const txHash = TxHash.fromString(l2TxHash);

  // Fr.fromHexString is the correct way to parse a 0x-prefixed 32-byte hash into an Fr.
  // computeL2ToL1MembershipWitness searches the tx's L2→L1 messages for this Fr value.
  const messageFr = Fr.fromHexString(expectedContent);

  const witness = await computeL2ToL1MembershipWitness(node, messageFr, txHash);

  if (!witness) {
    throw new Error(
      `L2 tx ${l2TxHash} not found or not yet in a finalized epoch. ` +
        `Ensure the tx is mined and the epoch is proven on L1 before calling this tool.`,
    );
  }

  const { epochNumber, leafIndex, siblingPath } = witness;

  // siblingPath is SiblingPath<number>; toBufferArray() returns Buffer[]
  const siblingPathHex = siblingPath
    .toBufferArray()
    .map((buf: Buffer) => `0x${buf.toString("hex")}`);

  return {
    l2Epoch: epochNumber.toString(),
    leafIndex: leafIndex.toString(),
    siblingPath: siblingPathHex,
    content: expectedContent,
  };
}
