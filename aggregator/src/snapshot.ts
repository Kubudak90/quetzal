/**
 * Per-epoch snapshot store for the Week 5d-4 settlement Merkle tree.
 *
 * The aggregator writes one JSON file per closed epoch under `<dir>/epoch-<N>.json`;
 * the CLI's `zswap claim` reads it back to construct the inclusion proof.
 */
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { Fr } from "@aztec/aztec.js/fields";
import type { JsFillEntry, MerkleTreeOutput } from "./merkle.js";

export interface SnapshotInput {
  epoch_id: number;
  fills: JsFillEntry[];
  tree: MerkleTreeOutput;
}

export interface SnapshotLeafJson {
  order_nonce: string;   // 0x-prefixed Field hex
  amount_out: string;    // decimal bigint string
  leaf_hash: string;     // 0x-prefixed Field hex
}

export interface SnapshotPathJson {
  siblings: string[];    // length 5, 0x-prefixed
  leaf_index: number;
}

export interface SnapshotJson {
  epoch_id: number;
  fills_root: string;
  leaves: SnapshotLeafJson[];
  paths: Record<string, SnapshotPathJson>;
}

/** In-memory snapshot returned by readSnapshot — same fields, with paths as a Map. */
export interface Snapshot {
  epoch_id: number;
  fills_root: string;
  leaves: SnapshotLeafJson[];
  paths: Map<string, { siblings: Fr[]; leaf_index: number }>;
}

export function snapshotPath(dir: string, epoch_id: number): string {
  return join(dir, `epoch-${epoch_id}.json`);
}

export function writeSnapshot(dir: string, snap: SnapshotInput): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const leaves: SnapshotLeafJson[] = [];
  for (let i = 0; i < snap.tree.leaves.length; i++) {
    const populated = snap.fills[i];
    leaves.push({
      order_nonce: populated ? populated.order_nonce.toString() : new Fr(0n).toString(),
      amount_out: populated ? populated.amount_out.toString() : "0",
      leaf_hash: snap.tree.leaves[i]!.toString(),
    });
  }
  const paths: Record<string, SnapshotPathJson> = {};
  for (const [nonce, path] of snap.tree.paths) {
    paths[nonce] = {
      siblings: path.siblings.map((s) => s.toString()),
      leaf_index: path.leaf_index,
    };
  }
  const json: SnapshotJson = {
    epoch_id: snap.epoch_id,
    fills_root: snap.tree.root.toString(),
    leaves,
    paths,
  };
  writeFileSync(snapshotPath(dir, snap.epoch_id), JSON.stringify(json, null, 2));
}

export function readSnapshot(dir: string, epoch_id: number): Snapshot {
  const raw = JSON.parse(readFileSync(snapshotPath(dir, epoch_id), "utf8")) as SnapshotJson;
  const paths = new Map<string, { siblings: Fr[]; leaf_index: number }>();
  for (const [nonce, p] of Object.entries(raw.paths)) {
    paths.set(nonce, {
      siblings: p.siblings.map((s) => Fr.fromString(s)),
      leaf_index: p.leaf_index,
    });
  }
  return {
    epoch_id: raw.epoch_id,
    fills_root: raw.fills_root,
    leaves: raw.leaves,
    paths,
  };
}

/**
 * Linear scan over `<dir>/epoch-*.json`; returns the epoch_id whose snapshot
 * carries `order_nonce_hex` as a populated path, or null. The CLI uses this when
 * the maker doesn't pass --epoch explicitly.
 */
export function findEpochForNonce(dir: string, order_nonce_hex: string): number | null {
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => /^epoch-\d+\.json$/.test(f));
  for (const f of files) {
    const raw = JSON.parse(readFileSync(join(dir, f), "utf8")) as SnapshotJson;
    if (raw.paths[order_nonce_hex]) return raw.epoch_id;
  }
  return null;
}
