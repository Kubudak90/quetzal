import { describe, test, expect, beforeEach } from "vitest";
import { loadSession, saveSession, clearSession, type PersistedSession } from "./persistence";

const sample: PersistedSession = {
  schemaVersion: 1,
  masterSecret: "0x" + "11".repeat(32) as `0x${string}`,
  poolSize: 3,
  network: "alpha-testnet",
  deployedAddresses: [
    "0x" + "aa".repeat(32) as `0x${string}`,
    "0x" + "bb".repeat(32) as `0x${string}`,
    "0x" + "cc".repeat(32) as `0x${string}`,
  ],
  onboardedAt: 1779900000000,
};

beforeEach(() => {
  localStorage.clear();
});

describe("persistence", () => {
  test("loadSession returns null when nothing is stored", () => {
    expect(loadSession()).toBeNull();
  });

  test("saveSession + loadSession round-trip", () => {
    saveSession(sample);
    expect(loadSession()).toEqual(sample);
  });

  test("clearSession removes the stored value", () => {
    saveSession(sample);
    clearSession();
    expect(loadSession()).toBeNull();
  });

  test("schema-version mismatch returns null (forward-compat: ignored, not thrown)", () => {
    localStorage.setItem("quetzal-onboarded-v1", JSON.stringify({ ...sample, schemaVersion: 999 }));
    expect(loadSession()).toBeNull();
  });

  test("corrupt JSON returns null (does not throw)", () => {
    localStorage.setItem("quetzal-onboarded-v1", "{not-json");
    expect(loadSession()).toBeNull();
  });
});
