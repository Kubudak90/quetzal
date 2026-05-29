// Sub-9.4 helper: force-close current epoch from admin.
// Use case: brand-new orderbook deployed past epoch 0 closes_at_block; no
// reveals in queue → aggregator's wouldClear stays false → epoch 0 never
// advances → submit_order is permanently rejected with "epoch has expired".
//
// This script just calls Orderbook.close_epoch() from admin.
import { readFileSync } from "node:fs";
import { Fr, Fq } from "@aztec/aztec.js/fields";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { createAztecNodeClient, waitForNode } from "@aztec/aztec.js/node";
import { EmbeddedWallet } from "@aztec/wallets/embedded";
import { OrderbookContract } from "../tests/integration/generated/Orderbook.js";

const NODE_URL = process.env.AZTEC_NODE_URL ?? "https://rpc.testnet.aztec-labs.com";
const m1 = JSON.parse(readFileSync("testnet-m1-state.json", "utf8"));
const cfg = JSON.parse(readFileSync("quetzal.config.json", "utf8"));
const orderbookAddr = AztecAddress.fromString(cfg.orderbook);

const node = createAztecNodeClient(NODE_URL);
await waitForNode(node);
const wallet = await EmbeddedWallet.create(node, {
  ephemeral: false,
  pxe: { proverEnabled: true, dataDirectory: "./testnet-m4-pxe" },
});
const mgr = await wallet.createSchnorrAccount(
  Fr.fromString(m1.secret),
  Fr.fromString(m1.salt),
  Fq.fromString(m1.signingKey),
);
const admin = (await mgr.getAccount()).getAddress();
console.log("admin:", admin.toString());
console.log("orderbook:", orderbookAddr.toString());

const ob = await OrderbookContract.at(orderbookAddr, wallet);
console.log("calling Orderbook.close_epoch() ...");
const t0 = Date.now();
const tx = await ob.methods.close_epoch().send({ from: admin });
const r = await tx.wait({ timeout: 600 });
console.log(`close_epoch OK in ${((Date.now() - t0) / 1000).toFixed(1)}s; tx=${r.txHash}`);

await wallet.stop();
