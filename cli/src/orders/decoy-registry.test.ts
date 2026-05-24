import { test } from "node:test";
import { strict as assert } from "node:assert";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
// Sub-6b Task 2.8: lifted to @quetzal/sdk.
import {
  loadDecoyRegistry,
  saveDecoyRegistry,
  recordDecoyBatch,
  isDecoy,
  listDecoys,
} from "@quetzal/sdk/privacy/decoy-registry";

// Isolate HOME so tests don't pollute the real ~/.quetzal/
const origHome = process.env.HOME;
const testHome = mkdtempSync(join(tmpdir(), "quetzal-decoy-test-"));
process.env.HOME = testHome;

test("empty registry returns {} for unknown wallet", () => {
  assert.deepEqual(loadDecoyRegistry("0xabc1"), {});
});

test("save + load round trip", () => {
  saveDecoyRegistry("0xabc2", { "0x10": true, "0x20": false });
  assert.deepEqual(loadDecoyRegistry("0xabc2"), { "0x10": true, "0x20": false });
});

test("recordDecoyBatch merges + lowercases keys", () => {
  recordDecoyBatch("0xabc3", [
    { nonce: "0xAB", isDecoy: true },
    { nonce: "0xCD", isDecoy: false },
  ]);
  recordDecoyBatch("0xabc3", [{ nonce: "0xEF", isDecoy: true }]);
  assert.deepEqual(loadDecoyRegistry("0xabc3"), { "0xab": true, "0xcd": false, "0xef": true });
});

test("isDecoy returns true only for explicit decoy=true entries", () => {
  recordDecoyBatch("0xabc4", [
    { nonce: "0x1", isDecoy: true },
    { nonce: "0x2", isDecoy: false },
  ]);
  assert.equal(isDecoy("0xabc4", "0x1"), true);
  assert.equal(isDecoy("0xabc4", "0x2"), false);
  assert.equal(isDecoy("0xabc4", "0x3"), false);  // unknown nonce
});

test("listDecoys returns only decoy=true nonces", () => {
  recordDecoyBatch("0xabc5", [
    { nonce: "0x1", isDecoy: true },
    { nonce: "0x2", isDecoy: false },
    { nonce: "0x3", isDecoy: true },
  ]);
  assert.deepEqual(listDecoys("0xabc5").sort(), ["0x1", "0x3"]);
});

process.on("exit", () => {
  process.env.HOME = origHome;
  rmSync(testHome, { recursive: true, force: true });
});
