import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { buildServer } from "../src/server.js";
import { RevealQueue } from "../src/queue.js";
import type { FastifyInstance } from "fastify";

const SAMPLE = {
  epoch_id: 7,
  order_nonce: "0xabc",
  side: false,
  amount_in: "1000",
  limit_price: "2000000000000000000",
  submitted_at_block: 42,
  owner: "0xdeadbeef",
};

describe("aggregator/server", () => {
  let app: FastifyInstance;
  let queue: RevealQueue;

  before(async () => {
    queue = new RevealQueue();
    app = await buildServer(queue);
  });

  after(async () => {
    await app.close();
  });

  it("S1: POST /reveal enqueues a valid payload", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/reveal",
      payload: SAMPLE,
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { ok: true });
    assert.equal(queue.size(), 1);
  });

  it("GET /health reports queue size", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { ok: boolean; queueSize: number };
    assert.equal(body.ok, true);
    assert.equal(body.queueSize, 1, "queue still has the previous payload");
  });

  it("S2: malformed payload returns 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/reveal",
      payload: { epoch_id: "not-a-number" },
    });
    assert.equal(res.statusCode, 400);
  });

  it("S3: duplicate (epoch_id, order_nonce) is silently dropped by queue dedup", async () => {
    // Drain previous test's queue state, then re-test fresh.
    queue.drainEpoch(7);
    await app.inject({ method: "POST", url: "/reveal", payload: SAMPLE });
    await app.inject({ method: "POST", url: "/reveal", payload: { ...SAMPLE, amount_in: "9999" } });
    assert.equal(queue.size(), 1, "second post with same key must be deduped");
  });
});
