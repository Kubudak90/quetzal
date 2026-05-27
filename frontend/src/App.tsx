// Quetzal — App shell: TopBar + SideNav + route state machine + Toast manager.
// Ported from _design-source/app.jsx. Tweaks panel + TourOverlay JSX stripped.
// Default theme is parchment (no class needed; .theme-dark would flip to malachite).

import { useState, useEffect, useRef } from "react";
import type { CSSProperties } from "react";
import {
  Dot, AddressMono, QuetzalLogo, Toast, StepDivider,
} from "./components/atoms.js";
import { LandingScreen, SetupScreen } from "./screens/landing.js";
import { TradeScreen } from "./screens/trade.js";
import { BridgeScreen } from "./screens/bridge.js";
import {
  WalletScreen, HistoryScreen, SettingsScreen,
} from "./screens/wallet-history-settings.js";

const VALID_ROUTES = ["landing", "setup", "trade", "bridge", "wallet", "history", "settings"] as const;
type Route = (typeof VALID_ROUTES)[number];

function routeFromHash(): Route {
  const h = (window.location.hash || "").replace(/^#\/?/, "");
  return (VALID_ROUTES as readonly string[]).includes(h) ? (h as Route) : "landing";
}

interface ToastIn { kind: string; text: string }
interface ToastState {
  kind: string;
  text: string;
  // The atoms `Toast` component supports both shapes; we expose `title` so it shows.
  title: string;
  tone: "success" | "info" | "error";
}

function toToastState(t: ToastIn): ToastState {
  const tone: "success" | "info" | "error" =
    t.kind === "success" ? "success" :
    t.kind === "error"   ? "error"   :
    "info";
  return { kind: t.kind, text: t.text, title: t.text, tone };
}

export default function App() {
  const [route, _setRoute] = useState<Route>(routeFromHash());
  const setRoute = (r: Route) => {
    _setRoute(r);
    if (r === "landing") history.replaceState(null, "", " ");
    else history.replaceState(null, "", "#" + r);
  };
  useEffect(() => {
    const h = () => _setRoute(routeFromHash());
    window.addEventListener("hashchange", h);
    return () => window.removeEventListener("hashchange", h);
  }, []);

  const [toast, setToast] = useState<ToastState | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(247);

  // pretty toast manager
  function pushToast(t: ToastIn) {
    setToast(toToastState(t));
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 4000);
  }

  // tick clock when on trade
  useEffect(() => {
    if (route !== "trade") return;
    const id = setInterval(() => {
      setSecondsLeft(s => s <= 1 ? 600 : s - 1);
    }, 1000);
    return () => clearInterval(id);
  }, [route]);

  // re-render lucide icons whenever route or DOM changes
  useEffect(() => {
    if (window.lucide) window.lucide.createIcons();
  });

  // Sub-6c frontend: theme switcher (parchment <-> dark/malachite)
  const [theme, setTheme] = useState<"parchment" | "dark">(() => {
    if (typeof window === "undefined") return "parchment";
    const saved = window.localStorage.getItem("quetzal-theme");
    return saved === "dark" ? "dark" : "parchment";
  });
  const toggleTheme = () => {
    setTheme((t) => {
      const next = t === "dark" ? "parchment" : "dark";
      window.localStorage.setItem("quetzal-theme", next);
      return next;
    });
  };

  // Default theme = parchment (no class). Persona + motifs are CSS hooks.
  const rootClasses = `${theme === "dark" ? "theme-dark" : ""} persona-renaissance motifs-subtle`.trim();
  useEffect(() => {
    document.body.className = rootClasses;
  }, [rootClasses]);

  // TODO: re-enable onboarding tour (TourOverlay JSX stripped; tourSteps content lives in
  // commit history at frontend/_design-source/app.jsx).

  return (
    <div className={rootClasses} style={{
      height: "100vh", display: "flex", flexDirection: "column",
      background: "var(--bg)", color: "var(--fg)",
    }}>
      <TopBar route={route} setRoute={setRoute} secondsLeft={secondsLeft} theme={theme} onToggleTheme={toggleTheme} />

      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        {route !== "landing" && route !== "setup" && (
          <SideNav route={route} setRoute={setRoute} />
        )}
        <main style={{ flex: 1, minWidth: 0, position: "relative" }}>
          {route === "landing" && <LandingScreen onStart={() => setRoute("setup")} />}
          {route === "setup"   && <SetupScreen onComplete={() => setRoute("trade")} />}
          {route === "trade"   && <TradeScreen pushToast={pushToast} secondsLeft={secondsLeft} />}
          {route === "bridge"  && <BridgeScreen pushToast={pushToast} />}
          {route === "wallet"  && <WalletScreen pushToast={pushToast} />}
          {route === "history" && <HistoryScreen />}
          {route === "settings"&& <SettingsScreen />}
        </main>
      </div>

      <Toast toast={toast} />
    </div>
  );
}

/* ============ TOP BAR ============ */
interface TopBarProps {
  route: Route;
  setRoute: (r: Route) => void;
  secondsLeft: number;
  theme: "parchment" | "dark";
  onToggleTheme: () => void;
}
function TopBar({ route, setRoute, secondsLeft, theme, onToggleTheme }: TopBarProps) {
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
          <button
            onClick={onToggleTheme}
            title={theme === "dark" ? "Switch to Parchment" : "Switch to Malachite"}
            aria-label="Toggle theme"
            style={{
              display: "inline-flex", alignItems: "center", justifyContent: "center",
              width: 32, height: 32, border: "1px solid var(--hairline-strong)",
              borderRadius: 999, background: "transparent",
              color: "var(--fg)", cursor: "pointer",
              transition: "all 120ms var(--ease-out)",
            }}
          >
            <i data-lucide={theme === "dark" ? "sun" : "moon"} style={{ width: 14, height: 14, strokeWidth: 1.5 } as CSSProperties}></i>
          </button>
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
            <i data-lucide="chevron-down" style={{ width: 12, height: 12, color: "var(--fg-muted)", strokeWidth: 1.5, marginLeft: 2 } as CSSProperties}></i>
          </div>
        )}
      </div>
    </header>
  );
}

/* ============ SIDE NAV ============ */
interface SideNavProps {
  route: Route;
  setRoute: (r: Route) => void;
}
function SideNav({ route, setRoute }: SideNavProps) {
  const items: { id: Route; label: string; icon: string }[] = [
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
            <i data-lucide={it.icon} style={{ width: 16, height: 16, strokeWidth: 1.5 } as CSSProperties}></i>
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
