import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RevealQueue, type RevealPayload } from "../src/queue.js";

const SAMPLE: RevealPayload = {
  epoch_id: 7,
  order_nonce: "0xabc",
  side: false,
  amount_in: "1000",
  limit_price: "2000000000000000000",
  submitted_at_block: 42,
  owner: "0xdeadbeef",
};

describe("RevealQueue", () => {
  it("enqueue + drainEpoch returns inserted payloads", () => {
    const q = new RevealQueue();
    q.enqueue(SAMPLE);
    const drained = q.drainEpoch(7);
    assert.equal(drained.length, 1);
    assert.equal(drained[0]!.order_nonce, "0xabc");
  });

  it("drainEpoch returns empty array when no payloads for that epoch", () => {
    const q = new RevealQueue();
    q.enqueue({ ...SAMPLE, epoch_id: 7 });
    assert.deepEqual(q.drainEpoch(8), []);
  });

  it("drainEpoch removes payloads for that epoch (second drain returns empty)", () => {
    const q = new RevealQueue();
    q.enqueue(SAMPLE);
    q.drainEpoch(7);
    assert.deepEqual(q.drainEpoch(7), []);
  });

  it("dedupes by (epoch_id, order_nonce)", () => {
    const q = new RevealQueue();
    q.enqueue(SAMPLE);
    q.enqueue({ ...SAMPLE, amount_in: "9999" });   // same key, different body
    const drained = q.drainEpoch(7);
    assert.equal(drained.length, 1, "duplicate (epoch_id, order_nonce) must dedupe");
    // First-write-wins.
    assert.equal(drained[0]!.amount_in, "1000");
  });

  it("size() reports total queued payloads across all epochs", () => {
    const q = new RevealQueue();
    q.enqueue({ ...SAMPLE, epoch_id: 1, order_nonce: "0x1" });
    q.enqueue({ ...SAMPLE, epoch_id: 2, order_nonce: "0x2" });
    q.enqueue({ ...SAMPLE, epoch_id: 2, order_nonce: "0x3" });
    assert.equal(q.size(), 3);
  });
});
