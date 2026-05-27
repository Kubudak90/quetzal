// Quetzal — atoms
// Primitive components. All inherit Aztec tokens via CSS vars.

const { useState, useEffect, useRef, useMemo } = React;

/* ============================================================
   FeatherGlyph — Quetzal's signature mark.
   A stylized quetzal tail feather drawn in 1.5px stroke,
   square caps. Reads as: long curved tail, central rachis,
   barbs angled outward, a small head dot.
   ============================================================ */
function FeatherGlyph({ size = 24, stroke = "currentColor", strokeWidth = 1.5, fill = "none" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none"
         xmlns="http://www.w3.org/2000/svg"
         style={{ display: "inline-block", flexShrink: 0 }}>
      {/* head — small filled dot */}
      <circle cx="22.5" cy="5.5" r="1.8" fill={stroke} />
      {/* main rachis — long curved tail sweeping bottom-left */}
      <path d="M21 7 C 18 12, 14 17, 10 22 C 7 25.5, 4.5 27, 3 28"
            stroke={stroke} strokeWidth={strokeWidth} strokeLinecap="square" fill="none" />
      {/* barbs along the rachis (one side) */}
      <path d="M18.5 10 L 22.5 9"     stroke={stroke} strokeWidth={strokeWidth} strokeLinecap="square" />
      <path d="M16 13 L 21 12.5"      stroke={stroke} strokeWidth={strokeWidth} strokeLinecap="square" />
      <path d="M13.5 16 L 19 16"      stroke={stroke} strokeWidth={strokeWidth} strokeLinecap="square" />
      <path d="M11 19 L 16.5 19.5"    stroke={stroke} strokeWidth={strokeWidth} strokeLinecap="square" />
      <path d="M8.5 22 L 13.5 23"     stroke={stroke} strokeWidth={strokeWidth} strokeLinecap="square" />
      <path d="M6 25 L 10.5 26.5"     stroke={stroke} strokeWidth={strokeWidth} strokeLinecap="square" />
    </svg>
  );
}

/* ============================================================
   FeatherWatermark — large, low-opacity feather for empty
   states and landing hero. Filled with ink.
   ============================================================ */
function FeatherWatermark({ size = 280, opacity = 0.05, style }) {
  return (
    <div data-feather-watermark aria-hidden="true" style={{ pointerEvents: "none", color: "var(--fg)", opacity, ...style }}>
      <FeatherGlyph size={size} strokeWidth={0.8} />
    </div>
  );
}

/* ============================================================
   Eyebrow / Hairline / StepDivider
   ============================================================ */
function Eyebrow({ children, style }) {
  return <div className="q-eyebrow" style={style}>{children}</div>;
}
function Hairline({ style }) {
  return <div style={{ height: 1, background: "var(--hairline)", ...style }} />;
}
function StepDivider({ style }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, ...style }}>
      <div style={{ flex: 1, height: 1, background: "var(--hairline)" }} />
      <svg width="56" height="8" viewBox="0 0 56 8" style={{ flexShrink: 0 }}>
        {/* Step pattern: rising-falling ziggurat */}
        <path d="M0 6 L8 6 L8 4 L16 4 L16 2 L24 2 L24 0 L32 0 L32 2 L40 2 L40 4 L48 4 L48 6 L56 6"
              fill="none" stroke="currentColor" strokeWidth="1" opacity="0.4" />
      </svg>
      <div style={{ flex: 1, height: 1, background: "var(--hairline)" }} />
    </div>
  );
}

/* ============================================================
   Dot — visibility / state indicator (Aztec celari pattern)
   ============================================================ */
function Dot({ kind = "private", size = 10, shimmer = false }) {
  const base = { display: "inline-block", width: size, height: size, borderRadius: "50%", flex: "none", boxSizing: "border-box" };
  if (kind === "private") {
    return <span style={{ ...base, background: "var(--priv)" }} className={shimmer ? "pulse-dot" : ""} />;
  }
  if (kind === "public") {
    return <span style={{ ...base, border: "2px solid var(--pub)" }} />;
  }
  if (kind === "decoy") {
    return <span style={{ ...base, background: "var(--q-decoy)" }} />;
  }
  if (kind === "proving") {
    return <span style={{ ...base, background: `conic-gradient(var(--proving) 0 70%, transparent 70% 100%)` }} />;
  }
  if (kind === "filled") {
    return <span style={{ ...base, background: "var(--aztec-chartreuse)", border: "1px solid var(--aztec-ink)" }} />;
  }
  if (kind === "pending") {
    return <span style={{ ...base, border: "1px solid var(--fg-subtle)" }} />;
  }
  if (kind === "cancel") {
    return <span style={{ ...base, background: "var(--fg-subtle)", opacity: 0.5 }} />;
  }
  return null;
}

/* ============================================================
   Badge — small inline label
   ============================================================ */
function Badge({ children, tone = "default", style, shimmer = false }) {
  const cls = `q-badge ${tone !== "default" ? `q-badge-${tone}` : ""} ${shimmer ? (tone === "decoy" ? "shimmer-orchid" : "shimmer") : ""}`;
  return <span className={cls} style={style}>{children}</span>;
}

/* ============================================================
   PillButton — Aztec's button primitive
   ============================================================ */
function PillButton({ children, variant = "primary", onClick, size = "md", disabled, style, fullWidth, leftIcon, rightIcon, type = "button" }) {
  const sizes = {
    sm: { height: 30, padding: "0 12px", fs: 11 },
    md: { height: 40, padding: "0 18px", fs: 13 },
    lg: { height: 48, padding: "0 24px", fs: 14 },
  };
  const s = sizes[size];
  const variants = {
    primary: { background: "var(--aztec-chartreuse)", color: "var(--aztec-ink)", border: "1px solid var(--aztec-chartreuse)" },
    ink:     { background: "var(--aztec-ink)", color: "var(--aztec-parchment)", border: "1px solid var(--aztec-ink)" },
    ghost:   { background: "transparent", color: "var(--fg)", border: "1px solid var(--hairline-strong)" },
    quiet:   { background: "rgba(26,20,0,0.04)", color: "var(--fg)", border: "1px solid transparent" },
    danger:  { background: "var(--aztec-vermillion)", color: "var(--aztec-parchment)", border: "1px solid var(--aztec-vermillion)" },
    onDeep:  { background: "transparent", color: "var(--aztec-parchment)", border: "1px solid rgba(242,238,225,0.25)" },
  };
  return (
    <button type={type} onClick={onClick} disabled={disabled} style={{
      display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 8,
      height: s.height, padding: s.padding, width: fullWidth ? "100%" : undefined,
      borderRadius: 999,
      fontFamily: "var(--font-mono)", fontSize: s.fs, fontWeight: 500,
      cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.45 : 1,
      transition: "background var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out), transform var(--dur-fast) var(--ease-out)",
      ...variants[variant], ...style,
    }}>
      {leftIcon && <i data-lucide={leftIcon} style={{ width: 14, height: 14, strokeWidth: 1.5 }}></i>}
      {children}
      {rightIcon && <i data-lucide={rightIcon} style={{ width: 14, height: 14, strokeWidth: 1.5 }}></i>}
    </button>
  );
}

/* ============================================================
   Field — labeled input
   ============================================================ */
function Field({ label, value, onChange, hint, hintTone = "neutral", placeholder, mono, suffix, prefix, type = "text", inputStyle }) {
  const tones = {
    neutral: "var(--fg-muted)",
    private: "var(--priv)",
    public:  "var(--pub)",
    warn:    "var(--q-warn-soft)",
    decoy:   "var(--q-decoy)",
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {label && (
        <label className="q-eyebrow" style={{ fontSize: 10 }}>{label}</label>
      )}
      <div style={{
        display: "flex", alignItems: "center", gap: 10,
        background: "var(--surface)",
        border: "1px solid var(--hairline-strong)",
        borderRadius: 6, height: 48, padding: "0 14px",
        transition: "border-color var(--dur-fast) var(--ease-out)",
      }}>
        {prefix && <div style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--fg-muted)" }}>{prefix}</div>}
        <input
          type={type}
          value={value ?? ""}
          onChange={onChange}
          placeholder={placeholder}
          style={{
            flex: 1, minWidth: 0, border: "none", outline: "none", background: "transparent",
            fontFamily: mono ? "var(--font-mono)" : "var(--font-body)",
            fontSize: 15, color: "var(--fg)",
            ...inputStyle,
          }}
        />
        {suffix && <div style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--fg-muted)" }}>{suffix}</div>}
      </div>
      {hint && (
        <div style={{ fontFamily: "var(--font-body)", fontSize: 12, color: tones[hintTone] || tones.neutral, lineHeight: 1.4 }}>
          {hintTone !== "neutral" && <span style={{ marginRight: 4 }}>→</span>}{hint}
        </div>
      )}
    </div>
  );
}

/* ============================================================
   AddressMono — short truncated mono address w/ copy
   ============================================================ */
function AddressMono({ value, copy = true, style, length = 6 }) {
  const [copied, setCopied] = useState(false);
  const display = value.length > length * 2 + 2 ? `${value.slice(0, length)}…${value.slice(-4)}` : value;
  const handleCopy = (e) => {
    e.stopPropagation();
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--fg)", ...style }}>
      <span>{display}</span>
      {copy && (
        <button onClick={handleCopy} style={{ background: "transparent", border: "none", padding: 2, cursor: "pointer", color: "var(--fg-muted)", display: "inline-flex" }}>
          <i data-lucide={copied ? "check" : "copy"} style={{ width: 11, height: 11, strokeWidth: 1.5 }}></i>
        </button>
      )}
    </span>
  );
}

/* ============================================================
   Tooltip — wraps a child with a hovering ink popover
   ============================================================ */
function Tooltip({ children, body }) {
  return (
    <span className="q-tip">
      {children}
      <span data-tip-body>{body}</span>
    </span>
  );
}

/* ============================================================
   Segmented — radio control as a pill row
   ============================================================ */
function Segmented({ value, onChange, options, size = "md", fullWidth }) {
  const heights = { sm: 28, md: 36, lg: 44 };
  const h = heights[size];
  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: `repeat(${options.length}, 1fr)`,
      gap: 2, padding: 3,
      background: "rgba(26,20,0,0.05)",
      borderRadius: 999,
      width: fullWidth ? "100%" : "fit-content",
    }}>
      {options.map(opt => {
        const active = value === opt.id;
        return (
          <button key={opt.id} onClick={() => onChange(opt.id)} style={{
            display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6,
            height: h, padding: "0 14px", borderRadius: 999, border: "none", cursor: "pointer",
            fontFamily: "var(--font-mono)", fontSize: size === "sm" ? 11 : 12, fontWeight: 500,
            background: active ? (opt.activeBg || "var(--aztec-ink)") : "transparent",
            color:      active ? (opt.activeFg || "var(--aztec-parchment)") : "var(--fg-muted)",
            transition: "background 120ms var(--ease-out), color 120ms var(--ease-out)",
            whiteSpace: "nowrap",
          }}>
            {opt.dot && <Dot kind={opt.dot} size={8} />}
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

/* ============================================================
   QuetzalLogo — full lockup
   ============================================================ */
function QuetzalLogo({ size = 22, showWord = true, color = "var(--fg)" }) {
  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: 8, color }}>
      <FeatherGlyph size={size} stroke="currentColor" />
      {showWord && (
        <span style={{
          fontFamily: "var(--font-display)", fontSize: Math.round(size * 0.95),
          fontWeight: 300, letterSpacing: "-0.02em",
        }}>
          Quet<em style={{ fontFamily: "var(--font-serif)", fontStyle: "italic", fontWeight: 400 }}>zal</em>
        </span>
      )}
    </div>
  );
}

Object.assign(window, {
  FeatherGlyph, FeatherWatermark, Eyebrow, Hairline, StepDivider,
  Dot, Badge, PillButton, Field, AddressMono, Tooltip, Segmented, QuetzalLogo,
});
if (window.qStatus) qStatus("Loaded · atoms");
