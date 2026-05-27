// Quetzal — Trade screen
// Order placement + open orders + recent fills

const { useState: useStateT, useEffect: useEffectT, useMemo: useMemoT } = React;

const {
  Eyebrow, Hairline, Dot, Badge, PillButton, Field, Tooltip, Segmented, FeatherWatermark,
  EpochCountdown, DecoyVisualizer, RoundAmountAdvisory, OrderRow, FillRow, PairSelector,
} = window;

const TRADE_PAIRS = [
  { id: "USDC/ETH",  label: "USDC / ETH",  priceLabel: "1 ETH = 3,217.84 USDC" },
  { id: "USDC/BTC",  label: "USDC / BTC",  priceLabel: "1 BTC = 67,402.10 USDC" },
  { id: "ETH/BTC",   label: "ETH / BTC",   priceLabel: "1 BTC = 20.94 ETH" },
];

const SEED_ORDERS = [
  { nonce: "0x9c4f…a012", side: "sell", amount: "1.0734", amountToken: "ETH",  limit: "3,220.50", limitToken: "USDC", epoch: 41827, status: "filled" },
  { nonce: "0x9c4f…a013", side: "buy",  amount: "5,073.20", amountToken: "USDC", limit: "3,180.00", limitToken: "USDC", epoch: 41828, status: "open"   },
  { nonce: "0x9c4f…a014", side: "buy",  amount: "0.0427",  amountToken: "ETH",  limit: "3,205.75", limitToken: "USDC", epoch: 41828, status: "open"   },
  { nonce: "0x9c4f…a015", side: "sell", amount: "2.1500",  amountToken: "ETH",  limit: "3,250.00", limitToken: "USDC", epoch: 41828, status: "decoy"  },
  { nonce: "0x9c4f…a016", side: "sell", amount: "0.8917",  amountToken: "ETH",  limit: "3,235.40", limitToken: "USDC", epoch: 41828, status: "decoy"  },
  { nonce: "0x9c4f…a008", side: "buy",  amount: "847.12",  amountToken: "USDC", limit: "3,150.00", limitToken: "USDC", epoch: 41825, status: "cancelled" },
];

const SEED_FILLS = [
  { epoch: 41827, side: "sell", amount: "1.0734",  amountToken: "ETH",  price: "3,220.50", priceToken: "USDC", tx: "0x4a2b…f81e" },
  { epoch: 41826, side: "buy",  amount: "2,840.00",amountToken: "USDC", price: "3,217.22", priceToken: "USDC", tx: "0x8f1c…0a4d" },
  { epoch: 41825, side: "sell", amount: "0.4127",  amountToken: "ETH",  price: "3,210.00", priceToken: "USDC", tx: "0xb7e2…3c1f" },
  { epoch: 41824, side: "buy",  amount: "1,500.00",amountToken: "USDC", price: "3,205.80", priceToken: "USDC", tx: "0x2d44…91ab" },
  { epoch: 41823, side: "sell", amount: "0.8923",  amountToken: "ETH",  price: "3,212.45", priceToken: "USDC", tx: "0x6e1f…7b2c" },
];

function classifyAmount(raw) {
  if (!raw) return { classification: "natural" };
  const n = parseFloat(raw.replace(/,/g, ""));
  if (isNaN(n) || n === 0) return { classification: "natural" };
  const s = String(n);
  // very simple: integer-only or trailing zeros after dot
  if (/^\d+$/.test(s) && n >= 1) return { classification: "round_unit", suggested: (n + 0.073).toFixed(3) };
  if (/^\d+\.0+$/.test(s)) return { classification: "round_unit", suggested: (n + 0.073).toFixed(3) };
  if (/^\d+\.00$/.test(s) || /^\d+\.000$/.test(s)) return { classification: "round_cent", suggested: (n + 0.073).toFixed(3) };
  return { classification: "natural" };
}

function TradeScreen({ pushToast, tweaks }) {
  const [pair, setPair] = useStateT("USDC/ETH");
  const [side, setSide] = useStateT("sell");
  const [amount, setAmount] = useStateT("");
  const [amountToken, setAmountToken] = useStateT("ETH");
  const [limit, setLimit] = useStateT("3,218.50");
  const [decoys, setDecoys] = useStateT(tweaks.defaultDecoys ?? 2);
  const [ack, setAck] = useStateT(false);
  const [submitting, setSubmitting] = useStateT(false);
  const [orders, setOrders] = useStateT(SEED_ORDERS);

  useEffectT(() => { setDecoys(tweaks.defaultDecoys ?? 2); }, [tweaks.defaultDecoys]);

  const advisory = useMemoT(() => classifyAmount(amount), [amount]);
  const canSubmit = !!amount && parseFloat(amount.replace(/,/g, "")) > 0 &&
    (advisory.classification === "natural" || ack);

  function handleSubmit() {
    setSubmitting(true);
    setTimeout(() => {
      const baseNonce = "0x9c4f…b" + String(Math.floor(Math.random() * 999)).padStart(3, "0");
      const newOrders = [{
        nonce: baseNonce, side, amount, amountToken,
        limit, limitToken: "USDC",
        epoch: 41828, status: "open",
      }];
      for (let i = 0; i < decoys; i++) {
        newOrders.push({
          nonce: "0x9c4f…b" + String(Math.floor(Math.random() * 999)).padStart(3, "0"),
          side, amount: (parseFloat(amount.replace(/,/g, "")) * (0.92 + Math.random() * 0.16)).toFixed(4),
          amountToken, limit, limitToken: "USDC", epoch: 41828, status: "decoy",
        });
      }
      setOrders([...newOrders, ...orders]);
      setAmount("");
      setSubmitting(false);
      pushToast({
        tone: "success",
        title: `Order submitted with ${decoys} decoys`,
        detail: `1 real + ${decoys} decoys saved to ~/.quetzal/decoy-registry-41828.json`,
        tx: "0x9c4f…",
      });
    }, 900);
  }

  function applySuggested() {
    if (advisory.suggested) setAmount(advisory.suggested);
  }
  function handleClaim(o) {
    setOrders(orders.map(x => x.nonce === o.nonce ? { ...x, status: "cancelled" } : x));
    pushToast({ tone: "success", title: "Fill claimed", detail: `${o.amount} ${o.amountToken}`, tx: "0xc1a2…" });
  }
  function handleCancel(o) {
    setOrders(orders.map(x => x.nonce === o.nonce ? { ...x, status: "cancelled" } : x));
    pushToast({ tone: "info", title: "Order cancelled", detail: o.nonce });
  }

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
                onChange={setSide}
                fullWidth
                size="lg"
                options={[
                  { id: "buy",  label: "Buy",  activeBg: "#0d9876", activeFg: "#FFFFFF" },
                  { id: "sell", label: "Sell", activeBg: "var(--aztec-vermillion)", activeFg: "var(--aztec-parchment)" },
                ]}
              />
              <div style={{ fontFamily: "var(--font-body)", fontSize: 11, color: "var(--fg-muted)", marginTop: 6, lineHeight: 1.4 }}>
                <Tooltip body="Buy = pay the canonical-low token (USDC) and receive the canonical-high token (ETH). The SDK auto-flips the path internally — you only think in plain buy/sell.">
                  <i data-lucide="info" style={{ width: 11, height: 11, color: "var(--fg-muted)", strokeWidth: 1.5, marginRight: 4 }}></i>
                </Tooltip>
                Path is auto-canonicalized.
              </div>
            </div>

            {/* Amount + token */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 100px", gap: 8 }}>
              <Field label="Amount" mono value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" />
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <Eyebrow>Token</Eyebrow>
                <select value={amountToken} onChange={(e) => setAmountToken(e.target.value)} style={{
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
                <i data-lucide="shield" style={{ width: 14, height: 14, color: "var(--priv)", strokeWidth: 1.5 }}></i>
                <Eyebrow>Privacy</Eyebrow>
              </div>
              <DecoyVisualizer count={decoys} max={4} onChange={setDecoys} viz={tweaks.decoyViz || "slots"} />
            </div>

            {/* Submit */}
            <PillButton
              variant="primary"
              size="lg"
              fullWidth
              disabled={!canSubmit || submitting}
              onClick={handleSubmit}
              rightIcon={submitting ? undefined : "arrow-right"}
            >
              {submitting ? "Sealing & submitting…" : `Submit ${side === "buy" ? "buy" : "sell"} · 1 real + ${decoys} decoy${decoys === 1 ? "" : "s"}`}
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
          <EpochCountdown epoch={41828} secondsLeft={tweaks.secondsLeft ?? 247} epochLength={600} />
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
          {orders.length === 0 ? (
            <div style={{ padding: 60, textAlign: "center", position: "relative", overflow: "hidden" }}>
              <FeatherWatermark size={180} opacity={0.08} style={{ position: "absolute", top: -20, right: -20 }} />
              <div style={{ fontFamily: "var(--font-serif)", fontSize: 16, color: "var(--fg-muted)" }}>No open orders.</div>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-subtle)", marginTop: 6 }}>Submit your first order to see it here.</div>
            </div>
          ) : (
            orders.slice(0, 8).map(o => (
              <OrderRow key={o.nonce} order={o} onClaim={handleClaim} onCancel={handleCancel} />
            ))
          )}
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
          {SEED_FILLS.map((f, i) => <FillRow key={i} fill={f} />)}
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { TradeScreen });
if (window.qStatus) qStatus("Loaded · trade");
