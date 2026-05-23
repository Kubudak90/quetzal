# Quetzal on Aztec — Sub-project 3 Design: Permissionless Aggregator (Liveness-First)

**Status:** spec
**Date:** 2026-05-22
**Predecessors:** [Sub-project 1 complete through Week 5d-4](./2026-05-21-zswap-aztec-week-05d-4-merkle-settlement-root-design.md)
**Sub-project:** 3 of 6 (DAR + Permissionless Aggregator)
**Sub-project 1 dependency:** complete. Sub-3 builds on the trustless-clearing-via-ZK-proof primitive.
**Estimated duration:** 5 weeks

---

## 1. Goal

Replace the single trusted aggregator (Sub-project 1's MVP) with a permissionless role: anyone holding the necessary off-chain reveals can submit a valid clearing proof for the current epoch. Add an on-chain bonded registry so aggregators have skin in the game, and a per-clearing fee so the role is economically sustainable. Address the MVP's only critical mainnet blocker (single point of trust/failure) without taking on MEV-resistance complexity (deferred to a future sub-project).

## 2. Threat model

Sub-3 explicitly scopes to **liveness + censorship** threats:
- The aggregator going offline (no clearings).
- The aggregator deliberately dropping specific orders.

Sub-3 does NOT address:
- Pre-clearing MEV (aggregator sees order plaintexts and can take adversarial positions). All registered aggregators see plaintexts. The "any aggregator can be honest" assumption is sufficient for liveness/censorship; not for MEV.
- Aggregator-aggregator collusion to exclude an order — economically irrational (the excluding aggregator forgoes the fee) but not cryptographically prevented.

Full MEV resistance (DAR via VDFs, threshold encryption committees) is deferred to Sub-3.5 or a future cycle. The contract surface designed here is forward-compatible with adding a reveal mechanism between Sub-3 and Sub-3.5.

## 3. Architecture overview

```
┌──────────────────────────────────────────────────────────────────────┐
│ Maker's PXE / CLI                                                    │
│  - submit_order(...) → on-chain OrderNote                            │
│  - broadcastReveal({nonce, side, amount_in, ...}) → HTTP POST to     │
│    every URL in aggregator-manifest.json                             │
└──────────────────────────────────────────────────────────────────────┘
                                  │
                ┌─────────────────┴──────────────────┐
                ▼                                    ▼
┌──────────────────────────┐         ┌──────────────────────────┐
│ Aggregator A (bonded)    │   ...   │ Aggregator B (bonded)    │
│  POST /reveal queue      │         │  POST /reveal queue      │
│  Clearing daemon         │         │  Clearing daemon         │
│  bb prove → submit       │         │  bb prove → submit       │
└──────────┬───────────────┘         └──────────┬───────────────┘
           │  close_epoch_and_clear_verified(...)│
           │  (race; first valid wins)           │
           ▼                                     ▼
┌──────────────────────────────────────────────────────────────────────┐
│ Orderbook contract                                                   │
│  1. msg_sender registered? (AggregatorRegistry.is_registered)        │
│  2. recursive verify (5d-3); freshness asserts (5d-4)                │
│  3. write fills_root[epoch_id]; advance epoch                        │
│  4. Treasury.pay_aggregator(msg_sender, FEE) — silent partial OK     │
└──────────────────────────────────────────────────────────────────────┘
        │                                       │
        ▼                                       ▼
┌──────────────────────────┐         ┌──────────────────────────┐
│ AggregatorRegistry       │         │ Treasury                 │
│  - bond_amount const     │         │  - holds tUSDC pool      │
│  - register/unregister   │         │  - pay_aggregator (only- │
│  - is_registered query   │         │    orderbook gate)       │
│  - 4 maps for lookup     │         │  - silent partial pay    │
└──────────────────────────┘         └──────────────────────────┘
```

## 4. Components

### 4.1 New contract: `AggregatorRegistry`

Location: `contracts/aggregator-registry/`.

**Storage:**
```rust
struct Storage<Context> {
    /// Token used for bonding. Initialised at deploy; tUSDC in MVP.
    bond_token: PublicImmutable<AztecAddress, Context>,
    /// Required bond per aggregator (smallest token unit). Constant per deploy.
    bond_amount: PublicImmutable<u128, Context>,
    /// Auto-incrementing aggregator id counter.
    next_id: PublicMutable<u32, Context>,
    /// addr → id (0 == not registered).
    aggregator_id_by_addr: Map<AztecAddress, PublicMutable<u32, Context>, Context>,
    /// addr → currently-escrowed bond (0 == not registered).
    bonded_amount_by_addr: Map<AztecAddress, PublicMutable<u128, Context>, Context>,
    /// addr → hash of the aggregator's HTTPS endpoint URL.
    endpoint_hash_by_addr: Map<AztecAddress, PublicMutable<Field, Context>, Context>,
    /// id → addr (for sequential discovery by makers).
    registered_addrs: Map<u32, PublicMutable<AztecAddress, Context>, Context>,
}
```

**Functions:**

- `constructor(bond_token: AztecAddress, bond_amount: u128)` — sets `PublicImmutable`s; `next_id` starts at 1 (0 reserved as "not registered" sentinel).

- `register(endpoint_url_hash: Field, nonce: Field)` — `#[external("private")]`.
  Escrows `bond_amount` tUSDC from caller's private balance into the registry's public balance via `Token.transfer_private_to_public(caller, registry_addr, bond_amount, nonce)`. Enqueues `_register_public(caller, endpoint_url_hash)` callback that:
  - Asserts `aggregator_id_by_addr[caller] == 0` (not already registered).
  - Allocates `id = next_id; next_id += 1`.
  - Writes maps: `aggregator_id_by_addr[caller] = id`, `bonded_amount_by_addr[caller] = bond_amount`, `endpoint_hash_by_addr[caller] = endpoint_url_hash`, `registered_addrs[id] = caller`.

- `update_endpoint(new_endpoint_url_hash: Field)` — `#[external("public")]`.
  Asserts `bonded_amount_by_addr[msg_sender] > 0`. Updates only `endpoint_hash_by_addr[msg_sender]`. No bond change.

- `unregister(nonce: Field)` — `#[external("private")]`.
  Asserts caller is registered (via `_assert_registered` enqueue). Calls `Token.transfer_public_to_private(registry_addr, caller, bond_amount, nonce)` to return the bond. Enqueues `_unregister_public(caller)` callback that zeros `aggregator_id_by_addr[caller]`, `bonded_amount_by_addr[caller]`, `endpoint_hash_by_addr[caller]`, and `registered_addrs[id]`. Bond returned in one tx; no unbonding period for MVP (slashing model is anti-Sybil only, so immediate unbond is safe).

**Utilities (`#[external("utility")] unconstrained`):**

- `is_registered(addr: AztecAddress) -> bool` — `bonded_amount_by_addr[addr] > 0`.
- `get_bonded_amount(addr: AztecAddress) -> u128` — direct read.
- `get_endpoint_hash(addr: AztecAddress) -> Field` — direct read.
- `get_aggregator_count() -> u32` — `next_id - 1`.
- `get_aggregator_by_id(id: u32) -> AztecAddress` — direct read of `registered_addrs[id]`.

Maker's PXE iterates `1..get_aggregator_count()` to enumerate.

**Why hash, not full URL?** Storing full URLs in Aztec PublicMutable would consume substantial public-state slots per aggregator. Hash (single Field) is cheap; full URL lives in an off-chain manifest (§4.4), verified against the hash by the maker before pushing.

### 4.2 New contract: `Treasury`

Location: `contracts/treasury/`.

**Storage:**
```rust
struct Storage<Context> {
    /// Token held in the treasury (must match AggregatorRegistry.bond_token).
    bond_token: PublicImmutable<AztecAddress, Context>,
    /// Orderbook address allowed to call pay_aggregator.
    orderbook_addr: PublicImmutable<AztecAddress, Context>,
}
```

**Functions:**

- `constructor(bond_token: AztecAddress, orderbook_addr: AztecAddress)` — immutable bindings.

- `pay_aggregator(winner: AztecAddress, amount: u128)` — `#[external("public")]`.
  Asserts `msg_sender == orderbook_addr` (only Orderbook can trigger payments). Computes `pay = min(amount, treasury_public_balance)` and transfers `pay` tUSDC to `winner`. Silent partial: if treasury is empty, transfers 0 and does not revert. The clearing tx succeeds even when the treasury is dry — only the aggregator forgoes the fee.

- `deposit(amount: u128, nonce: Field)` — `#[external("private")]`. Anyone can top-up the treasury by calling `Token.transfer_private_to_public(caller, treasury, amount, nonce)`. For MVP this is invoked manually (deploy script seeds 1000 tUSDC). Sub-6 will wire a volume-proportional protocol-fee accrual to refill the treasury automatically.

**Utility:**
- `get_balance() -> u128` — reads treasury's tUSDC public balance.

### 4.3 Modified contract: `Orderbook`

**Storage diff:**
```rust
+ aggregator_registry: PublicImmutable<AztecAddress, Context>,
+ treasury: PublicImmutable<AztecAddress, Context>,
+ aggregator_fee: PublicImmutable<u128, Context>,    // tUSDC, set at deploy. MVP suggestion: 500_000 (= 0.5 tUSDC at 6 decimals)
```

**Constructor diff:** three new args after `clearing_vk_hash`: `aggregator_registry, treasury, aggregator_fee`.

**`close_epoch_and_clear_verified` diff:**
```rust
#[external("private")]
fn close_epoch_and_clear_verified(
    public_inputs: ClearingPublic,
    proof: [Field; 456],
    vk: [Field; 127],
) {
    let caller = self.msg_sender();
    self.enqueue_self._assert_aggregator_registered(caller);  // NEW
    let vk_hash = self.storage.clearing_vk_hash.read();
    std::verify_proof_with_type(vk, proof, [], vk_hash, 1);
    self.enqueue_self._apply_verified_clearing(public_inputs, caller);  // caller arg NEW
}
```

**New callback:**
```rust
#[external("public")]
#[only_self]
fn _assert_aggregator_registered(addr: AztecAddress) {
    let registry = self.storage.aggregator_registry.read();
    let bonded: u128 = AggregatorRegistry::at(registry).get_bonded_amount(addr);
    assert(bonded > 0, "caller is not a bonded aggregator");
}
```

**`_apply_verified_clearing` diff:** New `winner: AztecAddress` parameter. At the end of the function (after `fills_root` write, before epoch advance — or after epoch advance, either order works since both writes are unconditional):

```rust
+ let treasury = self.storage.treasury.read();
+ let fee = self.storage.aggregator_fee.read();
+ Treasury::at(treasury).pay_aggregator(winner, fee);
```

The treasury performs the actual token transfer; the orderbook just signals the intent. Silent partial behaviour means a dry treasury does not block clearing.

### 4.4 Off-chain aggregator-manifest

A JSON file `aggregator-manifest.json` mapping addresses to HTTPS URLs:
```json
{
  "0xabc...": "https://agg-alice.zswap.network",
  "0xdef...": "https://agg-bob.zswap.network"
}
```

For MVP/devnet, this is a curated file in the repo (operators submit PRs to add their aggregator). For mainnet (Sub-5 Production Infra), a decentralized discovery service replaces it.

**Maker discovery flow:**
1. PXE calls `AggregatorRegistry.get_aggregator_count()` → N. (Returns the highest-ever-allocated id; may contain "holes" where aggregators have since unregistered.)
2. For i in 1..N: `get_aggregator_by_id(i)` → address.
   - If address == `AztecAddress::ZERO` → that id was unregistered; skip.
   - Otherwise: `get_endpoint_hash(address)` → on-chain hash.
3. PXE loads `aggregator-manifest.json`. MVP location: bundled inside the `@quetzal/cli` package at `cli/aggregator-manifest.json` (operators submit PRs to add their entry). Operators can override via the env var `ZSWAP_AGGREGATOR_MANIFEST=/path/to/manifest.json` for local testing or alternative discovery sources.
4. For each non-zero address, look up URL in manifest. If present, compute `poseidon2_hash(URL_bytes)` and assert it equals on-chain hash. Mismatch (or URL absent) → skip (manifest stale or malicious; aggregator effectively offline from this maker's perspective).
5. POST reveal to validated URLs in parallel via `Promise.allSettled` (failed pushes do not block other targets).

### 4.5 Aggregator runtime: `aggregator/src/server.ts` + `aggregator/src/daemon.ts`

**`server.ts`** — Fastify (preferred over Express for size + TypeScript ergonomics):

```ts
import Fastify from "fastify";
import { z } from "zod";  // payload validation
import { RevealQueue } from "./queue.js";  // in-memory ring buffer keyed by epoch_id

const RevealSchema = z.object({
  epoch_id: z.number().int().nonnegative(),
  order_nonce: z.string().regex(/^0x[0-9a-f]+$/i),
  side: z.boolean(),
  amount_in: z.string(),   // bigint as string
  limit_price: z.string(),
  submitted_at_block: z.number().int().nonnegative(),
  owner: z.string().regex(/^0x[0-9a-f]+$/i),
  submission_tx_hash: z.string().optional(),
});

const app = Fastify({ logger: true });
const queue = new RevealQueue();

app.post("/reveal", async (req, reply) => {
  const payload = RevealSchema.parse(req.body);
  queue.enqueue(payload);
  return { ok: true };
});

app.get("/health", () => ({ ok: true, queueSize: queue.size() }));

app.listen({ port: Number(process.env.PORT) || 3000, host: "0.0.0.0" });
```

**`daemon.ts`** — runs in parallel; polls the Aztec node:

```ts
async function clearingDaemon(ctx: AggregatorContext) {
  while (true) {
    const epoch = await ctx.orderbook.methods.get_epoch().simulate();
    const blockNow = await ctx.node.getBlockNumber();

    if (blockNow >= Number(epoch.closes_at_block)) {
      // Time to clear. Drain queue for this epoch_id.
      const reveals = ctx.queue.drain(Number(epoch.epoch_id));

      // 1. Validate each reveal against on-chain c_i (order_acc replay)
      const validated = await validateReveals(reveals, epoch, ctx);

      // 2. Compute clearing (existing 5b code path)
      const result = computeClearing(poolSnapshot, validated);

      // 3. Build witness, run nargo execute, bb prove (existing 5d code path)
      const { proverToml, fillsRoot } = await buildClearingWitness({ ... });
      // ... shell out to nargo + bb ...

      // 4. Snapshot
      writeSnapshot(SNAPSHOT_DIR, { epoch_id, fills, tree });

      // 5. Submit (race with other aggregators)
      try {
        await ctx.orderbook.methods.close_epoch_and_clear_verified(
          publicInputs, proofFields, vkFields,
        ).send({ from: ctx.aggregator_account });
      } catch (e) {
        // Likely lost the race; another aggregator's tx already advanced the epoch.
        console.log("clearing race lost:", e.message);
      }
    }

    await sleep(2000);
  }
}
```

Reveal validation step (step 1 above) is critical: an aggregator that includes a maliciously-crafted reveal (where `c_i` doesn't match the actual on-chain `order_acc`) will produce a witness the clearing circuit rejects → wastes the aggregator's bb prove time + gas. So the daemon precomputes `c_i = poseidon2_hash([owner, side, amount_in, limit_price, order_nonce, submitted_at_block])` for each reveal, replays the chain from the on-chain `order_acc=0` seed, and accepts only those reveals whose folded chain matches the on-chain `order_acc` exactly.

### 4.6 CLI surface

New commands (`cli/src/commands/aggregator.ts`):
- `quetzal aggregator register --bond 1000 --url https://my-agg.example.com` — calls `AggregatorRegistry.register(hash(URL), authwit_nonce)` after the maker tops up tUSDC to the required bond amount.
- `quetzal aggregator list` — prints `{id, address, url}` triples (resolves URLs via manifest).
- `quetzal aggregator unregister` — calls `AggregatorRegistry.unregister(authwit_nonce)`.

Modified command (`cli/src/commands/order.ts`):
- After `submit_order` mines, invoke `broadcastReveal(payload, registry)` to push to all registered aggregators (best-effort, errors logged not thrown).

`cli/src/reveal.ts` is a new module containing `broadcastReveal()` and the on-chain-registry → manifest → URL resolution.

## 5. Data flow

### 5.1 Order submission (per maker)

1. Maker calls `quetzal order --side buy --amount 1000 --limit 2.0`.
2. CLI builds OrderNote, calls `Orderbook.submit_order`. Wait for receipt. Capture `submitted_at_block` from receipt.
3. CLI calls `broadcastReveal({epoch_id, order_nonce, side, amount_in, limit_price, submitted_at_block, owner})` →
   3a. Read on-chain registry list.
   3b. Resolve URLs via manifest + hash verify.
   3c. POST in parallel to each.
4. Each aggregator's `POST /reveal` enqueues the payload locally.

### 5.2 Epoch close (per aggregator, parallel)

1. Daemon detects `block_now >= closes_at_block`.
2. Drain queue for current `epoch_id`.
3. Validate reveals by replaying `order_acc`. Discard non-matching.
4. Compute clearing (`computeClearing`).
5. Build witness, write Prover.toml, `nargo execute`, `bb prove`.
6. Snapshot tree to `aggregator/snapshots/epoch-<N>.json`.
7. Submit `close_epoch_and_clear_verified(publicInputs, proof, vk)`.

### 5.3 Race resolution

The first valid submission lands. Subsequent submissions for the same epoch revert at `_apply_verified_clearing`'s freshness asserts (the `order_acc` no longer matches the now-advanced epoch). Losers see a clean revert and move on to the next epoch.

### 5.4 Fee payment

After successful clearing:
1. `_apply_verified_clearing` calls `Treasury.pay_aggregator(winner_addr, AGGREGATOR_FEE)`.
2. Treasury checks its tUSDC public balance.
3. Transfers `min(AGGREGATOR_FEE, balance)` to winner. Silent if balance is 0.
4. Winner's PUBLIC tUSDC balance increases by the paid amount.

## 6. Migration

- **Storage layout change:** Orderbook constructor gains 3 new args. Fresh deploy required. No on-chain migration path (acceptable for pre-mainnet).
- **CLI behavior change:** `quetzal close-epoch-verified` only works for callers who have called `quetzal aggregator register` first. Document this in the README. Users running tests should add a `register` step before any expected clearing.
- **Treasury seeding:** `scripts/deploy-tokens.ts` deploys Treasury and transfers 1000 tUSDC to it via `deposit`. Without this, aggregators submit clearings successfully but earn 0 fee.

## 7. Test plan

### 7.1 Noir TXE

**`contracts/aggregator-registry/src/test.nr`:**
- R1: `register` escrows bond + writes maps with correct id assignment.
- R2: Re-registering same address reverts with "already registered".
- R3: `update_endpoint` changes only the hash; bond untouched.
- R4: `unregister` returns bond + zeros maps; subsequent `is_registered` returns false.
- R5: `is_registered` utility returns correct bool for registered and unregistered addresses.
- R6: `get_aggregator_count` reflects increments + decrements.

**`contracts/treasury/src/test.nr`:**
- T1: `pay_aggregator` transfers from treasury's public balance when balance > amount.
- T2: `pay_aggregator` silently truncates to balance when balance < amount (no revert).
- T3: `pay_aggregator` reverts when msg_sender ≠ orderbook_addr.
- T4: `deposit` increases treasury public balance by amount.

**`contracts/orderbook/src/test.nr` (additions):**
- O1: `close_epoch_and_clear_verified` reverts when caller is not in AggregatorRegistry.
- O2: After successful clearing, treasury balance decreases by `aggregator_fee` and winner's tUSDC balance increases by the same.
- O3: Successful clearing succeeds even when treasury balance is 0 (winner gets 0 fee, no revert).

### 7.2 Aggregator JS

**`aggregator/test/server.test.ts`:**
- S1: `POST /reveal` with a valid payload enqueues it; `GET /health` reflects queue size.
- S2: `POST /reveal` with malformed payload returns 400 (zod validation).
- S3: Duplicate `order_nonce` in queue is detected and dropped on second insert.

**`aggregator/test/validate.test.ts`:**
- V1: `validateReveals(reveals, epoch)` produces `order_acc` exactly matching on-chain when fed correct preimages.
- V2: A reveal with one bit flipped in `amount_in` is rejected (folded chain mismatch).

**`aggregator/test/daemon.test.ts`:**
- D1: Daemon polls node, detects epoch close, drains queue, submits clearing (mocked node + mocked bb).
- D2: Daemon handles race-loss gracefully (catches the freshness-mismatch revert, sleeps, retries on next epoch).

### 7.3 CLI integration

**`tests/integration/cli.test.ts` (additions):**
- C1: `quetzal aggregator register --bond 1000 --url X` mines, then `quetzal aggregator list` shows the new entry.
- C2: `quetzal aggregator unregister` after register returns bond + removes entry.
- C3: `quetzal order` post-submit triggers HTTP POST to all registered aggregator URLs (mocked aggregator servers in the test harness).

### 7.4 Full e2e (`tests/integration/aggregator-race.test.ts`)

- E1: Two aggregators registered. Alice submits order; PXE pushes to both. Both daemons attempt clearing. First valid wins (`get_fills_root(epoch_id) != 0` confirms, winner's tUSDC public balance increased by `aggregator_fee`). Second's submit reverts with `order_acc mismatch`.
- E2: Reveal-validation correctness: include one fake reveal in only one aggregator's queue (e.g., maker pushes valid reveal to A, malicious party pushes a corrupted reveal to B claiming the same order_nonce). A succeeds; B's daemon discards the bad reveal during validation, but B's clearing then misses that order's binding (fewer orders than on-chain → A wins).

### 7.5 Testnet (deferred)

After Sub-3 ships locally, run on Aztec testnet alongside the still-deferred 5d-3+5d-4 joint testnet validation. ~90 min walltime (existing 75 min for 5d-4 + ~15 min for two-aggregator deploy + race).

## 8. Out-of-scope (deferred)

- **MEV resistance:** DAR (Dutch Auction Reveal) via VDFs or threshold encryption committee. Aggregators in Sub-3 see plaintexts pre-clearing. Tracking: Sub-3.5 candidate.
- **Volume-proportional protocol fee accrual:** Treasury currently funded manually. Sub-6 (Governance + Protocol Fees) will add a basis-point protocol fee on swap volume that auto-replenishes the treasury.
- **Public decentralized aggregator discovery:** `aggregator-manifest.json` is curated. Sub-5 (L1 Bridge + Production Infra) replaces with a discovery service.
- **Liveness slashing:** Aggregators are not slashed for missing windows. Economic incentive (lose fee) is the only pressure. Tracking: Sub-3.x if needed.
- **Censorship fraud proofs:** Maker has no on-chain claim mechanism. Falls back to broadcasting reveal to a different aggregator. Tracking: Sub-3.x if needed.
- **Aggregator-aggregator coordination protocols:** Anti-spam if one aggregator floods another's `POST /reveal`. Sub-5 production hardening.

## 9. Success criteria

- 2+ aggregators register concurrently via `quetzal aggregator register` from different accounts.
- E1 e2e test green on live dev stack: both aggregators race, first valid wins, treasury → winner credit confirmed.
- O3 TXE test green: treasury-empty case does not block clearing.
- Maker's `quetzal order` reaches all registered aggregators (CLI integration test C3).
- `pnpm test:noir` green for the 4 contracts (Token, Pool, Orderbook, AggregatorRegistry, Treasury).
- `pnpm --filter @quetzal/aggregator test` green for server + daemon + validation modules.

## 10. Implementation phases (5 weeks)

| Week | Focus | Outputs |
|---|---|---|
| 1 | AggregatorRegistry + Treasury contracts | 2 new Noir contracts, 10 TXE tests, fresh deploy script |
| 2 | Orderbook diff + wiring | Constructor args, `_assert_aggregator_registered` callback, `pay_aggregator` call, 3 TXE tests |
| 3 | Aggregator HTTP server + daemon refactor | `server.ts`, `daemon.ts`, validation module, 8 JS unit tests |
| 4 | CLI commands + reveal broadcasting | `quetzal aggregator register/list/unregister`, `broadcastReveal()`, manifest discovery, 3 CLI tests |
| 5 | Full e2e + docs + testnet | `aggregator-race.test.ts`, README ops runbook, joint Sub-3 + 5d-3+5d-4 testnet validation run |

## 11. Cross-refs

- [Sub-project 1 MVP design](./2026-05-14-zswap-aztec-mvp-design.md)
- [Sub-project roadmap](./2026-05-14-zswap-aztec-roadmap.md)
- [Week 5d-4 Merkle settlement root](./2026-05-21-zswap-aztec-week-05d-4-merkle-settlement-root-design.md)
- Memory: [[project-zswap-aztec]], [[subproject1-complete]], [[privacy-maximalism-design-default]]
