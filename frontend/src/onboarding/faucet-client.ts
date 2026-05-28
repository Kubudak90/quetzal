// HTTP client for Sub-7a faucet's POST /api/drip. The frontend does NOT depend
// on @quetzal/faucet — we redeclare the response shape here to avoid pulling
// the Next.js server bundle into the browser.

export interface ClaimData {
  claimAmount: string;
  claimSecretHex: string;
  claimSecretHashHex: string;
  messageHashHex: string;
  messageLeafIndex: string;
  l1TxHash: string;
}

export interface DripResult {
  l2Address: `0x${string}`;
  claimData: ClaimData;
  tUSDCMint: { txHash: string; amount: string };
  tETHMint:  { txHash: string; amount: string };
}

export class FaucetError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "FaucetError";
  }
}
export class FaucetRateLimitedError extends FaucetError {
  constructor(public readonly retryAfterSeconds: number) {
    super(`Rate-limited; retry in ${retryAfterSeconds}s`);
    this.name = "FaucetRateLimitedError";
  }
}
export class FaucetDrainedError extends FaucetError {
  constructor() { super("Faucet drained"); this.name = "FaucetDrainedError"; }
}
export class FaucetTimeoutError extends FaucetError {
  constructor() { super("Faucet request timed out"); this.name = "FaucetTimeoutError"; }
}
export class FaucetNetworkError extends FaucetError {
  constructor(cause: string) { super(`Network error: ${cause}`); this.name = "FaucetNetworkError"; }
}

interface DripOpts {
  faucetUrl: string;
  address: `0x${string}`;
  bypassKey: string;
  signal?: AbortSignal;
  /** Default 5 minutes — drips can take 2-4 min server-side on Aztec testnet. */
  timeoutMs?: number;
}

export async function dripFaucet(opts: DripOpts): Promise<DripResult> {
  const timeoutMs = opts.timeoutMs ?? 5 * 60 * 1000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  // Compose external + internal abort
  if (opts.signal) {
    if (opts.signal.aborted) ctrl.abort();
    else opts.signal.addEventListener("abort", () => ctrl.abort(), { once: true });
  }
  try {
    const res = await fetch(`${opts.faucetUrl}/api/drip`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address: opts.address, captchaToken: opts.bypassKey }),
      signal: ctrl.signal,
    });
    if (res.status === 200) {
      const body = (await res.json()) as DripResult & { success: true };
      return {
        l2Address: opts.address,
        claimData: body.claimData,
        tUSDCMint: body.tUSDCMint,
        tETHMint: body.tETHMint,
      };
    }
    let json: { error?: string; retryAfterSeconds?: number };
    try { json = (await res.json()) as typeof json; } catch { json = {}; }
    if (res.status === 429) {
      throw new FaucetRateLimitedError(json.retryAfterSeconds ?? 0);
    }
    if (res.status === 503) {
      throw new FaucetDrainedError();
    }
    throw new FaucetNetworkError(`HTTP ${res.status} ${json.error ?? ""}`);
  } catch (e) {
    if (e instanceof FaucetError) throw e;
    if (e instanceof DOMException && e.name === "AbortError") {
      if (ctrl.signal.aborted && !opts.signal?.aborted) throw new FaucetTimeoutError();
      throw e;
    }
    throw new FaucetNetworkError(e instanceof Error ? e.message : String(e));
  } finally {
    clearTimeout(timer);
  }
}
