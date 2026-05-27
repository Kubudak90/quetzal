// Quetzal — composite components
// All depend on atoms.jsx and assume Aztec tokens are loaded.

const { useState: useStateC, useEffect: useEffectC, useMemo: useMemoC } = React;

// pull atoms off window (babel script scopes are isolated)
const { Eyebrow, Hairline, StepDivider, Dot, Badge, PillButton, Field, AddressMono, Tooltip, Segmented, QuetzalLogo, FeatherGlyph, FeatherWatermark } = window;

/* ============================================================
   EpochCountdown — live mm:ss to next epoch close.
   Shows a thin progress bar across the epoch.
   ============================================================ */
function EpochCountdown({ epoch, secondsLeft, epochLength = 600, compact = false }) {
  const pct = Math.max(0, Math.min(1, (epochLength - secondsLeft) / epochLength));
  const mm = String(Math.floor(secondsLeft / 60)).padStart(2, "0");
  const ss = String(secondsLeft % 60).padStart(2, "0");
  if (compact) {
    return (
      <div style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
        <span className="pulse-dot" style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--aztec-chartreuse)", display: "inline-block" }} />
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-muted)" }}>EPOCH {epoch}</span>
        <span data-mono style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--fg)", fontWeight: 500 }}>{mm}:{ss}</span>
      </div>
    );
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12 }}>
        <div>
          <Eyebrow>Clearing in</Eyebrow>
          <div data-mono style={{ fontFamily: "var(--font-mono)", fontSize: 28, letterSpacing: "-0.02em", color: "var(--fg)", fontWeight: 500, marginTop: 2 }}>
            {mm}:{ss}
          </div>
        </div>
        <div style={{ textAlign: "right" }}>
          <Eyebrow>Epoch</Eyebrow>
          <div data-mono style={{ fontFamily: "var(--font-mono)", fontSize: 16, color: "var(--fg)", marginTop: 2 }}>{epoch}</div>
        </div>
      </div>
      <div style={{ height: 2, background: "var(--hairline)", borderRadius: 1, overflow: "hidden" }}>
        <div style={{ height: "100%", width: `${pct * 100}%`, background: "var(--aztec-chartreuse)", transition: "width 1s linear" }} />
      </div>
    </div>
  );
}

/* ============================================================
   DecoyVisualizer — anonymity-set rendering.
   Renders K+1 squares horizontally; the first is YOUR real
   order (filled ink), the others are decoys (orchid, shimmer).
   Slider below to adjust count.
   ============================================================ */
function DecoyVisualizer({ count = 2, max = 4, onChange, viz = "slots" }) {
  const slots = max + 1; // 1 real + max decoys = 5

  /* ---------- viz: SLOTS (default, grid of K+1 squares) ---------- */
  function SlotsViz() {
    return (
      <div style={{ display: "grid", gridTemplateColumns: `repeat(${slots}, 1fr)`, gap: 6 }}>
        {Array.from({ length: slots }).map((_, i) => {
          const isReal = i === 0;
          const isActive = i <= count;
          return (
            <div key={i} style={{
              position: "relative",
              height: 56, borderRadius: 6,
              border: `1px solid ${isReal ? "var(--aztec-ink)" : (isActive ? "var(--q-decoy)" : "var(--hairline)")}`,
              background: isReal ? "var(--aztec-ink)" : (isActive ? "rgba(255,45,244,0.06)" : "transparent"),
              transition: "all 200ms var(--ease-out)",
              overflow: "hidden",
              opacity: isActive ? 1 : 0.4,
            }}>
              {!isReal && isActive && (
                <div className="shimmer-orchid" style={{ position: "absolute", inset: 0, pointerEvents: "none" }} />
              )}
              <div style={{
                position: "absolute", inset: 0,
                display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
                gap: 2,
              }}>
                {isReal ? (
                  <>
                    <Dot kind="filled" size={8} />
                    <div style={{ fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--aztec-parchment)", letterSpacing: "0.06em", textTransform: "uppercase" }}>real</div>
                  </>
                ) : (
                  <>
                    <Dot kind={isActive ? "decoy" : "pending"} size={8} />
                    <div style={{ fontFamily: "var(--font-mono)", fontSize: 9, color: isActive ? "var(--q-decoy)" : "var(--fg-subtle)", letterSpacing: "0.06em", textTransform: "uppercase" }}>
                      decoy
                    </div>
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  /* ---------- viz: RING (constellation, dots on a circle) ---------- */
  function RingViz() {
    // distribute slots evenly around the ring, with "real" at top
    return (
      <div style={{
        position: "relative", height: 200,
        display: "flex", alignItems: "center", justifyContent: "center",
      }}>
        <svg viewBox="0 0 200 200" style={{ width: 200, height: 200 }}>
          <circle cx="100" cy="100" r="78" fill="none" stroke="var(--hairline-strong)" strokeWidth="1" strokeDasharray="3 4" opacity="0.6" />
          {Array.from({ length: slots }).map((_, i) => {
            const isReal = i === 0;
            const isActive = i <= count;
            const angle = -90 + (i * 360 / slots);
            const rad = (angle * Math.PI) / 180;
            const x = 100 + Math.cos(rad) * 78;
            const y = 100 + Math.sin(rad) * 78;
            return (
              <g key={i} style={{ opacity: isActive ? 1 : 0.25, transition: "opacity 200ms var(--ease-out)" }}>
                {isReal ? (
                  <>
                    <circle cx={x} cy={y} r="10" fill="var(--aztec-ink)" />
                    <text x={x} y={y + 22} textAnchor="middle" fontFamily="var(--font-mono)" fontSize="8" letterSpacing="1" fill="var(--fg)">YOU</text>
                  </>
                ) : (
                  <circle cx={x} cy={y} r="10" fill={isActive ? "var(--q-decoy)" : "transparent"} stroke="var(--q-decoy)" strokeWidth="1.2" />
                )}
              </g>
            );
          })}
          <text x="100" y="98" textAnchor="middle" fontFamily="var(--font-serif)" fontStyle="italic" fontSize="12" fill="var(--fg-muted)">epoch 41828</text>
          <text x="100" y="112" textAnchor="middle" fontFamily="var(--font-mono)" fontSize="8" letterSpacing="1" fill="var(--fg-muted)">{count + 1} ORDERS</text>
        </svg>
      </div>
    );
  }

  /* ---------- viz: FEATHERS (Quetzal-native motif stack) ---------- */
  function FeathersViz() {
    return (
      <div style={{
        height: 110, display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
        padding: "8px 4px",
      }}>
        {Array.from({ length: slots }).map((_, i) => {
          const isReal = i === 0;
          const isActive = i <= count;
          return (
            <div key={i} style={{
              display: "flex", flexDirection: "column", alignItems: "center", gap: 4,
              opacity: isActive ? 1 : 0.25,
              color: isReal ? "var(--aztec-ink)" : "var(--q-decoy)",
              transform: `translateY(${isReal ? -2 : 0}px) rotate(${isReal ? 0 : (i - count / 2) * 4}deg)`,
              transition: "all 200ms var(--ease-out)",
            }}>
              <FeatherGlyph size={48} strokeWidth={isReal ? 2.2 : 1.2} />
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 8, letterSpacing: "0.06em", textTransform: "uppercase",
                            color: isReal ? "var(--aztec-ink)" : (isActive ? "var(--q-decoy)" : "var(--fg-subtle)") }}>
                {isReal ? "you" : "·"}
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <Eyebrow>Anonymity set</Eyebrow>
        <div style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--fg)" }}>
          <span style={{ color: "var(--fg)" }}>1 real</span>
          <span style={{ color: "var(--fg-muted)" }}> + </span>
          <span style={{ color: "var(--q-decoy)" }}>{count} decoy{count === 1 ? "" : "s"}</span>
        </div>
      </div>

      {viz === "ring" ? <RingViz /> : viz === "feathers" ? <FeathersViz /> : <SlotsViz />}

      {/* Slider */}
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <Eyebrow style={{ width: 64 }}>Decoys</Eyebrow>
        <input
          type="range" min="0" max={max} step="1"
          value={count}
          onChange={(e) => onChange?.(parseInt(e.target.value, 10))}
          style={{ flex: 1, accentColor: "var(--q-decoy)" }}
        />
        <div data-mono style={{ fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--fg)", width: 18, textAlign: "right" }}>{count}</div>
      </div>

      <div style={{ fontFamily: "var(--font-body)", fontSize: 12, color: "var(--fg-muted)", lineHeight: 1.45 }}>
        Decoys submit unfillable orders alongside yours so observers can't tell which is real. {count === 0 && <span style={{ color: "var(--q-warn-soft)" }}>0 decoys → your order is visible on-chain by elimination.</span>}
      </div>
    </div>
  );
}

/* ============================================================
   RoundAmountAdvisory — inline advisory shown when amount
   looks round. Provides one-click "apply suggested" or
   "acknowledge and proceed".
   ============================================================ */
function RoundAmountAdvisory({ classification, suggested, onApply, acknowledged, onAck }) {
  if (classification === "natural") return null;
  return (
    <div style={{
      background: "rgba(194,112,31,0.06)",
      border: "1px solid rgba(194,112,31,0.35)",
      borderRadius: 6,
      padding: "10px 12px",
      display: "flex",
      flexDirection: "column",
      gap: 8,
    }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
        <i data-lucide="alert-triangle" style={{ width: 14, height: 14, color: "var(--q-warn-soft)", strokeWidth: 1.5, marginTop: 2, flexShrink: 0 }}></i>
        <div style={{ flex: 1 }}>
          <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--q-warn-soft)", fontWeight: 600 }}>
            Round amount · {classification}
          </div>
          <div style={{ fontFamily: "var(--font-body)", fontSize: 12, color: "var(--fg)", marginTop: 4, lineHeight: 1.45 }}>
            Round amounts are easier to fingerprint across observations. Try a slightly perturbed amount instead.
          </div>
        </div>
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <PillButton size="sm" variant="ink" onClick={onApply} leftIcon="check">
          Apply <span style={{ fontFamily: "var(--font-mono)", marginLeft: 4 }}>{suggested}</span>
        </PillButton>
        <label style={{ display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer", fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-muted)" }}>
          <input type="checkbox" checked={acknowledged} onChange={(e) => onAck?.(e.target.checked)}
                 style={{ accentColor: "var(--q-warn-soft)" }} />
          Acknowledge & proceed anyway
        </label>
      </div>
    </div>
  );
}

/* ============================================================
   OrderRow — a row in the open-orders table
   ============================================================ */
function OrderRow({ order, onClaim, onCancel }) {
  const statusMap = {
    open:      { dot: "private", label: "Open", tone: "private" },
    filled:    { dot: "filled",  label: "Filled · claimable", tone: "filled" },
    cancelled: { dot: "cancel",  label: "Cancelled", tone: "cancel" },
    decoy:     { dot: "decoy",   label: "Decoy", tone: "decoy" },
    pending:   { dot: "pending", label: "Pending", tone: "default" },
  };
  const st = statusMap[order.status] || statusMap.open;
  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: "16px 80px 60px 1fr 1fr 100px 120px",
      gap: 12, alignItems: "center",
      padding: "12px 16px",
      borderBottom: "1px solid var(--hairline)",
      transition: "background 120ms",
    }}>
      <Dot kind={st.dot} size={10} shimmer={order.status === "open"} />
      <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-muted)" }}>
        {order.nonce}
      </div>
      <div style={{
        fontFamily: "var(--font-mono)", fontSize: 11, fontWeight: 500,
        color: order.side === "buy" ? "var(--aztec-ink)" : "var(--aztec-ink)",
        letterSpacing: "0.06em", textTransform: "uppercase",
      }}>
        <span style={{
          padding: "3px 7px", borderRadius: 3,
          background: order.side === "buy" ? "rgba(13, 152, 118, 0.12)" : "rgba(255, 26, 26, 0.10)",
          color: order.side === "buy" ? "#0d9876" : "var(--aztec-vermillion)",
        }}>{order.side}</span>
      </div>
      <div data-mono style={{ fontFamily: "var(--font-mono)", fontSize: 13 }}>
        {order.amount} <span style={{ color: "var(--fg-muted)" }}>{order.amountToken}</span>
      </div>
      <div data-mono style={{ fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--fg-muted)" }}>
        @ {order.limit} <span style={{ color: "var(--fg-subtle)" }}>{order.limitToken}</span>
      </div>
      <div>
        <Badge tone={st.tone} shimmer={order.status === "open" || order.status === "decoy"}>{st.label}</Badge>
      </div>
      <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
        {order.status === "filled" && (
          <PillButton size="sm" variant="primary" onClick={() => onClaim?.(order)} leftIcon="download">Claim</PillButton>
        )}
        {order.status === "open" && (
          <PillButton size="sm" variant="ghost" onClick={() => onCancel?.(order)}>Cancel</PillButton>
        )}
        {order.status === "decoy" && (
          <PillButton size="sm" variant="quiet" onClick={() => onCancel?.(order)}>Cancel</PillButton>
        )}
      </div>
    </div>
  );
}

/* ============================================================
   FillRow — minimal row of recent epoch fills
   ============================================================ */
function FillRow({ fill }) {
  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: "12px 70px 80px 1fr 1fr 100px",
      gap: 12, alignItems: "center",
      padding: "10px 16px",
      borderBottom: "1px solid var(--hairline)",
    }}>
      <Dot kind="filled" size={8} />
      <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-muted)" }}>e{fill.epoch}</div>
      <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--fg)", letterSpacing: "0.06em", textTransform: "uppercase" }}>
        <span style={{
          padding: "2px 6px", borderRadius: 3,
          background: fill.side === "buy" ? "rgba(13, 152, 118, 0.12)" : "rgba(255, 26, 26, 0.10)",
          color: fill.side === "buy" ? "#0d9876" : "var(--aztec-vermillion)",
        }}>{fill.side}</span>
      </div>
      <div data-mono style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>{fill.amount} {fill.amountToken}</div>
      <div data-mono style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--fg-muted)" }}>@ {fill.price} {fill.priceToken}</div>
      <div style={{ textAlign: "right" }}>
        <a href="#" onClick={(e) => e.preventDefault()} style={{
          fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-muted)",
          textDecoration: "underline", textDecorationColor: "var(--hairline-strong)",
        }}>
          {fill.tx} <i data-lucide="external-link" style={{ width: 9, height: 9, strokeWidth: 1.5, marginLeft: 2 }}></i>
        </a>
      </div>
    </div>
  );
}

/* ============================================================
   PoolCapacityBar — the X/18 indicator for wallet pool children.
   ============================================================ */
function PoolCapacityBar({ current, max = 18 }) {
  const pct = Math.min(1, current / max);
  let tone = "var(--aztec-chartreuse)";
  if (current >= 16) tone = "var(--aztec-vermillion)";
  else if (current >= 10) tone = "var(--proving)";
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <span className="q-eyebrow">Pending tx</span>
        <span data-mono style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--fg)" }}>{current}<span style={{ color: "var(--fg-muted)" }}>/{max}</span></span>
      </div>
      <div style={{ height: 4, background: "var(--hairline)", borderRadius: 2, overflow: "hidden" }}>
        <div style={{ height: "100%", width: `${pct * 100}%`, background: tone, transition: "width 200ms var(--ease-out)" }} />
      </div>
    </div>
  );
}

/* ============================================================
   Toast — transient notification
   ============================================================ */
function Toast({ toast }) {
  if (!toast) return null;
  const toneStyles = {
    success: { iconColor: "var(--aztec-chartreuse)", icon: "check-circle" },
    error:   { iconColor: "var(--aztec-vermillion)", icon: "x-circle" },
    info:    { iconColor: "var(--pub)",              icon: "info" },
  };
  const t = toneStyles[toast.tone] || toneStyles.info;
  return (
    <div style={{
      position: "fixed", bottom: 24, left: "50%", transform: "translateX(-50%)",
      zIndex: 100,
      background: "var(--aztec-ink)", color: "var(--aztec-parchment)",
      padding: "12px 16px", borderRadius: 8,
      display: "flex", alignItems: "center", gap: 12,
      boxShadow: "var(--shadow-pop)",
      minWidth: 320, maxWidth: 480,
      fontFamily: "var(--font-body)",
    }}>
      <i data-lucide={t.icon} style={{ width: 16, height: 16, color: t.iconColor, strokeWidth: 1.5, flexShrink: 0 }}></i>
      <div style={{ flex: 1, fontSize: 13 }}>
        <div>{toast.title}</div>
        {toast.detail && <div style={{ fontSize: 11, color: "var(--fg-on-deep-mu)", marginTop: 2, fontFamily: "var(--font-mono)" }}>{toast.detail}</div>}
      </div>
      {toast.tx && (
        <a href="#" onClick={(e) => e.preventDefault()} style={{
          fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--aztec-chartreuse)",
          textDecoration: "underline", textDecorationColor: "rgba(212,255,40,0.4)",
          whiteSpace: "nowrap",
        }}>View ↗</a>
      )}
    </div>
  );
}

/* ============================================================
   PairSelector — token pair picker (compact)
   ============================================================ */
function PairSelector({ value, options, onChange }) {
  const [open, setOpen] = useStateC(false);
  const cur = options.find(o => o.id === value) || options[0];
  return (
    <div style={{ position: "relative" }}>
      <button onClick={() => setOpen(!open)} style={{
        display: "flex", alignItems: "center", gap: 10,
        background: "transparent", border: "1px solid var(--hairline-strong)",
        borderRadius: 6, height: 48, padding: "0 14px", cursor: "pointer", width: "100%",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flex: 1 }}>
          <TokenPair pair={cur.id} />
          <div style={{ fontFamily: "var(--font-mono)", fontSize: 14, color: "var(--fg)" }}>{cur.label}</div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2 }}>
          <div data-mono style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-muted)" }}>{cur.priceLabel}</div>
        </div>
        <i data-lucide={open ? "chevron-up" : "chevron-down"} style={{ width: 14, height: 14, color: "var(--fg-muted)", strokeWidth: 1.5 }}></i>
      </button>
      {open && (
        <div style={{
          position: "absolute", top: "calc(100% + 4px)", left: 0, right: 0,
          background: "var(--surface)", border: "1px solid var(--hairline-strong)",
          borderRadius: 6, boxShadow: "var(--shadow-pop)", zIndex: 20,
          overflow: "hidden",
        }}>
          {options.map(opt => (
            <button key={opt.id} onClick={() => { onChange(opt.id); setOpen(false); }} style={{
              display: "flex", alignItems: "center", gap: 10, width: "100%",
              background: "transparent", border: "none", padding: "10px 14px", cursor: "pointer",
              borderBottom: "1px solid var(--hairline)", textAlign: "left",
            }}>
              <TokenPair pair={opt.id} />
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--fg)", flex: 1 }}>{opt.label}</div>
              <div data-mono style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-muted)" }}>{opt.priceLabel}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ============================================================
   TokenPair — two overlapping token glyphs
   ============================================================ */
function TokenPair({ pair }) {
  const tokens = pair.split("/");
  return (
    <div style={{ display: "flex", alignItems: "center" }}>
      {tokens.map((t, i) => (
        <TokenGlyph key={i} token={t} style={{ marginLeft: i > 0 ? -6 : 0, zIndex: tokens.length - i }} />
      ))}
    </div>
  );
}

function TokenGlyph({ token, size = 22, style }) {
  const colors = {
    USDC: { bg: "#2775CA", fg: "#fff", char: "$" },
    ETH:  { bg: "#627EEA", fg: "#fff", char: "Ξ" },
    WETH: { bg: "#627EEA", fg: "#fff", char: "Ξ" },
    BTC:  { bg: "#F7931A", fg: "#fff", char: "₿" },
    wBTC: { bg: "#F7931A", fg: "#fff", char: "₿" },
  };
  const c = colors[token] || { bg: "var(--fg-subtle)", fg: "var(--bg)", char: token[0] };
  return (
    <div style={{
      width: size, height: size, borderRadius: "50%",
      background: c.bg, color: c.fg,
      display: "inline-flex", alignItems: "center", justifyContent: "center",
      fontFamily: "var(--font-mono)", fontSize: Math.round(size * 0.48), fontWeight: 600,
      border: "1.5px solid var(--bg)",
      boxSizing: "border-box",
      ...style,
    }}>
      {c.char}
    </div>
  );
}

Object.assign(window, {
  EpochCountdown, DecoyVisualizer, RoundAmountAdvisory,
  OrderRow, FillRow, PoolCapacityBar, Toast,
  PairSelector, TokenPair, TokenGlyph,
});
if (window.qStatus) qStatus("Loaded · components");
