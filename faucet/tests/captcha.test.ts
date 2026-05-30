import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { verifyCaptcha } from "@/lib/captcha";

const baseFetch = global.fetch;

beforeEach(() => { vi.restoreAllMocks(); });
afterEach(() => { global.fetch = baseFetch; });

describe("verifyCaptcha", () => {
  // Audit #6: captcha disabled server-side (testnet) → always allow, never call hCaptcha.
  test("returns true regardless of token when requireCaptcha is false", async () => {
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;
    const ok = await verifyCaptcha({
      token: "anything",
      secretKey: "real-secret",
      requireCaptcha: false,
    });
    expect(ok).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();

    // Even with an empty token + empty secret, disabled means allowed.
    const ok2 = await verifyCaptcha({ token: "", secretKey: "", requireCaptcha: false });
    expect(ok2).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // Audit #6: required but unconfigured secret → FAIL CLOSED, never call hCaptcha.
  test("returns false (fail-closed) when requireCaptcha is true and secretKey is empty", async () => {
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;
    const ok = await verifyCaptcha({ token: "some-token", secretKey: "", requireCaptcha: true });
    expect(ok).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("calls hCaptcha siteverify when required + secret present (success)", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true }),
    }) as unknown as typeof fetch;
    const ok = await verifyCaptcha({ token: "real-token", secretKey: "secret", requireCaptcha: true });
    expect(ok).toBe(true);
  });

  test("returns false when hCaptcha rejects", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: false, "error-codes": ["invalid-input-response"] }),
    }) as unknown as typeof fetch;
    const ok = await verifyCaptcha({ token: "stale", secretKey: "secret", requireCaptcha: true });
    expect(ok).toBe(false);
  });

  test("returns false on hCaptcha HTTP error", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false }) as unknown as typeof fetch;
    const ok = await verifyCaptcha({ token: "x", secretKey: "secret", requireCaptcha: true });
    expect(ok).toBe(false);
  });

  test("returns false on network throw", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("ENOTFOUND")) as unknown as typeof fetch;
    const ok = await verifyCaptcha({ token: "x", secretKey: "secret", requireCaptcha: true });
    expect(ok).toBe(false);
  });
});
