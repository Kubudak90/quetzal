// Quetzal — Bridge screen
// L1 <-> L2 bridge with 3 tabs: Deposit / Claim / Exit.
// Ported from _design-source/bridge.jsx. Tweaks panel dropped.

import { useState, useMemo, Fragment } from "react";
import type { CSSProperties } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useQuetzalClient, useClientContext } from "../sdk/client-context.js";
import {
  Eyebrow, Hairline, Dot, Badge, PillButton, Field, AddressMono, Tooltip, Segmented,
} from "../components/atoms.js";
import { RoundAmountAdvisory, TokenGlyph } from "../components/screens-shared.js";

// ─── Amount helper ─────────────────────────────────────────────────────────────
/** Parse a display amount string (e.g. "1,234.56") to bigint with given decimals. */
function parseAmount(s: string, decimals: number = 6): bigint {
  const clean = s.replace(/,/g, "").trim();
  if (!clean || clean === ".") return 0n;
  const [whole = "0", frac = ""] = clean.split(".");
  const fracPadded = frac.padEnd(decimals, "0").slice(0, decimals);
  try {
    return BigInt(whole + fracPadded);
  } catch {
    return 0n;
  }
}

// ─── localStorage helpers for pending claims ───────────────────────────────────
// SDK has no client.bridge.getPendingClaims() — pending claims are tracked in
// localStorage after each deposit() call.
interface LocalPendingClaim {
  token: string;
  amount: string; // bigint stringified
  secret: string;
  secretHash: string;
  messageIndex: string;
  isPrivate: boolean;
  createdAt: number;
}

function addLocalPendingClaim(c: LocalPendingClaim) {
  const list = loadLocalPendingClaims();
  list.push(c);
  localStorage.setItem("quetzal-pending-claims", JSON.stringify(list));
}

function loadLocalPendingClaims(): LocalPendingClaim[] {
  try {
    const raw = localStorage.getItem("quetzal-pending-claims");
    return raw ? (JSON.parse(raw) as LocalPendingClaim[]) : [];
  } catch {
    return [];
  }
}

function removeLocalPendingClaim(secret: string) {
  const list = loadLocalPendingClaims().filter((c) => c.secret !== secret);
  localStorage.setItem("quetzal-pending-claims", JSON.stringify(list));
}

// ─── Browser-compatible bridge-state helpers ───────────────────────────────────
// SDK's loadBridgeState() / saveBridgeState() from @quetzal/sdk/privacy/bridge-schedule
// use Node's node:fs / node:os / node:path — unusable in the browser.
// TODO(sdk-browser-state): SDK needs a browser-portable bridge-state backend.
// Until then, the shape { scheduledExits: ScheduledExit[] } is mirrored here via localStorage.
interface BridgeScheduledExit {
  id: number;
  token: string;
  amount: string;
  recipient: string;
  part: string;
  scheduled: string;
  status: "submitted" | "pending";
}

function loadBrowserBridgeState(): { scheduledExits: BridgeScheduledExit[] } {
  try {
    const raw = localStorage.getItem("quetzal-bridge-state");
    return raw ? (JSON.parse(raw) as { scheduledExits: BridgeScheduledExit[] }) : { scheduledExits: [] };
  } catch {
    return { scheduledExits: [] };
  }
}

interface ToastIn { kind: string; text: string }
type PushToast = (t: ToastIn) => void;

interface BridgeScreenProps {
  pushToast: PushToast;
}

interface BridgeToken {
  id: string;
  label: string;
  l1Bal: string;
  l2Bal: string;
  priv: string;
  pub: string;
}
const BRIDGE_TOKENS: BridgeToken[] = [
  { id: "USDC", label: "USDC", l1Bal: "12,430.00", l2Bal: "8,127.42", priv: "5,200.00", pub: "2,927.42" },
  { id: "WETH", label: "WETH", l1Bal: "4.21",       l2Bal: "2.840",    priv: "1.500",    pub: "1.340"    },
  { id: "wBTC", label: "wBTC", l1Bal: "0.124",      l2Bal: "0.0842",   priv: "0.060",    pub: "0.0242"   },
];

function tokenById(id: string): BridgeToken {
  return BRIDGE_TOKENS.find(t => t.id === id) ?? BRIDGE_TOKENS[0]!;
}

export function BridgeScreen({ pushToast }: BridgeScreenProps) {
  const [tab, setTab] = useState<"deposit" | "claim" | "exit">("deposit");
  return (
    <div style={{ padding: 24, height: "100%", overflow: "auto" }} className="q-scroll">
      <div style={{ maxWidth: 920, margin: "0 auto", display: "flex", flexDirection: "column", gap: 20 }}>

        {/* Header */}
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 16 }}>
          <div>
            <Eyebrow>Bridge</Eyebrow>
            <h2 style={{ fontFamily: "var(--font-display)", fontSize: 44, fontWeight: 300, letterSpacing: "-0.04em", marginTop: 4 }}>
              Move funds <em style={{ fontFamily: "var(--font-serif)", fontStyle: "italic", fontWeight: 400 }}>across</em> layers
            </h2>
            <p style={{ fontFamily: "var(--font-body)", fontSize: 14, color: "var(--fg-muted)", marginTop: 8 }}>
              Sepolia L1 ↔ Aztec L2 · USDC / WETH / wBTC · public or private modes
            </p>
          </div>
          <Badge tone="warn"><i data-lucide="alert-triangle" style={{ width: 11, height: 11, strokeWidth: 1.5 } as CSSProperties}></i> Testnet</Badge>
        </div>

        {/* Tabs */}
        <div style={{ display: "flex", alignItems: "center", gap: 4, borderBottom: "1px solid var(--hairline)" }}>
          {([
            { id: "deposit", label: "Deposit", subtitle: "L1 → L2", icon: "arrow-down-to-line" },
            { id: "claim",   label: "Claim",   subtitle: "Pending messages", icon: "inbox" },
            { id: "exit",    label: "Exit",    subtitle: "L2 → L1", icon: "arrow-up-from-line" },
          ] as const).map(t => (
            <button key={t.id} onClick={() => setTab(t.id)} style={{
              display: "flex", flexDirection: "column", gap: 2,
              padding: "12px 16px", border: "none", background: "transparent",
              cursor: "pointer", textAlign: "left",
              borderBottom: `2px solid ${tab === t.id ? "var(--aztec-ink)" : "transparent"}`,
              marginBottom: -1,
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <i data-lucide={t.icon} style={{ width: 14, height: 14, color: tab === t.id ? "var(--fg)" : "var(--fg-muted)", strokeWidth: 1.5 } as CSSProperties}></i>
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 13, fontWeight: 500, color: tab === t.id ? "var(--fg)" : "var(--fg-muted)" }}>{t.label}</span>
              </div>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--fg-subtle)", letterSpacing: "0.04em" }}>{t.subtitle}</span>
            </button>
          ))}
        </div>

        {tab === "deposit" && <DepositTab pushToast={pushToast} />}
        {tab === "claim"   && <ClaimTab pushToast={pushToast} />}
        {tab === "exit"    && <ExitTab pushToast={pushToast} />}

        {/* Scheduled exits table (always shown below) */}
        <ScheduledExits />
      </div>
    </div>
  );
}

/* ============ DEPOSIT ============ */
function DepositTab({ pushToast }: { pushToast: PushToast }) {
  const client = useQuetzalClient();
  const { session } = useClientContext();
  const qc = useQueryClient();

  const [token, setToken] = useState("USDC");
  const [amount, setAmount] = useState("");
  const [visibility, setVisibility] = useState<"private" | "public">("private");
  const [advanced, setAdvanced] = useState(false);
  const [recipient, setRecipient] = useState("");
  const [step, setStep] = useState(0); // 0=form, 1=l1 sent, 2=ready

  const tokenData = tokenById(token);

  // Sub-6b 2.8 deviation: SDK bridge.deposit is currently reserved (throws BridgeError).
  // The CLI / scripts/testnet-sub5b-bridge.ts is canonical for L1 deposits.
  // When the SDK ships its own deposit impl this call will work; for now it
  // surfaces a clear error to the user.
  const depositMut = useMutation({
    mutationFn: async (input: { token: string; amount: bigint; isPrivate: boolean }) => {
      if (!client) throw new Error("Not connected");
      return await client.bridge.deposit({
        token: input.token,
        amount: input.amount,
        isPrivate: input.isPrivate,
      });
    },
    onSuccess: (result) => {
      addLocalPendingClaim({
        token,
        amount: parseAmount(amount, 6).toString(),
        secret: result.secret ?? "",
        secretHash: result.secretHash ?? "",
        messageIndex: result.messageIndex.toString(),
        isPrivate: visibility === "private",
        createdAt: Date.now(),
      });
      setStep(2);
      pushToast({ kind: "ok", text: `Deposit submitted: L1 tx ${String(result.l1TxHash).slice(0, 10)}…` });
      void qc.invalidateQueries({ queryKey: ["pendingClaims", session?.sessionId] });
    },
    onError: (e) => {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("not yet implemented")) {
        pushToast({ kind: "warn", text: "SDK bridge.deposit reserved (Sub-6b carry-forward). Use scripts/testnet-sub5b-bridge.ts for L1 deposits." });
      } else {
        pushToast({ kind: "warn", text: msg });
      }
      setStep(0);
    },
  });

  function handleSubmit() {
    setStep(1);
    pushToast({ kind: "info", text: "L1 transaction broadcast — waiting for L1→L2 message" });
    depositMut.mutate({
      token,
      amount: parseAmount(amount, 6),
      isPrivate: visibility === "private",
    });
  }

  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 320px", gap: 20 }}>

      <div className="q-card" style={{ display: "flex", flexDirection: "column", gap: 16 }}>

        {/* token + amount */}
        <div style={{ display: "grid", gridTemplateColumns: "140px 1fr", gap: 8 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <Eyebrow>Token</Eyebrow>
            <select value={token} onChange={(e) => setToken(e.target.value)} style={{
              height: 48, padding: "0 12px", borderRadius: 6,
              border: "1px solid var(--hairline-strong)", background: "var(--surface)",
              fontFamily: "var(--font-mono)", fontSize: 14, color: "var(--fg)",
              appearance: "none", cursor: "pointer",
            }}>
              {BRIDGE_TOKENS.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
            </select>
          </div>
          <Field
            label="Amount"
            mono
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.00"
            suffix={`L1 bal · ${tokenData.l1Bal}`}
            hint="Click 'Max' to use full L1 balance"
          />
        </div>

        {/* Max button as separate row (Field hint is a string in our atoms typing) */}
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button onClick={() => setAmount(tokenData.l1Bal.replace(/,/g, ""))} style={{
            background: "transparent", border: "none", padding: 0,
            fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg)",
            cursor: "pointer", textDecoration: "underline",
          }}>Max</button>
        </div>

        {/* Recipient */}
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
            <Eyebrow>Recipient</Eyebrow>
            <button onClick={() => setAdvanced(!advanced)} style={{ background: "transparent", border: "none", padding: 0, fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-muted)", cursor: "pointer", textDecoration: "underline" }}>
              {advanced ? "Use current wallet" : "Send to…"}
            </button>
          </div>
          {!advanced ? (
            <div style={{
              height: 48, padding: "0 14px", borderRadius: 6,
              border: "1px solid var(--hairline)", background: "var(--bg-alt)",
              display: "flex", alignItems: "center", gap: 10,
            }}>
              <Dot kind="private" size={8} />
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--fg-muted)" }}>child-0 ·</span>
              <AddressMono value="0x7c5fA12e8B3D4f9aC1e29bd071E4a7e123a456b8" />
            </div>
          ) : (
            <Field mono value={recipient} onChange={(e) => setRecipient(e.target.value)} placeholder="0x…" />
          )}
        </div>

        {/* Privacy mode */}
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <Eyebrow>Privacy mode</Eyebrow>
            <Tooltip body="Private deposits use a secret hash; only you can claim them on L2. Public deposits go directly to recipient and are linkable to your L1 address.">
              <i data-lucide="help-circle" style={{ width: 12, height: 12, color: "var(--fg-muted)", strokeWidth: 1.5 } as CSSProperties}></i>
            </Tooltip>
          </div>
          <Segmented
            value={visibility}
            onChange={(v) => setVisibility(v as "private" | "public")}
            fullWidth
            size="lg"
            options={[
              { id: "private", label: "Private", dot: "private", activeBg: "var(--aztec-ink)", activeFg: "var(--aztec-parchment)" },
              { id: "public",  label: "Public",  dot: "public",  activeBg: "var(--surface)",  activeFg: "var(--fg)" },
            ]}
          />
        </div>

        {/* Submit / progress */}
        {step === 0 && (
          <PillButton size="lg" fullWidth variant="primary" onClick={handleSubmit}
            disabled={!amount || depositMut.isPending} rightIcon="arrow-right">
            {depositMut.isPending ? "Submitting…" : `Bridge ${amount || "0"} ${token} to Aztec`}
          </PillButton>
        )}
        {step === 1 && (
          <div style={{
            background: "rgba(212,162,74,0.08)",
            border: "1px solid rgba(212,162,74,0.4)",
            borderRadius: 6, padding: "14px 16px",
            display: "flex", alignItems: "center", gap: 12,
          }}>
            <Dot kind="proving" size={14} />
            <div style={{ flex: 1 }}>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--fg)" }}>Waiting for L1→L2 message</div>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-muted)", marginTop: 2 }}>~4-15 min · auto-polling every 30s</div>
            </div>
            <div style={{ height: 4, width: 120, background: "var(--hairline)", borderRadius: 2, overflow: "hidden" }}>
              <div style={{ height: "100%", width: "65%", background: "var(--proving)", transition: "width 1s linear" }} />
            </div>
          </div>
        )}
        {step === 2 && (
          <div style={{
            background: "rgba(13,152,118,0.06)",
            border: "1px solid rgba(13,152,118,0.4)",
            borderRadius: 6, padding: "14px 16px",
            display: "flex", alignItems: "center", gap: 12,
          }}>
            <i data-lucide="check-circle" style={{ width: 18, height: 18, color: "#0d9876", strokeWidth: 1.5 } as CSSProperties}></i>
            <div style={{ flex: 1 }}>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--fg)" }}>Ready to claim on L2</div>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-muted)", marginTop: 2 }}>Switch to the Claim tab to finalize.</div>
            </div>
            <PillButton size="sm" variant="ink" onClick={() => { setStep(0); setAmount(""); }}>Reset</PillButton>
          </div>
        )}
      </div>

      {/* sidebar */}
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <div className="q-card q-card-tight">
          <Eyebrow style={{ marginBottom: 12 }}>Balances · {token}</Eyebrow>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <BalanceLine kind="public" label="L1 · Sepolia" amount={tokenData.l1Bal} token={token} />
            <BalanceLine kind="private" label="L2 · private" amount={tokenData.priv} token={`a${token}`} />
            <BalanceLine kind="public" label="L2 · public" amount={tokenData.pub} token={`a${token}`} />
          </div>
        </div>
        <div className="q-card q-card-tight">
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
            <i data-lucide="info" style={{ width: 12, height: 12, color: "var(--fg-muted)", strokeWidth: 1.5 } as CSSProperties}></i>
            <Eyebrow>Bridge latency</Eyebrow>
          </div>
          <div style={{ fontFamily: "var(--font-body)", fontSize: 12, color: "var(--fg-muted)", lineHeight: 1.5 }}>
            L1→L2: ~4–15 min<br />
            L2→L1: ~30 min after epoch finalizes
          </div>
        </div>
      </div>
    </div>
  );
}

/* ============ CLAIM ============ */
function ClaimTab({ pushToast }: { pushToast: PushToast }) {
  const client = useQuetzalClient();
  const { session } = useClientContext();
  const qc = useQueryClient();

  // Pending claims are tracked in localStorage (SDK has no getPendingClaims() API).
  const pendingClaimsQ = useQuery({
    queryKey: ["pendingClaims", session?.sessionId],
    queryFn: () => loadLocalPendingClaims(),
    refetchInterval: false,
  });

  const claimMut = useMutation({
    mutationFn: async (input: { token: string; amount: bigint; isPrivate: boolean; secret: string; messageIndex: string }) => {
      if (!client) throw new Error("Not connected");
      return await client.bridge.claim({
        token: input.token,
        amount: input.amount,
        isPrivate: input.isPrivate,
        secret: input.secret,
        messageIndex: input.messageIndex,
      });
    },
    onSuccess: (result, vars) => {
      removeLocalPendingClaim(vars.secret);
      void qc.invalidateQueries({ queryKey: ["pendingClaims", session?.sessionId] });
      pushToast({ kind: "ok", text: `Claimed on L2: ${String(result.l2TxHash).slice(0, 10)}…` });
    },
    onError: (e) => pushToast({ kind: "warn", text: e instanceof Error ? e.message : "Claim failed" }),
  });

  const claims = pendingClaimsQ.data ?? [];

  return (
    <div className="q-card" style={{ padding: 0, overflow: "hidden" }}>
      <div style={{ padding: "18px 20px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <h4 style={{ fontFamily: "var(--font-serif)", fontWeight: 400, fontSize: 18 }}>Pending deposits</h4>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-muted)" }}>{claims.length} pending</span>
      </div>
      <Hairline />
      {claims.length === 0 ? (
        <div style={{ padding: 60, textAlign: "center" }}>
          <div style={{ fontFamily: "var(--font-serif)", fontSize: 15, color: "var(--fg-muted)" }}>No pending deposits.</div>
        </div>
      ) : (
        claims.map(c => (
          <div key={c.secret} style={{
            display: "grid", gridTemplateColumns: "auto 1fr 1fr 80px 120px", gap: 16,
            alignItems: "center", padding: "16px 20px",
            borderBottom: "1px solid var(--hairline)",
          }}>
            <TokenGlyph token={c.token} size={28} />
            <div>
              <div data-mono style={{ fontFamily: "var(--font-mono)", fontSize: 16, fontWeight: 500 }}>{c.amount} <span style={{ color: "var(--fg-muted)" }}>{c.token}</span></div>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-muted)", marginTop: 2 }}>
                {Math.round((Date.now() - c.createdAt) / 60000)} min ago
              </div>
            </div>
            <div>
              <Eyebrow style={{ marginBottom: 2 }}>Secret</Eyebrow>
              <AddressMono value={c.secret} />
            </div>
            <div>
              <Badge tone="filled">Ready</Badge>
            </div>
            <div style={{ textAlign: "right" }}>
              <PillButton
                size="sm"
                variant="primary"
                disabled={claimMut.isPending}
                onClick={() => claimMut.mutate({
                  token: c.token,
                  amount: BigInt(c.amount),
                  isPrivate: c.isPrivate,
                  secret: c.secret,
                  messageIndex: c.messageIndex,
                })}
                rightIcon="check"
              >
                {claimMut.isPending ? "Claiming…" : "Claim"}
              </PillButton>
            </div>
          </div>
        ))
      )}
    </div>
  );
}

/* ============ EXIT ============ */
interface ExitAdvisory {
  classification: "natural" | "round_unit" | "round_cent";
  suggested?: string;
}

function ExitTab({ pushToast }: { pushToast: PushToast }) {
  const client = useQuetzalClient();
  const { session } = useClientContext();
  const qc = useQueryClient();

  const [token, setToken] = useState("USDC");
  const [amount, setAmount] = useState("");
  const [recipient, setRecipient] = useState("0x9Aa12B3C4d5E6f7890aB1c2D3e4F5067890aBcDe");
  const [splitInto, setSplitInto] = useState(1);
  const [interval, setIntervalDays] = useState(7);
  const [ackRound, setAckRound] = useState(false);
  const [ackDelay, setAckDelay] = useState(false);

  const advisory: ExitAdvisory = useMemo(() => {
    if (!amount) return { classification: "natural" };
    const n = parseFloat(amount.replace(/,/g, ""));
    if (isNaN(n)) return { classification: "natural" };
    if (/^\d+$/.test(String(n))) return { classification: "round_unit", suggested: (n + 0.073).toFixed(3) };
    if (/^\d+\.00$/.test(String(n.toFixed(2))) && n >= 100) return { classification: "round_cent", suggested: (n + 0.073).toFixed(3) };
    return { classification: "natural" };
  }, [amount]);

  const parsed = parseFloat(amount.replace(/,/g, ""));
  const showRoundTrip = !isNaN(parsed) && parsed >= 2400 && parsed <= 2600;

  const exitMut = useMutation({
    mutationFn: async (input: { token: string; amount: bigint; l1Recipient: string; splitInto: number; intervalDays: number; ackRound: boolean; ackDelay: boolean }) => {
      if (!client) throw new Error("Not connected");
      return await client.bridge.exit({
        token: input.token,
        amount: input.amount,
        l1Recipient: input.l1Recipient,
        splitInto: input.splitInto > 1 ? input.splitInto : undefined,
        intervalDays: input.splitInto > 1 ? input.intervalDays : undefined,
        ackRound: input.ackRound,
        ackDelay: input.ackDelay,
      });
    },
    onSuccess: (result) => {
      void qc.invalidateQueries({ queryKey: ["scheduledExits", session?.sessionId] });
      if ("scheduledExits" in result) {
        pushToast({ kind: "ok", text: `${(result as { scheduledExits: unknown[] }).scheduledExits.length} exits scheduled.` });
      } else {
        pushToast({ kind: "ok", text: `Exit submitted: L2 tx ${String((result as { l2TxHash: unknown }).l2TxHash).slice(0, 10)}…` });
      }
      setAmount("");
    },
    onError: (e) => pushToast({ kind: "warn", text: e instanceof Error ? e.message : "Exit failed" }),
  });

  const canSubmit = !!amount &&
    (advisory.classification === "natural" || ackRound) &&
    (!showRoundTrip || ackDelay) &&
    !exitMut.isPending;

  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 320px", gap: 20 }}>
      <div className="q-card" style={{ display: "flex", flexDirection: "column", gap: 16 }}>

        {/* Token + amount + recipient */}
        <div style={{ display: "grid", gridTemplateColumns: "140px 1fr", gap: 8 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <Eyebrow>Token</Eyebrow>
            <select value={token} onChange={(e) => setToken(e.target.value)} style={{
              height: 48, padding: "0 12px", borderRadius: 6,
              border: "1px solid var(--hairline-strong)", background: "var(--surface)",
              fontFamily: "var(--font-mono)", fontSize: 14, color: "var(--fg)",
              appearance: "none", cursor: "pointer",
            }}>
              {BRIDGE_TOKENS.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
            </select>
          </div>
          <Field label="Amount" mono value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" suffix={`a${token}`} />
        </div>

        <Field label="L1 recipient" mono value={recipient} onChange={(e) => setRecipient(e.target.value)} placeholder="0x…" />

        {/* Advisories */}
        <RoundAmountAdvisory
          classification={advisory.classification}
          suggested={advisory.suggested}
          acknowledged={ackRound}
          onAck={setAckRound}
          onApply={() => { if (advisory.suggested) setAmount(advisory.suggested); }}
        />

        {showRoundTrip && (
          <div style={{
            background: "rgba(255,26,26,0.04)",
            border: "1px solid rgba(255,26,26,0.35)",
            borderRadius: 6, padding: "12px 14px",
            display: "flex", flexDirection: "column", gap: 8,
          }}>
            <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
              <i data-lucide="link" style={{ width: 14, height: 14, color: "var(--aztec-vermillion)", strokeWidth: 1.5, marginTop: 2, flexShrink: 0 } as CSSProperties}></i>
              <div style={{ flex: 1 }}>
                <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--aztec-vermillion)", fontWeight: 600 }}>
                  Round-trip risk
                </div>
                <div style={{ fontFamily: "var(--font-body)", fontSize: 12, color: "var(--fg)", marginTop: 4, lineHeight: 1.45 }}>
                  This exit is within 5% of a recent L1 deposit you made (2,500 USDC, 4 days ago). Pattern-matching observers may link the two and de-anonymize your L2 activity.
                  &nbsp;<a href="#" onClick={(e) => e.preventDefault()} style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-muted)" }}>Why does this matter? →</a>
                </div>
              </div>
            </div>
            <label style={{ display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer", fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-muted)" }}>
              <input type="checkbox" checked={ackDelay} onChange={(e) => setAckDelay(e.target.checked)} style={{ accentColor: "var(--aztec-vermillion)" }} />
              I understand the linkage risk. Proceed anyway.
            </label>
          </div>
        )}

        {/* Multi-hop split */}
        <div style={{
          background: "var(--bg-alt)", border: "1px dashed var(--hairline-strong)", borderRadius: 8, padding: 16,
          display: "flex", flexDirection: "column", gap: 12,
        }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <i data-lucide="split" style={{ width: 14, height: 14, color: "var(--priv)", strokeWidth: 1.5 } as CSSProperties}></i>
              <Eyebrow>Multi-hop split</Eyebrow>
            </div>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-muted)" }}>
              {splitInto === 1 ? "single withdrawal" : `${splitInto} parts · every ${interval}d`}
            </span>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <Eyebrow style={{ width: 56 }}>Split</Eyebrow>
              <input type="range" min="1" max="20" value={splitInto} onChange={(e) => setSplitInto(parseInt(e.target.value, 10))}
                     style={{ flex: 1, accentColor: "var(--aztec-ink)" }} />
              <span data-mono style={{ fontFamily: "var(--font-mono)", fontSize: 13, width: 20, textAlign: "right" }}>{splitInto}</span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <Eyebrow style={{ width: 64 }}>Interval</Eyebrow>
              <input type="range" min="1" max="90" value={interval} onChange={(e) => setIntervalDays(parseInt(e.target.value, 10))}
                     style={{ flex: 1, accentColor: "var(--aztec-ink)" }} disabled={splitInto === 1} />
              <span data-mono style={{ fontFamily: "var(--font-mono)", fontSize: 13, width: 40, textAlign: "right" }}>{interval}d</span>
            </div>
          </div>
          {splitInto > 1 && (
            <ScheduleTimeline parts={splitInto} interval={interval} amount={amount || "0"} token={token} />
          )}
        </div>

        <PillButton size="lg" fullWidth variant="primary" onClick={() => {
          exitMut.mutate({
            token,
            amount: parseAmount(amount, 6),
            l1Recipient: recipient,
            splitInto,
            intervalDays: interval,
            ackRound,
            ackDelay,
          });
        }} disabled={!canSubmit} rightIcon="arrow-right">
          {exitMut.isPending
            ? "Submitting…"
            : splitInto === 1 ? `Exit ${amount || "0"} ${token} to L1` : `Schedule ${splitInto}-part exit`}
        </PillButton>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <div className="q-card q-card-tight">
          <Eyebrow style={{ marginBottom: 12 }}>Balances · {token}</Eyebrow>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <BalanceLine kind="private" label="L2 · private" amount={tokenById(token).priv} token={`a${token}`} />
            <BalanceLine kind="public" label="L2 · public" amount={tokenById(token).pub} token={`a${token}`} />
            <BalanceLine kind="public" label="L1 · Sepolia" amount={tokenById(token).l1Bal} token={token} />
          </div>
        </div>
        <div className="q-card q-card-tight" style={{ background: "var(--bg-deep)", borderColor: "rgba(242,238,225,0.10)" }}>
          <div style={{ color: "var(--fg-on-deep)" }}>
            <Eyebrow style={{ color: "var(--fg-on-deep-mu)", marginBottom: 8 }}>Why split?</Eyebrow>
            <p style={{ fontFamily: "var(--font-body)", fontSize: 12, color: "var(--fg-on-deep)", lineHeight: 1.5, margin: 0, maxWidth: "100%" }}>
              Withdrawing in N parts at irregular intervals breaks timing correlation with your L1 deposit history. The cost is held-up capital for the duration.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

interface ScheduleTimelineProps {
  parts: number;
  interval: number;
  amount: string;
  token: string;
}
function ScheduleTimeline({ parts, interval, amount, token }: ScheduleTimelineProps) {
  const per = (parseFloat(String(amount).replace(/,/g, "")) / parts).toFixed(2);
  return (
    <div>
      <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--fg-muted)", marginBottom: 8 }}>
        Schedule preview
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
        {Array.from({ length: parts }).map((_, i) => (
          <Fragment key={i}>
            <div style={{ flex: 1, position: "relative" }}>
              <div style={{
                height: 28,
                background: i === 0 ? "var(--aztec-ink)" : "var(--surface-card)",
                border: `1px solid ${i === 0 ? "var(--aztec-ink)" : "var(--hairline-strong)"}`,
                borderRadius: 4,
                display: "flex", alignItems: "center", justifyContent: "center",
                fontFamily: "var(--font-mono)", fontSize: 10, fontWeight: 500,
                color: i === 0 ? "var(--aztec-parchment)" : "var(--fg)",
              }}>
                {per} {token}
              </div>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--fg-subtle)", marginTop: 4, textAlign: "center" }}>
                {i === 0 ? "now" : `+${i * interval}d`}
              </div>
            </div>
            {i < parts - 1 && <div style={{ width: 6, height: 1, background: "var(--hairline-strong)" }} />}
          </Fragment>
        ))}
      </div>
    </div>
  );
}

function ScheduledExits() {
  const { session } = useClientContext();

  // SDK's loadBridgeState() uses Node fs (CLI-only) — see loadBrowserBridgeState() above.
  // TODO(sdk-browser-state): replace with a browser-portable SDK bridge-state backend.
  const scheduledExitsQ = useQuery({
    queryKey: ["scheduledExits", session?.sessionId],
    queryFn: () => loadBrowserBridgeState().scheduledExits,
    refetchInterval: false,
  });

  const exits = scheduledExitsQ.data ?? [];

  return (
    <div className="q-card" style={{ padding: 0, overflow: "hidden" }}>
      <div style={{ padding: "16px 20px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h4 style={{ fontFamily: "var(--font-serif)", fontSize: 18, fontWeight: 400 }}>Scheduled exits</h4>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-muted)", cursor: "pointer" }}>
            <input type="checkbox" defaultChecked style={{ accentColor: "var(--aztec-ink)" }} /> Auto-tick
          </label>
          <PillButton size="sm" variant="ghost" leftIcon="play">Tick now</PillButton>
        </div>
      </div>
      <Hairline />
      {exits.length === 0 ? (
        <div style={{ padding: 60, textAlign: "center" }}>
          <div style={{ fontFamily: "var(--font-serif)", fontSize: 15, color: "var(--fg-muted)" }}>No scheduled exits.</div>
        </div>
      ) : (
        <>
          <div style={{
            display: "grid", gridTemplateColumns: "10px 70px 100px 1fr 1fr 100px 100px",
            gap: 12, padding: "8px 20px", background: "var(--bg-alt)",
          }}>
            <span></span>
            <span className="q-eyebrow">Part</span>
            <span className="q-eyebrow">Token</span>
            <span className="q-eyebrow">Amount</span>
            <span className="q-eyebrow">Recipient</span>
            <span className="q-eyebrow">Due</span>
            <span className="q-eyebrow" style={{ textAlign: "right" }}>Status</span>
          </div>
          {exits.map(e => (
            <div key={e.id} style={{
              display: "grid", gridTemplateColumns: "10px 70px 100px 1fr 1fr 100px 100px",
              gap: 12, padding: "12px 20px", alignItems: "center",
              borderBottom: "1px solid var(--hairline)",
            }}>
              <Dot kind={e.status === "submitted" ? "filled" : "pending"} size={8} />
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>{e.part}</span>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <TokenGlyph token={e.token} size={16} />
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>{e.token}</span>
              </div>
              <span data-mono style={{ fontFamily: "var(--font-mono)", fontSize: 13 }}>{e.amount}</span>
              <AddressMono value={e.recipient} />
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-muted)" }}>{e.scheduled}</span>
              <div style={{ textAlign: "right" }}>
                <Badge tone={e.status === "submitted" ? "filled" : "default"}>{e.status}</Badge>
              </div>
            </div>
          ))}
        </>
      )}
    </div>
  );
}

interface BalanceLineProps {
  kind: "private" | "public";
  label: string;
  amount: string;
  token: string;
}
function BalanceLine({ kind, label, amount, token }: BalanceLineProps) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <Dot kind={kind} size={8} />
      <div style={{ flex: 1, fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--fg-muted)" }}>{label}</div>
      <div data-mono style={{ fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--fg)" }}>{amount} <span style={{ color: "var(--fg-muted)" }}>{token}</span></div>
    </div>
  );
}
