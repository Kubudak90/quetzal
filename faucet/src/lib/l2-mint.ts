// Sub-7a Task 12: L2 mint wrapper for operator-mintable tUSDC + tETH.
//
// Boots an EmbeddedWallet against the Aztec testnet node, recreates the
// operator's deterministic Schnorr account from FAUCET_L2_SECRET, and calls
// Token.mint_to_public(recipient, amount) for either tUSDC or tETH.
//
// ── Deviations from Task 12 plan's starting-point implementation ──────────
//
// 1. **Use the codegen'd TokenContract binding directly — NOT
//    `loadContractArtifact(TokenContractArtifactJson)` + untyped
//    `Contract.at`.** The plan's starting-point statically imported the
//    raw JSON artifact and used the untyped Contract base. Cleaner approach
//    used by every other script in this repo (scripts/testnet-m2-token.ts,
//    scripts/deploy-tokens.ts, …) is to import the typed
//    `TokenContract` class from `tests/integration/generated/Token.js`,
//    which itself transitively pulls the JSON artifact. Gives us type-safe
//    `mint_to_public` + `balance_of_public` calls.
//
//    NOTE: this introduces a build-order constraint already imposed
//    everywhere else in the repo:
//      pnpm compile        # produces contracts/*/target/*.json (gitignored)
//      pnpm codegen        # produces tests/integration/generated/*.ts (tracked)
//    On a fresh clone WITHOUT step 1, the JSON file doesn't exist and
//    `next build` / typecheck fail. CI runs both steps; the faucet
//    Dockerfile (Task 17) copies the compiled contracts directory in
//    before `next build`.
//
// 2. **mint_to_public takes bigint directly, not U128Like.** The plan
//    referenced U128Like but the codegen'd signature in
//    tests/integration/generated/Token.ts:184 is:
//      mint_to_public(to: AztecAddressLike, amount: (bigint | number))
//    so we pass `amount: bigint` directly.
//
// 3. **Pass `wallet` to TokenContract.at, not `account`.** The plan cast
//    `account as unknown as Wallet` — EmbeddedWallet extends BaseWallet
//    which IS the Wallet interface, so we pass the wallet itself, the same
//    way scripts/testnet-m2-token.ts:89 does. `account.getAddress()` is
//    only used for the `from:` field of `.send({ from })`.
//
// 4. **`from:` field is required.** The PXE multi-account wallet needs to
//    know which registered account is sending; the codegen'd
//    ContractFunctionInteraction.send takes `{ from: AztecAddress }`.
//    The plan's starting-point omitted `from` — would throw at runtime.
//
// 5. **walletPromise is cached per-process (per nodeUrl+operatorSecret).**
//    EmbeddedWallet.create boots the PXE (~5-10s + LMDB open), so the
//    singleton avoids re-paying on every mint request. `ephemeral: false`
//    persists the wallet DB on disk between server restarts.
//
// 6. **proverEnabled: true is required.** The testnet node reports
//    `realProofs: true` and rejects txs that don't carry real ClientIVC
//    proofs. Same configuration used by every other testnet wallet in
//    this repo (scripts/testnet-m2-token.ts, scripts/lib/aztec-wallet-bootstrap.ts).

import { Fr } from "@aztec/aztec.js/fields";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { createAztecNodeClient, waitForNode } from "@aztec/aztec.js/node";
import { EmbeddedWallet } from "@aztec/wallets/embedded";
import { TokenContract } from "../../../tests/integration/generated/Token.js";

// Token decimals are baked into the operator-mintable tokens at deploy time.
// These match the constructor arguments used by scripts/deploy-tokens.ts and
// scripts/testnet-m2-token.ts for the live testnet deploys whose addresses
// live in quetzal.config.json (l2.tUSDC, l2.tETH).
export const L2_TOKEN_DECIMALS = { tUSDC: 6, tETH: 18 } as const;

export interface L2MintOpts {
  /** Aztec node JSON-RPC URL (e.g. https://rpc.testnet.aztec-labs.com). */
  nodeUrl: string;
  /**
   * Operator Schnorr secret as hex Fr (32 bytes). Same value as
   * FAUCET_L2_SECRET / quetzal.config.json:admin. The account is assumed to
   * already be deployed on L2 — we don't run `accountManager.deploy()` here.
   */
  operatorSecret: `0x${string}`;
  /** Token contract address on L2. */
  tokenAddress: `0x${string}`;
}

export interface MintResult {
  txHash: string;
}

// Singleton wallet+account cache. Boot cost is high (~5-10s + LMDB open).
// Keyed by nodeUrl+operatorSecret so multiple operator wallets could coexist
// in theory (we expect exactly one in the faucet today).
type WalletEntry = {
  wallet: EmbeddedWallet;
  operatorAddress: AztecAddress;
};
const walletCache = new Map<string, Promise<WalletEntry>>();

function cacheKey(nodeUrl: string, operatorSecret: `0x${string}`): string {
  // operatorSecret is hex-encoded Fr; safe in a key with no separator collisions.
  return `${nodeUrl}::${operatorSecret}`;
}

/**
 * Internal: boot the EmbeddedWallet + recreate the operator's Schnorr account.
 * Cached per (nodeUrl, operatorSecret). Bootstrapping the wallet is slow
 * (~5-10s) and creates an on-disk LMDB store — we pay it once per process.
 */
async function getWalletEntry(
  nodeUrl: string,
  operatorSecret: `0x${string}`,
): Promise<WalletEntry> {
  const key = cacheKey(nodeUrl, operatorSecret);
  const existing = walletCache.get(key);
  if (existing) return existing;

  const entryPromise = (async (): Promise<WalletEntry> => {
    const node = createAztecNodeClient(nodeUrl);
    await waitForNode(node);
    const wallet = await EmbeddedWallet.create(node, {
      ephemeral: false,
      pxe: { proverEnabled: true },
    });
    // Salt is Fr.ZERO and signingKey defaults to a deterministic-from-secret
    // value via createSchnorrAccount(secret, salt). The operator account must
    // already be deployed on L2 (out-of-band, via the same M1 bootstrap flow
    // used in scripts/testnet-m1-hello.ts).
    const accountManager = await wallet.createSchnorrAccount(
      Fr.fromString(operatorSecret),
      Fr.ZERO,
    );
    const operatorAddress = (await accountManager.getAccount()).getAddress();
    return { wallet, operatorAddress };
  })().catch((err) => {
    // Don't poison the cache on boot failure — let the next call retry.
    walletCache.delete(key);
    throw err;
  });

  walletCache.set(key, entryPromise);
  return entryPromise;
}

/**
 * Internal: instantiate TokenContract bound to the operator's wallet.
 * The wallet is the SendOptions sender; the `from:` AztecAddress is added
 * at .send() time.
 */
async function getToken(opts: L2MintOpts): Promise<{
  operatorAddress: AztecAddress;
  token: TokenContract;
}> {
  const { wallet, operatorAddress } = await getWalletEntry(
    opts.nodeUrl,
    opts.operatorSecret,
  );
  const token = await TokenContract.at(AztecAddress.fromString(opts.tokenAddress), wallet);
  return { operatorAddress, token };
}

/**
 * Mint `amount` (atomic units, no decimal scaling) of the token at
 * `opts.tokenAddress` to `to`. Returns the L2 tx hash on inclusion.
 *
 * `amount` is the on-chain field value — callers MUST scale by
 * L2_TOKEN_DECIMALS[symbol] themselves (e.g. 100 tUSDC → 100_000_000n at
 * 6 decimals). This matches the calling convention of every other
 * mint_to_public callsite in the repo (scripts/testnet-m2-token.ts:96).
 */
export async function mintToPublic(
  opts: L2MintOpts,
  to: `0x${string}`,
  amount: bigint,
): Promise<MintResult> {
  if (amount <= 0n) {
    throw new Error(`[l2-mint] amount must be positive (got ${amount})`);
  }
  const { operatorAddress, token } = await getToken(opts);
  // send() defaults to `wait: undefined` → waits for mining and returns
  // { receipt: TxReceipt, offchainEffects, offchainMessages }. Pre-4.x
  // API used .send().wait(); 4.2.1 collapsed both into a single await.
  const sent = await token.methods
    .mint_to_public(AztecAddress.fromString(to), amount)
    .send({ from: operatorAddress });
  return { txHash: sent.receipt.txHash.toString() };
}

/**
 * Read the operator's public balance for the token at `opts.tokenAddress`.
 * Used by the drain-detection / Prometheus balance gauge (Task 13).
 *
 * Returns the raw field value (atomic units, no decimal scaling).
 */
export async function getOperatorL2Balance(opts: L2MintOpts): Promise<bigint> {
  const { operatorAddress, token } = await getToken(opts);
  // simulate() returns SimulationResult { result: any, offchainEffects, … };
  // for balance_of_public the field result is a bigint/number. Unwrap
  // defensively in case a future SDK version inlines (matches the
  // safeguard in scripts/testnet-m2-token.ts:109-110).
  const sim = await token.methods
    .balance_of_public(operatorAddress)
    .simulate({ from: operatorAddress });
  const raw =
    typeof sim === "object" && sim !== null && "result" in sim
      ? (sim as { result: bigint | number }).result
      : (sim as unknown as bigint | number);
  return BigInt(raw);
}

/**
 * Test/teardown helper — clears the wallet cache. Not needed in the live
 * faucet (the process lives for the server's lifetime), but useful in
 * integration tests that boot multiple wallets sequentially.
 */
export function _resetCachesForTesting(): void {
  walletCache.clear();
}
