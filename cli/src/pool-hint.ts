import type { AztecAddress } from "@aztec/aztec.js/addresses";
import type { LiquidityPoolContract } from "../../tests/integration/generated/LiquidityPool.js";

/** The five PoolState fields that `deposit` / `withdraw` take as their `hint` argument. */
export interface PoolStateHint {
  reserve_a: bigint;
  reserve_b: bigint;
  lp_supply: bigint;
  cum_fee_a_per_share: bigint;
  cum_fee_b_per_share: bigint;
}

/**
 * Read the live pool state to pass as the optimistic `hint` for a `deposit` /
 * `withdraw` call. The contract's public `_apply_*` callback re-validates the hint
 * against actual state, so a stale read simply reverts and the caller retries.
 */
export async function readPoolHint(
  pool: LiquidityPoolContract,
  from: AztecAddress,
): Promise<PoolStateHint> {
  const sim = await pool.methods.get_pool_state().simulate({ from });
  return (sim as { result: PoolStateHint }).result;
}
