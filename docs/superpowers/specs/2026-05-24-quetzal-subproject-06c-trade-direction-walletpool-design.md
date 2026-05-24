# Sub-project 6c: Trade-Direction Canonicalization + WalletPool — Design

**Date:** 2026-05-24
**Status:** Design (post-brainstorm; pending user spec review)
**Parent:** Sub-6 series (privacy + operability). Closes 2 of the 3 remaining Sub-6 brainstorm items; defers #6 (aggregator-side metadata reveals via threshold multi-sig) to Sub-6d / Sub-7.

## Goal

Close two orthogonal privacy gaps surfaced by the original Sub-6 brainstorm:

1. **#2 trade-direction fingerprinting** — `submit_order(path)` currently leaks side via path ordering (sell = `[input, output]`, buy = reverse). An on-chain observer can read direction from path order even though side bool itself is private.
2. **#5 PXE tagging-window stall** — Aztec 4.2.1 PXE caps ~20 unfinalised private submits per wallet. Sub-6a bulk submit (K=5) puts a maker at the ceiling after 4 batches. A frontend serving an active maker hits a hard stall.

Both are user-visible: privacy regression (#2) and capacity (#5). Both are tractable in a 13-task plan.

## Out of scope

- **#6 aggregator-side metadata reveals** — threshold T-of-N multi-sig OR rotating aggregators. Independent ~20-30 task work; deferred to Sub-6d.
- **Escrow-side direction leak** — `Token.transfer_in_to_public(orderbook, amount_in)` still reveals which token moves. Fixing requires per-token shielded escrow pool. Out of #2 cheap-fix scope; deferred.
- **Auto-fund per-wallet fee-juice in WalletPool** — operator responsibility (faucet drip on testnet, self-fund on mainnet). SDK doesn't sponsor.
- **HD-wallet recovery UI** — `masterSecret` regeneration policy is the integrator's concern.

## Constraints

- Privacy-maximalism: maintained (no new public state, no weakening existing private-by-default flows).
- Subagent model policy: Sonnet and Opus only; never Haiku.
- Working branch: `main` (no worktrees).
- PreToolUse security hook: rejects shell-injecting subprocess patterns; SDK + scripts use `spawn`.

## Phase A — Trade-direction canonicalization (#2)

### Goal

Path order no longer leaks side. Circuit enforces canonical (lex-sorted endpoints); SDK transparently converts user input.

### A1 — Noir circuit assertion

**Files:**
- Modify: `contracts/orderbook/src/main.nr` (in `_submit_one_order_internal`, after path-length validation, before escrow)

Add (exact Field-comparison syntax adapts to the existing codebase convention; Sub-6a A2 + Sub-4 `canon()` helpers use a documented pattern -- implementer copies it):
```rust
// Sub-6c A1: canonical path enforcement.
// Endpoints lex-sorted: path[0] < path[path_len-1]. Direction is encoded
// privately in `side` bool; on-chain path no longer leaks direction.
let lo = path[0];
let hi = path[(path_len - 1) as u32];
// Noir Field comparison: cast to u128 (canonical convention from Sub-6a A2
// `Fields cannot be compared, try casting to an integer first` fix); top 2 bits
// truncated -- safe for AztecAddress comparison since addresses are bounded.
assert((lo as u128) < (hi as u128), "path must be canonical (lex-sorted endpoints)");
```

3-hop case (`path = [a, b, c]`): only endpoints a vs c are sorted. Middle hop `b` is unconstrained (it's the intermediate pool -- irrelevant to direction).

**Implementer note:** the `as u128` cast loses the high 2 bits of a 254-bit Field. AztecAddress is bounded < 2^254 so the cast is order-preserving for the 0..2^126 range that practical addresses fall into. If full Field comparison is needed, the implementer should use the codebase's existing `canon(a, b)` helper pattern (see `scripts/deploy-tokens.ts:62` and `scripts/deploy-sub4-bridge.ts:62`) which uses `a.toBigInt() < b.toBigInt()` on the TS side. For Noir, see if `to_le_bytes` + byte-wise comparison is needed for 256-bit precision -- the implementer plans this in Phase A1 of the plan doc.

### A2 — SDK auto-canonicalization

**Files:**
- Modify: `sdk/src/orders.ts` (extract a `canonicalizePath` helper; call from `placeOrder` + `placeOrderBulk` before submit)

```typescript
export function canonicalizePath(
  side: OrderSide,
  path: string[],
): { side: OrderSide; path: string[] } {
  if (path.length < 2 || path.length > 3) {
    throw new OrderError("INVALID_PATH", `path length must be 2 or 3`);
  }
  const lo = BigInt(path[0]);
  const hi = BigInt(path[path.length - 1]);
  if (lo === hi) {
    throw new OrderError("INVALID_PATH", "path endpoints must differ");
  }
  if (lo < hi) return { side, path };
  // Reverse + flip side
  return {
    side: side === "buy" ? "sell" : "buy",
    path: [...path].reverse(),
  };
}
```

`placeOrder` / `placeOrderBulk` call this before passing to the circuit. Validators (`validatePlaceOrderInput` from 2.5) get a `canonical=true` pre-check option for callers that want to skip the auto-convert.

### A3 — Side semantics post-canonical

Once canonical, side bool refers to direction WRT canonical-sorted path:

- `side: "buy"` (false) → maker pays `path[0]` (canonical low), receives `path[path_len-1]` (canonical high)
- `side: "sell"` (true) → maker pays `path[path_len-1]` (canonical high), receives `path[0]` (canonical low)

Document in `sdk/README.md` Orders section + `docs/frontend-quickstart.md` walkthrough.

Backward compat: existing SDK callers passing `{side, path}` get auto-canonicalized -- same semantic intent, transparent.

### A4 — SDK unit tests

**Files:**
- Create: `sdk/src/orders.canonicalize.test.ts` (~6 tests)

```typescript
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { canonicalizePath } from "./orders.js";
import { OrderError } from "./errors.js";

describe("canonicalizePath", () => {
  test("already-canonical 2-hop unchanged", () => {
    const r = canonicalizePath("sell", ["0x10", "0x20"]);
    assert.equal(r.side, "sell");
    assert.deepEqual(r.path, ["0x10", "0x20"]);
  });

  test("reversed 2-hop flips side + reverses path", () => {
    const r = canonicalizePath("sell", ["0x20", "0x10"]);
    assert.equal(r.side, "buy");
    assert.deepEqual(r.path, ["0x10", "0x20"]);
  });

  test("3-hop endpoints canonical, middle preserved", () => {
    const r = canonicalizePath("buy", ["0x10", "0x99", "0x20"]);
    assert.equal(r.side, "buy");
    assert.deepEqual(r.path, ["0x10", "0x99", "0x20"]);
  });

  test("3-hop reversed endpoints flips + reverses (middle moves with)", () => {
    const r = canonicalizePath("buy", ["0x20", "0x99", "0x10"]);
    assert.equal(r.side, "sell");
    assert.deepEqual(r.path, ["0x10", "0x99", "0x20"]);
  });

  test("equal endpoints throws OrderError", () => {
    assert.throws(
      () => canonicalizePath("buy", ["0x10", "0x10"]),
      OrderError,
    );
  });

  test("round-trip: canonicalize twice = idempotent", () => {
    const once = canonicalizePath("sell", ["0x30", "0x10"]);
    const twice = canonicalizePath(once.side, once.path);
    assert.deepEqual(twice, once);
  });
});
```

### A5 — TXE circuit-enforcement tests

**Files:**
- Modify: `contracts/orderbook/src/test.nr` (~3 new tests)

```rust
// Sub-6c A5: canonical path enforcement
#[test]
unconstrained fn sub6c_canonical_path_accepted() {
  // ... fixture setup ...
  // path = [0x10, 0x20] (canonical) -> submit_order succeeds
}

#[test(should_fail_with = "path must be canonical")]
unconstrained fn sub6c_reversed_path_rejected() {
  // path = [0x20, 0x10] (non-canonical) -> assertion reverts
}

#[test]
unconstrained fn sub6c_3hop_canonical_endpoints_accepted() {
  // path = [0x10, 0x99, 0x20] (endpoints sorted, middle unconstrained) -> succeeds
}
```

### Phase A task count: 5

## Phase B — WalletPool (#5)

### Goal

Frontend / power-user makers can submit far more than 20 unfinalised private txs per maker by distributing across N parallel wallets. Pool transparently round-robins; auto-skips saturated wallets.

### B1 — WalletPool SDK class

**Files:**
- Create: `sdk/src/wallet/pool.ts`
- Modify: `sdk/src/index.ts` (re-export WalletPool)

```typescript
// sdk/src/wallet/pool.ts
import { createHash } from "node:crypto";
import { QuetzalClient } from "../client.js";
import type { NetworkName, NetworkConfig } from "../types.js";
import { ConfigError } from "../errors.js";

export const PXE_TAGGING_CAP = 18;  // 2 below Aztec's ~20 for safety buffer

export interface WalletPoolOptions {
  masterSecret: string;       // hex32 root for HD derivation
  n: number;                  // pool size (recommended 3-5)
  network: NetworkName;
  nodeUrl?: string;
  l1?: NetworkConfig["l1"];
}

interface PoolChild {
  client: QuetzalClient;
  index: number;
  pendingTx: number;
}

export class WalletPool {
  private children: PoolChild[];
  private cursor = 0;

  private constructor(children: PoolChild[]) {
    this.children = children;
  }

  static async fromMaster(opts: WalletPoolOptions): Promise<WalletPool> {
    if (!opts.masterSecret.startsWith("0x") || opts.masterSecret.length !== 66) {
      throw new ConfigError("MISSING_ENV", "masterSecret must be 0x-prefixed hex32");
    }
    if (opts.n < 1 || opts.n > 20) {
      throw new ConfigError("UNKNOWN", `pool size n must be 1..20; got ${opts.n}`);
    }
    const children: PoolChild[] = [];
    for (let i = 0; i < opts.n; i++) {
      const childHex = deriveChildSecret(opts.masterSecret, i);
      const client = await QuetzalClient.connect({
        network: opts.network,
        nodeUrl: opts.nodeUrl,
        account: { type: "schnorr", secret: childHex },
        l1: opts.l1,
      });
      children.push({ client, index: i, pendingTx: 0 });
    }
    return new WalletPool(children);
  }

  get size(): number { return this.children.length; }
  get addresses(): string[] { return this.children.map((c) => c.client.address.toString()); }

  /** Round-robin pick the next non-saturated child. */
  next(): QuetzalClient {
    for (let i = 0; i < this.children.length; i++) {
      const idx = (this.cursor + i) % this.children.length;
      const child = this.children[idx];
      if (child.pendingTx < PXE_TAGGING_CAP) {
        this.cursor = (idx + 1) % this.children.length;
        return this.wrapClient(child);
      }
    }
    throw new Error("WalletPoolExhausted: all N wallets at PXE_TAGGING_CAP; wait for finalization or grow pool");
  }

  /** Sticky-acquire: same tag returns same child across calls. Useful for
   *  related operations (place + claim of same epoch's order). */
  acquireFor(tag: string): QuetzalClient {
    const idx = Number(BigInt("0x" + createHash("sha256").update(tag).digest("hex").slice(0, 16))) % this.children.length;
    return this.wrapClient(this.children[idx]);
  }

  async stop(): Promise<void> {
    await Promise.all(this.children.map((c) => c.client.stop()));
  }

  private wrapClient(child: PoolChild): QuetzalClient {
    // Wrap client.orders.placeOrder etc. to track pendingTx counters.
    // Implementation detail: extend a proxy that intercepts send/wait.
    return child.client;  // placeholder; B2 fills the wrapping
  }
}

function deriveChildSecret(masterHex: string, index: number): string {
  const buf = Buffer.concat([
    Buffer.from(masterHex.slice(2), "hex"),
    Buffer.from(index.toString(16).padStart(8, "0"), "hex"),
  ]);
  const out = createHash("sha256").update(buf).digest("hex");
  // Mask top 2 bits to fit in bn254 modulus
  const masked = (BigInt("0x" + out) & ((1n << 254n) - 1n)).toString(16).padStart(64, "0");
  return "0x" + masked;
}
```

### B2 — Per-wallet pending-tx counter

**Files:**
- Modify: `sdk/src/wallet/pool.ts` (`wrapClient` becomes a Proxy that intercepts `client.orders.*` / `client.bridge.*` send calls + tracks counters)

Pseudocode (the actual proxy wraps the API namespaces):
```typescript
private wrapClient(child: PoolChild): QuetzalClient {
  return new Proxy(child.client, {
    get(target, prop) {
      if (prop === "orders" || prop === "bridge") {
        return new Proxy(target[prop], {
          get(sub, method) {
            const fn = sub[method];
            const methodName = method.toString();
            const isSubmit = methodName.startsWith("place") || methodName === "exit" || methodName === "claim";
            if (typeof fn !== "function" || !isSubmit) {
              return fn?.bind(sub);
            }
            return async (...args: unknown[]) => {
              child.pendingTx++;
              try {
                const result = await fn.apply(sub, args);
                // Schedule decrement on receipt (best-effort)
                if (result?.txHash) {
                  void target.wallet.getTxReceipt?.(result.txHash).finally(() => { child.pendingTx--; });
                } else {
                  child.pendingTx--;
                }
                return result;
              } catch (e) {
                child.pendingTx--;
                throw e;
              }
            };
          },
        });
      }
      return Reflect.get(target, prop);
    },
  });
}
```

The exact wrapping shape adapts to the actual `QuetzalClient` API; the contract is: any tx-emitting call increments before send, decrements on receipt (success or fail).

### B3 — Aggregated reads

**Files:**
- Modify: `sdk/src/wallet/pool.ts`

```typescript
async getAllOrders(): Promise<Array<{ wallet: string; orders: OrderViewModel[] }>> {
  const results = await Promise.all(
    this.children.map(async (c) => ({
      wallet: c.client.address.toString(),
      orders: await c.client.reads.getOrders(),
    })),
  );
  return results;
}

async getAggregatedBalance(token: string): Promise<bigint> {
  const balances = await Promise.all(this.children.map((c) => c.client.reads.getBalance(token)));
  return balances.reduce((acc, b) => acc + b, 0n);
}
```

### B4 — SDK unit tests

**Files:**
- Create: `sdk/src/wallet/pool.test.ts` (~6 tests)

```typescript
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { WalletPool, PXE_TAGGING_CAP } from "./pool.js";
import { ConfigError } from "../errors.js";

describe("WalletPool", () => {
  test("rejects invalid masterSecret format", async () => {
    await assert.rejects(
      () => WalletPool.fromMaster({ masterSecret: "abc", n: 3, network: "alpha-testnet", nodeUrl: "x" }),
      ConfigError,
    );
  });
  test("rejects n out of range", async () => {
    await assert.rejects(
      () => WalletPool.fromMaster({ masterSecret: "0x" + "11".repeat(32), n: 0, network: "alpha-testnet" }),
      ConfigError,
    );
    await assert.rejects(
      () => WalletPool.fromMaster({ masterSecret: "0x" + "11".repeat(32), n: 21, network: "alpha-testnet" }),
      ConfigError,
    );
  });
  // Live derivation tests use a mock QuetzalClient.connect to avoid network
  // (similar pattern as sdk/src/client.test.ts); 4 additional tests for
  // deterministic derivation, round-robin cursor advancement, acquireFor
  // tag stability, and WalletPoolExhausted on all-saturated.
});
```

### B5 — `docs/wallet-pool.md`

**Files:**
- Create: `docs/wallet-pool.md` (~80 lines)

Sections:
- Why a pool (PXE tagging-window cap explained)
- HD derivation (`childSecret_i = sha256(master || u32_be(i))`)
- Fee-juice topup is the OPERATOR's responsibility (each child needs its own faucet drip on testnet; mainnet self-fund)
- Frontend integration: single pool per session; store `masterSecret` in browser SecureStorage / OS keyring
- Capacity guide: N=3 -> 60 unfinalised slots, N=5 -> 100, N=10 -> 200; trade-off vs fee-juice cost
- Recovery: same masterSecret regenerates same N child addresses (deterministic)

### Phase B task count: 5

## Phase C — Close-out

### C1 — AUDIT.md T-16 + T-17

**Files:**
- Modify: `contracts-l1/AUDIT.md`

Append:

```markdown
| T-16 | Trade-direction path-order leak | Noir circuit asserts `path[0] < path[path_len-1]` (Sub-6c A1); SDK auto-canonicalizes (A2). Direction is encoded only in private `side` bool; path no longer leaks. Status: closed. |
| T-17 | WalletPool exhaustion | Maker's N child wallets all at PXE_TAGGING_CAP=18 saturate the pool; `next()` throws `WalletPoolExhausted`. Frontend must catch + show "wait for finalization OR grow pool" message. Status: accepted limitation; architectural, not a vulnerability. |

### T-16 detail -- Trade-direction path-order leak

submit_order's `path: [Field; 3]` field-array was previously interpreted in submission direction: a sell from USDC to ETH stored `[USDC, ETH]`; a buy of USDC from ETH stored `[ETH, USDC]`. On-chain observers reading the public submit tx would see this redundantly encode the direction that the private `side` bool was supposed to hide.

A1 circuit enforces `path[0] < path[path_len-1]` (lex-sorted endpoints). A2 SDK transparently canonicalizes: if user-input path is reversed, SDK flips the `side` bool + reverses the array. Post-canonical: `side=buy` means maker pays canonical-low + receives canonical-high; `side=sell` is the inverse.

Side itself remains private (encrypted in the OrderNote). The on-chain escrow call to `Token.transfer_in_to_public(orderbook, amount_in)` still reveals which token the maker spent (the input asset) -- this is the residual #2-leak, deferred to Sub-6d as "full direction obscure" via per-token shielded escrow pool.

- **Impact:** Medium. Pre-fix: observer could correlate path direction with side, learn maker's direction even for private orders.
- **Likelihood:** High under adversarial monitoring.
- **Mitigation:** A1 + A2 + A3 doc.
- **Status:** Closed (path-order leak fully fixed; residual escrow-side leak deferred).
- **Notes:** Backward-compat: existing SDK callers see no behavior change; canonicalization is transparent.

### T-17 detail -- WalletPool exhaustion

Aztec PXE caps ~20 unfinalised private submits per wallet. WalletPool distributes across N wallets to give frontend ~N*20 capacity, but a maker that opens many orders in rapid succession can saturate all N. `WalletPool.next()` throws `WalletPoolExhausted` with a helpful message.

- **Impact:** Low. UX degradation, not security. Maker either waits ~6-10s for testnet finalization OR grows pool by adding more child wallets (requires fresh fee-juice drip per).
- **Likelihood:** Medium for heavy power-user / market-maker patterns.
- **Mitigation:** Document in `docs/wallet-pool.md`; default pool size N=3 conservative; max N=20 configurable.
- **Status:** Accepted architectural limitation.
- **Notes:** Aztec 4.2.1 specific. Future Aztec releases may relax the per-wallet tagging cap; re-evaluate on each upgrade.
```

### C2 — Sub-6 series close-out

**Files:**
- Create: `docs/superpowers/runs/sub6-close-out.md` (~150 lines)

Sections:
- Sub-6a anonymity set (K=5 decoys, bridge advisory, amount heuristic) -- shipped 2026-05-23
- Sub-6b testnet operability + SDK + bridge deploy -- shipped 2026-05-24 (L1 GREEN, L2 claim BLOCKED on fee-juice)
- Sub-6c trade-direction + WalletPool -- shipped (this sub-project)
- Deferred to Sub-6d / Sub-7:
  - #6 aggregator-side metadata reveals (threshold T-of-N multi-sig)
  - Escrow-side leak (#2 full obscure via shielded pool)
  - L2 bridge claim_public end-to-end (Sub-6b carryforward)
  - Sub-4 ceremony bridge-wired Treasury seed via L1->L2 deposit
- Frontend integration readiness checklist (SDK + 3 examples + bridge + privacy + WalletPool)
- Test scoreboard across 6a/6b/6c (final unit/integration/TXE numbers)

### C3 — Memory note

**Files:**
- Create: `~/.claude/projects/-Users-huseyinarslan-Desktop-aztec-project/memory/project_subproject6c_complete.md`
- Modify: `~/.claude/projects/-Users-huseyinarslan-Desktop-aztec-project/memory/MEMORY.md`

Standard memory note format (matches existing `project_subproject*_complete.md` files).

### Phase C task count: 3

## Test scoreboard target

At Sub-6c close-out:

- SDK unit tests: 74 (Sub-6b baseline) + ~12 new (6 canonicalize + 6 WalletPool) = ~86 green
- Noir TXE tests: existing 6 (Sub-6a bulk) + 3 new (canonical path) = ~9 green
- L1 Foundry tests: unchanged (no L1 changes in Sub-6c)
- TypeScript typecheck: clean

## Branch + commit policy

- All work on `main` (no worktrees)
- Each task in its own commit (or 1-2 atomic commits per task)
- Phase boundaries marked with `git tag sub6c-phase{A,B,C}-done`

## Success criterion

A frontend dev can:

1. Place orders via `client.orders.placeOrder({side, inputToken, outputToken, amount, limitPrice})` without thinking about path ordering -- SDK canonicalizes transparently
2. Open a maker session with `WalletPool.fromMaster({masterSecret, n: 5, network: "alpha-testnet"})` and submit dozens-to-hundreds of orders without hitting PXE tagging-window stalls
3. Read SDK README + `docs/wallet-pool.md` and integrate the pool in their UI in under an hour

Privacy gain: on-chain observers can no longer derive maker direction from `path` ordering. Direction leaks only via the input-side `Token.transfer_in_to_public` call (residual gap deferred to Sub-6d full-obscure work).
