import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildClearingWitness, MAX_ORDERS_PER_EPOCH } from "../src/witness.js";
import { type ClearingResult } from "../src/clearing.js";

describe("buildClearingWitness", () => {
  it("emits the new fills_root public input + 32-entry private fills array", async () => {
    const epoch = { order_acc: 0n, cancel_acc: 0n, order_count: 1, cancel_count: 0 };
    const pool = { reserve_a: 1_000_000n, reserve_b: 2_000_000n, lp_supply: 1_000_000n };
    const orders = [{
      side: false,
      amount_in: 1000n,
      limit_price: 2_000_000_000_000_000_000n,
      order_nonce: 0x1n,
      submitted_at_block: 5,
      owner: 0xa1n,
    }];
    const clearing: ClearingResult = {
      cleared: true,
      clearingPrice: 1_500_000_000_000_000_000n,
      fills: [{ orderNonce: 0x1n, filledIn: 1000n, amountOut: 666n }],
      newReserveA: 1_000_500n,
      newReserveB: 1_999_500n,
      feeAPerShareIncrement: 0n,
      feeBPerShareIncrement: 0n,
    };
    const out = await buildClearingWitness({
      epoch, pool, orders, cancellationIndices: [], clearing,
    });

    // fills_root is a top-level public input now.
    assert.match(out.proverToml, /^fills_root = "0x[0-9a-f]+"$/m,
      "missing fills_root public input");
    // fills_len moved from public-input to private-witness section.  Verify it's
    // NOT in the public-input block (everything before the first `orders = [` line),
    // but IS still present in the witness block.
    const splitAtOrders = out.proverToml.split(/^orders = \[$/m);
    assert.equal(splitAtOrders.length, 2, "expected a single orders = [ separator in TOML");
    const publicInputs = splitAtOrders[0]!;
    const privateWitness = splitAtOrders[1]!;
    assert.doesNotMatch(publicInputs, /^fills_len\s*=/m,
      "fills_len must not appear in the public-input section (it moved to private witness)");
    assert.match(privateWitness, /^fills_len\s*=\s*\d+$/m,
      "fills_len must still appear in the private-witness section (the circuit needs it)");

    // The 32-entry private fills witness array survives.
    const fillsBlock = out.proverToml.match(/^fills = \[\s*(?:\{[^\}]+\},\s*){32}\]/m);
    assert.ok(fillsBlock, "expected 32-entry private fills array in TOML");

    assert.ok(out.fillsRoot, "buildClearingWitness must return fillsRoot");
    assert.match(out.fillsRoot, /^0x[0-9a-f]+$/);
    assert.equal(out.maxOrdersPerEpoch, MAX_ORDERS_PER_EPOCH);
    assert.equal(out.leaves.length, MAX_ORDERS_PER_EPOCH);
  });

  it("handles a no-fills clearing — fills_root collapses to the all-empty-leaves root", async () => {
    const epoch = { order_acc: 0n, cancel_acc: 0n, order_count: 0, cancel_count: 0 };
    const pool = { reserve_a: 1_000n, reserve_b: 2_000n, lp_supply: 1_000n };
    const clearing: ClearingResult = {
      cleared: false,
      clearingPrice: 0n,
      fills: [],
      newReserveA: 1_000n,
      newReserveB: 2_000n,
      feeAPerShareIncrement: 0n,
      feeBPerShareIncrement: 0n,
    };
    const out = await buildClearingWitness({
      epoch, pool, orders: [], cancellationIndices: [], clearing,
    });
    assert.match(out.proverToml, /^fills_root = "0x[0-9a-f]+"$/m);
    assert.match(out.fillsRoot, /^0x[0-9a-f]+$/);
    // The all-empty root is the EMPTY_ROOT constant from Task 3.
    assert.equal(
      out.fillsRoot,
      "0x01c28fe1059ae0237b72334700697bdf465e03df03986fe05200cadeda66bd76",
    );
  });
});
