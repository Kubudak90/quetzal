// sdk/src/reads.ts
import type { QuetzalClient } from "./client.js";

export interface OrderViewModel {
  nonce: string;
  side: "buy" | "sell";
  amount: string;
  limitPrice: string;
  status: "open" | "filled" | "cancelled";
}

export interface PoolViewModel {
  poolId: number;
  tokenA: string;
  tokenB: string;
  reserveA: string;
  reserveB: string;
}

export class ReadsApi {
  constructor(private client: QuetzalClient) {}

  async getOrders(): Promise<OrderViewModel[]> {
    throw new Error("getOrders not yet implemented (Task 2.8 lifts CLI body)");
  }

  async getPools(): Promise<PoolViewModel[]> {
    throw new Error("getPools not yet implemented (Task 2.8 lifts CLI body)");
  }

  async getCurrentEpoch(): Promise<number> {
    throw new Error("getCurrentEpoch not yet implemented (Task 2.8 lifts CLI body)");
  }

  async getBalance(token: string): Promise<bigint> {
    void token;
    throw new Error("getBalance not yet implemented (Task 2.8 lifts CLI body)");
  }
}
