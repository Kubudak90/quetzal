import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface ZswapConfig {
  nodeUrl: string;
  tUSDC: string;
  tETH: string;
  orderbook: string;
  pool: string;
  admin: string;
}

const REQUIRED: (keyof ZswapConfig)[] = ["nodeUrl", "tUSDC", "tETH", "orderbook", "pool", "admin"];

/** Load and validate zswap.config.json (written by scripts/deploy-tokens.ts). */
export function loadConfig(path = "zswap.config.json"): ZswapConfig {
  const abs = resolve(process.cwd(), path);
  let parsed: Partial<ZswapConfig>;
  try {
    parsed = JSON.parse(readFileSync(abs, "utf8")) as Partial<ZswapConfig>;
  } catch (e) {
    throw new Error(
      `could not read config at ${abs} — run \`pnpm tsx scripts/deploy-tokens.ts\` first ` +
        `(or pass --config): ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  for (const key of REQUIRED) {
    if (typeof parsed[key] !== "string") {
      throw new Error(`config at ${abs} is missing required string field "${key}"`);
    }
  }
  return parsed as ZswapConfig;
}
