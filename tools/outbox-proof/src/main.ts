#!/usr/bin/env node
import { buildOutboxProof } from "./build-proof.js";

function parseArgs(): { nodeUrl: string; l2TxHash: string; expectedContent: string } {
  const args = process.argv.slice(2);
  const opts: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!args[i] || !args[i].startsWith("--")) throw new Error(`bad arg: ${args[i]}`);
    opts[args[i].slice(2)] = args[i + 1] ?? "";
  }
  for (const k of ["node-url", "l2-tx-hash", "expected-content"] as const) {
    if (!opts[k]) throw new Error(`required: --${k}`);
  }
  return {
    nodeUrl: opts["node-url"],
    l2TxHash: opts["l2-tx-hash"],
    expectedContent: opts["expected-content"],
  };
}

async function main(): Promise<void> {
  const { nodeUrl, l2TxHash, expectedContent } = parseArgs();
  try {
    const proof = await buildOutboxProof(nodeUrl, l2TxHash, expectedContent);
    process.stdout.write(JSON.stringify(proof) + "\n");
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(e instanceof Error && e.message.includes("not found") ? 1 : 2);
  }
}

main();
