// Quetzal — Trade screen
// Order placement + open orders + recent fills.
// Ported from _design-source/trade.jsx. Tweaks panel dropped;
// decoy count starts at constant 2 (was tweaks.defaultDecoys).

import { useState, useMemo } from "react";
import type { ChangeEvent, CSSProperties } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useQuetzalClient, useClientContext } from "../sdk/client-context.js";
import {
  Eyebrow, Hairline, Dot, Badge, PillButton, Field, Tooltip, Segmented, FeatherWatermark,
  EpochCountdown,
} from "../components/atoms.js";
import {
  DecoyVisualizer, RoundAmountAdvisory, OrderRow, FillRow, PairSelector,
} from "../components/screens-shared.js";

interface ToastIn { kind: string; text: string }
type PushToast = (t: ToastIn) => void;

interface TradeScreenProps {
  pushToast: PushToast;
  secondsLeft: number;
}

const DEFAULT_DECOYS = 2;

const TRADE_PAIRS = [
  { id: "USDC/ETH",  label: "USDC / ETH",  priceLabel: "1 ETH = 3,217.84 USDC" },
  { id: "USDC/BTC",  label: "USDC / BTC",  priceLabel: "1 BTC = 67,402.10 USDC" },
  { id: "ETH/BTC",   label: "ETH / BTC",   priceLabel: "1 BTC = 20.94 ETH" },
];

type TradeOrderStatus = "open" | "filled" | "cancelled" | "decoy" | "pending";
interface TradeOrder {
  nonce: string;
  side: "buy" | "sell";
  amount: string;
  amountToken: string;
  limit: string;
  limitToken: string;
  epoch: number;
  status: TradeOrderStatus;
}

// SEED_ORDERS removed — replaced by useQuery(["orders", sessionId]) via client.reads.getOrders()

interface TradeFill {
  epoch: number;
  side: "buy" | "sell";
  amount: string;
  amountToken: string;
  price: string;
  priceToken: string;
  tx: string;
}

// SEED_FILLS removed — recentFills is now derived client-side from orders with status==="filled"
// (SDK has no separate history.getRecentFills; deferred to a future Sub-7 history API)

// ─── SDK input helpers ────────────────────────────────────────────────────────

/** Parse a display amount string (e.g. "1,234.56") to bigint with 6 decimals. */
function parseAmount(s: string, decimals: number = 6): bigint {
  const clean = s.replace(/,/g, "").trim();
  if (!clean || clean === "." ) return 0n;
  const [whole = "0", frac = ""] = clean.split(".");
  const fracPadded = frac.padEnd(decimals, "0").slice(0, decimals);
  try {
    return BigInt(whole + fracPadded);
  } catch {
    return 0n;
  }
}

/** "USDC/ETH" → ["tUSDC", "tETH"], "ETH/BTC" → ["tETH", "tBTC"] */
function pairToPath(pair: string): string[] {
  return pair.split("/").map(tok => "t" + tok);
}

/** Format a raw bigint amount (6-decimal fixed-point) to display string. */
function formatAmount(raw: bigint, decimals: number = 6): string {
  const s = raw.toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals) || "0";
  const frac = s.slice(s.length - decimals).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

// ─── Amount advisory ─────────────────────────────────────────────────────────

interface AmountAdvisory {
  classification: "natural" | "round_unit" | "round_cent";
  suggested?: string;
}
function classifyAmount(raw: string): AmountAdvisory {
  if (!raw) return { classification: "natural" };
  const n = parseFloat(raw.replace(/,/g, ""));
  if (isNaN(n) || n === 0) return { classification: "natural" };
  const s = String(n);
  if (/^\d+$/.test(s) && n >= 1) return { classification: "round_unit", suggested: (n + 0.073).toFixed(3) };
  if (/^\d+\.0+$/.test(s)) return { classification: "round_unit", suggested: (n + 0.073).toFixed(3) };
  if (/^\d+\.00$/.test(s) || /^\d+\.000$/.test(s)) return { classification: "round_cent", suggested: (n + 0.073).toFixed(3) };
  return { classification: "natural" };
}

export function TradeScreen({ pushToast, secondsLeft }: TradeScreenProps) {
  // ── SDK client + React Query ───────────────────────────────────────────────
  const client = useQuetzalClient();
  const { session } = useClientContext();
  const qc = useQueryClient();

  // Guard: App-level redirect handles the no-session case; this is belt-and-suspenders.
  if (!client) return null;

  // ── Form state ─────────────────────────────────────────────────────────────
  const [pair, setPair] = useState("USDC/ETH");
  const [side, setSide] = useState<"buy" | "sell">("sell");
  const [amount, setAmount] = useState("");
  const [amountToken, setAmountToken] = useState("ETH");
  const [limit, setLimit] = useState("3,218.50");
  const [decoys, setDecoys] = useState(DEFAULT_DECOYS);
  const [ack, setAck] = useState(false);

  const advisory = useMemo(() => classifyAmount(amount), [amount]);
  const canSubmit = !!amount && parseFloat(amount.replace(/,/g, "")) > 0 &&
    (advisory.classification === "natural" || ack);

  // ── Orders query ───────────────────────────────────────────────────────────
  // getOrders() returns resting orders (all "open" from the contract's perspective).
  // The SDK's OrderViewModel has: nonce: bigint, side: boolean, amount_in: bigint,
  // limit_price: bigint, submitted_at_block: bigint — no status field.
  const ordersQ = useQuery({
    queryKey: ["orders", session?.sessionId],
    queryFn: () => client.reads.getOrders(),
    enabled: !!client,
  });

  // Map SDK OrderViewModel → TradeOrder for display
  const orders: TradeOrder[] = (ordersQ.data ?? []).map(o => ({
    nonce: "0x" + o.nonce.toString(16),
    side: o.side ? "sell" : "buy",
    amount: formatAmount(o.amount_in),
    amountToken: pair.split("/")[o.side ? 1 : 0] ?? "—",
    limit: formatAmount(o.limit_price),
    limitToken: "USDC",
    epoch: Number(o.submitted_at_block),
    status: "open" as const,
  }));

  // Recent fills: client-side filter on orders with status === "filled".
  // All resting orders from the contract are "open"; filled orders are
  // removed from the note tree after claiming. Until a dedicated Sub-7
  // history API ships, recentFills will be empty (orders are claim-and-gone).
  const recentFills: TradeFill[] = orders
    .filter(o => o.status === "filled")
    .slice(0, 20)
    .map(o => ({
      epoch: o.epoch,
      side: o.side,
      amount: o.amount,
      amountToken: o.amountToken,
      price: o.limit,
      priceToken: o.limitToken,
      tx: o.nonce,
    }));

  // ── Place order mutation ───────────────────────────────────────────────────
  const placeOrderMut = useMutation({
    mutationFn: async (input: {
      side: "buy" | "sell";
      amount: bigint;
      limitPrice: bigint;
      path: string[];
      decoys: number;
    }) => {
      if (input.decoys === 0) {
        return await client.orders.placeOrder({
          side: input.side,
          amount: input.amount,
          limitPrice: input.limitPrice,
          path: input.path,
        });
      }
      return await client.orders.placeOrderBulk({
        side: input.side,
        amount: input.amount,
        limitPrice: input.limitPrice,
        path: input.path,
        decoyCount: input.decoys,
      });
    },
    onSuccess: (result, vars) => {
      void qc.invalidateQueries({ queryKey: ["orders", session?.sessionId] });
      setAmount("");
      pushToast({ kind: "ok", text: "Order placed." });

      // ── Sub-8.5: broadcast reveal to aggregator ──────────────────────────
      const aggregatorUrl = import.meta.env.VITE_AGGREGATOR_URL as string | undefined;
      if (aggregatorUrl && result) {
        const orderNonce =
          "orderNonce" in result
            ? `0x${result.orderNonce.toString(16)}`
            : `0x${result.realNonce.toString(16)}`;
        const realSide = vars.side === "sell";
        const revealPayload: Record<string, unknown> = {
          epoch_id: result.epoch,
          order_nonce: orderNonce,
          side: realSide,
          amount_in: vars.amount.toString(),
          limit_price: vars.limitPrice.toString(),
          submitted_at_block: result.blockNumber,
          owner: client.address.toString(),
          submission_tx_hash: result.txHash || undefined,
        };
        void client.aggregator.directReveal(aggregatorUrl, revealPayload).then((ok) => {
          if (ok) {
            pushToast({ kind: "ok", text: "Order revealed to aggregator." });
          } else {
            pushToast({ kind: "warn", text: "Aggregator unreachable — order won't clear until you retry." });
          }
        });
      }
    },
    onError: (e) => {
      pushToast({ kind: "warn", text: e instanceof Error ? e.message : "Order failed" });
    },
  });

  // ── Claim fill mutation ────────────────────────────────────────────────────
  const claimFillMut = useMutation({
    mutationFn: async (input: { nonce: bigint; epoch: number }) => {
      return await client.orders.claimFill({
        nonce: input.nonce,
        epoch: input.epoch,
        filterDecoys: true,
      });
    },
    onSuccess: (_, vars) => {
      void qc.invalidateQueries({ queryKey: ["orders", session?.sessionId] });
      pushToast({ kind: "ok", text: `Fill claimed (nonce 0x${vars.nonce.toString(16).slice(0, 8)}…)` });
    },
    onError: (e) => pushToast({ kind: "warn", text: e instanceof Error ? e.message : "Claim failed" }),
  });

  // ── Cancel mutation ────────────────────────────────────────────────────────
  const cancelMut = useMutation({
    mutationFn: async (input: { nonce: bigint }) => {
      return await client.orders.cancelOrder({ nonce: input.nonce });
    },
    onSuccess: (_, vars) => {
      void qc.invalidateQueries({ queryKey: ["orders", session?.sessionId] });
      pushToast({ kind: "ok", text: `Order cancelled (nonce 0x${vars.nonce.toString(16).slice(0, 8)}…)` });
    },
    onError: (e) => pushToast({ kind: "warn", text: e instanceof Error ? e.message : "Cancel failed" }),
  });

  // ── Form submit ────────────────────────────────────────────────────────────
  function handleSubmit() {
    const amountBigInt = parseAmount(amount);
    const limitBigInt = parseAmount(limit);
    const path = pairToPath(pair);
    placeOrderMut.mutate({
      side,
      amount: amountBigInt,
      limitPrice: limitBigInt,
      path,
      decoys,
    });
  }

  // ── Row action handlers ────────────────────────────────────────────────────
  function handleClaim(o: { nonce?: string | number; amount: string | number; amountToken: string }) {
    const nonceStr = String(o.nonce ?? "0x0");
    // epoch is stored in the .epoch field of TradeOrder (mapped from submitted_at_block)
    const orderData = orders.find(x => x.nonce === nonceStr);
    claimFillMut.mutate({ nonce: BigInt(nonceStr), epoch: orderData?.epoch ?? 0 });
  }
  function handleCancel(o: { nonce?: string | number }) {
    cancelMut.mutate({ nonce: BigInt(String(o.nonce ?? "0x0")) });
  }

  function applySuggested() {
    if (advisory.suggested) setAmount(advisory.suggested);
  }

  // ── Display counts ─────────────────────────────────────────────────────────
  const openCount = orders.filter(o => o.status === "open").length;
  const decoyCount = orders.filter(o => o.status === "decoy").length;
  const filledCount = orders.filter(o => o.status === "filled").length;

  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 460px) minmax(0, 1fr)", gap: 24, padding: 24, height: "100%", overflow: "auto" }} className="q-scroll">

      {/* ===== LEFT: ORDER FORM ===== */}
      <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>

        <div className="q-card">
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 16 }}>
            <h3 style={{ fontFamily: "var(--font-display)", fontSize: 28, fontWeight: 300, letterSpacing: "-0.03em", color: "var(--fg)" }}>
              Place <em style={{ fontFamily: "var(--font-serif)", fontStyle: "italic", fontWeight: 400 }}>private</em> order
            </h3>
            <Badge tone="private" shimmer>
              <Dot kind="private" size={6} /> sealed
            </Badge>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>

            {/* Pair */}
            <div>
              <Eyebrow style={{ marginBottom: 6 }}>Pair</Eyebrow>
              <PairSelector value={pair} options={TRADE_PAIRS} onChange={setPair} />
            </div>

            {/* Side toggle */}
            <div>
              <Eyebrow style={{ marginBottom: 6 }}>Side</Eyebrow>
              <Segmented
                value={side}
                onChange={(v) => setSide(v as "buy" | "sell")}
                fullWidth
                size="lg"
                options={[
                  { id: "buy",  label: "Buy",  activeBg: "#0d9876", activeFg: "#FFFFFF" },
                  { id: "sell", label: "Sell", activeBg: "var(--aztec-vermillion)", activeFg: "var(--aztec-parchment)" },
                ]}
              />
              <div style={{ fontFamily: "var(--font-body)", fontSize: 11, color: "var(--fg-muted)", marginTop: 6, lineHeight: 1.4 }}>
                <Tooltip body="Buy = pay the canonical-low token (USDC) and receive the canonical-high token (ETH). The SDK auto-flips the path internally — you only think in plain buy/sell.">
                  <i data-lucide="info" style={{ width: 11, height: 11, color: "var(--fg-muted)", strokeWidth: 1.5, marginRight: 4 } as CSSProperties}></i>
                </Tooltip>
                Path is auto-canonicalized.
              </div>
            </div>

            {/* Amount + token */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 100px", gap: 8 }}>
              <Field label="Amount" mono value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" />
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <Eyebrow>Token</Eyebrow>
                <select value={amountToken} onChange={(e: ChangeEvent<HTMLSelectElement>) => setAmountToken(e.target.value)} style={{
                  height: 48, padding: "0 12px", borderRadius: 6,
                  border: "1px solid var(--hairline-strong)", background: "var(--surface)",
                  fontFamily: "var(--font-mono)", fontSize: 14, color: "var(--fg)",
                  appearance: "none", cursor: "pointer",
                }}>
                  <option>ETH</option>
                  <option>USDC</option>
                </select>
              </div>
            </div>

            {/* Round-amount advisory */}
            <RoundAmountAdvisory
              classification={advisory.classification}
              suggested={advisory.suggested}
              acknowledged={ack}
              onAck={setAck}
              onApply={applySuggested}
            />

            {/* Limit price */}
            <Field
              label="Limit price"
              mono
              value={limit}
              onChange={(e) => setLimit(e.target.value)}
              suffix="USDC"
              hint="Pool √p ≈ 3,217.84 USDC · ±5%"
            />

            {/* Privacy panel */}
            <div style={{
              background: "var(--bg-alt)",
              border: "1px dashed var(--hairline-strong)",
              borderRadius: 8,
              padding: 16,
              display: "flex", flexDirection: "column", gap: 12,
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <i data-lucide="shield" style={{ width: 14, height: 14, color: "var(--priv)", strokeWidth: 1.5 } as CSSProperties}></i>
                <Eyebrow>Privacy</Eyebrow>
              </div>
              <DecoyVisualizer count={decoys} max={4} onChange={setDecoys} />
            </div>

            {/* Submit */}
            <PillButton
              variant="primary"
              size="lg"
              fullWidth
              disabled={!canSubmit || placeOrderMut.isPending}
              onClick={handleSubmit}
              rightIcon={placeOrderMut.isPending ? undefined : "arrow-right"}
            >
              {placeOrderMut.isPending ? "Sealing & submitting…" : `Submit ${side === "buy" ? "buy" : "sell"} · 1 real + ${decoys} decoy${decoys === 1 ? "" : "s"}`}
            </PillButton>

            <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--fg-muted)" }}>
                Fee-juice: <span style={{ color: "var(--fg)" }}>0.0024 ETH</span>
              </div>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--fg-muted)" }}>
                Wallet: <span style={{ color: "var(--fg)" }}>child-0</span> · 8/18 capacity
              </div>
            </div>
          </div>
        </div>

      </div>

      {/* ===== RIGHT: ORDERS + FILLS ===== */}
      <div style={{ display: "flex", flexDirection: "column", gap: 20, minWidth: 0 }}>

        {/* Epoch + summary strip */}
        <div className="q-card-deep q-card" style={{ padding: 20, display: "grid", gridTemplateColumns: "minmax(0, 320px) 1px 1fr 1fr 1fr", gap: 24, alignItems: "center" }}>
          <EpochCountdown epoch={41828} secondsLeft={secondsLeft} epochLength={600} />
          <div style={{ width: 1, height: 56, background: "rgba(242,238,225,0.12)" }} />
          <div>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--fg-on-deep-mu)" }}>Open</div>
            <div data-mono style={{ fontFamily: "var(--font-mono)", fontSize: 22, color: "var(--fg-on-deep)", marginTop: 4, fontWeight: 500 }}>{openCount}</div>
          </div>
          <div>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--fg-on-deep-mu)" }}>Decoys</div>
            <div data-mono style={{ fontFamily: "var(--font-mono)", fontSize: 22, color: "var(--q-decoy)", marginTop: 4, fontWeight: 500 }}>{decoyCount}</div>
          </div>
          <div>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--fg-on-deep-mu)" }}>Claimable</div>
            <div data-mono style={{ fontFamily: "var(--font-mono)", fontSize: 22, color: "var(--aztec-chartreuse)", marginTop: 4, fontWeight: 500 }}>{filledCount}</div>
          </div>
        </div>

        {/* Open orders */}
        <div className="q-card" style={{ padding: 0, overflow: "hidden" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "18px 20px" }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
              <h4 style={{ fontFamily: "var(--font-serif)", fontWeight: 400, fontSize: 18, color: "var(--fg)" }}>Open orders</h4>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-muted)" }}>
                auto-refresh every 10s
              </span>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <PillButton size="sm" variant="ghost" leftIcon="x-circle">Cancel decoys ({decoyCount})</PillButton>
              <PillButton size="sm" variant="quiet" leftIcon="refresh-cw">Refresh</PillButton>
            </div>
          </div>
          <Hairline />
          {/* Column header */}
          <div style={{
            display: "grid",
            gridTemplateColumns: "16px 80px 60px 1fr 1fr 100px 120px",
            gap: 12, alignItems: "center",
            padding: "8px 16px",
            background: "var(--bg-alt)",
          }}>
            <span></span>
            <span className="q-eyebrow">Nonce</span>
            <span className="q-eyebrow">Side</span>
            <span className="q-eyebrow">Amount</span>
            <span className="q-eyebrow">Limit</span>
            <span className="q-eyebrow">Status</span>
            <span className="q-eyebrow" style={{ textAlign: "right" }}>Actions</span>
          </div>
          {ordersQ.isLoading && (
            <div style={{ padding: 16, fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--fg-muted)", textAlign: "center" }}>
              Loading orders…
            </div>
          )}
          {ordersQ.error && (
            <div style={{ padding: 16, fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--aztec-vermillion)", textAlign: "center" }}>
              Failed to load orders: {ordersQ.error instanceof Error ? ordersQ.error.message : "unknown error"}
            </div>
          )}
          {!ordersQ.isLoading && !ordersQ.error && orders.length === 0 && (
            <div style={{ padding: 60, textAlign: "center", position: "relative", overflow: "hidden" }}>
              <FeatherWatermark size={180} opacity={0.08} style={{ position: "absolute", top: -20, right: -20 }} />
              <div style={{ fontFamily: "var(--font-serif)", fontSize: 16, color: "var(--fg-muted)" }}>No open orders.</div>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-subtle)", marginTop: 6 }}>Submit your first order to see it here.</div>
            </div>
          )}
          {orders.length > 0 && orders.slice(0, 8).map(o => (
            <OrderRow key={o.nonce} order={o} onClaim={handleClaim} onCancel={handleCancel} />
          ))}
        </div>

        {/* Recent fills */}
        <div className="q-card" style={{ padding: 0, overflow: "hidden" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "18px 20px" }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
              <h4 style={{ fontFamily: "var(--font-serif)", fontWeight: 400, fontSize: 18, color: "var(--fg)" }}>Recent fills</h4>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-muted)" }}>last 5 epochs</span>
            </div>
            <a href="#" onClick={(e) => e.preventDefault()} style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-muted)", textDecoration: "underline" }}>View full history →</a>
          </div>
          <Hairline />
          {/* recentFills: client-side filter of orders with status==="filled" (last 20).
              SDK has no separate history.getRecentFills; deferred to Sub-7 history API.
              Resting orders returned by getOrders() are all "open"; filled orders are
              removed from the note tree after claim, so this will show entries only if
              the local optimistic state is ever updated with "filled" status. */}
          {recentFills.length === 0 ? (
            <div style={{ padding: 32, textAlign: "center" }}>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--fg-muted)" }}>No recent fills.</div>
            </div>
          ) : (
            recentFills.map((f, i) => <FillRow key={i} fill={f} />)
          )}
        </div>
      </div>
    </div>
  );
}
