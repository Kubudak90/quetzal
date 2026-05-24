// sdk/src/orders.ts
import { Fr } from "@aztec/aztec.js/fields";
import type { QuetzalClient } from "./client.js";
import type {
  PlaceOrderInput,
  PlaceOrderResult,
  BulkPlaceOrderInput,
  BulkPlaceOrderResult,
} from "./types.js";
import { OrderError } from "./errors.js";

export const MAX_ORDERS_PER_BULK = 5;
export const MAX_DECOYS = MAX_ORDERS_PER_BULK - 1;

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

export class OrdersApi {
  constructor(private client: QuetzalClient) {}

  async placeOrder(input: PlaceOrderInput): Promise<PlaceOrderResult> {
    validatePlaceOrderInput(input);
    throw new OrderError("UNKNOWN", "placeOrder not yet implemented (Task 2.8 lifts CLI body)");
  }

  async placeOrderBulk(input: BulkPlaceOrderInput): Promise<BulkPlaceOrderResult> {
    validateBulkInput(input);
    throw new OrderError("UNKNOWN", "placeOrderBulk not yet implemented (Task 2.8 lifts CLI body)");
  }

  async claimFill(opts: {
    nonce: bigint;
    epoch: number;
    filterDecoys?: boolean;
  }): Promise<{ txHash: string }> {
    void opts;
    throw new OrderError("UNKNOWN", "claimFill not yet implemented (Task 2.8 lifts CLI body)");
  }

  async cancelOrder(opts: { nonce: bigint }): Promise<{ txHash: string }> {
    void opts;
    throw new OrderError("UNKNOWN", "cancelOrder not yet implemented (Task 2.8 lifts CLI body)");
  }
}

export { Fr };
