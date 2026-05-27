// Sub-7a Task 13: POST /api/drip — Next.js Pages API route.
//
// CORS allowlist + body validation + IP extraction live here; the actual
// drip logic is delegated to runDripPipeline so the integration is fully
// unit-testable (see tests/drip-pipeline.test.ts).

import type { NextApiRequest, NextApiResponse } from "next";
import { DripRequestSchema } from "@/lib/types";
import { matchOrigin } from "@/lib/cors";
import { getRuntime } from "@/lib/runtime";
import { metrics } from "@/lib/metrics";
import { runDripPipeline } from "@/lib/drip-pipeline";
import { verifyCaptcha } from "@/lib/captcha";

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
): Promise<void> {
  const rt = getRuntime();

  // CORS: only echo Access-Control-Allow-Origin when the request's Origin
  // header matches the configured allowlist. Block all cross-origin requests
  // from non-allowlisted origins.
  const origin = req.headers.origin ?? "";
  if (origin && !matchOrigin(origin, rt.config.allowedOrigins)) {
    res.status(403).end();
    return;
  }
  if (origin) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");

  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.status(204).end();
    return;
  }
  if (req.method !== "POST") {
    res.status(405).json({ success: false, error: "method not allowed" });
    return;
  }

  const parsed = DripRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      success: false,
      error: "invalid body: " + parsed.error.issues.map((i) => i.message).join("; "),
    });
    return;
  }

  // Prefer x-forwarded-for (set by the reverse proxy in front of the
  // Next.js server). First entry is the client; downstream proxies append.
  // Fall back to the socket address for tests / direct-connect scenarios.
  const xff = req.headers["x-forwarded-for"];
  const xffStr = Array.isArray(xff) ? xff[0] : xff;
  const ip =
    xffStr?.split(",")[0]?.trim() ?? req.socket.remoteAddress ?? "unknown";

  const out = await runDripPipeline({
    address: parsed.data.address,
    captchaToken: parsed.data.captchaToken,
    ip,
    deps: {
      verifyCaptcha: (t) =>
        verifyCaptcha({
          token: t,
          secretKey: rt.config.hcaptchaSecretKey,
          bypassKey: rt.config.hcaptchaBypassKey,
        }),
      rateLimiter: rt.rateLimiter,
      bridgeFeeJuice: (to, amount) => rt.l1Bridge.bridgeFeeJuice(to, amount),
      mintTUSDC: (to, amount) => rt.mintTUSDC(to, amount),
      mintTETH: (to, amount) => rt.mintTETH(to, amount),
      checkDrained: () => rt.checkDrained(),
      config: rt.config,
      auditLog: rt.auditLog,
    },
  });

  if (out.status === 200) metrics.dripTotal.inc();
  else if (out.status === 429) metrics.throttledTotal.inc();
  else metrics.dripFailedTotal.inc();

  res.status(out.status).json(out.body);
}
