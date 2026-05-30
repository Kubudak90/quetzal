# Audit Fix — Batch B Deploy Runbook

Status: DRAFT (assembled while fixes land). Batch A (off-chain security: #5/#6/#7/#8) is
already complete + verified. Batch B is the contract/circuit + L1 redeploy. This runbook is
the ordered operator procedure to verify, recompile, re-prove, redeploy, and smoke-test.

## VERIFIED FACTS (2026-05-30, supersede the draft below)
- **Toolchain**: there is ONE nargo, **1.0.0-beta.19** (both standalone AND inside the
  `aztecprotocol/aztec:4.2.1` Docker image used by `aztec-nargo` / `compile-all.sh`). The
  earlier "beta.11" was fabricated.
- **poseidon MUST be v0.3.0**, NOT v0.2.3. v0.2.3 fails under this nargo with
  `Comptime global RATE used in non-comptime code` (+ `poseidon2_permutation` arity). The
  fix `circuits/clearing/Nargo.toml` tag = **v0.3.0** is already applied. (v0.3.0 `Poseidon2::hash`
  is byte-identical to `@aztec/foundation poseidon2Hash` -- verified with a +/- probe.)
- **New clearing vk_hash to pin on deploy: `01c0837f90eb26a2f808b49d319321108e8f15985c4c23518228937be12d1b99`**
  (scheme ultra_honk; the redeploy scripts read it from `circuits/clearing/target/vk.bin/vk_hash`).
- **#1 proof binding (DONE in code, validated locally)**: orderbook `close_epoch_and_clear_verified`
  now `proof:[Field;500]`, `vk:[Field;115]`, calls
  `std::verify_proof_with_type(vk, proof, flatten_clearing_public(public_inputs), vk_hash, 6)`.
  `6 = PROOF_TYPE_HONK_ZK`. Aggregator `bb prove` cmd is now `-k target/vk.bin/vk -t noir-recursive`
  and the `bridgeProof/bridgeVk` truncation to 456/127 is removed (now full 500/115). Empirically
  proved: a real proof verifies; a one-field public-input tamper -> "verification failed".
- **Pool constructor** gained an `admin: AztecAddress` arg (#3). Deploy scripts already pass it;
  `set_orderbook` must be called `from = admin`.

## Toolchain facts (DRAFT -- partially WRONG, see VERIFIED FACTS above)
- **Run Noir compiles SERIALLY.** Concurrent `aztec-nargo` (Docker) compiles on macOS Docker
  Desktop intermittently crash with `stack overflow` (exit 133). One at a time succeeds.
- All Noir comments must be **ASCII only** (nargo rejects non-ASCII em-dash / curly quotes).
- L1 (`contracts-l1`) uses `forge` (real binary). `bb` available for proving.

## Findings in Batch B
| # | Sev | Area | Needs recompile | Needs redeploy |
|---|-----|------|-----------------|----------------|
| #1 | CRIT | proof not bound to public inputs | circuit + orderbook | yes (new vk_hash) |
| #2 | HIGH | order_acc 3-way shape mismatch | circuit + orderbook | yes |
| #3 | HIGH | pool set_orderbook race | pool | yes (new ctor arg) |
| #12 | MED | orderbook pool_count seed bound | orderbook | yes |
| #9 | MED | L1 deposit zero-l2-token | forge (done) | L1 redeploy OR just call setL2TokenAddress |
| #10 | MED | L1 deposit truncation/overwrite | forge (done) | L1 redeploy (struct widened) |
| #4 | HIGH | build gate | n/a (use aztec-nargo) | no |
| #11 | MED | aggregator pool-0 hardcode | no | no (daemon restart) |

## Step 0 — pre-flight (local, serial)
1. Ensure no agent/process is running Docker. `docker ps` should be idle.
2. `git status` — confirm only the intended audit files are modified.

## Step 1 — compile Noir contracts + circuit (SERIAL, aztec-nargo)
Run each, one at a time, confirm a `target/*.json` artifact is produced:
```
cd contracts/pool        && aztec-nargo compile && ls -la target/*.json
cd contracts/orderbook   && aztec-nargo compile && ls -la target/*.json
cd circuits/clearing     && aztec-nargo compile && ls -la target/*.json   # bin crate
```
If any non-ASCII comment error: fix the char, re-run.

## Step 2 — #2 cross-site hash equality (BEFORE proving)
Node script: compute `order_acc` for 2 sample orders three ways (contract submit_order formula,
aggregator `computeCi`+fold, and a JS replication of `binding::replay_chain_with_path`). All three
MUST match. (The 10-field hiding c_i: `[owner, side01, amount_in, limit_price, order_nonce,
submitted_at_block, path_len, path0, path1, path2]`, then `acc = poseidon2([acc, c_i])`.)

## Step 3 — #1 proof binding (DONE in code; orderbook recompiled clean)
Implemented as raw `std::verify_proof_with_type(vk, proof, flatten_clearing_public(public_inputs),
vk_hash, 6)`. The `bb_proof_verification::verify_honk_proof` library is NOT in the 4.2.1 image (it
lands in v4.3.0), so the raw stdlib call with `proof_type = 6` (PROOF_TYPE_HONK_ZK) is used -- which
is exactly what verify_honk_proof does internally. Already VALIDATED locally with a recursion-harness
`bb prove` (positive verifies; a one-field public-input tamper -> bb verify "verification failed at
reduction step"). Nothing to implement here; the on-chain end-to-end check is Step 8.

## Step 4 — regen TS bindings + vk_hash
```
pnpm codegen            # picks up new pool ctor arg (admin) + orderbook changes
# recompute clearing vk_hash from the freshly proven circuit; update deploy config
```

## Step 5 — align integration tests (#4)
`tests/integration/*.test.ts` break on the new constructor arities + order_acc shape +
`close_epoch_and_clear` rename. Update them to the new ABI (do NOT weaken assertions). Run the
non-Docker unit-level ones; full TXE suite is Docker-gated.

## Step 6 — testnet redeploy (operator)
Use the existing redeploy scripts (now passing pool `admin` arg). Order: tokens → pools →
orderbook → treasury (set_treasury) → set_orderbook(pool, from=admin) for each pool →
aggregator registry. Update `quetzal.config.json` + Vercel/VPS envs with new addresses.

## Step 7 — L1 bridge operator action (#9)
**REQUIRED after the L1 fix**: every `depositToL2Public/Private` now REVERTS with `L2TokenNotSet()`
until governance calls `setL2TokenAddress(<real L2 token>)` for EACH of the 3 bridges
(usdc/weth/wbtc). Call it before announcing the bridge live, or users see reverts. (If the L1
contracts are redeployed for #10's struct change, redeploy then immediately setL2TokenAddress.)

## Step 8 — smoke: exercise close_epoch_and_clear_verified for the FIRST time
This is the whole point of Batch B — the verified clearing path has never worked (it reverted on
#2). After redeploy: submit a real order on pool 0, let the epoch close, have the bonded
aggregator build the witness + bb prove + submit `close_epoch_and_clear_verified`. Confirm it
lands (not the `close_epoch()` fallback). This is the acceptance test for #1+#2 together.

## Step 9 — #11 aggregator routing
Add `path[]` to the reveal payload + forward through clearing-cycle; pool-0 fallback only when
path absent + warn. Restart aggregator on VPS. Low public-testnet urgency (only pool 0 seeded).
