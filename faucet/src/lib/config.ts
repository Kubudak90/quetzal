export class ConfigError extends Error {
  constructor(msg: string) { super(`[config] ${msg}`); this.name = "ConfigError"; }
}

export interface FaucetConfig {
  port: number;
  nodeEnv: string;
  l1RpcUrl: string;
  l1Pk: `0x${string}`;
  l1FeeJuicePortal: `0x${string}`;
  l2NodeUrl: string;
  l2Secret: `0x${string}`;
  l2TUSDC: `0x${string}`;
  l2TETH: `0x${string}`;
  feeJuiceAmount: bigint;
  tUSDCAmount: bigint;
  tETHAmount: bigint;
  hcaptchaSecretKey: string;
  hcaptchaBypassKey: string;
  globalDailyCap: number;
  perIpCooldownSeconds: number;
  allowedOrigins: Array<string | RegExp>;
  drainThresholdMultiplier: number;
  sqlitePath: string;
  auditLogPath: string;
}

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.length === 0) throw new ConfigError(`missing required env ${name}`);
  return v;
}

function asBigint(name: string, raw: string): bigint {
  try { return BigInt(raw); } catch { throw new ConfigError(`${name} not a bigint: ${raw}`); }
}

function asNumber(name: string, raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new ConfigError(`${name} not a number: ${raw}`);
  return n;
}

function parseAllowedOrigins(raw: string): Array<string | RegExp> {
  return raw.split(",").map((s) => s.trim()).filter(Boolean).map((s) => {
    if (s.startsWith("/") && s.endsWith("/")) {
      return new RegExp(s.slice(1, -1));
    }
    return s;
  });
}

export function loadConfig(): FaucetConfig {
  return {
    port: asNumber("FAUCET_PORT", required("FAUCET_PORT")),
    nodeEnv: required("FAUCET_NODE_ENV"),
    l1RpcUrl: required("FAUCET_L1_RPC_URL"),
    l1Pk: required("FAUCET_L1_PK") as `0x${string}`,
    l1FeeJuicePortal: required("FAUCET_L1_FEE_JUICE_PORTAL") as `0x${string}`,
    l2NodeUrl: required("FAUCET_L2_NODE_URL"),
    l2Secret: required("FAUCET_L2_SECRET") as `0x${string}`,
    l2TUSDC: required("FAUCET_L2_TUSDC") as `0x${string}`,
    l2TETH: required("FAUCET_L2_TETH") as `0x${string}`,
    feeJuiceAmount: asBigint("FAUCET_FEE_JUICE_AMOUNT", required("FAUCET_FEE_JUICE_AMOUNT")),
    tUSDCAmount: asBigint("FAUCET_TUSDC_AMOUNT", required("FAUCET_TUSDC_AMOUNT")),
    tETHAmount: asBigint("FAUCET_TETH_AMOUNT", required("FAUCET_TETH_AMOUNT")),
    hcaptchaSecretKey: required("HCAPTCHA_SECRET_KEY"),
    hcaptchaBypassKey: required("FAUCET_HCAPTCHA_BYPASS_KEY"),
    globalDailyCap: asNumber("FAUCET_GLOBAL_DAILY_CAP", required("FAUCET_GLOBAL_DAILY_CAP")),
    perIpCooldownSeconds: asNumber("FAUCET_PER_IP_COOLDOWN_SECONDS", required("FAUCET_PER_IP_COOLDOWN_SECONDS")),
    allowedOrigins: parseAllowedOrigins(required("FAUCET_ALLOWED_ORIGINS")),
    drainThresholdMultiplier: asNumber("FAUCET_DRAIN_THRESHOLD_MULTIPLIER", required("FAUCET_DRAIN_THRESHOLD_MULTIPLIER")),
    sqlitePath: required("FAUCET_SQLITE_PATH"),
    auditLogPath: required("FAUCET_AUDIT_LOG_PATH"),
  };
}
