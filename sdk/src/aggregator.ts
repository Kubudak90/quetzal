// sdk/src/aggregator.ts
import type { QuetzalClient } from "./client.js";

export class AggregatorApi {
  constructor(private client: QuetzalClient) {}

  async register(opts: { stake: bigint }): Promise<{ txHash: string }> {
    void opts;
    throw new Error("register not yet implemented (Task 2.8 lifts CLI body)");
  }

  async broadcastReveal(opts: { epoch: number }): Promise<{ txHash: string }> {
    void opts;
    throw new Error("broadcastReveal not yet implemented (Task 2.8 lifts CLI body)");
  }
}
