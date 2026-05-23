#!/usr/bin/env node
//
// Sub-5b: deploys the L1↔L2 bridge stack.
//
// L1 side (forge script): TimelockController + 2 TokenBridge proxies
// L2 side (aztec.js):     aUSDC + aWETH Token contracts (constructor_with_minter_bridged)
//
// E1 only deploys the contracts; E2 wires portals -> L2 token addresses
// via the timelock controller.
//
// Required env:
//   NETWORK              testnet | mainnet | local
//   AZTEC_NODE_URL       Aztec rollup RPC
//   L1_RPC_URL           Sepolia | Mainnet | anvil RPC
//   L1_USDC_ADDR         canonical USDC address
//   L1_WETH_ADDR         canonical WETH address
//   L1_INBOX_ADDR        Aztec rollup Inbox on L1
//   L1_OUTBOX_ADDR       Aztec rollup Outbox on L1
//   L1_MULTISIG_ADDR     Gnosis Safe (or single-key deployer on testnet)
//   DEPLOYER_PK          L1 deployer private key
//
// Output: writes/updates zswap.config.json with l1.{usdcBridge, wethBridge, timelock}
//         and tUSDC/tETH retargeted to the new aUSDC/aWETH L2 addresses.

import { spawn } from "node:child_process";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { Fr } from "@aztec/aztec.js/fields";

const NETWORK = process.env.NETWORK ?? "testnet";
if (!["testnet", "mainnet", "local"].includes(NETWORK)) {
  throw new Error(`NETWORK must be 'testnet' | 'mainnet' | 'local', got '${NETWORK}'`);
}

const AZTEC_NODE_URL = process.env.AZTEC_NODE_URL ?? "https://rpc.testnet.aztec-labs.com";
const L1_RPC_URL = process.env.L1_RPC_URL ?? "https://eth-sepolia.public.blastapi.io";
const L1_USDC_ADDR = process.env.L1_USDC_ADDR ?? "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";
const L1_WETH_ADDR = process.env.L1_WETH_ADDR ?? "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14";
const L1_INBOX_ADDR = requireEnv("L1_INBOX_ADDR");
const L1_OUTBOX_ADDR = requireEnv("L1_OUTBOX_ADDR");
const L1_MULTISIG_ADDR = requireEnv("L1_MULTISIG_ADDR");
const DEPLOYER_PK = requireEnv("DEPLOYER_PK");

const TIMELOCK_DELAY_SEC = NETWORK === "mainnet" ? 7 * 24 * 3600 : 0;
const MAX_TVL_PER_PORTAL = NETWORK === "mainnet" ? 10_000_000_000n : 0n; // $10k cap mainnet; unlimited elsewhere

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`required env var ${name} not set`);
  return v;
}

function runForge(args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("forge", args, { cwd, stdio: "inherit" });
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`forge exited ${code}`))));
  });
}

interface DeployedL1 { usdcBridge: string; wethBridge: string; timelock: string; }

async function deployL1Stack(): Promise<DeployedL1> {
  const args = [
    "script",
    "--rpc-url", L1_RPC_URL,
    "--private-key", DEPLOYER_PK,
    "--broadcast",
    "--sig", "run(address,address,address,address,address,uint256,uint256)",
    "script/DeployAllBridges.s.sol:DeployAllBridges",
    L1_USDC_ADDR, L1_WETH_ADDR, L1_INBOX_ADDR, L1_OUTBOX_ADDR, L1_MULTISIG_ADDR,
    TIMELOCK_DELAY_SEC.toString(), MAX_TVL_PER_PORTAL.toString(),
  ];
  console.log("Running forge deploy with args:", args.join(" "));
  await runForge(args, "contracts-l1");

  const chainId = NETWORK === "mainnet" ? 1 : NETWORK === "testnet" ? 11155111 : 31337;
  const broadcastPath = `contracts-l1/broadcast/DeployAllBridges.s.sol/${chainId}/run-latest.json`;
  if (!existsSync(broadcastPath)) {
    throw new Error(`forge broadcast log not found at ${broadcastPath}. Did the deploy succeed?`);
  }
  const broadcast = JSON.parse(readFileSync(broadcastPath, "utf8")) as {
    transactions: Array<{ contractName: string; contractAddress: string }>;
  };

  // The forge broadcast log labels both proxies the same ("ERC1967Proxy"). To distinguish,
  // rely on deployment order: TimelockController first, USDCBridge impl + proxy, WETHBridge
  // impl + proxy. So proxies are the 2nd and 4th ERC1967Proxy. But the order from forge's
  // CREATE list is what matters. Read the script's stdout log instead:
  // we logged the addresses already via console.log inside the script.
  // For robust parsing, capture forge stdout — for now, document the limitation and rely
  // on the operator to verify against the printed log.
  void broadcast; // suppress unused-variable warning; see explanation above

  throw new Error(
    "L1 deploy succeeded; copy the 3 addresses (TimelockController, USDCBridge, WETHBridge) " +
    "from the forge broadcast log printed above + paste them into zswap.config.json manually, " +
    "then re-run with SKIP_L1=1 to proceed to L2 deploy. (Robust broadcast-log parsing is a " +
    "Sub-5c follow-up.)",
  );

  // Unreachable in current iteration:
  // return { usdcBridge: "", wethBridge: "", timelock: "" };
}

interface DeployedL2 { aUSDC: string; aWETH: string; adminAddr: string; }

async function deployL2Tokens(_usdcBridgeL1: string, _wethBridgeL1: string): Promise<DeployedL2> {
  // Wallet bootstrap: port the testnet-m1-hello.ts flow (faucet drip -> claim ->
  // deploy with FeeJuicePaymentMethodWithClaim). The implementer of Sub-5b
  // testnet runner (Task F2) inlines this in a state-persisted form; the
  // one-shot deploy here is a thinner version.
  throw new Error(
    "L2 deploy: wallet bootstrap (faucet drip + claim + deploy) not yet wired. " +
    "Port the pattern from scripts/testnet-m1-hello.ts (~lines 25-180) and " +
    "call TokenContract.deployWithOpts({wallet, method: 'constructor_with_minter_bridged'}, " +
    "name, symbol, decimals, admin, EthAddress packed in 32 bytes).send({from: admin}). " +
    "F2 (testnet-sub5b-bridge.ts) does this end-to-end; E1's standalone deploy is reserved " +
    "for mainnet automation in a Sub-5c follow-up.",
  );
}

function castCalldata(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("cast", ["calldata", ...args]);
    let out = "";
    child.stdout?.on("data", (d: Buffer) => { out += d.toString(); });
    child.on("exit", (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(`cast calldata exited ${code}`))));
  });
}

function castSend(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("cast", ["send", ...args], { stdio: "inherit" });
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`cast send exited ${code}`))));
  });
}

/**
 * Sub-5b E2: schedule + (for testnet/local with delay=0) execute
 * setL2TokenAddress on a portal via the TimelockController.
 *
 * On mainnet (delay=7d), only schedules. The execute call must be run
 * by an operator after the 7-day window via the printed cast command.
 *
 * @param timelockAddr  TimelockController address
 * @param bridgeAddr    TokenBridge proxy address
 * @param l2TokenHex    bytes32 hex (0x-prefixed, 32 bytes) of the L2 Token address
 * @param label         human-readable label (e.g. "USDC", "WETH") for logs
 */
export async function wirePortalL2Token(
  timelockAddr: string,
  bridgeAddr: string,
  l2TokenHex: string,
  label: string,
): Promise<void> {
  if (!l2TokenHex.startsWith("0x") || l2TokenHex.length !== 66) {
    throw new Error(`l2TokenHex must be 0x-prefixed 32 bytes (66 chars), got ${l2TokenHex}`);
  }
  const innerCalldata = await castCalldata(["setL2TokenAddress(bytes32)", l2TokenHex]);

  console.log(`Scheduling setL2TokenAddress for ${label}Bridge → ${l2TokenHex}`);
  await castSend([
    "--rpc-url", L1_RPC_URL,
    "--private-key", DEPLOYER_PK,
    timelockAddr,
    "schedule(address,uint256,bytes,bytes32,bytes32,uint256)",
    bridgeAddr, "0", innerCalldata, "0x0", "0x0", TIMELOCK_DELAY_SEC.toString(),
  ]);

  if (TIMELOCK_DELAY_SEC === 0) {
    console.log(`Executing setL2TokenAddress for ${label}Bridge immediately (delay=0)`);
    await castSend([
      "--rpc-url", L1_RPC_URL,
      "--private-key", DEPLOYER_PK,
      timelockAddr,
      "execute(address,uint256,bytes,bytes32,bytes32)",
      bridgeAddr, "0", innerCalldata, "0x0", "0x0",
    ]);
  } else {
    console.log(`Mainnet delay = ${TIMELOCK_DELAY_SEC}s. After the timelock window, run:`);
    console.log(
      `  cast send ${timelockAddr} "execute(address,uint256,bytes,bytes32,bytes32)" ${bridgeAddr} 0 ${innerCalldata} 0x0 0x0`,
    );
  }
}

async function main() {
  console.log(`Sub-5b deploy on ${NETWORK}`);
  console.log(`  L1 USDC:        ${L1_USDC_ADDR}`);
  console.log(`  L1 WETH:        ${L1_WETH_ADDR}`);
  console.log(`  L1 Inbox:       ${L1_INBOX_ADDR}`);
  console.log(`  L1 Outbox:      ${L1_OUTBOX_ADDR}`);
  console.log(`  L1 Multisig:    ${L1_MULTISIG_ADDR}`);
  console.log(`  Timelock delay: ${TIMELOCK_DELAY_SEC}s`);
  console.log(`  Max TVL/portal: ${MAX_TVL_PER_PORTAL}`);
  console.log("");

  let l1: DeployedL1;
  if (process.env.SKIP_L1 === "1") {
    console.log("SKIP_L1=1 set; reading L1 addresses from zswap.config.json");
    const cfgRaw = JSON.parse(readFileSync("zswap.config.json", "utf8")) as Record<string, unknown>;
    const l1Cfg = cfgRaw.l1 as { usdcBridge: string; wethBridge: string; timelock: string } | undefined;
    if (!l1Cfg?.usdcBridge || !l1Cfg.wethBridge || !l1Cfg.timelock) {
      throw new Error("SKIP_L1 set but zswap.config.json missing l1.{usdcBridge, wethBridge, timelock}");
    }
    l1 = { usdcBridge: l1Cfg.usdcBridge, wethBridge: l1Cfg.wethBridge, timelock: l1Cfg.timelock };
  } else {
    console.log("=== L1 deploy ===");
    l1 = await deployL1Stack();
  }
  console.log(`USDCBridge:         ${l1.usdcBridge}`);
  console.log(`WETHBridge:         ${l1.wethBridge}`);
  console.log(`TimelockController: ${l1.timelock}`);
  console.log("");

  console.log("=== L2 deploy ===");
  const l2 = await deployL2Tokens(l1.usdcBridge, l1.wethBridge);
  console.log(`aUSDC: ${l2.aUSDC}`);
  console.log(`aWETH: ${l2.aWETH}`);
  console.log("");

  console.log("=== Wiring portals -> L2 tokens (timelock-gated) ===");

  // EthAddress on L1 + bytes32 on contract: aUSDC/aWETH are AztecAddress
  // (32-byte). Pack via Fr serialization.
  const aUSDCBytes32 = new Fr(BigInt(l2.aUSDC)).toString(); // 0x-prefixed 32-byte hex
  const aWETHBytes32 = new Fr(BigInt(l2.aWETH)).toString();

  await wirePortalL2Token(l1.timelock, l1.usdcBridge, aUSDCBytes32, "USDC");
  await wirePortalL2Token(l1.timelock, l1.wethBridge, aWETHBytes32, "WETH");

  console.log("");
  console.log("Portals wired. Maker flow ready:");
  console.log(`  - deposit:  cast send <l1Token> approve <bridge> <amount> + bridge.depositToL2Public/Private(...)`);
  console.log(`  - claim:    pnpm zswap bridge claim --token aUSDC --secret 0x... --message-index N`);
  console.log(`  - exit:     pnpm zswap bridge exit --token aWETH --amount N --l1-recipient 0x...`);
  console.log(`  - L1 claim: pnpm zswap bridge claim-l1 --l2-tx 0x... --bridge ${l1.usdcBridge} --amount N --content 0x...`);

  // Merge into zswap.config.json
  const cfgPath = "zswap.config.json";
  const existing = existsSync(cfgPath)
    ? (JSON.parse(readFileSync(cfgPath, "utf8")) as Record<string, unknown>)
    : {};
  const config = {
    ...existing,
    network: NETWORK,
    nodeUrl: AZTEC_NODE_URL,
    tUSDC: l2.aUSDC,
    tETH: l2.aWETH,
    admin: l2.adminAddr,
    l1: {
      rpcUrl: L1_RPC_URL,
      usdc: L1_USDC_ADDR,
      weth: L1_WETH_ADDR,
      inbox: L1_INBOX_ADDR,
      outbox: L1_OUTBOX_ADDR,
      multisig: L1_MULTISIG_ADDR,
      usdcBridge: l1.usdcBridge,
      wethBridge: l1.wethBridge,
      timelock: l1.timelock,
      timelockDelaySec: TIMELOCK_DELAY_SEC,
      maxTvl: MAX_TVL_PER_PORTAL.toString(),
    },
  };
  writeFileSync(cfgPath, JSON.stringify(config, null, 2));
  console.log(`Wrote ${cfgPath}`);

  console.log("");
  console.log("Sub-5b E1+E2 complete. Use the testnet runner scripts/testnet-sub5b-bridge.ts (F2) for end-to-end validation.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
