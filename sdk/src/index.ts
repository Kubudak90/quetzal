// sdk/src/index.ts
// @quetzal/sdk — programmatic API for the Quetzal dark-pool DEX on Aztec.
export const VERSION = "0.1.0";

export { QuetzalClient } from "./client.js";
export type { AccountSpec, QuetzalClientConnectOptions } from "./client.js";

export { OrdersApi, MAX_ORDERS_PER_BULK, MAX_DECOYS } from "./orders.js";
export { BridgeApi, validateBridgeExitInput } from "./bridge.js";
export type {
  BridgeDepositInput,
  BridgeDepositResult,
  BridgeClaimInput,
  BridgeExitInput,
  BridgeTickInput,
} from "./bridge.js";
export { ReadsApi } from "./reads.js";
export type { OrderViewModel, PoolViewModel, PositionViewModel } from "./reads.js";
export { AggregatorApi, hashUrl } from "./aggregator.js";
export type { AggregatorEntry } from "./aggregator.js";

export {
  QuetzalError,
  OrderError,
  BridgeError,
  ConfigError,
} from "./errors.js";

export type {
  NetworkName,
  NetworkConfig,
  NetworkConfigL1,
  QuetzalContracts,
  QuetzalPoolEntry,
  OrderSide,
  ScheduledExit,
  PlaceOrderInput,
  PlaceOrderResult,
  BulkPlaceOrderInput,
  BulkPlaceOrderResult,
  CurrentEpoch,
} from "./types.js";

export { resolveTokenDecimals, NETWORK_DEFAULTS } from "./config.js";

// Utility surface (re-exported so CLI / front-end can drop the local copies)
export { randomField, parseField } from "./util/field.js";
export { computeWithdrawContent } from "./util/sha256-content.js";
