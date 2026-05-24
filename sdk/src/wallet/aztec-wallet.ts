// sdk/src/wallet/aztec-wallet.ts
import type { Wallet } from "@aztec/aztec.js/wallet";
import type { AztecAddress } from "@aztec/aztec.js/addresses";
import type { WalletAdapter } from "./adapter.js";
import { ConfigError } from "../errors.js";

/**
 * Minimal shape of a browser wallet provider (window.aztec).
 * The provider is expected to follow the Aztec wallet RPC spec — providing
 * a PXE-equivalent RPC bridge and an account wallet handle.
 */
export interface AztecBrowserProvider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

export interface AztecWalletAdapterOptions {
  provider: AztecBrowserProvider;
}

/**
 * Adapter for the Aztec Wallet browser extension (window.aztec).
 * Calls aztec_requestAccounts and aztec_getWallet on the provider to obtain
 * a connected AccountWallet without embedding a PXE in the page.
 *
 * stop() is a no-op — the page lifecycle owns the provider connection.
 */
export class AztecWalletAdapter implements WalletAdapter {
  constructor(private readonly opts: AztecWalletAdapterOptions) {
    if (typeof opts.provider?.request !== "function") {
      throw new ConfigError(
        "MISSING_ENV",
        "AztecWalletAdapter requires a provider with a .request() method",
      );
    }
  }

  async connect() {
    const accounts = (await this.opts.provider.request({
      method: "aztec_requestAccounts",
    })) as unknown[];

    if (!Array.isArray(accounts) || accounts.length === 0) {
      throw new ConfigError(
        "MISSING_ENV",
        "AztecWalletAdapter: provider returned no accounts",
      );
    }

    // accounts[0] is the AztecAddress of the selected account (hex string or AztecAddress object)
    const address = accounts[0] as AztecAddress;

    const wallet = (await this.opts.provider.request({
      method: "aztec_getWallet",
      params: [accounts[0]],
    })) as Wallet;

    return { wallet, address };
  }

  async stop() {
    // Browser provider — page lifecycle manages it.
  }
}
