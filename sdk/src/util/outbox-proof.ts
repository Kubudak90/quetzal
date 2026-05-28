// Browser-friendly L2→L1 outbox proof builder.
// Ports tools/outbox-proof/src/build-proof.ts (Node binary) for use in the
// browser PXE — same canonical helper, same Aztec 4.2.1 4-level unbalanced
// Merkle semantics (Epoch → Checkpoints → Blocks → Transactions → Messages).
//
// Run from the browser via `await buildOutboxProof(nodeUrl, l2TxHash, expectedContent)`.
// On success returns the concatenated sibling path + leaf index + epoch number
// for the L1 bridge's withdraw() call.
//
// See tools/outbox-proof/src/build-proof.ts header for the full mechanics writeup.

import { createAztecNodeClient } from "@aztec/aztec.js/node";
import { Fr } from "@aztec/aztec.js/fields";
import { TxHash } from "@aztec/aztec.js/tx";
import { computeL2ToL1MembershipWitness } from "@aztec/stdlib/messaging";

export class OutboxProofShapeError extends Error {
  constructor(msg: string) {
    super(`[outbox-proof] ${msg}`);
    this.name = "OutboxProofShapeError";
  }
}

export class OutboxProofNotReadyError extends Error {
  constructor(l2TxHash: string) {
    super(
      `[outbox-proof] L2 tx ${l2TxHash} not found or not yet in a finalised epoch. ` +
        `Ensure the tx is mined and the epoch is proven on L1 before calling.`,
    );
    this.name = "OutboxProofNotReadyError";
  }
}

export interface OutboxProof {
  l2Epoch: string;
  leafIndex: string;
  /** Concatenated [message + tx + block + checkpoint] sibling path, hex strings. */
  siblingPath: `0x${string}`[];
  content: `0x${string}`;
}

export async function buildOutboxProof(
  nodeUrl: string,
  l2TxHash: string,
  expectedContent: string,
): Promise<OutboxProof> {
  if (!l2TxHash.startsWith("0x") || l2TxHash.length !== 66) {
    throw new OutboxProofShapeError(`l2TxHash must be 0x + 32 bytes (66 chars), got: ${l2TxHash}`);
  }
  if (!expectedContent.startsWith("0x") || expectedContent.length !== 66) {
    throw new OutboxProofShapeError(
      `expectedContent must be 0x + 32 bytes (66 chars), got: ${expectedContent}`,
    );
  }

  const node = createAztecNodeClient(nodeUrl);
  const txHash = TxHash.fromString(l2TxHash);
  const messageFr = Fr.fromHexString(expectedContent);

  const witness = await computeL2ToL1MembershipWitness(node, messageFr, txHash);
  if (!witness) {
    throw new OutboxProofNotReadyError(l2TxHash);
  }

  const { epochNumber, leafIndex, siblingPath } = witness;
  const siblingPathHex = siblingPath
    .toBufferArray()
    .map((buf: Uint8Array) => {
      const hex = Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
      return `0x${hex}` as `0x${string}`;
    });

  return {
    l2Epoch: epochNumber.toString(),
    leafIndex: leafIndex.toString(),
    siblingPath: siblingPathHex,
    content: expectedContent as `0x${string}`,
  };
}
