// ClaimTab — claim pending L1→L2 messages on L2.

import { useMutation, useQuery, useQueries, useQueryClient } from "@tanstack/react-query";
import { useQuetzalClient, useClientContext } from "../../sdk/client-context.js";
import { Eyebrow, Hairline, Badge, PillButton, AddressMono } from "../../components/atoms.js";
import { TokenGlyph } from "../../components/screens-shared.js";
import {
  loadPendingClaims,
  removePendingClaim,
} from "./pending-claims.js";
import { type PushToast } from "./helpers.js";

export function ClaimTab({ pushToast }: { pushToast: PushToast }) {
  const client = useQuetzalClient();
  const { session } = useClientContext();
  const qc = useQueryClient();

  // Pending claims are tracked in localStorage (SDK has no getPendingClaims() API).
  // See ./bridge/pending-claims.ts (Sub-7c C1).
  const pendingClaimsQ = useQuery({
    queryKey: ["pendingClaims", session?.sessionId],
    queryFn: () => loadPendingClaims(),
    refetchInterval: false,
  });

  const claims = pendingClaimsQ.data ?? [];

  // Sub-7c Task 12 (D1): poll getMessageReady() every 30s per pending claim.
  // Returns true once the sequencer has finalised the L1→L2 message into the
  // inbox tree, at which point claim_{public,private} on L2 will succeed.
  //
  // messageHash is parsed from the L1Inbox.MessageSent event during deposit
  // (BridgeApi.deposit, Sub-7c Task 12 Option B). For older pending claims
  // persisted before this code shipped (messageHash="") polling is skipped
  // and the button falls back to enabled — caller can still claim manually.
  const readyQueries = useQueries({
    queries: claims.map((claim) => ({
      queryKey: ["bridge", "msg-ready", claim.messageIndex],
      queryFn: async (): Promise<boolean> => {
        if (!client) return false;
        if (!claim.messageHash) return false;
        try {
          return await client.bridge.getMessageReady(claim.messageHash as `0x${string}`);
        } catch {
          // Malformed messageHash (legacy/corrupt persisted row): treat as
          // not-ready, but don't propagate the error — the row stays visible
          // with a Waiting label instead of flipping to red error state.
          // Polling is a read path, not a user-initiated write.
          return false;
        }
      },
      enabled: !!client && !!claim.messageHash,
      refetchInterval: 30_000,
      staleTime: 25_000,
    })),
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
      removePendingClaim(vars.messageIndex);
      void qc.invalidateQueries({ queryKey: ["pendingClaims", session?.sessionId] });
      pushToast({ kind: "ok", text: `Claimed on L2: ${String(result.l2TxHash).slice(0, 10)}…` });
    },
    onError: (e) => pushToast({ kind: "warn", text: e instanceof Error ? e.message : "Claim failed" }),
  });

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
        claims.map((c, i) => {
          const readyQ = readyQueries[i];
          // Treat "no messageHash" (legacy claim) as ready=true so the row
          // remains actionable — fall back to user-driven retry on revert.
          const isReady = !c.messageHash || readyQ?.data === true;
          const isPolling = !!c.messageHash && readyQ?.isFetching && readyQ.data !== true;
          // Per-row gating: claimMut is shared across all rows, but only THIS
          // row's claim should disable its own button. Without this, a claim
          // in flight for row A would disable every other ready row too.
          const isThisRowPending =
            claimMut.isPending && claimMut.variables?.messageIndex === c.messageIndex;
          return (
          <div key={c.messageIndex} style={{
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
              {isReady ? (
                <Badge tone="filled">Ready</Badge>
              ) : (
                <Badge tone="warn">{isPolling ? "Polling" : "Waiting"}</Badge>
              )}
            </div>
            <div style={{ textAlign: "right" }}>
              <PillButton
                size="sm"
                variant="primary"
                disabled={isThisRowPending || !isReady}
                onClick={() => claimMut.mutate({
                  token: c.token,
                  amount: BigInt(c.amount),
                  isPrivate: c.isPrivate,
                  secret: c.secret,
                  messageIndex: c.messageIndex,
                })}
                rightIcon={isReady ? "check" : "clock"}
              >
                {isThisRowPending ? "Claiming…" : isReady ? "Claim" : "⏳ Waiting"}
              </PillButton>
            </div>
          </div>
          );
        })
      )}
    </div>
  );
}
