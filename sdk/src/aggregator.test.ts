// sdk/src/aggregator.test.ts
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { AggregatorApi } from "./aggregator.js";
import type { QuetzalClient } from "./client.js";

// Minimal stub: directReveal only uses `fetch` — no client methods needed.
const stubClient = {} as unknown as QuetzalClient;

describe("AggregatorApi.directReveal", () => {
  const api = new AggregatorApi(stubClient);

  const samplePayload: Record<string, unknown> = {
    epoch_id: 1,
    order_nonce: "0xdeadbeef",
    side: true,
    amount_in: "1000000",
    limit_price: "3000000000",
    submitted_at_block: 42,
    owner: "0xabcd1234",
  };

  let originalFetch: typeof globalThis.fetch;

  before(() => {
    originalFetch = globalThis.fetch;
  });

  after(() => {
    globalThis.fetch = originalFetch;
  });

  test("returns true when server responds HTTP 200", async () => {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ ok: true }), { status: 200 }) as unknown as Response;

    const result = await api.directReveal("http://localhost:3001", samplePayload);
    assert.equal(result, true);
  });

  test("returns false when fetch throws a network error", async () => {
    globalThis.fetch = async () => {
      throw new Error("ECONNREFUSED");
    };

    const result = await api.directReveal("http://localhost:3001", samplePayload);
    assert.equal(result, false);
  });

  test("returns false when server responds HTTP 400", async () => {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ error: "invalid payload" }), { status: 400 }) as unknown as Response;

    const result = await api.directReveal("http://localhost:3001", samplePayload);
    assert.equal(result, false);
  });
});
