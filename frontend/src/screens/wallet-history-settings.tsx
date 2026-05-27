// Quetzal — Wallet pool screen + History screen + Settings screen.
// Ported from _design-source/wallet-history-settings.jsx. Tweaks panel dropped;
// `poolExhausted` hardcoded to false; theme switcher hardcoded to "parchment".

import { useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import {
  Eyebrow, Hairline, Dot, Badge, PillButton, AddressMono, Segmented,
} from "../components/atoms.js";
import { PoolCapacityBar, TokenGlyph } from "../components/screens-shared.js";

interface ToastIn { kind: string; text: string }
type PushToast = (t: ToastIn) => void;

interface WalletScreenProps {
  pushToast: PushToast;
}

interface PoolChild {
  id: number;
  addr: string;
  fee: string;
  usdc: string;
  weth: string;
  wbtc: string;
  pending: number;
}
const POOL_CHILDREN: PoolChild[] = [
  { id: 0, addr: "0x7c5fA12e8B3D4f9aC1e29bd071E4a7e123a456b8", fee: "0.0824", usdc: "5,200.00", weth: "1.500", wbtc: "0.040", pending: 8 },
  { id: 1, addr: "0x4a82B17c9D5e6F08172a3B4c5D6e7F8902a13b4c", fee: "0.0941", usdc: "3,150.00", weth: "0.840", wbtc: "0.020", pending: 12 },
  { id: 2, addr: "0x9c34D1B7E5f6a8b9c0d1e2f3041526738a90bc12", fee: "0.0712", usdc: "1,840.00", weth: "0.500", wbtc: "0.024", pending: 4 },
];

const POOL_EXHAUSTED = false; // hardcoded (was tweaks.poolExhausted)

export function WalletScreen({ pushToast }: WalletScreenProps) {
  const totalCapacity = POOL_CHILDREN.length * 18 - POOL_CHILDREN.reduce((s, c) => s + c.pending, 0);
  const [showMaster, setShowMaster] = useState(false);
  return (
    <div style={{ padding: 24, height: "100%", overflow: "auto" }} className="q-scroll">
      <div style={{ maxWidth: 1200, margin: "0 auto", display: "flex", flexDirection: "column", gap: 20 }}>

        <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 16 }}>
          <div>
            <Eyebrow>Wallet pool</Eyebrow>
            <h2 style={{ fontFamily: "var(--font-display)", fontSize: 44, fontWeight: 300, letterSpacing: "-0.04em", marginTop: 4 }}>
              {POOL_CHILDREN.length} wallets · <em style={{ fontFamily: "var(--font-serif)", fontStyle: "italic", fontWeight: 400 }}>{totalCapacity}</em> open slots
            </h2>
            <p style={{ fontFamily: "var(--font-body)", fontSize: 14, color: "var(--fg-muted)", marginTop: 8 }}>
              HD-derived children of a single master secret · round-robin via <code style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>pool.next()</code>
            </p>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <PillButton variant="ghost" leftIcon="plus">Grow pool</PillButton>
            <PillButton variant="ink" leftIcon="droplet">Faucet all</PillButton>
          </div>
        </div>

        {/* Pool exhaustion banner (conditional — hardcoded false; the next task wires it from real state) */}
        {POOL_EXHAUSTED && (
          <div style={{
            background: "rgba(255,26,26,0.06)",
            border: "1px solid rgba(255,26,26,0.4)",
            borderRadius: 8,
            padding: "14px 16px",
            display: "flex", alignItems: "center", gap: 12,
          }}>
            <i data-lucide="alert-octagon" style={{ width: 18, height: 18, color: "var(--aztec-vermillion)", strokeWidth: 1.5 } as CSSProperties}></i>
            <div style={{ flex: 1 }}>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--fg)", fontWeight: 500 }}>All wallets at capacity</div>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-muted)", marginTop: 2 }}>Submissions paused. Either wait for next epoch to clear pending tx, or grow the pool.</div>
            </div>
            <PillButton size="sm" variant="ink">Grow to 6 wallets</PillButton>
          </div>
        )}

        {/* Children grid */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(360px, 1fr))", gap: 16 }}>
          {/* TODO(sdk): replace POOL_CHILDREN with client.pool.getChildren() */}
          {POOL_CHILDREN.map(c => (
            <ChildCard
              key={c.id}
              child={c}
              onFaucet={() => {
                // TODO(sdk): call client.pool.faucetChild(c.id)
                pushToast({ kind: "success", text: `Faucet sent to child-${c.id} · 0.1 ETH fee-juice` });
              }}
            />
          ))}
        </div>

        {/* Master secret */}
        <div className="q-card-deep q-card" style={{ padding: 24 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
            <div>
              <Eyebrow style={{ color: "var(--fg-on-deep-mu)" }}>Master secret</Eyebrow>
              <div style={{ fontFamily: "var(--font-display)", fontSize: 24, fontWeight: 300, color: "var(--fg-on-deep)", marginTop: 6 }}>
                Single source of <em style={{ fontFamily: "var(--font-serif)", fontStyle: "italic", fontWeight: 400 }}>truth</em>
              </div>
            </div>
            <PillButton variant="onDeep" size="sm" onClick={() => setShowMaster(!showMaster)} leftIcon={showMaster ? "eye-off" : "eye"}>
              {showMaster ? "Hide" : "Reveal"}
            </PillButton>
          </div>
          <div style={{ marginTop: 16, display: "flex", alignItems: "center", gap: 12, padding: "14px 16px", background: "rgba(0,0,0,0.3)", borderRadius: 6 }}>
            <i data-lucide="key" style={{ width: 16, height: 16, color: "var(--aztec-chartreuse)", strokeWidth: 1.5 } as CSSProperties}></i>
            <code style={{
              flex: 1, fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--fg-on-deep)",
              filter: showMaster ? "none" : "blur(6px)", userSelect: showMaster ? "auto" : "none",
            }}>
              0x9d2c1f8a4b3e7d6c5f1e2a9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f2a1b0c9d8
            </code>
            <PillButton variant="onDeep" size="sm" leftIcon="copy" disabled={!showMaster}>Copy</PillButton>
          </div>
          <div style={{ marginTop: 10, fontFamily: "var(--font-body)", fontSize: 12, color: "var(--fg-on-deep-mu)", lineHeight: 1.5 }}>
            Whoever holds this secret controls every child wallet in the pool. Store it in a password manager. Never paste it into a website.
          </div>
        </div>
      </div>
    </div>
  );
}

function ChildCard({ child, onFaucet }: { child: PoolChild; onFaucet: () => void }) {
  return (
    <div className="q-card" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{
            width: 32, height: 32, borderRadius: 6,
            background: "var(--aztec-ink)", color: "var(--aztec-parchment)",
            display: "flex", alignItems: "center", justifyContent: "center",
            fontFamily: "var(--font-mono)", fontSize: 13, fontWeight: 500,
          }}>{child.id}</div>
          <div>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--fg)" }}>child-{child.id}</div>
            <AddressMono value={child.addr} style={{ fontSize: 11, color: "var(--fg-muted)" }} />
          </div>
        </div>
        <PillButton size="sm" variant="quiet" onClick={onFaucet} leftIcon="droplet">Faucet</PillButton>
      </div>

      <Hairline />

      <PoolCapacityBar current={child.pending} max={18} />

      <Hairline />

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <Eyebrow>Balances</Eyebrow>
        <BalanceRow2 token="ETH"  kind="public"  amount={child.fee}  label="fee-juice" />
        <BalanceRow2 token="USDC" kind="private" amount={child.usdc} label="aUSDC" />
        <BalanceRow2 token="WETH" kind="private" amount={child.weth} label="aWETH" />
        <BalanceRow2 token="wBTC" kind="private" amount={child.wbtc} label="awBTC" />
      </div>
    </div>
  );
}

interface BalanceRow2Props {
  token: string;
  kind: "private" | "public";
  amount: string;
  label: string;
}
function BalanceRow2({ token, kind, amount, label }: BalanceRow2Props) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "22px 1fr auto", gap: 10, alignItems: "center" }}>
      <TokenGlyph token={token} size={22} />
      <div>
        <div style={{ fontFamily: "var(--font-serif)", fontSize: 13 }}>{label}</div>
        <div style={{ fontFamily: "var(--font-mono)", fontSize: 9, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--fg-muted)", marginTop: 1 }}>
          <Dot kind={kind} size={5} /> {kind}
        </div>
      </div>
      <div data-mono style={{ fontFamily: "var(--font-mono)", fontSize: 13, textAlign: "right", color: "var(--fg)" }}>{amount}</div>
    </div>
  );
}

/* ============ HISTORY ============ */
interface HistoryRow {
  time: string;
  epoch: number;
  side: "buy" | "sell";
  amount: string;
  amountToken: string;
  limit: string;
  fillPrice: string;
  status: "filled" | "decoy" | "cancelled";
  tx: string;
  decoy: boolean;
}
const HISTORY: HistoryRow[] = [
  { time: "12:24:18", epoch: 41827, side: "sell", amount: "1.0734",  amountToken: "ETH",  limit: "3,220.50", fillPrice: "3,220.50", status: "filled",    tx: "0x4a2b…f81e", decoy: false },
  { time: "12:14:02", epoch: 41826, side: "buy",  amount: "2,840.00",amountToken: "USDC", limit: "3,220.00", fillPrice: "3,217.22", status: "filled",    tx: "0x8f1c…0a4d", decoy: false },
  { time: "12:13:58", epoch: 41826, side: "buy",  amount: "2,615.20",amountToken: "USDC", limit: "3,215.00", fillPrice: "—",        status: "decoy",     tx: "0x8f1c…0a4e", decoy: true },
  { time: "12:13:55", epoch: 41826, side: "buy",  amount: "3,102.40",amountToken: "USDC", limit: "3,215.00", fillPrice: "—",        status: "decoy",     tx: "0x8f1c…0a4f", decoy: true },
  { time: "12:04:30", epoch: 41825, side: "sell", amount: "0.4127",  amountToken: "ETH",  limit: "3,210.00", fillPrice: "3,210.00", status: "filled",    tx: "0xb7e2…3c1f", decoy: false },
  { time: "11:54:11", epoch: 41824, side: "buy",  amount: "1,500.00",amountToken: "USDC", limit: "3,205.80", fillPrice: "3,205.80", status: "filled",    tx: "0x2d44…91ab", decoy: false },
  { time: "11:44:00", epoch: 41823, side: "sell", amount: "0.8923",  amountToken: "ETH",  limit: "3,212.45", fillPrice: "3,212.45", status: "filled",    tx: "0x6e1f…7b2c", decoy: false },
  { time: "11:33:42", epoch: 41822, side: "buy",  amount: "847.12",  amountToken: "USDC", limit: "3,150.00", fillPrice: "—",        status: "cancelled", tx: "0x1a2b…9876", decoy: false },
  { time: "11:23:15", epoch: 41821, side: "sell", amount: "1.2400",  amountToken: "ETH",  limit: "3,200.00", fillPrice: "3,200.00", status: "filled",    tx: "0x5e6f…0a1b", decoy: false },
  { time: "11:13:08", epoch: 41820, side: "buy",  amount: "1,250.00",amountToken: "USDC", limit: "3,195.00", fillPrice: "3,195.00", status: "filled",    tx: "0xa0b1…c2d3", decoy: false },
];

export function HistoryScreen() {
  const [side, setSide] = useState<"all" | "buy" | "sell">("all");
  const [hideDecoys, setHideDecoys] = useState(false);
  const filtered = HISTORY.filter(h => (side === "all" || h.side === side) && (!hideDecoys || !h.decoy));
  return (
    <div style={{ padding: 24, height: "100%", overflow: "auto" }} className="q-scroll">
      <div style={{ maxWidth: 1200, margin: "0 auto", display: "flex", flexDirection: "column", gap: 20 }}>

        <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between" }}>
          <div>
            <Eyebrow>History</Eyebrow>
            <h2 style={{ fontFamily: "var(--font-display)", fontSize: 44, fontWeight: 300, letterSpacing: "-0.04em", marginTop: 4 }}>
              Every <em style={{ fontFamily: "var(--font-serif)", fontStyle: "italic", fontWeight: 400 }}>order</em>, every epoch
            </h2>
          </div>
          {/* TODO(sdk): wire up CSV export — call client.history.exportCsv() */}
          <PillButton variant="ghost" leftIcon="download">Export CSV</PillButton>
        </div>

        {/* Filter row */}
        <div className="q-card" style={{ padding: 16, display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <Eyebrow>Side</Eyebrow>
            <Segmented value={side} onChange={(v) => setSide(v as "all" | "buy" | "sell")} size="sm" options={[
              { id: "all",  label: "All"  },
              { id: "buy",  label: "Buy"  },
              { id: "sell", label: "Sell" },
            ]} />
          </div>
          <div style={{ width: 1, height: 24, background: "var(--hairline)" }} />
          <label style={{ display: "inline-flex", alignItems: "center", gap: 8, cursor: "pointer", fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--fg)" }}>
            <input type="checkbox" checked={hideDecoys} onChange={(e) => setHideDecoys(e.target.checked)} style={{ accentColor: "var(--q-decoy)" }} />
            Hide decoys
          </label>
          <div style={{ width: 1, height: 24, background: "var(--hairline)" }} />
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <Eyebrow>Epoch range</Eyebrow>
            <div style={{ display: "flex", alignItems: "center", gap: 6, fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--fg)" }}>
              <input type="number" defaultValue={41820} style={{ width: 70, height: 28, padding: "0 8px", borderRadius: 4, border: "1px solid var(--hairline-strong)", background: "var(--surface)", fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--fg)" }} />
              <span style={{ color: "var(--fg-muted)" }}>→</span>
              <input type="number" defaultValue={41828} style={{ width: 70, height: 28, padding: "0 8px", borderRadius: 4, border: "1px solid var(--hairline-strong)", background: "var(--surface)", fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--fg)" }} />
            </div>
          </div>
          <div style={{ flex: 1 }} />
          <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-muted)" }}>{filtered.length} rows</div>
        </div>

        {/* Table */}
        <div className="q-card" style={{ padding: 0, overflow: "hidden" }}>
          <div style={{
            display: "grid", gridTemplateColumns: "16px 80px 80px 70px 1fr 1fr 1fr 100px 100px",
            gap: 12, padding: "10px 20px", background: "var(--bg-alt)",
          }}>
            <span></span>
            <span className="q-eyebrow">Time</span>
            <span className="q-eyebrow">Epoch</span>
            <span className="q-eyebrow">Side</span>
            <span className="q-eyebrow">Amount</span>
            <span className="q-eyebrow">Limit</span>
            <span className="q-eyebrow">Fill</span>
            <span className="q-eyebrow">Status</span>
            <span className="q-eyebrow" style={{ textAlign: "right" }}>TX</span>
          </div>
          {/* TODO(sdk): replace HISTORY with client.history.getOrders({ from, to }) */}
          {filtered.map((h, i) => (
            <div key={i} style={{
              display: "grid", gridTemplateColumns: "16px 80px 80px 70px 1fr 1fr 1fr 100px 100px",
              gap: 12, padding: "12px 20px", alignItems: "center",
              borderBottom: "1px solid var(--hairline)",
              opacity: h.decoy ? 0.7 : 1,
            }}>
              <Dot kind={h.status === "filled" ? "filled" : h.status === "decoy" ? "decoy" : "cancel"} size={8} />
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-muted)" }}>{h.time}</span>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 11 }}>{h.epoch}</span>
              <span style={{
                fontFamily: "var(--font-mono)", fontSize: 10, fontWeight: 500, letterSpacing: "0.06em",
                textTransform: "uppercase",
                padding: "3px 7px", borderRadius: 3, width: "fit-content",
                background: h.side === "buy" ? "rgba(13, 152, 118, 0.12)" : "rgba(255, 26, 26, 0.10)",
                color: h.side === "buy" ? "#0d9876" : "var(--aztec-vermillion)",
              }}>{h.side}</span>
              <span data-mono style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>{h.amount} <span style={{ color: "var(--fg-muted)" }}>{h.amountToken}</span></span>
              <span data-mono style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--fg-muted)" }}>{h.limit}</span>
              <span data-mono style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: h.fillPrice === "—" ? "var(--fg-subtle)" : "var(--fg)" }}>{h.fillPrice}</span>
              <Badge tone={h.status === "filled" ? "filled" : h.status === "decoy" ? "decoy" : "cancel"}>{h.status}</Badge>
              <a href="#" onClick={(e) => e.preventDefault()} style={{
                fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-muted)",
                textDecoration: "underline", textDecorationColor: "var(--hairline-strong)",
                textAlign: "right",
              }}>{h.tx.slice(0, 8)}…</a>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ============ SETTINGS ============ */
export function SettingsScreen() {
  const [network, setNetwork] = useState("alpha-testnet");
  return (
    <div style={{ padding: 24, height: "100%", overflow: "auto" }} className="q-scroll">
      <div style={{ maxWidth: 760, margin: "0 auto", display: "flex", flexDirection: "column", gap: 20 }}>
        <div>
          <Eyebrow>Settings</Eyebrow>
          <h2 style={{ fontFamily: "var(--font-display)", fontSize: 44, fontWeight: 300, letterSpacing: "-0.04em", marginTop: 4 }}>
            <em style={{ fontFamily: "var(--font-serif)", fontStyle: "italic", fontWeight: 400 }}>Knobs</em>, for power users
          </h2>
        </div>

        <SettingsSection title="Network">
          <Segmented value={network} onChange={setNetwork} fullWidth options={[
            { id: "alpha-testnet", label: "alpha-testnet" },
            { id: "sandbox",       label: "sandbox" },
            { id: "mainnet",       label: "mainnet" },
          ]} />
          <div style={{ fontFamily: "var(--font-body)", fontSize: 12, color: "var(--fg-muted)", marginTop: 8 }}>
            {network === "mainnet" && (
              <span style={{ color: "var(--aztec-vermillion)" }}>⚠ Mainnet is live. Operations cost real money.</span>
            )}
            {network === "alpha-testnet" && "Public testnet. Free faucet, no real value. 10-min epochs."}
            {network === "sandbox"       && "Local sandbox. Requires a running node at localhost:8080."}
          </div>
        </SettingsSection>

        <SettingsSection title="Theme">
          {/* Hardcoded to Parchment for now; the next task wires the actual switcher */}
          <Segmented value="parchment" onChange={() => undefined} fullWidth options={[
            { id: "parchment", label: "Parchment" },
            { id: "dark",      label: "Malachite" },
          ]} />
          <div style={{ fontFamily: "var(--font-body)", fontSize: 12, color: "var(--fg-muted)", marginTop: 8 }}>
            Parchment is the default. Malachite switcher lands in the next task.
          </div>
        </SettingsSection>

        <SettingsSection title="Privacy defaults">
          <SettingRow label="Default decoy count" hint="Applied to new orders. You can override per-order on the trade screen.">
            <input type="number" min="0" max="4" defaultValue={2} style={{ width: 60, height: 32, padding: "0 8px", border: "1px solid var(--hairline-strong)", borderRadius: 4, fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--fg)", background: "var(--surface)" }} />
          </SettingRow>
          <SettingRow label="Show round-amount advisory" hint="Warn when amount looks fingerprintable.">
            <Toggle defaultOn />
          </SettingRow>
          <SettingRow label="Show round-trip warning" hint="Warn when exit amount resembles a recent L1 deposit.">
            <Toggle defaultOn />
          </SettingRow>
        </SettingsSection>

        <SettingsSection title="Advanced">
          <SettingRow label="RPC override" hint="Use a custom Aztec node. Leave blank for default.">
            <input placeholder="https://…" style={{ width: 240, height: 32, padding: "0 10px", border: "1px solid var(--hairline-strong)", borderRadius: 4, fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--fg)", background: "var(--surface)" }} />
          </SettingRow>
          <SettingRow label="Gas overestimate" hint="Multiplier applied to gas estimate.">
            <input type="number" defaultValue={1.2} step={0.1} style={{ width: 60, height: 32, padding: "0 8px", border: "1px solid var(--hairline-strong)", borderRadius: 4, fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--fg)", background: "var(--surface)" }} />
          </SettingRow>
        </SettingsSection>

        <SettingsSection title="Danger zone">
          <div style={{
            border: "1px solid rgba(255,26,26,0.35)", background: "rgba(255,26,26,0.04)",
            borderRadius: 6, padding: 16, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16,
          }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 12, fontWeight: 500, color: "var(--fg)" }}>Reset local state</div>
              <div style={{ fontFamily: "var(--font-body)", fontSize: 12, color: "var(--fg-muted)", marginTop: 4 }}>Clears decoy registry, pending claims, and cached pool config. Does not delete the master secret.</div>
            </div>
            {/* TODO(sdk): call client.local.reset() */}
            <PillButton variant="danger" size="sm">Reset</PillButton>
          </div>
        </SettingsSection>
      </div>
    </div>
  );
}

function SettingsSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="q-card">
      <h4 style={{ fontFamily: "var(--font-serif)", fontSize: 18, fontWeight: 400, marginBottom: 16 }}>{title}</h4>
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>{children}</div>
    </div>
  );
}

function SettingRow({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 16, alignItems: "center", paddingBottom: 12, borderBottom: "1px solid var(--hairline)" }}>
      <div>
        <div style={{ fontFamily: "var(--font-body)", fontSize: 13, color: "var(--fg)" }}>{label}</div>
        {hint && <div style={{ fontFamily: "var(--font-body)", fontSize: 11, color: "var(--fg-muted)", marginTop: 2, lineHeight: 1.45 }}>{hint}</div>}
      </div>
      <div>{children}</div>
    </div>
  );
}

function Toggle({ defaultOn = false }: { defaultOn?: boolean }) {
  const [on, setOn] = useState(defaultOn);
  return (
    <button onClick={() => setOn(!on)} style={{
      width: 40, height: 22, borderRadius: 999,
      background: on ? "var(--aztec-ink)" : "var(--hairline-strong)",
      border: "none", cursor: "pointer", position: "relative",
      transition: "background var(--dur-fast) var(--ease-out)",
    }}>
      <span style={{
        position: "absolute", top: 2, left: on ? 20 : 2,
        width: 18, height: 18, borderRadius: "50%", background: "var(--aztec-parchment)",
        transition: "left var(--dur-fast) var(--ease-out)",
      }} />
    </button>
  );
}
