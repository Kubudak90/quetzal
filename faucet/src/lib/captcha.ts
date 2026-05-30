const HCAPTCHA_SITEVERIFY = "https://api.hcaptcha.com/siteverify";

interface VerifyCaptchaOpts {
  token: string;
  secretKey: string;
  /**
   * Server-side captcha toggle (config.requireCaptcha). When false the faucet
   * skips verification entirely (testnet, which ships no hCaptcha widget).
   */
  requireCaptcha: boolean;
}

interface SiteverifyResponse {
  success: boolean;
  "error-codes"?: string[];
}

/**
 * Audit #6: the old implementation accepted a public-shared `bypassKey` that was
 * baked into the browser bundle AND equalled the server's secret — anyone could
 * read it and skip captcha entirely (faucet drain risk). This replaces that with
 * an explicit server-side toggle:
 *
 *   - requireCaptcha === false  → captcha disabled by config (testnet); allow.
 *   - requireCaptcha === true   → captcha REQUIRED. If no secretKey is configured
 *                                 we FAIL CLOSED (return false) rather than letting
 *                                 a misconfiguration silently disable verification.
 *   - otherwise                 → real hCaptcha siteverify against opts.token.
 *
 * No secret is ever shipped to the browser.
 */
export async function verifyCaptcha(opts: VerifyCaptchaOpts): Promise<boolean> {
  if (!opts.requireCaptcha) return true; // captcha disabled by server config (testnet)
  if (!opts.secretKey) return false; // required but unconfigured → fail closed
  try {
    const res = await fetch(HCAPTCHA_SITEVERIFY, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ response: opts.token, secret: opts.secretKey }).toString(),
    });
    if (!res.ok) return false;
    const body = (await res.json()) as SiteverifyResponse;
    return body.success === true;
  } catch {
    return false;
  }
}
