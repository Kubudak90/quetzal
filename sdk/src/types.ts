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
}

export interface CurrentEpoch {
  epoch_id: number;
  closes_at_block: number;
}

export interface BulkPlaceOrderInput extends PlaceOrderInput {
  decoyCount: number;
}

export interface BulkPlaceOrderResult {
  txHash: string;
  realNonce: bigint;
  decoyNonces: bigint[];
  epoch: number;
}
