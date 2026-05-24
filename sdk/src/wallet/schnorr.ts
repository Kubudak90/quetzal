// sdk/src/wallet/schnorr.ts
// Mirrors the pattern used in cli/src/wallet.ts:openCli — EmbeddedWallet.create
// with ephemeral storage, then createSchnorrAccount with the caller's secret key.
import { Fr } from "@aztec/aztec.js/fields";
import { EmbeddedWallet } from "@aztec/wallets/embedded";
import type { WalletAdapter } from "./adapter.js";
import { ConfigError } from "../errors.js";

export interface SchnorrSecretAdapterOptions {
  /** 0x-prefixed 32-byte hex secret key (Fr field element). */
  secret: string;
  /** Aztec node JSON-RPC URL, e.g. http://localhost:8080 */
  nodeUrl: string;
}

/**
 * Adapter that spins up an ephemeral embedded PXE, creates a Schnorr account
 * derived from `secret`, and returns it ready for use.
 *
 * The embedded PXE is torn down on stop().  This adapter is appropriate for
 * server-side SDK usage (scripts, CLI, backend services).
 */
export class SchnorrSecretAdapter implements WalletAdapter {
  private embeddedWallet: EmbeddedWallet | null = null;

  constructor(private readonly opts: SchnorrSecretAdapterOptions) {
    if (!opts.secret || !opts.secret.startsWith("0x")) {
      throw new ConfigError(
        "MISSING_ENV",
        "SchnorrSecretAdapter requires a 0x-prefixed hex32 secret",
      );
    }
  }

  async connect() {
    const wallet = await EmbeddedWallet.create(this.opts.nodeUrl, {
      ephemeral: true,
      pxe: { proverEnabled: false },
    });
    const accountManager = await wallet.createSchnorrAccount(
      Fr.fromString(this.opts.secret),
      Fr.ZERO,
    );
    const account = await accountManager.getAccount();
    this.embeddedWallet = wallet;
    return {
      wallet: account as unknown as import("@aztec/aztec.js/wallet").Wallet,
      address: account.getAddress(),
    };
  }

  async stop() {
    if (this.embeddedWallet) {
      await this.embeddedWallet.stop();
      this.embeddedWallet = null;
    }
  }
}
