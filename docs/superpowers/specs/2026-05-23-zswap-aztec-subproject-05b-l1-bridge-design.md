# Sub-project 5b: L1 Bridge (USDC + WETH)

**Status:** Design
**Date:** 2026-05-23
**Parent project:** [Quetzal](2026-05-14-zswap-aztec-mvp-design.md) — sub-project 5 (split into 5a / 5b / 5c)
**Predecessor specs:**
- [Sub-5a Deterministic Addresses + Carryforward Fixes](2026-05-23-zswap-aztec-subproject-05a-deterministic-addresses-design.md) — must ship first; provides the 3-deploy ceremony + per-hop nullifier scheme that Sub-5b consumes unchanged.

## Goal

Replace Quetzal's test tokens (tUSDC, tETH) with bridge-aware Token contracts (aUSDC, aWETH) that lock canonical L1 ERC20s (USDC, WETH) and mint matching L2 supply via the Aztec L1↔L2 messaging primitives. End-to-end maker journey: deposit canonical USDC on L1 → claim aUSDC on Aztec L2 → trade through Quetzal (Sub-1 through Sub-5a unchanged) → exit aUSDC back to canonical USDC on L1. L1 portals are owned by a 3-of-5 multisig behind a 7-day TimelockController; same code deploys to Sepolia (testnet) and mainnet, parametrized at deploy time.

## Non-Goals

- A third bridged asset (wBTC, DAI, etc.) — Sub-5b's MVP locks at 2. Adding a third asset is mechanical but requires its own audit + runbook entry; defer.
- L1 audit + formal verification — Sub-5b ships portal source code + Foundry tests + governance topology. The audit / mainnet deployment is a Sub-5c concern.
- Statistical privacy leak mitigation (deposit-claim temporal linkage, withdraw amount-pattern fingerprinting) — Sub-6 dummy-order territory.
- Cross-chain bridges to non-Ethereum L1s (Polygon, Arbitrum, BNB, etc.) — explicit never-do; Quetzal is Aztec-on-Ethereum-only.
- L1 portal v2 (post-launch upgrades) — Sub-5b ships v1; v2 is its own project.
- L1 portal monitoring infrastructure (Prometheus exporters, alerting) — Sub-5c.
- Sponsored-bridge integration (LayerZero, Wormhole, etc.) — explicitly rejected during brainstorm; canonical Aztec portal pattern only.

## Section 1 — Architecture + 2-portal topology

Quetzal operates in three environments after Sub-5b lands:

| Environment | L2 Token contracts | `is_bridged` flag | L1 token contracts bridged |
|---|---|---|---|
| Local dev stack (anvil + `scripts/dev.sh`) | tUSDC, tETH | `false` (admin mints) | None — fast iteration only |
| Aztec testnet (Sepolia L1) | aUSDC, aWETH | `true` (portal-only) | Sepolia testnet USDC (`0x1c7D...A48E`) + WETH (`0xfFf9...11d2`) |
| Aztec mainnet (Ethereum L1) | aUSDC, aWETH | `true` (portal-only) | Canonical mainnet USDC (`0xA0b8...eB48`) + WETH (`0xC02a...6Cc2`) |

The same `Token.nr` contract sources all three; deploy-time parameters select the mode. Local stack keeps existing tUSDC/tETH (no breaking change to Sub-1 through Sub-5a tests). Aztec testnet and mainnet both run the bridge actively; bridge code paths are tested in production against testnet first, then promoted to mainnet.

**L1 directory (NEW): `contracts-l1/`**

```
contracts-l1/
├── foundry.toml
├── src/
│   ├── TokenBridge.sol             ← Aztec reference fork (parametric L1 token / L2 token)
│   ├── interfaces/
│   │   ├── IInbox.sol              ← Aztec L1→L2 messaging
│   │   └── IOutbox.sol             ← Aztec L2→L1 messaging
│   └── lib/DataStructures.sol      ← L1↔L2 message types
├── script/
│   ├── DeployTokenBridge.s.sol     ← deploys 1 portal (parametric)
│   └── DeployAllBridges.s.sol      ← deploys USDC + WETH portals + multisig + timelock wiring
└── test/
    ├── TokenBridge.t.sol           ← Foundry unit tests
    └── BridgeFlow.t.sol            ← e2e against mocked Aztec Inbox/Outbox
```

Two `TokenBridge` portal contracts are deployed (USDCBridge, WETHBridge), parameterized by `(l1_token, l2_token_addr, l2_token_class_id, multisig_owner, timelock_controller)`. Both share the same source; only constructor arguments differ.

**Aztec testnet / mainnet topology:**

```
L1 (Sepolia / Mainnet):
  Canonical USDC: 0x1c7D...A48E (Sepolia) | 0xA0b8...eB48 (Mainnet)
  Canonical WETH: 0xfFf9...11d2 (Sepolia) | 0xC02a...6Cc2 (Mainnet)
  USDCBridge:     <deploy address> (parametric)
  WETHBridge:     <deploy address> (parametric)
  Multisig:       3-of-5 Gnosis Safe at <safe addr>
  Timelock:       OpenZeppelin TimelockController, 7 days (mainnet) | 0 sec (testnet), admin = multisig

L2 (Aztec):
  aUSDC: Token contract deployed with is_bridged=true, portal_addr=USDCBridge
  aWETH: Token contract deployed with is_bridged=true, portal_addr=WETHBridge
  Orderbook + Pool + AggregatorRegistry + Treasury:
    deployed via Sub-5a 3-deploy ceremony pointing at aUSDC + aWETH
    (instead of testnet tUSDC + tETH)
```

The Sub-5a deploy ceremony (commit f2f4439) remains; Sub-5b only changes which Token contracts the rest of the stack points at.

## Section 2 — L2 Token.nr bridge-mode extension

The existing `contracts/token/src/main.nr` is generalized with two new immutable storage fields and four new external functions. No callers (Orderbook, Pool, integration tests) need updates as long as test stack continues using `is_bridged=false`.

**Storage additions:**

```rust
struct Storage<Context> {
    // ... existing fields (name, symbol, decimals, minter, balances, etc.) ...

    // Sub-5b: bridge configuration. Set once at deploy; immutable.
    is_bridged: PublicImmutable<bool, Context>,
    portal_addr: PublicImmutable<EthAddress, Context>,  // ZERO sentinel for non-bridged
}
```

`EthAddress` (Aztec-nr's 20-byte L1 address type) distinguishes the L1 portal from L2 `AztecAddress` (32-byte) recipients.

**Constructor signature change:**

```rust
#[external("public")]
#[initializer]
fn constructor(
    name: str<31>,
    symbol: str<31>,
    decimals: u8,
    admin_minter: AztecAddress,
    // Sub-5b additions:
    is_bridged: bool,
    portal_addr: EthAddress,    // EthAddress::zero() if !is_bridged
) {
    // ... existing initialize() calls ...
    self.storage.is_bridged.initialize(is_bridged);
    self.storage.portal_addr.initialize(portal_addr);
    if is_bridged {
        assert(portal_addr != EthAddress::zero(), "bridged token requires non-zero portal_addr");
    }
}
```

**Mode-gated existing functions:**

`mint_to_public` and `mint_to_private` keep their admin-only behavior, but revert when `is_bridged=true`:

```rust
#[external("public")]
fn mint_to_public(to: AztecAddress, amount: u128) {
    let bridged = self.storage.is_bridged.read();
    assert(!bridged, "bridged token: use claim_public from portal flow");
    let caller = self.msg_sender();
    let admin = self.storage.minter.read();
    assert(caller == admin, "only minter");
    // ... existing mint logic ...
}
```

Same pattern for `mint_to_private`. Transfer functions (`transfer_*`, `burn_*`) are unchanged.

**New `claim_public` and `claim_private` (deposit-flow consumption):**

```rust
/// Sub-5b: consume an L1→L2 deposit message from the portal and mint
/// `amount` to `to`. secret is the preimage of secret_hash that the portal
/// committed to on L1 when locking the canonical asset.
#[external("public")]
fn claim_public(to: AztecAddress, amount: u128, secret: Field, message_leaf_index: u64) {
    let bridged = self.storage.is_bridged.read();
    assert(bridged, "non-bridged token: use mint_to_public");
    let portal = self.storage.portal_addr.read();

    let content = poseidon2_hash([
        to.to_field(),
        amount as Field,
        secret,
        DEPOSIT_PUBLIC_TAG,    // compile-time domain separator
    ], 4);

    context.consume_l1_to_l2_message(content, secret, portal, message_leaf_index);
    self._mint_public_internal(to, amount);
}

#[external("private")]
fn claim_private(to: AztecAddress, amount: u128, secret: Field, message_leaf_index: u64) {
    // Analogous private-context: consumes the same L1→L2 message but mints an
    // encrypted note to `to` rather than a public balance entry.
}
```

**New `exit_to_l1_public` and `exit_to_l1_private` (withdraw-flow emission):**

```rust
/// Sub-5b: burn `amount` of the caller's public balance + emit an L2→L1
/// withdrawal message via Aztec Outbox. The portal on L1 consumes the
/// message + releases canonical USDC/WETH to `l1_recipient`.
#[external("public")]
fn exit_to_l1_public(amount: u128, l1_recipient: EthAddress) {
    let bridged = self.storage.is_bridged.read();
    assert(bridged, "non-bridged token: cannot exit_to_l1");
    let portal = self.storage.portal_addr.read();
    let caller = self.msg_sender();

    self._burn_public_internal(caller, amount);

    let content = poseidon2_hash([
        l1_recipient.to_field(),
        amount as Field,
        WITHDRAW_PUBLIC_TAG,
    ], 3);
    context.message_portal(portal, content);
}

#[external("private")]
fn exit_to_l1_private(amount: u128, l1_recipient: EthAddress) {
    // Analogous: nullifies private notes worth `amount` + emits Outbox message.
}
```

**Compile-time domain separators (computed once in B1 task):**

```rust
global DEPOSIT_PUBLIC_TAG:  Field = <poseidon2("ZSWAP_DEPOSIT_PUB")>;
global DEPOSIT_PRIVATE_TAG: Field = <poseidon2("ZSWAP_DEPOSIT_PRV")>;
global WITHDRAW_PUBLIC_TAG: Field = <poseidon2("ZSWAP_WITHDRAW_PUB")>;
global WITHDRAW_PRIVATE_TAG: Field = <poseidon2("ZSWAP_WITHDRAW_PRV")>;
```

Same pattern as Sub-5a B1's nullifier tags. Implementer computes real poseidon2 hashes at task time + pins as hex literals.

**Impact on existing code paths:**

- `tUSDC` test deploys → `is_bridged=false, portal_addr=EthAddress::zero()`. All existing `mint_to_*`, `transfer_*` work unchanged. Zero breaking change to local dev stack tests.
- `aUSDC` production deploys → `is_bridged=true, portal_addr=USDCBridge.address`. Admin mint paths revert; only portal flows (`claim_*`, `exit_to_l1_*`) succeed.
- Orderbook, Pool, submit_order, claim_fill, etc.: unchanged. Token contract is opaque to them; mode-gating is internal.

## Section 3 — Deposit flow (L1 → L2) + privacy semantics

**Step-by-step:**

```
1. (L1) Maker approves the portal to transfer `amount` of canonical USDC:
       USDC.approve(USDCBridge.address, amount)

2. (L1) Maker generates a secret + secret_hash off-chain:
       secret = random 32 bytes (kept locally)
       secret_hash = sha256(secret)    // L1 uses sha256 for Aztec inbox compatibility

3. (L1) Maker calls:
       USDCBridge.depositToL2Public(amount, l2_recipient, secret_hash)
       USDCBridge.depositToL2Private(amount, secret_hash)

   L1 portal:
     a. Transfers `amount` of canonical USDC from maker → portal escrow (lock).
     b. Encodes the L1→L2 message:
        content = poseidon2_hash([l2_recipient, amount, secret_hash, DEPOSIT_PUBLIC_TAG])
        (for `depositToL2Private`, recipient is omitted from content; only amount + secret_hash + DEPOSIT_PRIVATE_TAG)
     c. Calls Inbox.sendL2Message(content, recipient_l2_contract = aUSDC.address).
     d. Returns the message_leaf_index for the L2 claim.

4. Wait for L1 finality + Aztec L1→L2 inclusion (~4-15 min Sepolia, ~12-15 min mainnet).
   This is the same bridge wait that Sub-2.5 testnet validation observed for fee-juice claims.

5. (L2) Maker calls aUSDC.claim_public(to=l2_recipient, amount, secret, message_leaf_index)
   or aUSDC.claim_private(to=l2_recipient, amount, secret, message_leaf_index).

   L2 Token (bridge mode):
     a. Reconstructs content from args + DEPOSIT_PUBLIC_TAG (or PRIVATE_TAG).
        secret revealed at this step; Aztec inbox verifies sha256(secret) matches the
        L1-committed secret_hash and that l1_message_index matches a real portal message.
     b. context.consume_l1_to_l2_message(content, secret, portal_addr, message_leaf_index).
        Reverts if message not yet inboxed or already consumed.
     c. _mint_public_internal(l2_recipient, amount) or analogous private mint.
```

**Privacy semantics:**

| Public observer learns | Public observer does NOT learn |
|---|---|
| L1: maker's USDC address, locked `amount`, target L2 contract (aUSDC), secret_hash | L1: when the L2 claim will happen, by whom |
| L2: an L1→L2 message at `message_leaf_index` was consumed by aUSDC; for `claim_public`, recipient + amount visible; for `claim_private`, only the consumption event | L2: `claim_private` keeps recipient identity + amount hidden inside an encrypted note |
| Cross-side: amount + secret_hash + temporal correlation can link L1 deposit ↔ L2 claim | Only the maker knows the `secret` (sha256 preimage); a third party cannot deterministically link the two halves without timing-attack inference |

**Privacy-maximalist UX:** makers use `claim_private`. L1 deposit exposes amount + hash; L2 claim is an opaque consumption event with payload in an encrypted note. Multiple makers depositing the same amount within an epoch defeats the temporal correlation; this is the same anonymity-set strategy Aztec's documentation recommends.

**Maker UX (CLI):**

```bash
# L1 side (Foundry cast):
cast send $USDC_ADDR "approve(address,uint256)" $USDC_BRIDGE 1000000000   # 1000 USDC at 6 decimals
cast send $USDC_BRIDGE "depositToL2Private(uint256,bytes32)" 1000000000 $SECRET_HASH

# ~5-15 min wait for L1→L2.

# L2 side:
pnpm --filter @quetzal/cli quetzal bridge claim \
  --token aUSDC --amount 1000000000 --secret $SECRET --message-index $LEAF_INDEX
```

New CLI command `quetzal bridge claim` ships in Phase D.

**Edge cases:**

| Scenario | Behavior |
|---|---|
| Maker loses the secret | Cannot claim. Funds remain locked in L1 portal escrow. (Recovery: deposit-claim attestation by the maker proving they own the secret_hash preimage is out-of-scope MVP; tracked as Sub-5c follow-up.) |
| Same secret reused (collision) | Second claim reverts ("message already consumed"). Single-use guarantee. |
| L1 deposit tx reverts (insufficient approval) | Zero L2 state change. Maker retries. |
| Portal paused during L1→L2 wait | Portal accepts no new deposits; pending L1→L2 message still in inbox. Claim still works (claim is independent of portal pause state — pause gates L1 actions only). |

## Section 4 — Withdraw flow (L2 → L1) + finality

**Step-by-step:**

```
1. (L2) Maker calls aUSDC.exit_to_l1_public(amount, l1_recipient)
   or aUSDC.exit_to_l1_private(amount, l1_recipient).

   L2 Token (bridge mode):
     a. Burns `amount` from maker's public balance OR nullifies private notes worth `amount`.
     b. Builds the L2→L1 message content:
        content = poseidon2_hash([l1_recipient, amount, WITHDRAW_PUBLIC_TAG])
        (PRIVATE_TAG for private exit; same shape, different domain separator)
     c. context.message_portal(portal_addr, content).
        Aztec adds the message to the L2 block's Outbox tree.
     d. Returns (l2_block_number, message_leaf_index) for the L1 claim.

2. Wait for the L2 rollup proof containing this Outbox to land on L1.
   - Aztec testnet (Sepolia): ~30 min - 2 hours per epoch rollup cadence.
   - Aztec mainnet: ~1-3 hours production cadence.
   This is L2's finality gate; the bridge cannot accelerate it.

3. (L1) Maker (or any party with the proof) calls:
       USDCBridge.withdraw(
         amount, l1_recipient,
         l2_block_number, leaf_index, sibling_path,
       )

   L1 portal:
     a. Reconstructs content = poseidon2_hash([l1_recipient, amount, WITHDRAW_PUBLIC_TAG]).
     b. Calls Outbox.consume(content, l2_block_number, leaf_index, sibling_path).
        Reverts if proof invalid or message already consumed.
     c. Releases `amount` of canonical USDC from portal escrow to l1_recipient.

4. Canonical USDC arrives at maker's L1 wallet.
```

**UX implications:**

- L2 → L1 messages travel inside L2 rollup proofs, batched. Single withdrawals cannot accelerate the cadence.
- Maker submits `exit_to_l1_*` on L2, waits 30 min - 3 hours (network-dependent), then submits the L1 `withdraw()` claim transaction.
- Anyone can submit the L1 claim if they have the proof + sibling_path (both public after rollup inclusion); the proceeds always go to `l1_recipient`. In practice the maker submits themselves OR delegates to a relayer (Sub-5c production runbook addresses relayer integration).

**Maker UX (CLI):**

```bash
# L2 side — emit the exit message:
pnpm --filter @quetzal/cli quetzal bridge exit \
  --token aUSDC --amount 500000000 --l1-recipient 0xMyEthAddress

# Output:
#   L2 burn tx: 0xabc...
#   L2 block: 12345
#   Outbox leaf index: 42
#   "Wait ~1-3 hours for L2 rollup proof. Then on L1:"
#   cast send $USDC_BRIDGE "withdraw(uint256,address,uint256,uint256,bytes32[])" \
#            500000000 0xMyEthAddress 12345 42 [proof_array]

# After waiting, L1 side:
cast send $USDC_BRIDGE "withdraw(...)" ...
```

A helper `quetzal bridge claim-l1 --l2-tx <hash>` will extract the Outbox proof + emit the ready-to-run `cast send` block.

**Privacy semantics:**

| Public observer learns | Public observer does NOT learn |
|---|---|
| L2: an Outbox message exists at (block, leaf_index); `exit_to_l1_public` reveals burned address + amount; `exit_to_l1_private` only reveals "some maker burned an amount" | `exit_to_l1_private` keeps the maker's L2 identity + their note's private payload secret |
| L1: `withdraw()` tx submitter, `l1_recipient`, amount, `l2_block_number` — all public | For `exit_to_l1_private`, no deterministic link from the L2 maker's identity back to the L1 claim submitter or `l1_recipient` |

**Edge cases:**

| Scenario | Behavior |
|---|---|
| `exit_to_l1_*` reverts (insufficient L2 balance) | Zero L2 state change; no L2→L1 message emitted. Maker retries. |
| L2→L1 message emitted but maker forgets to claim on L1 | Message remains in Outbox indefinitely. Maker claims at any time (no expiry). |
| L1 `withdraw()` called with wrong proof | Outbox `consume` reverts. No state change. Maker corrects proof + retries. |
| Same L2→L1 message claimed twice | Second `withdraw()` reverts (Outbox flag is one-shot). |
| Portal paused on L1 | `withdraw()` reverts "portal paused". L2→L1 messages safe in Outbox; claimable once unpaused. **Funds are NOT permanently locked** — pause is recoverable. |
| Multisig submits a portal upgrade during a pending withdraw | 7-day timelock buffer (mainnet) lets the maker race their `withdraw()` against the upgrade. Testnet has delay=0 so dev-cycle upgrades happen immediately. |

**Security boundary clarification:** the bridge is fundamentally semi-public at the in/out points — L1 actions are public on Ethereum and L2 exit-messages contain enough metadata (amount + L1 recipient) to be linkable to L1 events. Privacy is preserved during Quetzal trading on L2; bridge crossings are where the privacy boundary breaks. This is inherent to L2 ↔ L1 messaging, not a Quetzal design choice.

## Section 5 — Governance, testing, phasing, success criteria

### L1 governance: 3-of-5 multisig + 7-day TimelockController

Each `TokenBridge` portal's `owner` is set to an OpenZeppelin `TimelockController` instance. The TimelockController's admin is a Gnosis Safe 3-of-5 multisig with five distinct signer parties documented in the deploy runbook.

```
L1 governance topology:
  ┌──────────────────────┐
  │  Multisig (3-of-5)   │  signer keys held by 5 distinct parties
  └──────────┬───────────┘
             │ proposes
             ▼
  ┌──────────────────────┐
  │  TimelockController  │  7-day delay (mainnet) or 0 (testnet)
  └──────────┬───────────┘
             │ queues → executes after delay
             ▼
  ┌──────────────────────┐
  │   USDCBridge         │  owner = TimelockController
  ├──────────────────────┤
  │   WETHBridge         │  owner = TimelockController
  └──────────────────────┘
```

**Critical functions (owner-gated, timelocked):**

- `pause()` / `unpause()` — emergency stop for L1 deposits + withdrawals; existing pending Outbox messages still claimable once unpaused.
- `upgrade(new_implementation)` — UUPS upgrade via OpenZeppelin proxy.
- `set_l2_token_addr(new_addr)` — emergency redirect if L2 contract redeployed (rare; mainly for testnet iteration).
- `withdraw_treasury_dust(token, amount, to)` — sweep accumulated dust to multisig treasury (rare).

**Read-only (no auth):**

- `view_total_locked()`, `view_paused()`, `view_l2_token()`, `view_implementation()`.

**Testnet vs mainnet delay:** TimelockController's `minDelay` is 0 on testnet (rapid dev iteration) and 7 days on mainnet. Deploy script parameterizes by `network=testnet|mainnet`. Signer count is also parametric: 1-of-1 on testnet for solo deployment, 3-of-5 on mainnet.

### Testing strategy

| Layer | Test type | Tooling |
|---|---|---|
| L1 portal isolated | Foundry unit tests (`forge test`) | Foundry, OpenZeppelin TimelockController, mocked Aztec Inbox/Outbox |
| L1 portal + Aztec messaging | Foundry integration with anvil + mock rollup | Foundry + anvil + custom Aztec mock |
| Token.nr bridge mode | TXE Noir tests | aztec-nargo (Docker required) + native nargo where possible |
| Local e2e | `tests/integration/bridge-e2e.test.ts` | tsx + anvil + local Aztec dev stack |
| Sepolia testnet e2e | `scripts/testnet-sub5b-bridge.ts` | live Sepolia + Aztec testnet, ~30-90 min walltime |

Mainnet validation strategy: deploy with capped total-value-locked (e.g., $10k initial cap enforced in TokenBridge.sol `MAX_TVL_PER_ASSET`); 30-day bug bounty + monitoring; gradual cap increase if no incidents.

### File structure

**Created:**

```
contracts-l1/                       ← NEW directory: L1 Solidity
├── foundry.toml
├── src/
│   ├── TokenBridge.sol             ← Aztec reference fork (parametric)
│   ├── interfaces/IInbox.sol + IOutbox.sol
│   └── lib/DataStructures.sol
├── script/
│   ├── DeployTokenBridge.s.sol
│   └── DeployAllBridges.s.sol
└── test/
    ├── TokenBridge.t.sol
    └── BridgeFlow.t.sol

cli/src/commands/bridge.ts          ← NEW: quetzal bridge claim/exit subcommands
cli/src/bridge-helpers.ts           ← NEW: L1 proof construction + Outbox traversal

scripts/deploy-bridge.ts            ← NEW: deploys 2 portals (USDC + WETH) on L1 + 2 aTokens on L2
scripts/testnet-sub5b-bridge.ts     ← NEW: live Sepolia + Aztec testnet bridge runner
tests/integration/bridge-e2e.test.ts ← NEW: local dev stack bridge e2e

docs/superpowers/specs/sub5b-runbook.md ← NEW: mainnet deployment runbook
```

**Modified:**

- `contracts/token/src/main.nr` — add `is_bridged` + `portal_addr` storage, mode-gate `mint_to_*`, add `claim_public/private` + `exit_to_l1_public/private`, add domain-separator globals.
- `cli/src/commands/index.ts` — register `bridge` subcommand.
- `scripts/testnet-sub5a.ts` — step 3 (Token deploy) and step 9 (alice mints) replaced with Sub-5b bridge calls.
- `README.md` — Sub-5b status block.

### Phasing (15-18 tasks across 7 phases, ~6-8 weeks)

| Phase | Tasks | Purpose |
|---|---|---|
| **A — L1 portal scaffolding (3)** | A1: Foundry project + reference fork import; A2: parametric `TokenBridge.sol` + governance wiring; A3: Foundry unit tests | L1 portal contract |
| **B — L2 Token bridge mode (3)** | B1: Storage + constructor extension (`is_bridged` + `portal_addr` + domain-tag globals); B2: `claim_public/private` + `exit_to_l1_public/private`; B3: TXE tests | L2 contract changes |
| **C — Aztec messaging integration (2)** | C1: `context.consume_l1_to_l2_message` wiring + content-hash format alignment; C2: `context.message_portal` wiring + Outbox content hash format | L1 ↔ L2 wire format |
| **D — CLI + helpers (2)** | D1: `quetzal bridge claim` + secret/secret_hash management; D2: `quetzal bridge exit` + L1 proof helper | UX |
| **E — Deploy + governance (3)** | E1: `deploy-bridge.ts` (USDC + WETH portals + L2 aTokens); E2: TimelockController + multisig deploy on Sepolia; E3: governance integration tests | Deploy ceremony |
| **F — Integration tests (2)** | F1: `tests/integration/bridge-e2e.test.ts` (local dev stack); F2: `scripts/testnet-sub5b-bridge.ts` scaffold | E2E |
| **G — Runbook + close (1-2)** | G1: `sub5b-runbook.md` (mainnet deployment, monitoring, incident response); G2: memory note + README + spec/plan links | Operator-ready |

### Success criteria

1. **L1 portal:** USDCBridge + WETHBridge deployed on Sepolia; Foundry tests 100% pass; governance topology verified (multisig owns timelock, timelock owns portal).
2. **L2 Token:** aUSDC + aWETH deployed on Aztec testnet with `is_bridged=true`; admin `mint_to_*` calls revert; only portal-flow `claim_*` / `exit_to_l1_*` work.
3. **Bridge happy path:** maker deposits 100 Sepolia USDC → 100 aUSDC on Aztec testnet → uses in a 1-hop trade through Quetzal Sub-1/2.5/3/4/5a stack → withdraws remaining aUSDC back to Sepolia USDC. End-to-end tx hashes documented.
4. **Governance:** pause attempted by non-owner reverts; multisig-proposed pause queued + executable on testnet (delay=0) and observable as pending-for-7-days on mainnet (delay=7d); non-timelocked critical-function call reverts.
5. **Sub-5a integration:** `scripts/testnet-sub5a.ts` step 3 (Token deploy) and step 9 (alice private mints) are replaced with Sub-5b bridge ceremony calls. The full 17-step runner now exercises the bridge alongside the Sub-5a deterministic-address ceremony.

### Out-of-scope (Sub-5c, Sub-6+)

- wBTC bridge (next Sub-5b iteration after USDC + WETH stable in production).
- L1 portal mainnet audit + formal verification — Sub-5c prerequisite.
- Monitoring dashboards / alerting / on-call rotation — Sub-5c.
- Relayer infrastructure for L1 withdraw claim submission — Sub-5c (could be the same operator running Sub-3 aggregator daemon).
- Cross-chain bridges to non-Ethereum L1s — explicit never.
- L1 portal v2 upgrade plan — separate post-Sub-5b project.
- Statistical privacy leak mitigation (deposit ↔ claim temporal linkage) — Sub-6 dummy-order/route territory.
- Loss-of-secret recovery flow for stuck L1 deposits — Sub-5c follow-up; affects user trust.

### Dependencies

- Aztec testnet bridge endpoint produces mainnet-equivalent behavior (Sub-2.5 verified fee-juice bridging works; ERC20 bridging uses similar but distinct contracts — confirm with Aztec docs at task A1).
- OpenZeppelin v5 (`TimelockController` + UUPS).
- Foundry 0.2+ + cast (already on dev box).
- Sub-5a SHIPPED (HEAD 5285f36) — Sub-5b consumes the 3-deploy ceremony + per-hop nullifier scheme unchanged.
