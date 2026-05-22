/**
 * Validate a batch of reveals against the on-chain order_acc accumulator.
 * Recomputes c_i for each, sorts by FIFO (submitted_at_block, order_nonce),
 * replays the fold from 0, and accepts ALL reveals only if the replayed
 * accumulator matches the on-chain expected value. If any single reveal is
 * tampered, replay fails and the whole batch is rejected - the daemon then
 * either submits the empty (skip) clearing or aborts and waits for a complete
 * re-broadcast.
 */
import { Fr } from "@aztec/aztec.js/fields";
import { poseidon2Hash } from "@aztec/foundation/crypto/poseidon";
import type { RevealPayload } from "./queue.js";

export interface ValidatedReveal {
  order_nonce: Fr;
  side: boolean;
  amount_in: bigint;
  limit_price: bigint;
  submitted_at_block: number;
  owner: Fr;
}

export async function computeCi(p: {
  owner: bigint;
  side: boolean;
  amount_in: bigint;
  limit_price: bigint;
  order_nonce: bigint;
  submitted_at_block: number;
}): Promise<Fr> {
  return poseidon2Hash([
    p.owner,
    p.side ? 1n : 0n,
    p.amount_in,
    p.limit_price,
    p.order_nonce,
    BigInt(p.submitted_at_block),
  ]);
}

export async function replayOrderAcc(cis: Fr[]): Promise<Fr> {
  let acc: Fr = new Fr(0n);
  for (const ci of cis) {
    acc = await poseidon2Hash([acc.toBigInt(), ci.toBigInt()]);
  }
  return acc;
}

/**
 * Sort reveals by FIFO (submitted_at_block ASC, then order_nonce ASC) - same
 * total ordering as `aggregator/src/clearing.ts::selectBatch`. Replay the
 * order_acc chain. Return parsed ValidatedReveal[] if the folded acc matches
 * `expectedOrderAcc`; otherwise return [].
 */
export async function validateReveals(
  reveals: RevealPayload[],
  expectedOrderAcc: Fr,
): Promise<ValidatedReveal[]> {
  const parsed: ValidatedReveal[] = reveals.map((r) => ({
    order_nonce: Fr.fromString(r.order_nonce),
    side: r.side,
    amount_in: BigInt(r.amount_in),
    limit_price: BigInt(r.limit_price),
    submitted_at_block: r.submitted_at_block,
    owner: Fr.fromString(r.owner),
  }));

  parsed.sort((a, b) => {
    if (a.submitted_at_block !== b.submitted_at_block) {
      return a.submitted_at_block - b.submitted_at_block;
    }
    const an = a.order_nonce.toBigInt();
    const bn = b.order_nonce.toBigInt();
    if (an < bn) return -1;
    if (an > bn) return 1;
    return 0;
  });

  const cis: Fr[] = [];
  for (const p of parsed) {
    cis.push(await computeCi({
      owner: p.owner.toBigInt(),
      side: p.side,
      amount_in: p.amount_in,
      limit_price: p.limit_price,
      order_nonce: p.order_nonce.toBigInt(),
      submitted_at_block: p.submitted_at_block,
    }));
  }
  const replayed = await replayOrderAcc(cis);

  if (replayed.toString() !== expectedOrderAcc.toString()) {
    return [];
  }
  return parsed;
}
