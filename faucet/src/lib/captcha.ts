const HCAPTCHA_SITEVERIFY = "https://api.hcaptcha.com/siteverify";

interface VerifyCaptchaOpts {
  token: string;
  secretKey: string;
  bypassKey: string;
}

interface SiteverifyResponse {
  success: boolean;
  "error-codes"?: string[];
}

export async function verifyCaptcha(opts: VerifyCaptchaOpts): Promise<boolean> {
  if (opts.token === opts.bypassKey) return true;
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
