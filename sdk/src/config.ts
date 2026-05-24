// sdk/src/config.ts
import { ConfigError } from "./errors.js";
import type { NetworkConfig } from "./types.js";

const DECIMALS_BY_CANONICAL: Record<string, number> = {
  usdc: 6,
  weth: 18,
  eth: 18,
  wbtc: 8,
  btc: 8,
};

export function resolveTokenDecimals(alias: string): number {
  if (!alias) throw new ConfigError("UNKNOWN_TOKEN", `Empty token alias`);
  let canonical = alias.toLowerCase();
  if (canonical.startsWith("t") || canonical.startsWith("a")) {
    canonical = canonical.slice(1);
  }
  const d = DECIMALS_BY_CANONICAL[canonical];
  if (d === undefined) {
    throw new ConfigError("UNKNOWN_TOKEN", `Unknown token alias: ${alias}`);
  }
  return d;
}

export const NETWORK_DEFAULTS: Record<string, Pick<NetworkConfig, "nodeUrl">> = {
  "alpha-testnet": { nodeUrl: "https://rpc.testnet.aztec-labs.com" },
  sandbox: { nodeUrl: "http://localhost:8080" },
  mainnet: { nodeUrl: "" },
};
