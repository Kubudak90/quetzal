// sdk/src/types.ts

export type OrderSide = "buy" | "sell";

export type NetworkName = "alpha-testnet" | "sandbox" | "mainnet";

export interface QuetzalPoolEntry {
  pool_id: number;
  token_a: string;
  token_b: string;
  address: string;
}

export interface QuetzalContracts {
  orderbook: string;
  tUSDC: string;
  tETH: string;
  tBTC?: string;
  pools: QuetzalPoolEntry[];
  admin?: string;
  aggregatorRegistry?: string;
  treasury?: string;
}

export interface NetworkConfigL1 {
  rpcUrl?: string;
  privateKey?: string;
  makerAddr?: string;
  usdcBridge?: string;
  wethBridge?: string;
  wbtcBridge?: string;
}

export interface NetworkConfig {
  name: NetworkName;
  nodeUrl: string;
  l1?: NetworkConfigL1;
  /**
   * Optional Quetzal protocol deployment metadata.  When present, the SDK
   * APIs (OrdersApi, BridgeApi, ReadsApi, AggregatorApi) can resolve
   * contract addresses + token aliases without the caller passing them on
   * every method call.
   */
  contracts?: QuetzalContracts;
}

export interface ScheduledExit {
  id: string;
  token: string;
  amount: string;
  l1Recipient: string;
  submitAfterUnix: number;
  status: "pending" | "submitted" | "l1_claimable" | "done";
  l2TxHash: string | null;
  l2EpochAtSubmit: number | null;
  createdAtUnix: number;
}

export interface PlaceOrderInput {
  side: OrderSide;
  amount: bigint;
  limitPrice: bigint;
  path: string[];
}

export interface PlaceOrderResult {
  txHash: string;
  nonce: bigint;
  orderNonce: bigint;
  epoch: number;
  blockNumber: number;
}

export interface CurrentEpoch {
  epoch_id: number;
  closes_at_block: number;
}

/**
 * Sub-9.3: full epoch state read for the aggregator clearing loop.
 *
 * Mirror of `contracts/orderbook/src/main.nr::EpochState` (subset relevant to
 * off-chain consumers; we drop `state` and `opened_at_block` since they're
 * implied by the open/closing/settled state machine).
 *
 * `order_acc` and `cancel_acc` are returned as 0x-prefixed hex strings so the
 * SDK keeps a single JSON-safe wire shape across boundaries (the aggregator
 * parses them back to `Fr` via `Fr.fromString`).
 */
export interface CurrentEpochFull {
  epoch_id: number;
  closes_at_block: number;
  order_acc: string;       // 0x-prefixed Field hex
  order_count: number;
  cancel_acc: string;      // 0x-prefixed Field hex
  cancel_count: number;
}

export interface BulkPlaceOrderInput extends PlaceOrderInput {
  decoyCount: number;
}

export interface BulkPlaceOrderResult {
  txHash: string;
  realNonce: bigint;
  decoyNonces: bigint[];
  epoch: number;
  blockNumber: number;
}
