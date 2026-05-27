import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { loadConfig, ConfigError } from "@/lib/config";

const MINIMAL_ENV: Record<string, string> = {
  FAUCET_PORT: "3030",
  FAUCET_NODE_ENV: "test",
  FAUCET_L1_RPC_URL: "https://sepolia.example",
  FAUCET_L1_PK: "0x" + "11".repeat(32),
  FAUCET_L1_FEE_JUICE_PORTAL: "0x" + "22".repeat(20),
  FAUCET_L2_NODE_URL: "https://node.example",
  FAUCET_L2_SECRET: "0x" + "33".repeat(32),
  FAUCET_L2_TUSDC: "0x" + "44".repeat(32),
  FAUCET_L2_TETH: "0x" + "55".repeat(32),
  FAUCET_FEE_JUICE_AMOUNT: "100000000000000000000",
  FAUCET_TUSDC_AMOUNT: "1000000000",
  FAUCET_TETH_AMOUNT: "500000000000000000",
  HCAPTCHA_SECRET_KEY: "test-secret",
  FAUCET_HCAPTCHA_BYPASS_KEY: "BYPASS",
  FAUCET_GLOBAL_DAILY_CAP: "500",
  FAUCET_PER_IP_COOLDOWN_SECONDS: "28800",
  FAUCET_ALLOWED_ORIGINS: "https://quetzaldex.xyz",
  FAUCET_DRAIN_THRESHOLD_MULTIPLIER: "10",
  FAUCET_SQLITE_PATH: ":memory:",
  FAUCET_AUDIT_LOG_PATH: "/dev/null",
};

const savedEnv = { ...process.env };

beforeEach(() => {
  for (const k of Object.keys(MINIMAL_ENV)) delete process.env[k];
});
afterEach(() => {
  process.env = { ...savedEnv };
});

describe("loadConfig", () => {
  test("returns a typed config from a valid env", () => {
    Object.assign(process.env, MINIMAL_ENV);
    const cfg = loadConfig();
    expect(cfg.port).toBe(3030);
    expect(cfg.feeJuiceAmount).toBe(100000000000000000000n);
    expect(cfg.tUSDCAmount).toBe(1_000_000_000n);
    expect(cfg.allowedOrigins.length).toBe(1);
    expect(cfg.drainThresholdMultiplier).toBe(10);
  });

  test("throws ConfigError when a required key is missing", () => {
    Object.assign(process.env, { ...MINIMAL_ENV });
    delete process.env.FAUCET_L1_PK;
    expect(() => loadConfig()).toThrow(ConfigError);
  });

  test("parses comma-separated allowed origins + /regex/ entries", () => {
    Object.assign(process.env, {
      ...MINIMAL_ENV,
      FAUCET_ALLOWED_ORIGINS: "https://quetzaldex.xyz,/^https:\\/\\/.*\\.vercel\\.app$/",
    });
    const cfg = loadConfig();
    expect(cfg.allowedOrigins).toHaveLength(2);
    expect(cfg.allowedOrigins[0]).toBe("https://quetzaldex.xyz");
    expect(cfg.allowedOrigins[1]).toBeInstanceOf(RegExp);
  });

  test("rejects single-slash CORS wildcard (degenerate regex)", () => {
    Object.assign(process.env, { ...MINIMAL_ENV, FAUCET_ALLOWED_ORIGINS: "/" });
    const cfg = loadConfig();
    // "/" stays a plain string, not promoted to an empty regex that matches all
    expect(cfg.allowedOrigins).toEqual(["/"]);
  });

  test("rejects two-slash degenerate (//)", () => {
    Object.assign(process.env, { ...MINIMAL_ENV, FAUCET_ALLOWED_ORIGINS: "//" });
    const cfg = loadConfig();
    expect(cfg.allowedOrigins).toEqual(["//"]);
  });

  test("accepts minimal three-char regex /a/", () => {
    Object.assign(process.env, { ...MINIMAL_ENV, FAUCET_ALLOWED_ORIGINS: "/a/" });
    const cfg = loadConfig();
    expect(cfg.allowedOrigins[0]).toBeInstanceOf(RegExp);
    expect((cfg.allowedOrigins[0] as RegExp).source).toBe("a");
  });
});
