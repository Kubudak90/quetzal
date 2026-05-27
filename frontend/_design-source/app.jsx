// Quetzal — App shell with nav, top bar, Tweaks, onboarding tour

const { useState: useStateA, useEffect: useEffectA, useRef: useRefA } = React;

const {
  Eyebrow, Hairline, StepDivider, Dot, Badge, PillButton, Field, AddressMono, Tooltip, Segmented,
  FeatherGlyph, FeatherWatermark, QuetzalLogo,
  Toast, EpochCountdown,
  TradeScreen, BridgeScreen, WalletScreen, HistoryScreen, SettingsScreen,
  LandingScreen, SetupScreen,
  TweaksPanel, TweakSection, TweakRadio, TweakSlider, TweakToggle, TweakButton, TweakSelect,
  useTweaks,
} = window;

const QUETZAL_DEFAULTS = /*EDITMODE-BEGIN*/{
  "theme": "parchment",
  "persona": "renaissance",
  "decoyViz": "slots",
  "motifs": "subtle",
  "defaultDecoys": 2,
  "showOnboarding": false,
  "poolExhausted": false,
  "secondsLeft": 247
}/*EDITMODE-END*/;

const VALID_ROUTES = ["landing", "setup", "trade", "bridge", "wallet", "history", "settings"];
function routeFromHash() {
  const h = (window.location.hash || "").replace(/^#\/?/, "");
  return VALID_ROUTES.includes(h) ? h : "landing";
}

function App() {
  const [route, _setRoute] = useStateA(routeFromHash());
  const setRoute = (r) => {
    _setRoute(r);
    if (r === "landing") history.replaceState(null, "", " ");
    else history.replaceState(null, "", "#" + r);
  };
  useEffectA(() => {
    const h = () => _setRoute(routeFromHash());
    window.addEventListener("hashchange", h);
    return () => window.removeEventListener("hashchange", h);
  }, []);
  const [toast, setToast] = useStateA(null);
  const toastTimer = useRefA(null);
  const [tweaks, setTweak] = useTweaks(QUETZAL_DEFAULTS);
  const [tourStep, setTourStep] = useStateA(-1);
  const [secondsLeft, setSecondsLeft] = useStateA(tweaks.secondsLeft);

  // pretty toast manager
  function pushToast(t) {
    setToast(t);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 4000);
  }

  // tick clock when on trade
  useEffectA(() => {
    if (route !== "trade") return;
    const id = setInterval(() => {
      setSecondsLeft(s => s <= 1 ? 600 : s - 1);
    }, 1000);
    return () => clearInterval(id);
  }, [route]);

  useEffectA(() => { setSecondsLeft(tweaks.secondsLeft ?? 247); }, [tweaks.secondsLeft]);

  // tour
  useEffectA(() => {
    if (tweaks.showOnboarding && route === "trade") setTourStep(0);
  }, [tweaks.showOnboarding, route]);

  // re-render lucide icons whenever route or DOM changes
  useEffectA(() => {
    if (window.lucide) window.lucide.createIcons();
  });

  // theme class — respect ?theme=dark URL param for canvas embeds
  const urlTheme = new URLSearchParams(window.location.search).get("theme");
  const effectiveTheme = urlTheme === "dark" || urlTheme === "parchment" ? urlTheme : tweaks.theme;
  const themeClass = effectiveTheme === "dark" ? "theme-dark" : "";
  const personaClass = `persona-${tweaks.persona || "renaissance"}`;
  const motifsClass = `motifs-${tweaks.motifs || "subtle"}`;
  const rootClasses = `${themeClass} ${personaClass} ${motifsClass}`.trim();
  useEffectA(() => {
    document.body.className = rootClasses;
  }, [rootClasses]);

  // Onboarding tour content
  const tourSteps = [
    { title: "Wallet pool", body: "Quetzal uses N HD-derived child wallets in round-robin. Manage them at /wallet.", target: "nav-wallet" },
    { title: "Decoys", body: "Decoys submit unfillable orders alongside yours so observers can't pick out which is real. Pick 0–4.", target: "decoy-area" },
    { title: "Round-amount advisory", body: "Round numbers (1 USDC, 100 ETH) are easy to fingerprint. The form warns inline and suggests a perturbed amount.", target: "advisory-area" },
    { title: "Round-trip warning", body: "On Bridge → Exit, if your withdrawal matches a recent deposit, you'll be warned that the two could be linked.", target: "nav-bridge" },
    { title: "Epoch clearing", body: "Orders are matched in 10-minute batches. Your order lands at the next epoch close at a single uniform price.", target: "epoch-card" },
  ];

  const tweaksForScreen = { ...tweaks, secondsLeft };

  return (
    <div className={rootClasses} style={{
      height: "100vh", display: "flex", flexDirection: "column",
      background: "var(--bg)", color: "var(--fg)",
    }}>
      <TopBar route={route} setRoute={setRoute} tweaks={tweaks} secondsLeft={secondsLeft} />

      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        {route !== "landing" && route !== "setup" && (
          <SideNav route={route} setRoute={setRoute} />
        )}
        <main style={{ flex: 1, minWidth: 0, position: "relative" }}>
          {route === "landing" && <LandingScreen onStart={() => setRoute("setup")} />}
          {route === "setup"   && <SetupScreen onComplete={() => setRoute("trade")} />}
          {route === "trade"   && <TradeScreen pushToast={pushToast} tweaks={tweaksForScreen} />}
          {route === "bridge"  && <BridgeScreen pushToast={pushToast} tweaks={tweaksForScreen} />}
          {route === "wallet"  && <WalletScreen pushToast={pushToast} tweaks={tweaksForScreen} />}
          {route === "history" && <HistoryScreen tweaks={tweaksForScreen} />}
          {route === "settings"&& <SettingsScreen />}
        </main>
      </div>

      <Toast toast={toast} />

      {/* Onboarding tour */}
      {tourStep >= 0 && tourStep < tourSteps.length && (
        <TourOverlay
          step={tourSteps[tourStep]}
          index={tourStep}
          total={tourSteps.length}
          onNext={() => setTourStep(s => s + 1)}
          onSkip={() => { setTourStep(-1); setTweak("showOnboarding", false); }}
        />
      )}

      {/* Tweaks panel */}
      <TweaksPanel title="Tweaks">
        <TweakSection label="Persona">
          <TweakRadio label="Register" value={tweaks.persona} onChange={(v) => setTweak("persona", v)}
            options={[
              { value: "renaissance", label: "Renaissance" },
              { value: "terminal",    label: "Terminal" },
              { value: "editorial",   label: "Editorial" },
            ]} />
          <div style={{ fontFamily: "var(--font-body)", fontSize: 11, color: "var(--fg-muted)", lineHeight: 1.5, paddingTop: 4 }}>
            Reshapes type, eyebrow casing, italic breaks, and rhythm. Renaissance is Aztec as-shipped; Terminal goes cipherpunk-mono; Editorial swaps to serif everywhere.
          </div>
        </TweakSection>

        <TweakSection label="Decoy visualization">
          <TweakRadio label="Render" value={tweaks.decoyViz} onChange={(v) => setTweak("decoyViz", v)}
            options={[
              { value: "slots",    label: "Slots" },
              { value: "ring",     label: "Ring" },
              { value: "feathers", label: "Feathers" },
            ]} />
          <TweakSlider label="Default decoys" value={tweaks.defaultDecoys} min={0} max={4} step={1}
            onChange={(v) => setTweak("defaultDecoys", v)} />
        </TweakSection>

        <TweakSection label="Motifs">
          <TweakRadio label="Intensity" value={tweaks.motifs} onChange={(v) => setTweak("motifs", v)}
            options={[
              { value: "none",   label: "None" },
              { value: "subtle", label: "Subtle" },
              { value: "loud",   label: "Loud" },
            ]} />
          <div style={{ fontFamily: "var(--font-body)", fontSize: 11, color: "var(--fg-muted)", lineHeight: 1.5, paddingTop: 4 }}>
            Feather watermarks, step-pattern textures on deep cards, privacy shimmer. None for clean, Loud for theatrical.
          </div>
        </TweakSection>

        <TweakSection label="Theme">
          <TweakRadio label="Surface" value={tweaks.theme} onChange={(v) => setTweak("theme", v)}
            options={[
              { value: "parchment", label: "Parchment" },
              { value: "dark",      label: "Malachite" },
            ]} />
        </TweakSection>

        <TweakSection label="States">
          <TweakToggle label="Onboarding tour" value={tweaks.showOnboarding}
            onChange={(v) => setTweak("showOnboarding", v)} />
          <TweakToggle label="Pool exhaustion banner" value={tweaks.poolExhausted}
            onChange={(v) => setTweak("poolExhausted", v)} />
          <TweakSlider label="Epoch s left" value={tweaks.secondsLeft} min={1} max={600} step={1} unit="s"
            onChange={(v) => setTweak("secondsLeft", v)} />
        </TweakSection>

        <TweakSection label="Navigate">
          <TweakButton label="Landing"  onClick={() => setRoute("landing")} />
          <TweakButton label="Setup"    onClick={() => setRoute("setup")} />
          <TweakButton label="Trade"    onClick={() => setRoute("trade")} />
          <TweakButton label="Bridge"   onClick={() => setRoute("bridge")} />
          <TweakButton label="Wallet"   onClick={() => setRoute("wallet")} />
          <TweakButton label="History"  onClick={() => setRoute("history")} />
          <TweakButton label="Settings" onClick={() => setRoute("settings")} />
        </TweakSection>
      </TweaksPanel>
    </div>
  );
}

/* ============ TOP BAR ============ */
function TopBar({ route, setRoute, tweaks, secondsLeft }) {
  const showEpoch = route !== "landing" && route !== "setup";
  return (
    <header style={{
      display: "flex", alignItems: "center", justifyContent: "space-between",
      gap: 24, padding: "14px 24px",
      background: "var(--bg)",
      borderBottom: "1px solid var(--hairline)",
      flexShrink: 0,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 24 }}>
        <button onClick={() => setRoute("landing")} style={{ background: "transparent", border: "none", padding: 0, cursor: "pointer" }}>
          <QuetzalLogo size={22} />
        </button>
        {showEpoch && (
          <div style={{
            display: "inline-flex", alignItems: "center", gap: 8,
            padding: "5px 10px", border: "1px solid var(--hairline)",
            borderRadius: 999,
          }}>
            <span className="pulse-dot" style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--aztec-chartreuse)" }}></span>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-muted)" }}>alpha-testnet · seq 4</span>
          </div>
        )}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        {showEpoch && (
          <div style={{
            display: "inline-flex", alignItems: "center", gap: 10,
            padding: "6px 12px", background: "var(--bg-alt)", borderRadius: 999,
          }}>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--fg-muted)" }}>Epoch 41828</span>
            <span data-mono style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--fg)", fontWeight: 500 }}>
              {String(Math.floor(secondsLeft / 60)).padStart(2, "0")}:{String(secondsLeft % 60).padStart(2, "0")}
            </span>
          </div>
        )}
        {route !== "landing" && route !== "setup" && (
          <div style={{
            display: "inline-flex", alignItems: "center", gap: 8,
            padding: "5px 10px 5px 14px", border: "1px solid var(--hairline-strong)",
            borderRadius: 999,
          }}>
            <Dot kind="private" size={6} />
            <AddressMono value="0x7c5fA12e8B3D4f9aC1e29bd071E4a7e123a456b8" copy={false} style={{ fontSize: 11 }} />
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--fg-muted)" }}>· child-0</span>
            <i data-lucide="chevron-down" style={{ width: 12, height: 12, color: "var(--fg-muted)", strokeWidth: 1.5, marginLeft: 2 }}></i>
          </div>
        )}
      </div>
    </header>
  );
}

/* ============ SIDE NAV ============ */
function SideNav({ route, setRoute }) {
  const items = [
    { id: "trade",    label: "Trade",     icon: "candlestick-chart" },
    { id: "bridge",   label: "Bridge",    icon: "git-branch" },
    { id: "wallet",   label: "Wallet",    icon: "layers" },
    { id: "history",  label: "History",   icon: "history" },
    { id: "settings", label: "Settings",  icon: "sliders-horizontal" },
  ];
  return (
    <nav style={{
      width: 200, flexShrink: 0,
      background: "var(--bg)",
      borderRight: "1px solid var(--hairline)",
      padding: "20px 12px",
      display: "flex", flexDirection: "column", gap: 4,
    }}>
      {items.map(it => {
        const active = route === it.id;
        return (
          <button key={it.id} onClick={() => setRoute(it.id)} style={{
            display: "flex", alignItems: "center", gap: 10,
            padding: "10px 14px", borderRadius: 8,
            background: active ? "var(--aztec-ink)" : "transparent",
            color: active ? "var(--aztec-parchment)" : "var(--fg)",
            border: "none", cursor: "pointer", textAlign: "left",
            fontFamily: "var(--font-mono)", fontSize: 13, fontWeight: 500,
            transition: "all 120ms var(--ease-out)",
          }}>
            <i data-lucide={it.icon} style={{ width: 16, height: 16, strokeWidth: 1.5 }}></i>
            {it.label}
          </button>
        );
      })}

      <div style={{ flex: 1 }} />

      {/* Sidebar footer — small Quetzal motif */}
      <div style={{ padding: "14px 12px 4px", display: "flex", flexDirection: "column", gap: 8 }}>
        <StepDivider />
        <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--fg-subtle)", letterSpacing: "0.04em", lineHeight: 1.5 }}>
          Quetzal v0.4.1<br/>
          SDK 0.84.0<br/>
          <a href="#" onClick={(e) => e.preventDefault()} style={{ color: "var(--fg-muted)" }}>Docs ↗</a>
          &nbsp;·&nbsp;
          <a href="#" onClick={(e) => e.preventDefault()} style={{ color: "var(--fg-muted)" }}>GitHub ↗</a>
        </div>
      </div>
    </nav>
  );
}

/* ============ ONBOARDING TOUR ============ */
function TourOverlay({ step, index, total, onNext, onSkip }) {
  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 200,
      background: "rgba(26, 20, 0, 0.55)",
      backdropFilter: "blur(2px)",
      display: "flex", alignItems: "center", justifyContent: "center",
    }}>
      <div className="q-card" style={{
        maxWidth: 480, padding: 32, position: "relative",
        background: "var(--surface-card)",
      }}>
        <FeatherWatermark size={180} opacity={0.06} style={{ position: "absolute", top: -20, right: -20 }} />
        <div style={{ position: "relative" }}>
          <Eyebrow>Tour · {index + 1} / {total}</Eyebrow>
          <h3 style={{ fontFamily: "var(--font-display)", fontSize: 32, fontWeight: 300, letterSpacing: "-0.03em", marginTop: 8 }}>
            {step.title}
          </h3>
          <p style={{ fontFamily: "var(--font-body)", fontSize: 14, color: "var(--fg-muted)", marginTop: 12, lineHeight: 1.55 }}>
            {step.body}
          </p>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 24, gap: 8 }}>
            <button onClick={onSkip} style={{ background: "transparent", border: "none", fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--fg-muted)", cursor: "pointer", textDecoration: "underline" }}>Skip tour</button>
            <PillButton variant="primary" onClick={index === total - 1 ? onSkip : onNext} rightIcon={index === total - 1 ? "check" : "arrow-right"}>
              {index === total - 1 ? "Done" : "Next"}
            </PillButton>
          </div>
        </div>
      </div>
    </div>
  );
}

try {
  const root = ReactDOM.createRoot(document.getElementById("root"));
  root.render(<App />);
  if (window.__qBootDone) requestAnimationFrame(() => window.__qBootDone());
} catch (e) {
  if (window.__qBoot) {
    const el = document.getElementById('q-boot-error');
    if (el) { el.style.display = 'block'; el.textContent = "Render failed:\n" + (e.stack || e.message || String(e)); }
    const s = document.getElementById('q-boot-status');
    if (s) s.textContent = 'render failed';
  }
  throw e;
}
