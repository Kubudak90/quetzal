// Smoke test for Sub-8.5d SDK schnorr fix: does client.reads.getCurrentEpoch()
// work against live testnet now?
import { QuetzalClient } from "../sdk/src/index.js";

async function main() {
  const nodeUrl = process.env.AZTEC_NODE_URL!;
  const secret = process.env.AGGREGATOR_L2_SECRET || "0x" + "11".repeat(32);
  console.log("connecting to", nodeUrl);

  const client = await QuetzalClient.connect({
    network: "alpha-testnet",
    nodeUrl,
    account: { type: "schnorr", secret },
    contracts: {
      orderbook: "0x2486ac705f0e7b509256dc96c8310a3abdf6465faa4a24e406a10fbcc17e5184",
      tUSDC: "0x09075988b52dec9c83c7da73ca3f746c14431a7974ccd8fb899e6476ef6b6b22",
      tETH: "0x1c839479228a2cf9304a61ea4d0b3b2d3c319f3e72c8f4d87c3ade3a5809a198",
      admin: "0x0524b493a6766243d07f655a26ceb5e71c44af9cf0060c670f49ee7699c92a00",
      pools: [{
        pool_id: 0,
        token_a: "0x09075988b52dec9c83c7da73ca3f746c14431a7974ccd8fb899e6476ef6b6b22",
        token_b: "0x1c839479228a2cf9304a61ea4d0b3b2d3c319f3e72c8f4d87c3ade3a5809a198",
        address: "0x1c06506878d782e8060557bc0ac73a4ff38cfda00083035103058b73be2def75",
      }],
      aggregatorRegistry: "0x00e43e816cdc85de14b31c02450b06890f0ebca5c19023d2fdb511fd16ece8e0",
      treasury: "0x1b2c36d0b7f5da9ccb7888eee7785111f4a5c35778097bb79957ac031a6606e6",
    },
  });
  console.log("connected; client.address =", client.address.toString());

  console.log("calling client.reads.getCurrentEpoch() ...");
  const epoch = await client.reads.getCurrentEpoch();
  console.log("✅ getCurrentEpoch OK:", JSON.stringify(epoch, (_k, v) => typeof v === "bigint" ? v.toString() : v));
}
main().catch((e) => { console.error("❌ FAILED:", e); process.exit(1); });
