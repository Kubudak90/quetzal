import { describe, test, expect } from "vitest";
import { L1Bridge } from "@/lib/l1-bridge";
import { mintToPublic } from "@/lib/l2-mint";
import { loadConfig } from "@/lib/config";

const RUN = process.env.RUN_INTEGRATION_TESTS === "1";

describe.skipIf(!RUN)("faucet integration (live testnet)", () => {
  test("L1 bridgeFeeJuice + L2 mintTUSDC + mintTETH succeed end-to-end for a fresh address", async () => {
    const cfg = loadConfig();
    const recipient = ("0x" + "00".repeat(31) + "01") as `0x${string}`;

    const bridge = new L1Bridge({
      rpcUrl: cfg.l1RpcUrl,
      privateKey: cfg.l1Pk,
      chainId: cfg.l1ChainId,
      aztecNodeUrl: cfg.l2NodeUrl,
    });
    const bridgeRes = await bridge.bridgeFeeJuice(recipient, cfg.feeJuiceAmount);
    expect(bridgeRes.messageLeafIndex).toBeGreaterThan(0n);
    expect(bridgeRes.claimSecretHex).toMatch(/^0x[0-9a-f]{64}$/);

    const usdcRes = await mintToPublic({ nodeUrl: cfg.l2NodeUrl, operatorSecret: cfg.l2Secret, tokenAddress: cfg.l2TUSDC }, recipient, cfg.tUSDCAmount);
    expect(usdcRes.txHash).toMatch(/^0x[0-9a-f]+$/);

    const ethRes = await mintToPublic({ nodeUrl: cfg.l2NodeUrl, operatorSecret: cfg.l2Secret, tokenAddress: cfg.l2TETH }, recipient, cfg.tETHAmount);
    expect(ethRes.txHash).toMatch(/^0x[0-9a-f]+$/);
  }, 600_000); // 10 min — testnet ClientIVC proving is slow
});
