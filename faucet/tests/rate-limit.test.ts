import { describe, test, expect, beforeEach } from "vitest";
import { RateLimiter } from "@/lib/rate-limit";

function makeLimiter(opts?: Partial<{ cooldownSeconds: number; dailyCap: number }>) {
  return new RateLimiter({
    sqlitePath: ":memory:",
    cooldownSeconds: opts?.cooldownSeconds ?? 28_800,
    dailyCap: opts?.dailyCap ?? 500,
  });
}

let now = 1_700_000_000;
const clock = { now: () => now };

beforeEach(() => { now = 1_700_000_000; });

describe("RateLimiter", () => {
  test("first request for an IP is allowed", () => {
    const lim = makeLimiter();
    const r = lim.checkAndRecord("1.2.3.4", clock);
    expect(r.allowed).toBe(true);
    expect(r.retryAfterSeconds).toBeUndefined();
  });

  test("second request from same IP within cooldown is throttled", () => {
    const lim = makeLimiter();
    lim.checkAndRecord("1.2.3.4", clock);
    now += 100;
    const r = lim.checkAndRecord("1.2.3.4", clock);
    expect(r.allowed).toBe(false);
    expect(r.retryAfterSeconds).toBeGreaterThan(28_000);
    expect(r.reason).toBe("per-ip");
  });

  test("request from same IP AFTER cooldown is allowed", () => {
    const lim = makeLimiter();
    lim.checkAndRecord("1.2.3.4", clock);
    now += 28_801;
    const r = lim.checkAndRecord("1.2.3.4", clock);
    expect(r.allowed).toBe(true);
  });

  test("different IPs do not share cooldown", () => {
    const lim = makeLimiter();
    lim.checkAndRecord("1.2.3.4", clock);
    const r = lim.checkAndRecord("5.6.7.8", clock);
    expect(r.allowed).toBe(true);
  });

  test("global daily cap blocks all requests at the limit", () => {
    const lim = makeLimiter({ dailyCap: 2 });
    expect(lim.checkAndRecord("1.1.1.1", clock).allowed).toBe(true);
    now += 1; expect(lim.checkAndRecord("2.2.2.2", clock).allowed).toBe(true);
    now += 1;
    const r = lim.checkAndRecord("3.3.3.3", clock);
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("global-cap");
  });

  test("stats: totalRequests24h and throttled24h", () => {
    const lim = makeLimiter();
    lim.checkAndRecord("1.1.1.1", clock);
    now += 1; lim.checkAndRecord("1.1.1.1", clock);
    now += 1; lim.checkAndRecord("2.2.2.2", clock);
    const s = lim.stats(clock);
    expect(s.totalRequests24h).toBe(3);
    expect(s.throttled24h).toBe(1);
  });

  test("evictOlderThan24h drops stale rows", () => {
    const lim = makeLimiter();
    lim.checkAndRecord("1.1.1.1", clock);
    now += 86_401;
    lim.evictStale(clock);
    const s = lim.stats(clock);
    expect(s.totalRequests24h).toBe(0);
  });
});
