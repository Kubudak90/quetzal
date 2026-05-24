// sdk/src/types.ts

export type OrderSide = "buy" | "sell";

export type NetworkName = "alpha-testnet" | "sandbox" | "mainnet";

export interface NetworkConfig {
  name: NetworkName;
  nodeUrl: string;
  l1?: {
    rpcUrl: string;
    privateKey?: string;
    makerAddr?: string;
  };
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

export interface BulkPlaceOrderInput extends PlaceOrderInput {
  decoyCount: number;
}

export interface BulkPlaceOrderResult {
  txHash: string;
  realNonce: bigint;
  decoyNonces: bigint[];
  epoch: number;
}
