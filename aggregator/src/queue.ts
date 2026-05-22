/**
 * In-memory reveal queue keyed by (epoch_id, order_nonce). Deduplicates on
 * insertion - second insert with the same key is a no-op (first-write-wins).
 * `drainEpoch(epoch_id)` empties the queue for that epoch and returns the
 * payloads. The daemon calls drainEpoch at clearing time.
 *
 * NB: this is intentionally NOT persistent. An aggregator restart loses
 * in-flight reveals; makers retry by broadcasting on the next epoch. This
 * is acceptable for MVP because the bonded race naturally tolerates dropped
 * aggregators.
 */

export interface RevealPayload {
  epoch_id: number;
  order_nonce: string;       // 0x-prefixed hex
  side: boolean;
  amount_in: string;         // bigint as decimal string
  limit_price: string;       // bigint as decimal string
  submitted_at_block: number;
  owner: string;             // 0x-prefixed hex
  submission_tx_hash?: string;
}

export class RevealQueue {
  private byEpoch = new Map<number, Map<string, RevealPayload>>();

  enqueue(payload: RevealPayload): void {
    let inner = this.byEpoch.get(payload.epoch_id);
    if (!inner) {
      inner = new Map();
      this.byEpoch.set(payload.epoch_id, inner);
    }
    if (!inner.has(payload.order_nonce)) {
      inner.set(payload.order_nonce, payload);
    }
    // duplicate (epoch_id, order_nonce): silently dropped (first-write-wins)
  }

  drainEpoch(epoch_id: number): RevealPayload[] {
    const inner = this.byEpoch.get(epoch_id);
    if (!inner) return [];
    const out = Array.from(inner.values());
    this.byEpoch.delete(epoch_id);
    return out;
  }

  size(): number {
    let total = 0;
    for (const inner of this.byEpoch.values()) total += inner.size;
    return total;
  }
}
