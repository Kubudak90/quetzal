import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { AztecAddress } from "@aztec/aztec.js/addresses";
import { Fr } from "@aztec/aztec.js/fields";
import { poseidon2Hash } from "@aztec/foundation/crypto/poseidon";

import type { AggregatorRegistryContract } from "../../tests/integration/generated/AggregatorRegistry.js";

export interface RevealPayload {
  epoch_id: number;
  order_nonce: string;
  side: boolean;
  amount_in: string;
  limit_price: string;
  submitted_at_block: number;
  owner: string;
  submission_tx_hash?: string;
}

function manifestPath(): string {
  const override = process.env.ZSWAP_AGGREGATOR_MANIFEST;
  if (override && existsSync(override)) return override;
  // Resolve relative to this file's directory at runtime.
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "aggregator-manifest.json");
}

function loadManifest(): Record<string, string> {
  const path = manifestPath();
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, string>;
}

/**
 * Canonical URL -> Field hash. Must match the form the CLI's `aggregator
 * register` command uses, since the on-chain stored endpoint hash is computed
 * here AND the on-chain `view_bonded_amount`-style lookup against the manifest
 * compares against this hash.
 *
 * The encoding: utf8 bytes -> hex string -> bigint -> poseidon2Hash([bigint]).
 */
export async function hashUrl(url: string): Promise<Fr> {
  const bytes = new TextEncoder().encode(url);
  const asBigint = bytes.length === 0
    ? 0n
    : BigInt("0x" + Buffer.from(bytes).toString("hex"));
  return poseidon2Hash([asBigint]);
}

/**
 * Broadcast a reveal to every registered aggregator whose endpoint hash matches
 * the manifest URL. Best-effort: failed pushes are logged but do not throw.
 */
export async function broadcastReveal(
  payload: RevealPayload,
  registry: AggregatorRegistryContract,
  account: AztecAddress,
): Promise<{ pushed: number; skipped: number }> {
  const manifest = loadManifest();
  const countSim = await registry.methods.get_aggregator_count().simulate({ from: account });
  const count = Number((countSim as { result: bigint }).result);

  const targets: { url: string; addr: string }[] = [];
  for (let id = 1; id <= count; id++) {
    const addrSim = await registry.methods.get_aggregator_by_id(id).simulate({ from: account });
    const addrField = (addrSim as { result: { inner?: bigint } | bigint }).result;
    const addrBigInt = typeof addrField === "bigint" ? addrField : (addrField as { inner: bigint }).inner;
    if (addrBigInt === 0n) continue;
    const addrHex = `0x${addrBigInt.toString(16).padStart(64, "0")}`;
    const url = manifest[addrHex] || manifest[`0x${addrBigInt.toString(16)}`];
    if (!url) continue;

    // Hash-verify URL against on-chain endpoint hash.
    const { AztecAddress: AA } = await import("@aztec/aztec.js/addresses");
    const addr = AA.fromBigInt(addrBigInt);
    const hashSim = await registry.methods.get_endpoint_hash(addr).simulate({ from: account });
    const onchainHashRaw = (hashSim as { result: { inner?: bigint } | bigint }).result;
    const onchainHash =
      typeof onchainHashRaw === "bigint" ? onchainHashRaw : (onchainHashRaw as { inner: bigint }).inner;
    const computedHash = await hashUrl(url);
    if (computedHash.toBigInt() !== onchainHash) continue;

    targets.push({ url, addr: addrHex });
  }

  let pushed = 0;
  let skipped = 0;
  await Promise.allSettled(
    targets.map(async (t) => {
      try {
        const res = await fetch(`${t.url}/reveal`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (res.ok) pushed += 1;
        else skipped += 1;
      } catch {
        skipped += 1;
      }
    }),
  );
  return { pushed, skipped };
}
