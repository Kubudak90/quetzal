// sdk/src/reads.ts
import { AztecAddress } from "@aztec/aztec.js/addresses";
import type { QuetzalClient } from "./client.js";
import type { CurrentEpoch, CurrentEpochFull, QuetzalContracts } from "./types.js";
import { ConfigError } from "./errors.js";

export interface OrderViewModel {
  nonce: bigint;
  side: boolean;
  amount_in: bigint;
  limit_price: bigint;
  submitted_at_block: bigint;
}

export interface PoolViewModel {
  pool_id: number;
  token_a: string;
  token_b: string;
  address: string;
}

export interface PositionViewModel {
  bucket_id: number;
  nonce: bigint;
  lp_share: bigint;
  cum_fee_a_per_share_at_deposit: bigint;
  cum_fee_b_per_share_at_deposit: bigint;
}

function requireContracts(client: QuetzalClient): QuetzalContracts {
  const c = client.config.contracts;
  if (!c) {
    throw new ConfigError(
      "MISSING_ENV",
      "QuetzalClient.config.contracts not set; pass `contracts` to QuetzalClient.connect()",
    );
  }
  return c;
}

export class ReadsApi {
  constructor(private client: QuetzalClient) {}

  /**
   * List all resting orders for the connected account.
   *
   * Returns the raw OrderNote fields exposed by the orderbook (nonce, side,
   * amount_in, limit_price, submitted_at_block). Callers format these for
   * display (see CLI's orders command for the canonical formatting).
   */
  async getOrders(): Promise<OrderViewModel[]> {
    const contracts = requireContracts(this.client);
    const { loadOrderbookContract } = await import("./internal/contracts.js");
    const OrderbookContract = await loadOrderbookContract();
    const orderbook = await OrderbookContract.at(
      AztecAddress.fromString(contracts.orderbook),
      this.client.wallet,
    );
    const sim = await orderbook.methods
      .get_orders(this.client.address)
      .simulate({ from: this.client.address });
    const bv = (sim as { result: { storage: unknown[]; len: bigint | number } }).result;
    const len = Number(bv.len);
    return bv.storage.slice(0, len).map((o) => {
      const r = o as Record<string, bigint | number | boolean>;
      return {
        nonce: BigInt(r.nonce as bigint),
        side: Boolean(r.side),
        amount_in: BigInt(r.amount_in as bigint),
        limit_price: BigInt(r.limit_price as bigint),
        submitted_at_block: BigInt(r.submitted_at_block as bigint),
      };
    });
  }

  /**
   * Return the configured pool registry.  Pure-config read — no PXE call.
   */
  async getPools(): Promise<PoolViewModel[]> {
    const contracts = requireContracts(this.client);
    return contracts.pools.map((p) => ({
      pool_id: p.pool_id,
      token_a: p.token_a,
      token_b: p.token_b,
      address: p.address,
    }));
  }

  /**
   * Read the orderbook's current epoch (id + close-at-block).
   */
  async getCurrentEpoch(): Promise<CurrentEpoch> {
    const contracts = requireContracts(this.client);
    const { loadOrderbookContract } = await import("./internal/contracts.js");
    const OrderbookContract = await loadOrderbookContract();
    const orderbook = await OrderbookContract.at(
      AztecAddress.fromString(contracts.orderbook),
      this.client.wallet,
    );
    const sim = await orderbook.methods.get_epoch().simulate({ from: this.client.address });
    const epoch = (sim as { result: { epoch_id: bigint; closes_at_block: bigint } }).result;
    return {
      epoch_id: Number(epoch.epoch_id),
      closes_at_block: Number(epoch.closes_at_block),
    };
  }

  /**
   * Sub-9.3: read the orderbook's full epoch state — id, close-at-block, and the
   * `(order_acc, order_count, cancel_acc, cancel_count)` binding accumulators
   * the clearing circuit's public inputs are bound against.
   *
   * Returns `order_acc` / `cancel_acc` as 0x-prefixed Field hex strings so the
   * shape stays JSON-friendly across the aggregator boundary. Callers parse
   * back via `Fr.fromString`.
   */
  async getCurrentEpochFull(): Promise<CurrentEpochFull> {
    const contracts = requireContracts(this.client);
    const { loadOrderbookContract } = await import("./internal/contracts.js");
    const OrderbookContract = await loadOrderbookContract();
    const orderbook = await OrderbookContract.at(
      AztecAddress.fromString(contracts.orderbook),
      this.client.wallet,
    );
    const sim = await orderbook.methods.get_epoch().simulate({ from: this.client.address });
    const epoch = (sim as {
      result: {
        epoch_id: bigint;
        closes_at_block: bigint;
        order_acc: { toString: () => string } | bigint;
        cancel_acc: { toString: () => string } | bigint;
        order_count: bigint | number;
        cancel_count: bigint | number;
      };
    }).result;
    // order_acc / cancel_acc come back as Fr-like or bigint depending on
    // simulator decoder; normalise to "0x…" hex.
    const toHex = (v: { toString: () => string } | bigint | number): string => {
      if (typeof v === "bigint") return "0x" + v.toString(16);
      if (typeof v === "number") return "0x" + BigInt(v).toString(16);
      const s = v.toString();
      return s.startsWith("0x") ? s : "0x" + BigInt(s).toString(16);
    };
    return {
      epoch_id: Number(epoch.epoch_id),
      closes_at_block: Number(epoch.closes_at_block),
      order_acc: toHex(epoch.order_acc),
      order_count: Number(epoch.order_count),
      cancel_acc: toHex(epoch.cancel_acc),
      cancel_count: Number(epoch.cancel_count),
    };
  }

  /**
   * List LP positions for the connected account in a specific pool.
   */
  async getPositions(opts: { poolId?: number } = {}): Promise<PositionViewModel[]> {
    const contracts = requireContracts(this.client);
    const poolId = opts.poolId ?? 0;
    const poolEntry = contracts.pools[poolId];
    if (!poolEntry) throw new ConfigError("UNKNOWN", `pool_id ${poolId} not found in contracts.pools`);
    const { loadLiquidityPoolContract } = await import("./internal/contracts.js");
    const LiquidityPoolContract = await loadLiquidityPoolContract();
    const pool = await LiquidityPoolContract.at(
      AztecAddress.fromString(poolEntry.address),
      this.client.wallet,
    );
    const sim = await pool.methods
      .get_positions(this.client.address)
      .simulate({ from: this.client.address });
    const bv = (sim as { result: { storage: unknown[]; len: bigint | number } }).result;
    const len = Number(bv.len);
    return bv.storage.slice(0, len).map((o) => {
      const r = o as Record<string, bigint | number>;
      return {
        bucket_id: Number(r.bucket_id),
        nonce: BigInt(r.nonce),
        lp_share: BigInt(r.lp_share),
        cum_fee_a_per_share_at_deposit: BigInt(r.cum_fee_a_per_share_at_deposit),
        cum_fee_b_per_share_at_deposit: BigInt(r.cum_fee_b_per_share_at_deposit),
      };
    });
  }

  /**
   * Read a Token contract balance (public). For private balances, callers
   * must use the wallet's PXE directly (private notes are PXE-local).
   */
  async getBalance(token: string): Promise<bigint> {
    const contracts = requireContracts(this.client);
    const map: Record<string, string | undefined> = {
      tUSDC: contracts.tUSDC,
      aUSDC: contracts.tUSDC,
      tETH: contracts.tETH,
      aWETH: contracts.tETH,
      tBTC: contracts.tBTC,
      aWBTC: contracts.tBTC,
    };
    const addr = map[token];
    if (!addr) throw new ConfigError("UNKNOWN_TOKEN", `unknown token alias: ${token}`);
    const { loadTokenContract } = await import("./internal/contracts.js");
    const TokenContract = await loadTokenContract();
    const tokenContract = await TokenContract.at(
      AztecAddress.fromString(addr),
      this.client.wallet,
    );
    const sim = await tokenContract.methods
      .balance_of_public(this.client.address)
      .simulate({ from: this.client.address });
    return BigInt((sim as { result: bigint }).result);
  }
}
