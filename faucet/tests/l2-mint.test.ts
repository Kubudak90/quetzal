import { describe, test, expect } from "vitest";
import { L2_TOKEN_DECIMALS } from "@/lib/l2-mint";

describe("L2_TOKEN_DECIMALS", () => {
  test("tUSDC has 6 decimals", () => {
    expect(L2_TOKEN_DECIMALS.tUSDC).toBe(6);
  });
  test("tETH has 18 decimals", () => {
    expect(L2_TOKEN_DECIMALS.tETH).toBe(18);
  });
});
