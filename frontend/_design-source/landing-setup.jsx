// Quetzal — Landing + First-launch setup

const { useState: useStateS, useEffect: useEffectS } = React;

const {
  Eyebrow, Hairline, StepDivider, Dot, Badge, PillButton, Field, AddressMono, Tooltip, Segmented,
  FeatherGlyph, FeatherWatermark, QuetzalLogo,
} = window;

function LandingScreen({ onStart }) {
  return (
    <div style={{
      height: "100%", overflow: "auto",
      display: "flex", alignItems: "center", justifyContent: "center",
      position: "relative",
    }} className="q-scroll">
      {/* Watermark background — large feather */}
      <div style={{
        position: "absolute", right: -120, top: "50%", transform: "translateY(-50%)",
        pointerEvents: "none",
      }}>
        <FeatherWatermark size={680} opacity={0.05} />
      </div>

      <div style={{ maxWidth: 1080, padding: "0 48px", position: "relative", zIndex: 1, display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 64, alignItems: "center" }}>

        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 24 }}>
            <FeatherGlyph size={28} />
            <div style={{
              fontFamily: "var(--font-mono)", fontSize: 11, letterSpacing: "0.1em",
              textTransform: "uppercase", color: "var(--fg-muted)",
            }}>Quetzal · v0.4 · alpha-testnet</div>
          </div>

          <h1 style={{
            fontFamily: "var(--font-display)", fontSize: 96, fontWeight: 300,
            letterSpacing: "-0.05em", lineHeight: 0.95, color: "var(--fg)",
            margin: 0,
          }}>
            Trade <em style={{ fontFamily: "var(--font-serif)", fontStyle: "italic", fontWeight: 400 }}>privately.</em>
            <br/>Clear together.
          </h1>

          <p style={{
            fontFamily: "var(--font-body)", fontSize: 18, color: "var(--fg-muted)",
            marginTop: 24, maxWidth: 540, lineHeight: 1.5,
          }}>
            A dark-pool DEX on Aztec. Order side, amount and limit price are sealed on-chain;
            only the per-epoch clearing result is public. No MEV, no order book to front-run.
          </p>

          <div style={{ display: "flex", gap: 12, marginTop: 36 }}>
            <PillButton size="lg" variant="primary" onClick={onStart} rightIcon="arrow-right">Set up wallet</PillButton>
            <PillButton size="lg" variant="ghost" leftIcon="book-open">Read the docs</PillButton>
          </div>

          <div style={{ marginTop: 48, display: "flex", gap: 32 }}>
            <LandingStat n="10 min" label="Epoch length on testnet" />
            <LandingStat n="K = 5" label="Max anonymity set per order" />
            <LandingStat n="0" label="MEV bots in the chain" />
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>

          <div className="q-card-deep q-card" style={{ padding: 24 }}>
            <Eyebrow style={{ color: "var(--fg-on-deep-mu)" }}>How clearing works</Eyebrow>
            <ol style={{ margin: "16px 0 0", padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 14 }}>
              {[
                { n: "01", t: "You submit a sealed order. Side, amount and price are encrypted.", icon: "shield" },
                { n: "02", t: "The protocol batches all orders in the current 10-minute epoch.", icon: "layers" },
                { n: "03", t: "At epoch close, a single uniform clearing price is computed.", icon: "git-merge" },
                { n: "04", t: "Fills land in your private balance. Nobody sees who traded what.", icon: "check-circle" },
              ].map(s => (
                <li key={s.n} style={{ display: "grid", gridTemplateColumns: "32px 18px 1fr", gap: 12, alignItems: "flex-start" }}>
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--aztec-chartreuse)", letterSpacing: "0.06em" }}>{s.n}</span>
                  <i data-lucide={s.icon} style={{ width: 14, height: 14, color: "var(--fg-on-deep-mu)", strokeWidth: 1.5, marginTop: 2 }}></i>
                  <span style={{ fontFamily: "var(--font-body)", fontSize: 13, color: "var(--fg-on-deep)", lineHeight: 1.5 }}>{s.t}</span>
                </li>
              ))}
            </ol>
          </div>

          <div className="q-card" style={{ padding: 20 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <i data-lucide="alert-triangle" style={{ width: 14, height: 14, color: "var(--q-warn-soft)", strokeWidth: 1.5 }}></i>
              <Eyebrow>Alpha software</Eyebrow>
            </div>
            <div style={{ marginTop: 8, fontFamily: "var(--font-body)", fontSize: 13, color: "var(--fg-muted)", lineHeight: 1.5 }}>
              Don't deposit more than you can lose. Audit is in progress; AUDIT items T-13/T-15 are surfaced inline throughout the UI.
            </div>
          </div>
        </div>

      </div>
    </div>
  );
}

function LandingStat({ n, label }) {
  return (
    <div>
      <div style={{ fontFamily: "var(--font-display)", fontSize: 28, fontWeight: 300, letterSpacing: "-0.02em", color: "var(--fg)" }}>{n}</div>
      <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--fg-muted)", marginTop: 4 }}>{label}</div>
    </div>
  );
}

/* ============ FIRST-LAUNCH SETUP ============ */
function SetupScreen({ onComplete }) {
  const [step, setStep] = useStateS(0); // 0=mode, 1=secret, 2=size+net, 3=faucet
  const [mode, setMode] = useStateS(null);
  const [n, setN] = useStateS(3);
  const [network, setNetwork] = useStateS("alpha-testnet");
  const [funded, setFunded] = useStateS([false, false, false]);

  function fund(i) {
    const next = [...funded];
    next[i] = true;
    setFunded(next);
  }

  const allFunded = funded.slice(0, n).every(Boolean);

  return (
    <div style={{
      height: "100%", overflow: "auto",
      display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "flex-start",
      padding: "48px 24px",
    }} className="q-scroll">
      <div style={{ width: "100%", maxWidth: 760 }}>

        {/* progress dots */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, justifyContent: "center", marginBottom: 32 }}>
          {["Mode", "Secret", "Pool", "Faucet"].map((label, i) => (
            <React.Fragment key={label}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{
                  width: 24, height: 24, borderRadius: "50%",
                  background: i <= step ? "var(--aztec-ink)" : "transparent",
                  color: i <= step ? "var(--aztec-parchment)" : "var(--fg-muted)",
                  border: `1px solid ${i <= step ? "var(--aztec-ink)" : "var(--hairline-strong)"}`,
                  display: "inline-flex", alignItems: "center", justifyContent: "center",
                  fontFamily: "var(--font-mono)", fontSize: 11, fontWeight: 500,
                }}>{i < step ? "✓" : i + 1}</span>
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: i <= step ? "var(--fg)" : "var(--fg-muted)", letterSpacing: "0.04em" }}>{label}</span>
              </div>
              {i < 3 && <div style={{ width: 32, height: 1, background: i < step ? "var(--aztec-ink)" : "var(--hairline)" }} />}
            </React.Fragment>
          ))}
        </div>

        {/* STEP 0 — Mode picker */}
        {step === 0 && (
          <div>
            <Eyebrow>Wallet mode</Eyebrow>
            <h2 style={{ fontFamily: "var(--font-display)", fontSize: 40, fontWeight: 300, letterSpacing: "-0.04em", marginTop: 4 }}>
              How do you want to <em style={{ fontFamily: "var(--font-serif)", fontStyle: "italic", fontWeight: 400 }}>sign</em>?
            </h2>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginTop: 32 }}>
              <ModeCard
                id="aztec-wallet"
                title="Aztec Wallet"
                badge=""
                desc="Use the Aztec browser extension. One account, one signer. Best for casual use."
                features={["1 account", "browser-managed", "instant connect"]}
                active={mode === "aztec-wallet"}
                onClick={() => setMode("aztec-wallet")}
                icon="chrome"
              />
              <ModeCard
                id="wallet-pool"
                title="Wallet Pool"
                badge="Recommended"
                desc="N HD-derived child wallets, round-robin. ~18N pending tx capacity. Best for active traders."
                features={[`${n} wallets`, `${n * 18} parallel tx`, "self-custodied"]}
                active={mode === "wallet-pool"}
                onClick={() => setMode("wallet-pool")}
                icon="layers"
              />
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 32 }}>
              <PillButton size="lg" variant="primary" disabled={!mode} onClick={() => mode === "wallet-pool" ? setStep(1) : onComplete()} rightIcon="arrow-right">
                {mode === "aztec-wallet" ? "Connect Aztec Wallet" : "Continue"}
              </PillButton>
            </div>
          </div>
        )}

        {/* STEP 1 — Master secret */}
        {step === 1 && (
          <div>
            <Eyebrow>Master secret</Eyebrow>
            <h2 style={{ fontFamily: "var(--font-display)", fontSize: 40, fontWeight: 300, letterSpacing: "-0.04em", marginTop: 4 }}>
              Generate or <em style={{ fontFamily: "var(--font-serif)", fontStyle: "italic", fontWeight: 400 }}>import</em>?
            </h2>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginTop: 32 }}>
              <div className="q-card" style={{ padding: 24 }}>
                <Eyebrow>Recommended</Eyebrow>
                <h3 style={{ fontFamily: "var(--font-serif)", fontSize: 22, fontWeight: 400, marginTop: 8 }}>Generate fresh</h3>
                <p style={{ fontFamily: "var(--font-body)", fontSize: 13, color: "var(--fg-muted)", marginTop: 8, lineHeight: 1.5 }}>
                  A 64-character hex string seeds all N child wallets. Save it to your password manager — losing it means losing every wallet in the pool.
                </p>
                <div style={{
                  marginTop: 16, padding: 14, background: "var(--bg-alt)",
                  border: "1px dashed var(--hairline-strong)", borderRadius: 6,
                  fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg)",
                  wordBreak: "break-all", lineHeight: 1.5,
                }}>
                  0x9d2c1f8a4b3e7d6c5f1e2a9b8c7d6e5f<br/>4a3b2c1d0e9f8a7b6c5d4e3f2a1b0c9d8
                </div>
                <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
                  <PillButton size="sm" variant="ink" leftIcon="copy">Copy</PillButton>
                  <PillButton size="sm" variant="ghost" leftIcon="refresh-cw">Regenerate</PillButton>
                </div>
              </div>
              <div className="q-card" style={{ padding: 24 }}>
                <Eyebrow>Existing user</Eyebrow>
                <h3 style={{ fontFamily: "var(--font-serif)", fontSize: 22, fontWeight: 400, marginTop: 8 }}>Import existing</h3>
                <p style={{ fontFamily: "var(--font-body)", fontSize: 13, color: "var(--fg-muted)", marginTop: 8, lineHeight: 1.5 }}>
                  Paste an existing 64-character hex secret to restore your pool. Children derive deterministically — same secret, same addresses.
                </p>
                <textarea placeholder="0x…" style={{
                  width: "100%", height: 80, marginTop: 16, padding: 12,
                  background: "var(--surface)", border: "1px solid var(--hairline-strong)", borderRadius: 6,
                  fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--fg)", resize: "none",
                }} />
              </div>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", marginTop: 32 }}>
              <PillButton size="lg" variant="ghost" onClick={() => setStep(0)} leftIcon="arrow-left">Back</PillButton>
              <PillButton size="lg" variant="primary" onClick={() => setStep(2)} rightIcon="arrow-right">I've saved my secret</PillButton>
            </div>
          </div>
        )}

        {/* STEP 2 — Pool size + network */}
        {step === 2 && (
          <div>
            <Eyebrow>Pool config</Eyebrow>
            <h2 style={{ fontFamily: "var(--font-display)", fontSize: 40, fontWeight: 300, letterSpacing: "-0.04em", marginTop: 4 }}>
              Size your <em style={{ fontFamily: "var(--font-serif)", fontStyle: "italic", fontWeight: 400 }}>pool</em>
            </h2>
            <div className="q-card" style={{ padding: 28, marginTop: 32, display: "flex", flexDirection: "column", gap: 24 }}>
              <div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                  <Eyebrow>Number of child wallets</Eyebrow>
                  <span data-mono style={{ fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--fg)" }}>{n} wallets · ≈ {n * 18 - 6} capacity</span>
                </div>
                <input type="range" min="1" max="20" value={n} onChange={(e) => setN(parseInt(e.target.value, 10))}
                       style={{ width: "100%", marginTop: 12, accentColor: "var(--aztec-ink)" }} />
                <div style={{ display: "flex", justifyContent: "space-between", fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-muted)", marginTop: 4 }}>
                  <span>1</span><span>5</span><span>10</span><span>15</span><span>20</span>
                </div>
                <div style={{ marginTop: 8, fontFamily: "var(--font-body)", fontSize: 12, color: "var(--fg-muted)", lineHeight: 1.5 }}>
                  Each wallet can hold up to 18 pending tx before stalling. {n === 1 ? "1 wallet ≈ 12 simultaneous orders." : `${n} wallets ≈ ${n * 18 - 6} simultaneous orders before any wallet stalls.`}
                </div>
              </div>

              <Hairline />

              <div>
                <Eyebrow>Network</Eyebrow>
                <div style={{ marginTop: 8 }}>
                  <Segmented value={network} onChange={setNetwork} fullWidth options={[
                    { id: "alpha-testnet", label: "alpha-testnet" },
                    { id: "sandbox",       label: "sandbox" },
                    { id: "mainnet",       label: "mainnet" },
                  ]} />
                </div>
              </div>
            </div>

            <div style={{ display: "flex", justifyContent: "space-between", marginTop: 32 }}>
              <PillButton size="lg" variant="ghost" onClick={() => setStep(1)} leftIcon="arrow-left">Back</PillButton>
              <PillButton size="lg" variant="primary" onClick={() => setStep(3)} rightIcon="arrow-right">Initialize pool</PillButton>
            </div>
          </div>
        )}

        {/* STEP 3 — Faucet helper */}
        {step === 3 && (
          <div>
            <Eyebrow>Fund your pool</Eyebrow>
            <h2 style={{ fontFamily: "var(--font-display)", fontSize: 40, fontWeight: 300, letterSpacing: "-0.04em", marginTop: 4 }}>
              Drip fee-juice <em style={{ fontFamily: "var(--font-serif)", fontStyle: "italic", fontWeight: 400 }}>per child</em>
            </h2>
            <p style={{ fontFamily: "var(--font-body)", fontSize: 14, color: "var(--fg-muted)", marginTop: 12 }}>
              Each child needs a small amount of L1 fee-juice (ETH on Sepolia) to publish proofs. Once any one child is funded you can start trading.
            </p>

            <div className="q-card" style={{ padding: 0, marginTop: 24, overflow: "hidden" }}>
              {Array.from({ length: n }).map((_, i) => (
                <div key={i} style={{
                  display: "grid", gridTemplateColumns: "32px 1fr 1fr 110px", gap: 16,
                  padding: "14px 20px", alignItems: "center",
                  borderBottom: i === n - 1 ? "none" : "1px solid var(--hairline)",
                  opacity: funded[i] ? 0.6 : 1,
                }}>
                  <div style={{
                    width: 28, height: 28, borderRadius: 4,
                    background: funded[i] ? "var(--aztec-chartreuse)" : "var(--aztec-ink)",
                    color: funded[i] ? "var(--aztec-ink)" : "var(--aztec-parchment)",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    fontFamily: "var(--font-mono)", fontSize: 12, fontWeight: 500,
                  }}>{funded[i] ? "✓" : i}</div>
                  <div>
                    <div style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>child-{i}</div>
                    <AddressMono value={`0x${"7c5fA12e8B3D4f9aC1e29bd071E4a7e123a456b8".slice(0, 38)}${i.toString(16).padStart(2, "0")}`} style={{ fontSize: 11, color: "var(--fg-muted)" }} />
                  </div>
                  <div style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: funded[i] ? "var(--fg)" : "var(--fg-muted)" }}>
                    {funded[i] ? "0.10 ETH" : "0.00 ETH"} <span style={{ color: "var(--fg-subtle)" }}>fee-juice</span>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    {funded[i] ? (
                      <Badge tone="filled">Funded</Badge>
                    ) : (
                      <PillButton size="sm" variant="primary" onClick={() => fund(i)} leftIcon="droplet">Faucet</PillButton>
                    )}
                  </div>
                </div>
              ))}
            </div>

            <div style={{ display: "flex", justifyContent: "space-between", marginTop: 32 }}>
              <PillButton size="lg" variant="ghost" onClick={() => setStep(2)} leftIcon="arrow-left">Back</PillButton>
              <PillButton size="lg" variant="primary" disabled={!funded.slice(0, 1).some(Boolean)} onClick={onComplete} rightIcon="arrow-right">
                {allFunded ? "Enter Quetzal" : `Continue with ${funded.filter(Boolean).length}/${n} funded`}
              </PillButton>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function ModeCard({ id, title, badge, desc, features, active, onClick, icon }) {
  return (
    <button onClick={onClick} style={{
      textAlign: "left", padding: 24, cursor: "pointer",
      background: active ? "var(--aztec-ink)" : "var(--surface-card)",
      color: active ? "var(--aztec-parchment)" : "var(--fg)",
      border: `1px solid ${active ? "var(--aztec-ink)" : "var(--hairline-strong)"}`,
      borderRadius: 12,
      transition: "all 200ms var(--ease-out)",
      display: "flex", flexDirection: "column", gap: 12,
    }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <i data-lucide={icon} style={{ width: 22, height: 22, color: active ? "var(--aztec-chartreuse)" : "var(--fg)", strokeWidth: 1.5 }}></i>
        {badge && (
          <span style={{
            padding: "3px 8px", borderRadius: 999,
            background: active ? "var(--aztec-chartreuse)" : "var(--aztec-chartreuse)",
            color: "var(--aztec-ink)",
            fontFamily: "var(--font-mono)", fontSize: 10, fontWeight: 500, letterSpacing: "0.04em",
            textTransform: "uppercase",
          }}>{badge}</span>
        )}
      </div>
      <div style={{ fontFamily: "var(--font-serif)", fontSize: 24, fontWeight: 400, lineHeight: 1.1 }}>{title}</div>
      <div style={{ fontFamily: "var(--font-body)", fontSize: 13, color: active ? "var(--fg-on-deep-mu)" : "var(--fg-muted)", lineHeight: 1.5 }}>{desc}</div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 4 }}>
        {features.map(f => (
          <span key={f} style={{
            fontFamily: "var(--font-mono)", fontSize: 10, padding: "3px 8px",
            borderRadius: 999, border: `1px solid ${active ? "rgba(242,238,225,0.2)" : "var(--hairline-strong)"}`,
            color: active ? "var(--fg-on-deep-mu)" : "var(--fg-muted)",
            letterSpacing: "0.04em",
          }}>{f}</span>
        ))}
      </div>
    </button>
  );
}

Object.assign(window, { LandingScreen, SetupScreen });
if (window.qStatus) qStatus("Loaded · landing/setup · rendering…");
