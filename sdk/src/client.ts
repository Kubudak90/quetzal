// sdk/src/client.ts
import type { AztecAddress } from "@aztec/aztec.js/addresses";
import type { Wallet } from "@aztec/aztec.js/wallet";
import type { NetworkName, NetworkConfig } from "./types.js";
import { ConfigError } from "./errors.js";
import { NETWORK_DEFAULTS } from "./config.js";
import type { WalletAdapter } from "./wallet/adapter.js";
import { SchnorrSecretAdapter } from "./wallet/schnorr.js";
import { ExternalPxeAdapter } from "./wallet/pxe.js";
import { AztecWalletAdapter } from "./wallet/aztec-wallet.js";
import type { AztecBrowserProvider } from "./wallet/aztec-wallet.js";

/**
 * Discriminated union covering all supported account types.
 *
 * - "schnorr"      — ephemeral embedded PXE, server-side usage
 * - "external-pxe" — caller already holds a connected wallet + address
 * - "aztec-wallet" — browser extension (window.aztec RPC provider)
 */
export type AccountSpec =
  | { type: "schnorr"; secret: string }
  | { type: "external-pxe"; wallet: Wallet; address: AztecAddress }
  | { type: "aztec-wallet"; provider: AztecBrowserProvider };

export interface QuetzalClientConnectOptions {
  network: NetworkName;
  nodeUrl?: string;
  account: AccountSpec;
  l1?: NetworkConfig["l1"];
}

/**
 * Top-level SDK entry point.  Obtain an instance via `QuetzalClient.connect()`.
 *
 * Stores { address, wallet, config, adapter } — no `pxe` field (PXE is not
 * exported from aztec.js 4.2.1 sub-paths; access it through the wallet if needed).
 */
export class QuetzalClient {
  private constructor(
    public readonly address: AztecAddress,
    public readonly wallet: Wallet,
    public readonly config: NetworkConfig,
    private readonly adapter: WalletAdapter,
  ) {}

  /**
   * Factory: resolves network defaults, validates required fields, spins up
   * the appropriate wallet adapter, and returns a ready-to-use client.
   *
   * @throws {ConfigError} for unknown networks or missing nodeUrl.
   */
  static async connect(opts: QuetzalClientConnectOptions): Promise<QuetzalClient> {
    const defaults = NETWORK_DEFAULTS[opts.network];
    if (!defaults) {
      throw new ConfigError(
        "INVALID_NETWORK",
        `Unknown network: ${opts.network}`,
      );
    }

    const nodeUrl = opts.nodeUrl ?? defaults.nodeUrl;
    if (!nodeUrl) {
      throw new ConfigError(
        "MISSING_ENV",
        `nodeUrl required for network '${opts.network}' (no default configured)`,
      );
    }

    let adapter: WalletAdapter;
    switch (opts.account.type) {
      case "schnorr":
        adapter = new SchnorrSecretAdapter({
          secret: opts.account.secret,
          nodeUrl,
        });
        break;
      case "external-pxe":
        adapter = new ExternalPxeAdapter({
          wallet: opts.account.wallet,
          address: opts.account.address,
        });
        break;
      case "aztec-wallet":
        adapter = new AztecWalletAdapter({
          provider: opts.account.provider,
        });
        break;
    }

    const { wallet, address } = await adapter.connect();
    return new QuetzalClient(
      address,
      wallet,
      { name: opts.network, nodeUrl, l1: opts.l1 },
      adapter,
    );
  }

  /** Tears down the underlying adapter (e.g. stops an embedded PXE). */
  async stop(): Promise<void> {
    await this.adapter.stop();
  }
}
