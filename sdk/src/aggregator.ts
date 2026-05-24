// sdk/src/aggregator.ts
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { Fr } from "@aztec/aztec.js/fields";
import { poseidon2Hash } from "@aztec/foundation/crypto/poseidon";
import type { QuetzalClient } from "./client.js";
import type { QuetzalContracts } from "./types.js";
import { ConfigError } from "./errors.js";

function requireRegistry(client: QuetzalClient): { contracts: QuetzalContracts; registry: string } {
  const contracts = client.config.contracts;
  if (!contracts) {
    throw new ConfigError(
      "MISSING_ENV",
      "QuetzalClient.config.contracts not set; pass `contracts` to QuetzalClient.connect()",
    );
  }
  if (!contracts.aggregatorRegistry) {
    throw new ConfigError(
      "MISSING_ENV",
      "config.contracts.aggregatorRegistry not set — deploy Sub-3 AggregatorRegistry first.",
    );
  }
  return { contracts, registry: contracts.aggregatorRegistry };
}

/**
 * Canonical URL → Field hash. Mirrors cli/src/reveal.ts:hashUrl so on-chain
 * endpoint_hash registration + maker-side reveal-broadcast hash both produce
 * the same Field for the same URL string.
 */
export async function hashUrl(url: string): Promise<Fr> {
  const bytes = new TextEncoder().encode(url);
  const asBigint =
    bytes.length === 0 ? 0n : BigInt("0x" + Buffer.from(bytes).toString("hex"));
  return poseidon2Hash([asBigint]);
}

export interface AggregatorEntry {
  id: number;
  address: string;
  endpointHash: string;
}

export class AggregatorApi {
  constructor(private client: QuetzalClient) {}

  async register(opts: { url: string }): Promise<{ txHash: string; endpointHash: string }> {
    const { registry } = requireRegistry(this.client);
    const endpointHash = await hashUrl(opts.url);
    const { loadAggregatorRegistryContract } = await import("./internal/contracts.js");
    const AggregatorRegistryContract = await loadAggregatorRegistryContract();
    const reg = await AggregatorRegistryContract.at(
      AztecAddress.fromString(registry),
      this.client.wallet,
    );
    const nonce = Fr.random();
    const tx = await reg.methods.register(endpointHash, nonce).send({ from: this.client.address });
    const receipt = (await (tx as { wait?: () => Promise<unknown> }).wait?.()) as
      | { txHash?: { toString: () => string } }
      | undefined;
    return {
      txHash: receipt?.txHash?.toString() ?? "",
      endpointHash: endpointHash.toString(),
    };
  }

  async unregister(): Promise<{ txHash: string }> {
    const { registry } = requireRegistry(this.client);
    const { loadAggregatorRegistryContract } = await import("./internal/contracts.js");
    const AggregatorRegistryContract = await loadAggregatorRegistryContract();
    const reg = await AggregatorRegistryContract.at(
      AztecAddress.fromString(registry),
      this.client.wallet,
    );
    const tx = await reg.methods.unregister(new Fr(0n)).send({ from: this.client.address });
    const receipt = (await (tx as { wait?: () => Promise<unknown> }).wait?.()) as
      | { txHash?: { toString: () => string } }
      | undefined;
    return { txHash: receipt?.txHash?.toString() ?? "" };
  }

  async list(): Promise<AggregatorEntry[]> {
    const { registry } = requireRegistry(this.client);
    const { loadAggregatorRegistryContract } = await import("./internal/contracts.js");
    const AggregatorRegistryContract = await loadAggregatorRegistryContract();
    const reg = await AggregatorRegistryContract.at(
      AztecAddress.fromString(registry),
      this.client.wallet,
    );
    const countSim = await reg.methods
      .get_aggregator_count()
      .simulate({ from: this.client.address });
    const count = Number((countSim as { result: bigint }).result);
    const out: AggregatorEntry[] = [];
    for (let id = 1; id <= count; id++) {
      const addrSim = await reg.methods
        .get_aggregator_by_id(id)
        .simulate({ from: this.client.address });
      const addrField = (addrSim as { result: { inner?: bigint } | bigint }).result;
      const addrBigInt =
        typeof addrField === "bigint" ? addrField : (addrField as { inner: bigint }).inner;
      if (addrBigInt === 0n) continue;
      const addr = AztecAddress.fromBigInt(addrBigInt);
      const hashSim = await reg.methods.get_endpoint_hash(addr).simulate({ from: this.client.address });
      const hash = (hashSim as { result: bigint }).result;
      out.push({
        id,
        address: addr.toString(),
        endpointHash: `0x${hash.toString(16)}`,
      });
    }
    return out;
  }

  /**
   * Broadcast a reveal to all bonded aggregators.  The URL→address manifest
   * is supplied by the caller (CLI looks up its own JSON file; future
   * front-end embeddings may use a hard-coded list).
   *
   * The reveal payload shape is intentionally untyped here — the SDK does
   * not own the Sub-3 reveal schema (lives in aggregator/).  Callers pass
   * the JSON payload they intend POSTed.
   */
  async broadcastReveal(opts: {
    payload: Record<string, unknown>;
    manifest: Record<string, string>; // addrHex → URL
  }): Promise<{ pushed: number; skipped: number }> {
    const { registry } = requireRegistry(this.client);
    const { loadAggregatorRegistryContract } = await import("./internal/contracts.js");
    const AggregatorRegistryContract = await loadAggregatorRegistryContract();
    const reg = await AggregatorRegistryContract.at(
      AztecAddress.fromString(registry),
      this.client.wallet,
    );
    const countSim = await reg.methods.get_aggregator_count().simulate({ from: this.client.address });
    const count = Number((countSim as { result: bigint }).result);

    const targets: { url: string; addr: string }[] = [];
    for (let id = 1; id <= count; id++) {
      const addrSim = await reg.methods
        .get_aggregator_by_id(id)
        .simulate({ from: this.client.address });
      const addrField = (addrSim as { result: { inner?: bigint } | bigint }).result;
      const addrBigInt =
        typeof addrField === "bigint" ? addrField : (addrField as { inner: bigint }).inner;
      if (addrBigInt === 0n) continue;
      const addrHex = `0x${addrBigInt.toString(16).padStart(64, "0")}`;
      const url = opts.manifest[addrHex] || opts.manifest[`0x${addrBigInt.toString(16)}`];
      if (!url) continue;
      const addr = AztecAddress.fromBigInt(addrBigInt);
      const hashSim = await reg.methods.get_endpoint_hash(addr).simulate({ from: this.client.address });
      const onchainHashRaw = (hashSim as { result: { inner?: bigint } | bigint }).result;
      const onchainHash =
        typeof onchainHashRaw === "bigint"
          ? onchainHashRaw
          : (onchainHashRaw as { inner: bigint }).inner;
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
            body: JSON.stringify(opts.payload),
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
}
