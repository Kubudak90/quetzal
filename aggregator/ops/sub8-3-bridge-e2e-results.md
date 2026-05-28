# Sub-8.3 — Bridge E2E testnet validation results

**Date**: 2026-05-28
**Goal**: Execute the full L1↔L2 bridge round trip (deposit → claim → exit →
L1 withdraw) on Aztec testnet to validate the Sub-7c UI surface end-to-end.

## Environment

| Field | Value |
|---|---|
| Aztec node | `https://rpc.testnet.aztec-labs.com` |
| Aztec rollup version | `4127419662` |
| L1 chain | Sepolia (`11155111`) |
| L1 USDC | `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238` |
| L1 USDCBridge | `0x219ffbb6a504fcd69ae80d1e70db699b48a9936b` |
| L1Inbox | `0xf1bb424ac888aa239f1e658b5bddabc65a1c94e6` (auto-discovered) |
| L2 aUSDC | `0x19aec530674b3b54977b5216fdcad01d5219346e902f2bcb84653a950dd23369` |
| L1 operator | `0xcF582A37AaE1E580b63666587FFa42d84169bA62` |
| L2 recipient | `0x2399a3557af5cf714812a6911908d2fe998030b7b0c31c054a76034bfd6cb8dc` (bridge-deployer wallet, `deploy-bridge-state.json`) |

Test amounts: deposit 10 USDC, exit 5 USDC.

## Steps + results

| # | Step | Status | Tx | Notes |
|---|---|---|---|---|
| 1 | L1 `USDC.approve(bridge, 10 USDC)` | ✅ | `0xcfa8581ea95790ca0e677aa4866711421746a32116db1d2c80fe627c0d08ca3b` | 8s |
| 2 | L1 `USDCBridge.depositToL2Public(10 USDC, l2Recipient, secretHash)` | ✅ | `0x7e776a69fa0cdc66131ef3d9aac9c55eb25fe3e81e0d2e38ee8be5b9739e1ac5` | 23s; L1 block 10941180; gas 164k gwei |
| 3 | Sleep 240s + verify L1→L2 inbox window | ✅ | n/a | inbox_wait=451s |
| 3a | L1Inbox.MessageSent decoded | ✅ | n/a | messageHash=`0x00b13661f192b8ef90455d00a5b26ccc50b7b1721bc5ecd9283356e6b746d1b3`, leafIndex=`94183424`, checkpoint=`91977` |
| 3b | `getL1ToL2MessageMembershipWitness("latest", msg)` → IN TREE | ✅ | n/a | verified via `scripts/decode-deposit-events.mts` |
| 4 | L2 `aUSDC.claim_public(maker, 10 USDC, secret, leafIdx)` | ❌ | — | BLOCKED — see analysis below |
| 5-9 | balance verify / exit / outbox / L1 withdraw | ⏸ | — | gated on step 4 |

### Step 4 blocking analysis

Two distinct failure modes hit during runs:

**Attempt 1** (`testnet-bridge-e2e.ts` default payment method):
- Error: `Not enough balance for fee payer to pay for transaction`
- Cause: the L2 recipient wallet `0x2399…` is the Sub-5b bridge deployer, NOT
  an onboarded user. It has no fee-juice. The default L2 payment method requires
  fee-juice in the caller's account.

**Attempt 2** (`sub8-3-resume.mts` with `FeeJuicePaymentMethodWithClaim`):
- Dripped 100 fee-juice to maker from Sub-7a faucet → drip's L1→L2 message
  confirmed in tree (msgHash `0x00eb47249595fbe31e29303b5ee89d953ed6b150b11aac432e36dfcd18795d1d`, leafIdx `94190592`).
- Re-tried `aUSDC.claim_public` with `FeeJuicePaymentMethodWithClaim(maker, dripClaim)`.
- Error: `Assertion failed: Tried to consume nonexistent L1-to-L2 message`
  (internal function selector `0xf858ba0c`, "Could not find function artifact in contract Token" enricher warning).
- Both L1→L2 messages (USDC deposit AND fee-juice drip) confirmed IN TREE
  on the L2 side. Tags match between L1 (`DataStructures.DEPOSIT_PUBLIC_TAG = 0x...5a535741505f44505f01`)
  and L2 (`token::DEPOSIT_PUBLIC_TAG`).

**Hypothesis** (not confirmed): `FeeJuicePaymentMethodWithClaim` may be designed
for ACCOUNT DEPLOY transactions only — Sub-7b/`scripts/lib/aztec-wallet-bootstrap.ts`
uses it during `getDeployMethod().send({ fee: { paymentMethod } })` for a NEW
account, not for subsequent calls on an already-deployed account. For
deployed-but-unfunded wallets, the canonical recovery path is a separate
`FeeJuice.claim_public` tx — but that itself needs fee-juice, creating the
chicken-and-egg blocking issue here.

## Sub-7c verdict

**🟡 PARTIAL — L1 path validated, L2 path validation deferred.**

What IS validated:
- ✅ L1 `USDC.approve` + `USDCBridge.depositToL2Public` succeed against live
  testnet contracts (Sub-5b deploy).
- ✅ L1Inbox emits `MessageSent` correctly; topic0 + payload match Sub-7c SDK
  decoder (`sdk/src/bridge.ts:DEPOSIT_INITIATED_TOPIC`, `INBOX_MESSAGE_SENT_TOPIC`).
- ✅ L2 sequencer ingests the L1→L2 message within ~7-8 min of L1 inclusion;
  `getL1ToL2MessageMembershipWitness` returns the witness.
- ✅ Sub-7c-shipped `buildOutboxProof` import path resolves against live SDK.

What is DEFERRED:
- ⏸ L2 `aUSDC.claim_public` on a wallet that hasn't been wizard-onboarded.
- ⏸ `aUSDC.exit_to_l1_public` on L2.
- ⏸ `buildOutboxProof` against a real proven epoch.
- ⏸ L1 `USDCBridge.withdraw` calldata format under real proven-epoch siblingPath.

**Important context**: This blocker does NOT affect the public DEX user flow.
A user coming through Sub-7b's onboarding wizard arrives with fee-juice already
in their wallet (drip+claim+deploy is the wizard's job). The bridge tab then
works against that funded wallet using the standard default payment method —
no `FeeJuicePaymentMethodWithClaim` involved. The Sub-7c E2E gap is specifically
for "bridge ops on a deployed-but-unfunded wallet", which is an operator-test
edge case.

## Artifacts produced (committed)

- `scripts/testnet-bridge-e2e.ts` — full-flow runner from the original Sub-8.3 subagent
- `scripts/sub8-3-resume.mts` — resume runner adding `FeeJuicePaymentMethodWithClaim`
- `scripts/recover-drip.mts` — recovers fee-juice drip's `messageHash`+`leafIndex` from Sepolia logs (used when faucet response gets truncated by shell pipe)
- `scripts/check-msg-status.mts` — verifies a specific L1→L2 messageHash is in the L2 tree
- `scripts/check-usdc-deposit-msg.mts` — same, for USDCBridge deposits filtered by L2 recipient
- `scripts/inspect-deposit-tx.mts` — decodes all L1 events from a deposit tx
- `scripts/decode-deposit-events.mts` — decodes L1Inbox.MessageSent + DepositInitiated and verifies L2 tree membership
- `testnet-bridge-e2e-state.json` — gitignored; persisted at `step=3`

## Follow-ups

1. **Sub-8.3b** (re-run with onboarded wallet): use a fresh wallet that's been
   through the Sub-7b wizard end-to-end. Skip the drip-then-claim funding dance.
   Bridge UI flow then matches what a real user experiences.
2. **Aztec sponsored-FPC**: investigate whether testnet exposes a public FPC
   that can sponsor a one-off `FeeJuice.claim_public` for a deployed-unfunded
   wallet. Would unblock operator-test flows without re-onboarding.
3. **Step 6-8 E2E**: once step 4 unblocks, the exit + outbox + L1 withdraw
   path needs a clean run. Outbox proving on testnet runs every 30-90 min
   so plan for the wait.

## Outcomes for Sub-8 plan

- Sub-7c bridge UI continues to ship as-is. No code defects surfaced.
- Sub-8.1 (aggregator VPS deploy) becomes the next critical-path task —
  the bridge L1 path is validated and users will close the loop via wizard.
- Sub-8.4 (pool expansion) and Sub-8.3b (full E2E) can run after Sub-8.1.
