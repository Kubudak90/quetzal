import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { verifyCaptcha } from "@/lib/captcha";

const baseFetch = global.fetch;

beforeEach(() => { vi.restoreAllMocks(); });
afterEach(() => { global.fetch = baseFetch; });

describe("verifyCaptcha", () => {
  test("accepts the bypass key without calling hCaptcha", async () => {
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;
    const ok = await verifyCaptcha({
      token: "BYPASS-XYZ",
      secretKey: "real-secret",
      bypassKey: "BYPASS-XYZ",
    });
    expect(ok).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("calls hCaptcha siteverify when token != bypass key (success)", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true }),
    }) as unknown as typeof fetch;
    const ok = await verifyCaptcha({ token: "real-token", secretKey: "secret", bypassKey: "BYPASS" });
    expect(ok).toBe(true);
  });

  test("returns false when hCaptcha rejects", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: false, "error-codes": ["invalid-input-response"] }),
    }) as unknown as typeof fetch;
    const ok = await verifyCaptcha({ token: "stale", secretKey: "secret", bypassKey: "BYPASS" });
    expect(ok).toBe(false);
  });

  test("returns false on hCaptcha HTTP error", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false }) as unknown as typeof fetch;
    const ok = await verifyCaptcha({ token: "x", secretKey: "secret", bypassKey: "BYPASS" });
    expect(ok).toBe(false);
  });

  test("returns false on network throw", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("ENOTFOUND")) as unknown as typeof fetch;
    const ok = await verifyCaptcha({ token: "x", secretKey: "secret", bypassKey: "BYPASS" });
    expect(ok).toBe(false);
  });
});
