// sdk/src/wallet/pool.ts
// Sub-6c B1-B3: WalletPool — N-wallet round-robin to bypass Aztec PXE's
// ~20-unfinalised-private-tx-per-wallet tagging cap.
//
// Each child wallet is HD-derived from a master secret + index. Pool
// transparently round-robins submissions; auto-skips children at the
// PXE_TAGGING_CAP; throws WalletPoolExhausted when all are saturated.
//
// Fee-juice topup for each child wallet is the OPERATOR's responsibility
// (Aztec faucet drip on testnet; self-fund on mainnet). The SDK does
// not sponsor fees.

import { createHash } from "node:crypto";
import { QuetzalClient } from "../client.js";
import type { NetworkName, NetworkConfig } from "../types.js";
import { ConfigError } from "../errors.js";

export const PXE_TAGGING_CAP = 18; // 2 below Aztec's ~20 for safety buffer

export interface WalletPoolOptions {
  masterSecret: string; // 0x-prefixed hex32 root
  n: number;            // pool size; recommend 3-5
  network: NetworkName;
  nodeUrl?: string;
  l1?: NetworkConfig["l1"];
}

interface PoolChild {
  client: QuetzalClient;
  index: number;
  pendingTx: number;
}

/**
 * Derive a child wallet secret from a master secret + index.
 * Formula: childSecret_i = sha256(masterHex_bytes || u32_be(i)),
 * with top 2 bits masked to fit into the bn254 field modulus.
 */
export function deriveChildSecret(masterHex: string, index: number): string {
  const buf = Buffer.concat([
    Buffer.from(masterHex.slice(2), "hex"),
    Buffer.from(index.toString(16).padStart(8, "0"), "hex"),
  ]);
  const digest = createHash("sha256").update(buf).digest("hex");
  const masked = (BigInt("0x" + digest) & ((1n << 254n) - 1n))
    .toString(16)
    .padStart(64, "0");
  return "0x" + masked;
}

export class WalletPool {
  private children: PoolChild[];
  private cursor = 0;

  private constructor(children: PoolChild[]) {
    this.children = children;
  }

  static async fromMaster(opts: WalletPoolOptions): Promise<WalletPool> {
    // Input validation runs BEFORE any QuetzalClient.connect calls
    if (!opts.masterSecret.startsWith("0x") || opts.masterSecret.length !== 66) {
      throw new ConfigError(
        "MISSING_ENV",
        "masterSecret must be 0x-prefixed hex32 (66 chars total)",
      );
    }
    if (opts.n < 1 || opts.n > 20) {
      throw new ConfigError(
        "UNKNOWN",
        `pool size n must be in [1, 20]; got ${opts.n}`,
      );
    }
    const children: PoolChild[] = [];
    for (let i = 0; i < opts.n; i++) {
      const childHex = deriveChildSecret(opts.masterSecret, i);
      const client = await QuetzalClient.connect({
        network: opts.network,
        nodeUrl: opts.nodeUrl,
        account: { type: "schnorr", secret: childHex },
        l1: opts.l1,
      });
      children.push({ client, index: i, pendingTx: 0 });
    }
    return new WalletPool(children);
  }

  get size(): number {
    return this.children.length;
  }

  get addresses(): string[] {
    return this.children.map((c) => c.client.address.toString());
  }

  /**
   * Round-robin pick the next non-saturated child.
   * Throws if all N children are at PXE_TAGGING_CAP.
   */
  next(): QuetzalClient {
    for (let i = 0; i < this.children.length; i++) {
      const idx = (this.cursor + i) % this.children.length;
      const child = this.children[idx];
      if (child.pendingTx < PXE_TAGGING_CAP) {
        this.cursor = (idx + 1) % this.children.length;
        return child.client;
      }
    }
    throw new Error(
      "WalletPoolExhausted: all N wallets at PXE_TAGGING_CAP; " +
        "wait for finalization or grow pool",
    );
  }

  /**
   * Sticky-acquire: same tag returns the same child across calls.
   * Useful for related operations (place + claim of same epoch's order).
   */
  acquireFor(tag: string): QuetzalClient {
    const hashHex = createHash("sha256").update(tag).digest("hex").slice(0, 16);
    const idx = Number(BigInt("0x" + hashHex) % BigInt(this.children.length));
    return this.children[idx].client;
  }

  async stop(): Promise<void> {
    await Promise.all(this.children.map((c) => c.client.stop()));
  }
}
