// sdk/src/orders.ts
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { Fr } from "@aztec/aztec.js/fields";
import type { QuetzalClient } from "./client.js";
import type {
  PlaceOrderInput,
  PlaceOrderResult,
  BulkPlaceOrderInput,
  BulkPlaceOrderResult,
  CurrentEpoch,
  OrderSide,
} from "./types.js";
import { OrderError, ConfigError } from "./errors.js";
import { randomField } from "./util/field.js";
import { recordDecoyBatch, isDecoy } from "./privacy/decoy-registry.js";

export const MAX_ORDERS_PER_BULK = 5;
export const MAX_DECOYS = MAX_ORDERS_PER_BULK - 1;

// ─── Validators ───────────────────────────────────────────────────────────────

export function validatePlaceOrderInput(input: PlaceOrderInput): void {
  if (input.amount <= 0n) {
    throw new OrderError("INVALID_PATH", "amount must be > 0");
  }
  if (input.limitPrice <= 0n) {
    throw new OrderError("INVALID_PATH", "limitPrice must be > 0");
  }
  if (input.path.length < 2 || input.path.length > 3) {
    throw new OrderError("INVALID_PATH", `path must have 2-3 hops; got ${input.path.length}`);
  }
}

export function validateBulkInput(input: BulkPlaceOrderInput): void {
  validatePlaceOrderInput(input);
  if (input.decoyCount < 0 || input.decoyCount > MAX_DECOYS) {
    throw new OrderError(
      "INVALID_PATH",
      `decoyCount must be in [0, ${MAX_DECOYS}]; got ${input.decoyCount}`,
    );
  }
}

// ─── Sub-6c A2: canonical path normalization ──────────────────────────────────
//
// Path-order leaks side: a sell from USDC->ETH used to store [USDC, ETH];
// a buy of USDC from ETH used to store [ETH, USDC]. On-chain observers could
// derive direction from the redundant path encoding. Sub-6c A1 Noir circuit
// asserts path[0] < path[path_len-1] (canonical); A2 (this) transparently
// canonicalizes SDK callers' paths + flips the `side` bool so the semantic
// intent is preserved while the on-chain path no longer leaks direction.
//
// Post-canonical side semantics:
//   side="buy" (false) -> pay path[0] (canonical low), receive path[last] (high)
//   side="sell" (true) -> pay path[last] (high), receive path[0] (low)

export function canonicalizePath(
  side: OrderSide,
  path: string[],
): { side: OrderSide; path: string[] } {
  if (path.length < 2 || path.length > 3) {
    throw new OrderError("INVALID_PATH", `path length must be 2 or 3; got ${path.length}`);
  }
  const lo = BigInt(path[0]);
  const hi = BigInt(path[path.length - 1]);
  if (lo === hi) {
    throw new OrderError("INVALID_PATH", "path endpoints must differ");
  }
  if (lo < hi) return { side, path };
  return {
    side: side === "buy" ? "sell" : "buy",
    path: [...path].reverse(),
  };
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function requireContracts(client: QuetzalClient): NonNullable<typeof client.config.contracts> {
  const c = client.config.contracts;
  if (!c) {
    throw new ConfigError(
      "MISSING_ENV",
      "QuetzalClient.config.contracts not set; pass `contracts` to QuetzalClient.connect()",
    );
  }
  return c;
}

interface PathTriple {
  path_len: 2 | 3;
  pathFields: [Fr, Fr, Fr];
}

function resolvePath(client: QuetzalClient, aliases: string[]): PathTriple {
  const contracts = requireContracts(client);
  const map: Record<string, string | undefined> = {
    tUSDC: contracts.tUSDC,
    tETH: contracts.tETH,
    tBTC: contracts.tBTC,
  };
  if (aliases.length < 2 || aliases.length > 3) {
    throw new OrderError("INVALID_PATH", `path_len must be 2 or 3, got ${aliases.length}`);
  }
  const resolved = aliases.map((a) => {
    const addr = map[a];
    if (!addr) throw new OrderError("INVALID_PATH", `unknown token alias: ${a}`);
    return addr;
  });
  for (let i = 0; i < resolved.length; i++) {
    for (let j = i + 1; j < resolved.length; j++) {
      if (resolved[i] === resolved[j]) {
        throw new OrderError("INVALID_PATH", `path[${i}] == path[${j}]: ${resolved[i]}`);
      }
    }
  }
  const path: [Fr, Fr, Fr] = [
    Fr.fromString(resolved[0]!),
    Fr.fromString(resolved[1]!),
    resolved[2] ? Fr.fromString(resolved[2]) : Fr.ZERO,
  ];
  return { path_len: aliases.length as 2 | 3, pathFields: path };
}

// ─── Public API ───────────────────────────────────────────────────────────────

export class OrdersApi {
  constructor(private client: QuetzalClient) {}

  async placeOrder(input: PlaceOrderInput): Promise<PlaceOrderResult> {
    validatePlaceOrderInput(input);
    const contracts = requireContracts(this.client);
    // Sub-6c A3: canonicalize path BEFORE alias resolution so the side
    // semantics carry through. canonicalizePath operates on the alias
    // strings (compared as BigInt) and returns the canonical {side, path};
    // resolvePath then turns them into Fr fields for the circuit.
    const canonical = canonicalizePath(input.side, input.path);
    const { path_len, pathFields } = resolvePath(this.client, canonical.path);

    const realSide = canonical.side === "sell"; // false = bid, true = ask
    const orderNonce = randomField();
    const txNonce = randomField();

    const { loadOrderbookContract } = await import("./internal/contracts.js");
    const OrderbookContract = await loadOrderbookContract();
    const orderbook = await OrderbookContract.at(
      AztecAddress.fromString(contracts.orderbook),
      this.client.wallet,
    );
    // Cast: codegen bindings may lag the Sub-4 7-arg signature
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tx = await (orderbook.methods.submit_order as any)(
      realSide,
      input.amount,
      input.limitPrice,
      txNonce,
      orderNonce,
      BigInt(path_len),
      pathFields,
    ).send({ from: this.client.address });
    const receipt = (await (tx as { wait?: () => Promise<unknown> }).wait?.()) as
      | { txHash?: { toString: () => string }; blockNumber?: number }
      | undefined;

    let epoch = 0;
    try {
      const epochSim = await orderbook.methods.get_epoch().simulate({ from: this.client.address });
      epoch = Number((epochSim as { result: { epoch_id: bigint } }).result.epoch_id);
    } catch {
      /* best-effort */
    }

    return {
      txHash: receipt?.txHash?.toString() ?? "",
      nonce: txNonce,
      orderNonce,
      epoch,
    };
  }

  async placeOrderBulk(input: BulkPlaceOrderInput): Promise<BulkPlaceOrderResult> {
    validateBulkInput(input);
    const contracts = requireContracts(this.client);
    // Sub-6c A3: same canonicalization treatment as placeOrder. The real
    // order (slot 0) inherits the canonical side; decoys (slots 1..K-1) use
    // unfillable limit-price so direction is irrelevant for them.
    const canonical = canonicalizePath(input.side, input.path);
    const { path_len, pathFields } = resolvePath(this.client, canonical.path);

    const realSide = canonical.side === "sell";
    const decoyCount = input.decoyCount;
    const SLOTS = MAX_ORDERS_PER_BULK;
    const sides: boolean[] = new Array(SLOTS).fill(false);
    const amounts: bigint[] = new Array(SLOTS).fill(0n);
    const limits: bigint[] = new Array(SLOTS).fill(0n);
    const nonces: bigint[] = new Array(SLOTS).fill(0n);
    const orderNonces: bigint[] = new Array(SLOTS).fill(0n);
    const pathLens: number[] = new Array(SLOTS).fill(0);
    const pathArrays: [Fr, Fr, Fr][] = new Array(SLOTS).fill([Fr.ZERO, Fr.ZERO, Fr.ZERO]);

    // Slot 0: real order
    sides[0] = realSide;
    amounts[0] = input.amount;
    limits[0] = input.limitPrice;
    nonces[0] = randomField();
    orderNonces[0] = randomField();
    pathLens[0] = path_len;
    pathArrays[0] = pathFields;

    // Decoys: same amount, unfillable limit price
    // sell: u128::MAX (no one buys at MAX); buy: 1 wei (pool sqrt_p >> 1).
    // Must be > 0 — the orderbook helper asserts limit_price > 0.
    const UNFILLABLE_HIGH = (1n << 128n) - 1n;
    const UNFILLABLE_LOW = 1n;
    for (let i = 1; i <= decoyCount; i++) {
      sides[i] = realSide;
      amounts[i] = input.amount;
      limits[i] = realSide ? UNFILLABLE_HIGH : UNFILLABLE_LOW;
      nonces[i] = randomField();
      orderNonces[i] = randomField();
      pathLens[i] = path_len;
      pathArrays[i] = pathFields;
    }

    const { loadOrderbookContract } = await import("./internal/contracts.js");
    const OrderbookContract = await loadOrderbookContract();
    const orderbook = await OrderbookContract.at(
      AztecAddress.fromString(contracts.orderbook),
      this.client.wallet,
    );
    const bulkOrderbook = orderbook as unknown as {
      methods: {
        submit_order_bulk: (
          side: boolean[],
          amount_in: bigint[],
          limit_price: bigint[],
          nonce: bigint[],
          order_nonce: bigint[],
          path_len: number[],
          path: [Fr, Fr, Fr][],
        ) => { send: (args: { from: AztecAddress }) => { wait?: () => Promise<unknown> } };
      };
    };
    const tx = bulkOrderbook.methods
      .submit_order_bulk(sides, amounts, limits, nonces, orderNonces, pathLens, pathArrays)
      .send({ from: this.client.address });
    const receipt = (await (tx as { wait?: () => Promise<unknown> }).wait?.()) as
      | { txHash?: { toString: () => string } }
      | undefined;

    // Record nonces in maker-local decoy registry
    const entries: Array<{ nonce: string; isDecoy: boolean }> = [
      { nonce: `0x${orderNonces[0]!.toString(16)}`, isDecoy: false },
    ];
    for (let i = 1; i <= decoyCount; i++) {
      entries.push({ nonce: `0x${orderNonces[i]!.toString(16)}`, isDecoy: true });
    }
    recordDecoyBatch(this.client.address.toString(), entries);

    let epoch = 0;
    try {
      const epochSim = await orderbook.methods.get_epoch().simulate({ from: this.client.address });
      epoch = Number((epochSim as { result: { epoch_id: bigint } }).result.epoch_id);
    } catch {
      /* best-effort */
    }

    return {
      txHash: receipt?.txHash?.toString() ?? "",
      realNonce: orderNonces[0]!,
      decoyNonces: orderNonces.slice(1, decoyCount + 1),
      epoch,
    };
  }

  async claimFill(opts: {
    nonce: bigint;
    epoch: number;
    filterDecoys?: boolean;
  }): Promise<{ txHash: string; skipped?: true; reason?: string }> {
    const contracts = requireContracts(this.client);
    const filterDecoys = opts.filterDecoys !== false;
    const nonceHex = new Fr(opts.nonce).toString();
    if (filterDecoys && isDecoy(this.client.address.toString(), nonceHex)) {
      return { txHash: "", skipped: true, reason: "known decoy (amount_out=0)" };
    }
    const { loadOrderbookContract } = await import("./internal/contracts.js");
    const OrderbookContract = await loadOrderbookContract();
    const orderbook = await OrderbookContract.at(
      AztecAddress.fromString(contracts.orderbook),
      this.client.wallet,
    );
    // Plain Sub-1 claim_fill(nonce, epoch). Hop-fill (Sub-4) claims are intentionally
    // left to the CLI's claim.ts for now — see CLI command for snapshot-based proof
    // construction; SDK ergonomics for that path are tracked as a follow-up.
    const orderbookDyn = orderbook as unknown as {
      methods: {
        claim_fill: (
          nonce: bigint,
          epoch: number,
        ) => { send: (args: { from: AztecAddress }) => { wait?: () => Promise<unknown> } };
      };
    };
    const tx = orderbookDyn.methods
      .claim_fill(opts.nonce, opts.epoch)
      .send({ from: this.client.address });
    const receipt = (await (tx as { wait?: () => Promise<unknown> }).wait?.()) as
      | { txHash?: { toString: () => string } }
      | undefined;
    return { txHash: receipt?.txHash?.toString() ?? "" };
  }

  async cancelOrder(opts: { nonce: bigint }): Promise<{ txHash: string }> {
    const contracts = requireContracts(this.client);
    const { loadOrderbookContract } = await import("./internal/contracts.js");
    const OrderbookContract = await loadOrderbookContract();
    const orderbook = await OrderbookContract.at(
      AztecAddress.fromString(contracts.orderbook),
      this.client.wallet,
    );
    // authwit nonce MUST be 0n: cancel_order calls transfer_public_to_private
    // with from=orderbook.address; self-call requires nonce==0 (authorize_once).
    const tx = await orderbook.methods
      .cancel_order(opts.nonce, 0n)
      .send({ from: this.client.address });
    const receipt = (await (tx as { wait?: () => Promise<unknown> }).wait?.()) as
      | { txHash?: { toString: () => string } }
      | undefined;
    return { txHash: receipt?.txHash?.toString() ?? "" };
  }

  /**
   * Plain epoch advance (no clearing proof).  For the verified path that
   * applies a ZK clearing proof, use `closeEpochVerified`.
   */
  async closeEpoch(_opts: { epoch?: number } = {}): Promise<CurrentEpoch> {
    const contracts = requireContracts(this.client);
    const { loadOrderbookContract } = await import("./internal/contracts.js");
    const OrderbookContract = await loadOrderbookContract();
    const orderbook = await OrderbookContract.at(
      AztecAddress.fromString(contracts.orderbook),
      this.client.wallet,
    );
    await orderbook.methods.close_epoch().send({ from: this.client.address });

    const sim = await orderbook.methods.get_epoch().simulate({ from: this.client.address });
    const epoch = (sim as { result: { epoch_id: bigint; closes_at_block: bigint } }).result;
    return {
      epoch_id: Number(epoch.epoch_id),
      closes_at_block: Number(epoch.closes_at_block),
    };
  }

  /**
   * Verified close-epoch: submits a recursive ZK clearing proof + applies clearing.
   * Inputs are the parsed proof / vk / public-inputs payloads (callers normalize
   * file reads in their own layer).
   */
  async closeEpochVerified(opts: {
    proofFields: Fr[];
    vkFields: Fr[];
    publicInputs: unknown;
  }): Promise<CurrentEpoch> {
    const contracts = requireContracts(this.client);
    const { loadOrderbookContract } = await import("./internal/contracts.js");
    const OrderbookContract = await loadOrderbookContract();
    const orderbook = await OrderbookContract.at(
      AztecAddress.fromString(contracts.orderbook),
      this.client.wallet,
    );
    const orderbookDyn = orderbook as unknown as {
      methods: {
        close_epoch_and_clear_verified: (
          publicInputs: unknown,
          proof: Fr[],
          vk: Fr[],
        ) => { send: (args: { from: AztecAddress }) => { wait?: () => Promise<unknown> } };
      };
    };
    await orderbookDyn.methods
      .close_epoch_and_clear_verified(opts.publicInputs, opts.proofFields, opts.vkFields)
      .send({ from: this.client.address });

    const sim = await orderbook.methods.get_epoch().simulate({ from: this.client.address });
    const epoch = (sim as { result: { epoch_id: bigint; closes_at_block: bigint } }).result;
    return {
      epoch_id: Number(epoch.epoch_id),
      closes_at_block: Number(epoch.closes_at_block),
    };
  }
}

export { Fr };
