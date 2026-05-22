/**
 * Week 5d-4 Merkle settlement tree (JS parity of circuits/clearing/src/merkle.nr).
 * Depth 5; 32 leaves; Poseidon2 (via @aztec/foundation). Empty slots use
 * leaf = poseidon2([0, 0]) — same sentinel as the circuit's `fill_leaf(0, 0)`.
 */
import { Fr } from "@aztec/aztec.js/fields";
import { poseidon2Hash } from "@aztec/foundation/crypto/poseidon";

export const TREE_LEAVES = 32;
export const TREE_DEPTH = 5;

export interface JsFillEntry {
  order_nonce: Fr;
  amount_out: bigint;
}

export interface MerkleTreeOutput {
  root: Fr;
  leaves: Fr[];                                          // length TREE_LEAVES (= 32)
  paths: Map<string, { siblings: Fr[]; leaf_index: number }>;  // keyed by order_nonce.toString()
}

/** poseidon2([order_nonce, amount_out as Field]) — matches circuits/clearing/src/merkle.nr's fill_leaf. */
export async function fillLeaf(orderNonce: Fr, amountOut: bigint): Promise<Fr> {
  return poseidon2Hash([orderNonce.toBigInt(), amountOut]);
}

/** Hash 32 leaves into the depth-5 root. */
export async function merkleRoot32(leaves: Fr[]): Promise<Fr> {
  if (leaves.length !== TREE_LEAVES) {
    throw new Error(`expected ${TREE_LEAVES} leaves, got ${leaves.length}`);
  }
  let level: Fr[] = leaves.slice();
  for (let round = 0; round < TREE_DEPTH; round++) {
    const next: Fr[] = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(await poseidon2Hash([level[i]!.toBigInt(), level[i + 1]!.toBigInt()]));
    }
    level = next;
  }
  return level[0]!;
}

/**
 * Build the full Merkle tree from a list of populated fills.
 * - Pads to 32 leaves with the (0,0) sentinel.
 * - Returns the root, the 32 leaf hashes, and per-populated-fill inclusion paths.
 * - Throws on duplicate order_nonce among populated fills (the circuit would not produce one).
 */
export async function buildFillsTree(fills: JsFillEntry[]): Promise<MerkleTreeOutput> {
  if (fills.length > TREE_LEAVES) {
    throw new Error(`too many fills (${fills.length}); max ${TREE_LEAVES}`);
  }
  const seen = new Set<string>();
  for (const f of fills) {
    if (f.order_nonce.toBigInt() === 0n) {
      throw new Error("order_nonce 0 is the empty-slot sentinel; real fills must use a non-zero nonce");
    }
    const k = f.order_nonce.toString();
    if (seen.has(k)) throw new Error(`duplicate order_nonce ${k}`);
    seen.add(k);
  }

  // Hash leaves (populated + padding sentinels).
  const leaves: Fr[] = [];
  for (let i = 0; i < TREE_LEAVES; i++) {
    if (i < fills.length) {
      leaves.push(await fillLeaf(fills[i]!.order_nonce, fills[i]!.amount_out));
    } else {
      leaves.push(await fillLeaf(new Fr(0n), 0n));
    }
  }

  // Build the per-level node arrays, retaining them so we can later read off siblings.
  const levels: Fr[][] = [leaves];
  for (let r = 0; r < TREE_DEPTH; r++) {
    const prev = levels[r]!;
    const next: Fr[] = [];
    for (let i = 0; i < prev.length; i += 2) {
      next.push(await poseidon2Hash([prev[i]!.toBigInt(), prev[i + 1]!.toBigInt()]));
    }
    levels.push(next);
  }
  const root = levels[TREE_DEPTH]![0]!;

  // For each populated fill, harvest siblings going up.
  const paths = new Map<string, { siblings: Fr[]; leaf_index: number }>();
  for (let i = 0; i < fills.length; i++) {
    let idx = i;
    const siblings: Fr[] = [];
    for (let r = 0; r < TREE_DEPTH; r++) {
      const siblingIdx = idx ^ 1;
      siblings.push(levels[r]![siblingIdx]!);
      idx >>= 1;
    }
    paths.set(fills[i]!.order_nonce.toString(), { siblings, leaf_index: i });
  }

  return { root, leaves, paths };
}

export interface HopFillLeaf {
  order_nonce: Fr;
  hop_index: number;
  amount_out: bigint;
  pool_id: number;
}

/**
 * Sub-4: 64-leaf Merkle over hop-fill leaves.
 * Each leaf = poseidon2([order_nonce, hop_index, amount_out, pool_id]).
 * Empty slots use poseidon2([0, 0, 0, 0]) sentinel.
 * @param fills - list of hop-fill leaves (order is significant; padded to `depth` entries)
 * @param depth - total leaf count (must be a power of 2, e.g. 64)
 */
export async function buildHopFillsTree(
  fills: HopFillLeaf[],
  depth: number,
): Promise<{ leaves: Fr[]; root: Fr }> {
  const leafCount = depth;
  const emptyLeaf = await poseidon2Hash([0n, 0n, 0n, 0n]);

  // Hash leaves (populated + padding sentinels).
  const leaves: Fr[] = [];
  for (let i = 0; i < leafCount; i++) {
    if (i < fills.length) {
      const f = fills[i]!;
      const hash = await poseidon2Hash([
        f.order_nonce.toBigInt(),
        BigInt(f.hop_index),
        f.amount_out,
        BigInt(f.pool_id),
      ]);
      leaves.push(hash);
    } else {
      leaves.push(emptyLeaf);
    }
  }

  // Binary reduction (same pattern as buildFillsTree).
  let layer = leaves.slice();
  while (layer.length > 1) {
    const next: Fr[] = [];
    for (let i = 0; i < layer.length; i += 2) {
      next.push(await poseidon2Hash([layer[i]!.toBigInt(), layer[i + 1]!.toBigInt()]));
    }
    layer = next;
  }

  return { leaves, root: layer[0]! };
}
