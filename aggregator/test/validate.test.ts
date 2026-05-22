import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Fr } from "@aztec/aztec.js/fields";
import { poseidon2Hash } from "@aztec/foundation/crypto/poseidon";
import { validateReveals, computeCi, replayOrderAcc } from "../src/validate.js";
import type { RevealPayload } from "../src/queue.js";

describe("validate.computeCi", () => {
  it("matches the Orderbook.submit_order leaf formula", async () => {
    const payload = {
      owner: 0xa1n,
      side: false,
      amount_in: 1000n,
      limit_price: 2_000_000_000_000_000_000n,
      order_nonce: 0x42n,
      submitted_at_block: 5,
    };
    const ci = await computeCi(payload);
    const expected = await poseidon2Hash([
      payload.owner,
      payload.side ? 1n : 0n,
      payload.amount_in,
      payload.limit_price,
      payload.order_nonce,
      BigInt(payload.submitted_at_block),
    ]);
    assert.equal(ci.toString(), expected.toString());
  });
});

describe("validate.replayOrderAcc", () => {
  it("matches a hand-rolled fold for 1 entry", async () => {
    const c1 = new Fr(0xAAn);
    const replayed = await replayOrderAcc([c1]);
    const expected = await poseidon2Hash([0n, c1.toBigInt()]);
    assert.equal(replayed.toString(), expected.toString());
  });

  it("matches a hand-rolled fold for 2 entries", async () => {
    const c1 = new Fr(0xAAn);
    const c2 = new Fr(0xBBn);
    const replayed = await replayOrderAcc([c1, c2]);
    const step1 = await poseidon2Hash([0n, c1.toBigInt()]);
    const expected = await poseidon2Hash([step1.toBigInt(), c2.toBigInt()]);
    assert.equal(replayed.toString(), expected.toString());
  });
});

describe("validate.validateReveals", () => {
  function makePayload(
    order_nonce: bigint,
    amount_in: bigint,
    submitted_at_block = 5,
  ): RevealPayload {
    return {
      epoch_id: 0,
      order_nonce: new Fr(order_nonce).toString(),
      side: false,
      amount_in: amount_in.toString(),
      limit_price: "2000000000000000000",
      submitted_at_block,
      owner: new Fr(0xa1n).toString(),
    };
  }

  it("V1: returns ValidatedReveal[] whose replayed order_acc matches input", async () => {
    const p = makePayload(0x42n, 1000n);
    const ci = await computeCi({
      owner: 0xa1n, side: false, amount_in: 1000n,
      limit_price: 2_000_000_000_000_000_000n, order_nonce: 0x42n,
      submitted_at_block: 5,
    });
    const expected_acc = await replayOrderAcc([ci]);

    const validated = await validateReveals([p], expected_acc);
    assert.equal(validated.length, 1);
    assert.equal(validated[0]!.order_nonce.toString(), p.order_nonce);
  });

  it("V2: rejects reveals whose folded acc does NOT match expected", async () => {
    const p = makePayload(0x42n, 1000n);
    const ci_real = await computeCi({
      owner: 0xa1n, side: false, amount_in: 1000n,
      limit_price: 2_000_000_000_000_000_000n, order_nonce: 0x42n,
      submitted_at_block: 5,
    });
    const expected_acc = await replayOrderAcc([ci_real]);

    // Corrupt the payload (amount_in flipped) - c_i no longer matches.
    const tampered = { ...p, amount_in: "1001" };
    const validated = await validateReveals([tampered], expected_acc);
    assert.equal(validated.length, 0, "tampered reveal must be rejected");
  });

  it("orders payloads by submitted_at_block + order_nonce (matches selectBatch)", async () => {
    const p1 = makePayload(0x10n, 100n, 5);
    const p2 = makePayload(0x20n, 200n, 4);  // earlier block
    const ci2 = await computeCi({
      owner: 0xa1n, side: false, amount_in: 200n,
      limit_price: 2_000_000_000_000_000_000n, order_nonce: 0x20n,
      submitted_at_block: 4,
    });
    const ci1 = await computeCi({
      owner: 0xa1n, side: false, amount_in: 100n,
      limit_price: 2_000_000_000_000_000_000n, order_nonce: 0x10n,
      submitted_at_block: 5,
    });
    const expected_acc = await replayOrderAcc([ci2, ci1]);

    const validated = await validateReveals([p1, p2], expected_acc);
    assert.equal(validated.length, 2);
    assert.equal(validated[0]!.submitted_at_block, 4);
    assert.equal(validated[1]!.submitted_at_block, 5);
  });
});
