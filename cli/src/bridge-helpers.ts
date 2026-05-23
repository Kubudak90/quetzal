/**
 * Sub-5b: L2→L1 Outbox proof retrieval interface.
 *
 * After a maker calls aUSDC.exit_to_l1_*, they need three values to
 * call USDCBridge.withdraw on L1:
 *   - l2Epoch: the rollup epoch containing the L2→L1 message
 *   - leafIndex: the leaf position in that epoch's Outbox tree
 *   - siblingPath: Merkle proof from leaf to Outbox root
 *
 * These are derived from the Aztec node's L2 tx receipt + Outbox query.
 * D2 wires the actual aztec.js calls; C2 establishes the API.
 */

export interface OutboxProof {
  /** L2 rollup epoch containing the L2→L1 message (passes to IOutbox.consume as Epoch). */
  l2Epoch: bigint;

  /** Leaf position in the epoch's Outbox tree. */
  leafIndex: bigint;

  /** Hex-encoded sibling hashes from leaf to Outbox root. */
  siblingPath: string[];

  /** Hex-encoded 32-byte content hash (sha256_to_field of the message payload). */
  content: string;
}

/**
 * Given an L2 tx hash + expected content hash, query the Aztec node for the
 * Outbox membership witness needed to consume the message on L1.
 *
 * D2 replaces this stub with the actual aztec.js call.
 *
 * @param l2TxHash  L2 tx hash of the exit_to_l1_* call
 * @param expectedContent 0x-prefixed 32-byte content hash the maker computed
 *                  locally (must match what was committed on L2)
 * @returns OutboxProof ready to feed into IOutbox.consume on L1
 */
export async function buildOutboxProof(
  l2TxHash: string,
  expectedContent: string,
): Promise<OutboxProof> {
  void l2TxHash;
  void expectedContent;
  throw new Error(
    "buildOutboxProof: not yet implemented — Sub-5b Task D2 wires the actual aztec.js Outbox membership query",
  );
}

/**
 * Format an OutboxProof as a ready-to-run `cast send` command for the L1
 * TokenBridge.withdraw call. Lets the maker paste it directly into Foundry
 * without manually building calldata.
 *
 * @param proof          OutboxProof from buildOutboxProof
 * @param bridgeAddress  L1 portal address (USDCBridge / WETHBridge)
 * @param amount         token amount (smallest unit)
 * @param l1Recipient    0x-prefixed L1 recipient address
 * @returns Multi-line shell command string
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
