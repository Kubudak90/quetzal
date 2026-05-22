export interface PoolRegistryEntry {
  pool_id: number;
  token_a: bigint;  // canonical (lower)
  token_b: bigint;  // canonical (higher)
}
export type PoolRegistry = PoolRegistryEntry[];

/** Find the pool_id matching unordered (a, b). Returns -1 if not found. */
export function resolvePoolId(reg: PoolRegistry, a: bigint, b: bigint): number {
  const [lo, hi] = a < b ? [a, b] : [b, a];
  for (const p of reg) {
    if (p.token_a === lo && p.token_b === hi) return p.pool_id;
  }
  return -1;
}

/** Resolve per-hop pool_ids for a path. Throws on missing pool. */
export function resolveHopPools(reg: PoolRegistry, path: bigint[]): number[] {
  if (path.length < 2 || path.length > 3) {
    throw new Error(`path length must be 2 or 3, got ${path.length}`);
  }
  const hops: number[] = [];
  for (let i = 0; i + 1 < path.length; i++) {
    const pid = resolvePoolId(reg, path[i]!, path[i + 1]!);
    if (pid < 0) throw new Error(`no pool for hop ${i}: 0x${path[i]!.toString(16)}->0x${path[i + 1]!.toString(16)}`);
    hops.push(pid);
  }
  return hops;
}
