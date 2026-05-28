// Onboarding Step 3 orchestration hook. Splits the React state machine from
// the UI so the state transitions can be unit-tested without rendering.
import { useCallback, useReducer, useRef } from "react";
import { deriveChildren } from "./derive-children";
import type { DripResult } from "./faucet-client";
import { dripFaucet as defaultDripFaucet } from "./faucet-client";
import type { ClaimDeployResult, ClaimDeployPhase } from "./claim-deploy";
import { claimAndDeploy as defaultClaimAndDeploy } from "./claim-deploy";
import { saveSession as defaultSaveSession, type PersistedSession } from "./persistence";
import { defaultDeriveAddress } from "./derive-address";

export type ChildState =
  | { state: "pending" }
  | { state: "dripping" }
  | { state: "claiming"; phase: ClaimDeployPhase }
  | { state: "done"; deployedAddress: `0x${string}`; dripTx: DripResult; claim: ClaimDeployResult }
  | { state: "error"; error: string };

export type OverallPhase = "idle" | "running" | "done" | "partial-error";

export interface OnboardingStep3Deps {
  /**
   * Derives the deterministic L2 address from a child schnorr secret.
   * Production: SDK-based (EmbeddedWallet + createSchnorrAccount + getAddress).
   * Tests: mock with `async (secret) => secret as 0x...` for fixture simplicity.
   */
  deriveAddress: (secret: `0x${string}`, nodeUrl: string) => Promise<`0x${string}`>;
  dripFaucet: (opts: {
    faucetUrl: string;
    address: `0x${string}`;
    bypassKey: string;
    signal?: AbortSignal;
  }) => Promise<DripResult>;
  claimAndDeploy: (opts: {
    nodeUrl: string;
    childSecretHex: `0x${string}`;
    claimData: DripResult["claimData"];
    signal?: AbortSignal;
    onProgress?: (phase: ClaimDeployPhase) => void;
  }) => Promise<ClaimDeployResult>;
  saveSession: (s: PersistedSession) => void;
  config: { faucetUrl: string; bypassKey: string; nodeUrl: string };
}

interface State {
  phase: OverallPhase;
  children: Array<ChildState & { index: number; secret: `0x${string}` }>;
}

type Action =
  | { type: "init"; secrets: Array<{ index: number; secret: `0x${string}` }> }
  | { type: "child-state"; index: number; state: ChildState }
  | { type: "phase"; phase: OverallPhase };

function reducer(s: State, a: Action): State {
  switch (a.type) {
    case "init":
      return {
        phase: "running",
        children: a.secrets.map((c) => ({ ...c, state: "pending" })),
      };
    case "child-state": {
      const next = s.children.map((c, i) =>
        i === a.index ? { ...c, ...a.state } : c
      );
      return { ...s, children: next };
    }
    case "phase":
      return { ...s, phase: a.phase };
  }
}

export interface OnboardingStep3Hook {
  phase: OverallPhase;
  children: State["children"];
  start: () => void;
  retry: (index: number) => void;
}

export function useOnboardingStep3(opts: {
  masterSecret: string;
  n: number;
  deps?: Partial<OnboardingStep3Deps> & Pick<OnboardingStep3Deps, "config">;
}): OnboardingStep3Hook {
  const deps: OnboardingStep3Deps = {
    deriveAddress: opts.deps?.deriveAddress ?? defaultDeriveAddress,
    dripFaucet: opts.deps?.dripFaucet ?? defaultDripFaucet,
    claimAndDeploy: opts.deps?.claimAndDeploy ?? defaultClaimAndDeploy,
    saveSession: opts.deps?.saveSession ?? defaultSaveSession,
    config: opts.deps!.config,
  };

  const [state, dispatch] = useReducer(reducer, {
    phase: "idle",
    children: [],
  });

  const aborters = useRef<Map<number, AbortController>>(new Map());

  const runChild = useCallback(async (
    index: number,
    secret: `0x${string}`,
  ): Promise<{ ok: true; deployed: `0x${string}` } | { ok: false; error: string }> => {
    const ctrl = new AbortController();
    aborters.current.set(index, ctrl);
    try {
      dispatch({ type: "child-state", index, state: { state: "dripping" } });
      const l2Address = await deps.deriveAddress(secret, deps.config.nodeUrl);
      const drip = await deps.dripFaucet({
        faucetUrl: deps.config.faucetUrl,
        address: l2Address,
        bypassKey: deps.config.bypassKey,
        signal: ctrl.signal,
      });
      dispatch({ type: "child-state", index, state: { state: "claiming", phase: "claiming" } });
      const claim = await deps.claimAndDeploy({
        nodeUrl: deps.config.nodeUrl,
        childSecretHex: secret,
        claimData: drip.claimData,
        signal: ctrl.signal,
        onProgress: (phase) =>
          dispatch({ type: "child-state", index, state: { state: "claiming", phase } }),
      });
      dispatch({
        type: "child-state",
        index,
        state: { state: "done", deployedAddress: claim.deployedAddress, dripTx: drip, claim },
      });
      return { ok: true, deployed: claim.deployedAddress };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      dispatch({ type: "child-state", index, state: { state: "error", error: msg } });
      return { ok: false, error: msg };
    }
  }, [deps]);

  const finalize = useCallback((children: State["children"]) => {
    const allDone = children.every((c) => c.state === "done");
    if (allDone) {
      const deployedAddresses = children
        .filter((c): c is typeof c & { state: "done"; deployedAddress: `0x${string}` } => c.state === "done")
        .map((c) => c.deployedAddress);
      deps.saveSession({
        schemaVersion: 1,
        masterSecret: opts.masterSecret as `0x${string}`,
        poolSize: opts.n,
        network: "alpha-testnet",
        deployedAddresses,
        onboardedAt: Date.now(),
      });
      dispatch({ type: "phase", phase: "done" });
    } else {
      dispatch({ type: "phase", phase: "partial-error" });
    }
  }, [deps, opts.masterSecret, opts.n]);

  const start = useCallback(() => {
    const secrets = deriveChildren(opts.masterSecret, opts.n).map((c) => ({
      index: c.index,
      secret: c.secret,
    }));
    dispatch({ type: "init", secrets });
    Promise.all(secrets.map((s) => runChild(s.index, s.secret))).then(() => {
      // No-op; the in-render settle-check below transitions to done/partial-error.
    });
  }, [opts.masterSecret, opts.n, runChild]);

  // Effect-like guard: when all children settle, run finalize.
  if (state.phase === "running") {
    const settled = state.children.length === opts.n &&
      state.children.every((c) => c.state === "done" || c.state === "error");
    if (settled) {
      queueMicrotask(() => finalize(state.children));
    }
  }

  const retry = useCallback((index: number) => {
    const child = state.children[index];
    if (!child) return;
    dispatch({ type: "phase", phase: "running" });
    runChild(index, child.secret).then(() => {
      // The settle-check above re-fires after re-render.
    });
  }, [state.children, runChild]);

  return {
    phase: state.phase,
    children: state.children,
    start,
    retry,
  };
}
