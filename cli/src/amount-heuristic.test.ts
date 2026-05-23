// cli/src/amount-heuristic.test.ts
// Sub-6a D1 unit tests.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { classifyAmount, formatAdvisory } from "./amount-heuristic.js";

describe("classifyAmount", () => {
  test("flags 1.0 USDC (1_000_000) as round_unit", () => {
    const r = classifyAmount(1_000_000n, 6);
    assert.equal(r.classification, "round_unit");
    assert.notEqual(r.suggested, null);
  });

  test("flags 10_000 USDC (10_000_000_000) as round_unit", () => {
    const r = classifyAmount(10_000_000_000n, 6);
    assert.equal(r.classification, "round_unit");
  });

  test("flags 1.0 WETH (10^18) as round_unit", () => {
    const r = classifyAmount(10n ** 18n, 18);
    assert.equal(r.classification, "round_unit");
  });

  test("flags 0.5 WETH (5 * 10^17) as round_tenth", () => {
    const r = classifyAmount(5n * 10n ** 17n, 18);
    assert.equal(r.classification, "round_tenth");
  });

  test("flags 0.1 USDC (100_000) as round_tenth", () => {
    const r = classifyAmount(100_000n, 6);
    assert.equal(r.classification, "round_tenth");
  });

  test("flags 1_500_000 USDC as round_decimal (2 sig digits)", () => {
    const r = classifyAmount(1_500_000n, 6); // 1.5 USDC
    assert.equal(r.classification, "round_decimal");
  });

  test("does NOT flag 1_234_567 USDC as round (7 sig digits)", () => {
    const r = classifyAmount(1_234_567n, 6); // 1.234567 USDC
    assert.equal(r.classification, "natural");
    assert.equal(r.suggested, null);
  });

  test("does NOT flag 1_500_001 USDC as round (7 sig digits)", () => {
    const r = classifyAmount(1_500_001n, 6); // 1.500001 USDC
    assert.equal(r.classification, "natural");
  });

  test("returns natural for zero", () => {
    const r = classifyAmount(0n, 6);
    assert.equal(r.classification, "natural");
    assert.equal(r.suggested, null);
  });

  test("returns natural for negative", () => {
    const r = classifyAmount(-1_000_000n, 6);
    assert.equal(r.classification, "natural");
  });

  test("perturbed suggestion differs from input", () => {
    const r = classifyAmount(1_000_000n, 6);
    assert.notEqual(r.suggested, r.baseUnits);
  });

  test("perturbed suggestion within +/-7% default tolerance", () => {
    const amount = 1_000_000n;
    const r = classifyAmount(amount, 6);
    assert.ok(r.suggested !== null);
    const lower = (amount * 93n) / 100n;
    const upper = (amount * 107n) / 100n;
    assert.ok(r.suggested >= lower, `suggested ${r.suggested} < ${lower}`);
    assert.ok(r.suggested <= upper, `suggested ${r.suggested} > ${upper}`);
  });

  test("deterministic: same input yields same suggestion", () => {
    const r1 = classifyAmount(1_000_000n, 6);
    const r2 = classifyAmount(1_000_000n, 6);
    assert.equal(r1.suggested, r2.suggested);
  });

  test("custom tolerancePct=2 narrows the perturbation range", () => {
    const amount = 1_000_000n;
    const r = classifyAmount(amount, 6, 2);
    assert.ok(r.suggested !== null);
    const lower = (amount * 98n) / 100n;
    const upper = (amount * 102n) / 100n;
    assert.ok(r.suggested >= lower);
    assert.ok(r.suggested <= upper);
  });

  test("custom precisionDigits=5 tightens round_decimal threshold", () => {
    // 1_234_500 has 5 sig digits — with threshold=5 flagged round_decimal;
    // with default threshold=3 it would be "natural".
    const looser = classifyAmount(1_234_500n, 6);
    const tighter = classifyAmount(1_234_500n, 6, 7, 5);
    assert.equal(looser.classification, "natural");
    assert.equal(tighter.classification, "round_decimal");
  });
});

describe("formatAdvisory", () => {
  test("formats round_unit USDC", () => {
    const r = classifyAmount(1_000_000n, 6);
    const line = formatAdvisory(r, 6, "USDC");
    assert.match(line, /WARN: amount 1 USDC looks round \(round_unit\)/);
    assert.match(line, /Suggest perturbing -> .* USDC/);
  });

  test("returns empty for natural amounts", () => {
    const r = classifyAmount(1_234_567n, 6);
    assert.equal(formatAdvisory(r, 6, "USDC"), "");
  });

  test("renders 1.5 USDC correctly", () => {
    const r = classifyAmount(1_500_000n, 6);
    const line = formatAdvisory(r, 6, "USDC");
    assert.match(line, /amount 1.5 USDC/);
  });
});
