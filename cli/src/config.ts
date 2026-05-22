import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface ZswapPool {
  pool_id: number;
  token_a: string;     // canonical (lex-ordered) lower hex address
  token_b: string;     // canonical (lex-ordered) higher hex address
  address: string;     // Pool contract address
}

export interface ZswapConfig {
  nodeUrl: string;
  tUSDC: string;
  tETH: string;
  tBTC?: string;       // Sub-4: optional alias for third token
  pools: ZswapPool[];  // Sub-4: multi-pool registry
  orderbook: string;
  admin: string;
  aggregatorRegistry?: string;
  treasury?: string;
  bucketPMinSqrt?: string;
  bucketGrowthNum?: string;
}

const REQUIRED: (keyof ZswapConfig)[] = ["nodeUrl", "tUSDC", "tETH", "orderbook", "admin", "pools"];

export function loadConfig(path = "zswap.config.json"): ZswapConfig {
  const abs = resolve(process.cwd(), path);
  let parsed: Partial<ZswapConfig>;
  try {
    parsed = JSON.parse(readFileSync(abs, "utf8")) as Partial<ZswapConfig>;
  } catch (e) {
    throw new Error(`could not read config at ${abs}: ${e instanceof Error ? e.message : String(e)}`);
  }
  for (const key of REQUIRED) {
    if (parsed[key] === undefined || parsed[key] === null) {
      throw new Error(`config at ${abs} missing required field "${key}"`);
    }
  }
  if (!Array.isArray(parsed.pools) || parsed.pools.length === 0) {
    throw new Error(`config at ${abs}: pools must be a non-empty array`);
  }
  return parsed as ZswapConfig;
}
