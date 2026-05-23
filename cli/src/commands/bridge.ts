import type { Command } from "commander";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { Fr } from "@aztec/aztec.js/fields";
import { TokenContract } from "../../../tests/integration/generated/Token.js";
import { loadConfig } from "../config.js";
import { openCli } from "../wallet.js";
import { parseField } from "../field.js";

function resolveTokenAddress(config: ReturnType<typeof loadConfig>, alias: string): string {
  // Accept both legacy (tUSDC/tETH/tBTC) and bridged (aUSDC/aWETH/aWBTC) names.
  // Bridged + legacy refer to the same config slot — what differs is the deploy
  // mode (is_bridged flag) at the contract level, not the CLI's view.
  const map: Record<string, string | undefined> = {
    tUSDC: config.tUSDC,
    aUSDC: config.tUSDC,
    tETH: config.tETH,
    aWETH: config.tETH,
    tBTC: config.tBTC,
    aWBTC: config.tBTC,
  };
  const addr = map[alias];
  if (!addr) {
    throw new Error(
      `unknown token alias '${alias}'. Known: tUSDC/aUSDC, tETH/aWETH, tBTC/aWBTC.`,
    );
  }
  return addr;
}

function validateL1Address(addr: string): void {
  if (!addr.startsWith("0x") || addr.length !== 42) {
    throw new Error(`--l1-recipient must be a 0x-prefixed 20-byte L1 address, got: ${addr}`);
  }
}

export function registerBridge(program: Command): void {
  const bridge = program.command("bridge").description("L1<>L2 bridge operations (Sub-5b)");

  // ── bridge claim ─────────────────────────────────────────────────────────────────────────
  bridge
    .command("claim")
    .description("Claim an L1->L2 deposit on Aztec L2 (consumes an Inbox message)")
    .requiredOption("--token <alias>", "token alias: tUSDC|aUSDC|tETH|aWETH|tBTC|aWBTC")
    .requiredOption("--amount <units>", "amount in token's smallest unit (uint128)")
    .requiredOption("--secret <field>", "0x-prefixed Field preimage of L1 secret_hash")
    .requiredOption("--message-index <field>", "Inbox leaf index returned by L1 portal at deposit time")
    .option("--no-private", "use claim_public (default is claim_private — privacy-maximalist)")
    .action(async (_opts, cmd: Command) => {
      const opts = cmd.optsWithGlobals();
      const config = loadConfig(opts.config);
      const tokenAddress = resolveTokenAddress(config, String(opts.token));
      const amount = BigInt(opts.amount);
      const secret = new Fr(parseField(String(opts.secret)));
      const messageIndex = new Fr(parseField(String(opts.messageIndex)));
      const usePrivate = opts.private !== false; // commander handles --no-private

      const ctx = await openCli(config, Number(opts.account));
      try {
        const token = await TokenContract.at(AztecAddress.fromString(tokenAddress), ctx.wallet);
        // Cast through any: codegen bindings may not yet include the new
        // Sub-5b bridge functions until a fresh pnpm codegen runs.
        const tokenDyn = token as unknown as {
          methods: {
            claim_public: (
              to: AztecAddress, amount: bigint, secret: Fr, messageLeafIndex: Fr,
            ) => { send: (args: { from: AztecAddress }) => Promise<unknown> };
            claim_private: (
              to: AztecAddress, amount: bigint, secret: Fr, messageLeafIndex: Fr,
            ) => { send: (args: { from: AztecAddress }) => Promise<unknown> };
          };
        };
        const recipient = ctx.account;
        if (usePrivate) {
          await tokenDyn.methods
            .claim_private(recipient, amount, secret, messageIndex)
            .send({ from: ctx.account });
          console.log(
            `claim_private OK: ${amount} ${opts.token} → ${recipient.toString()}`,
          );
        } else {
          await tokenDyn.methods
            .claim_public(recipient, amount, secret, messageIndex)
            .send({ from: ctx.account });
          console.log(
            `claim_public OK: ${amount} ${opts.token} → ${recipient.toString()}`,
          );
        }
      } finally {
        await ctx.stop();
      }
    });

  // ── bridge exit ───────────────────────────────────────────────────────────────────────────
  bridge
    .command("exit")
    .description("Emit an L2->L1 withdraw message (burns L2 balance, queues Outbox msg)")
    .requiredOption("--token <alias>", "token alias: tUSDC|aUSDC|tETH|aWETH|tBTC|aWBTC")
    .requiredOption("--amount <units>", "amount to withdraw (uint128)")
    .requiredOption("--l1-recipient <addr>", "0x-prefixed L1 recipient address (20 bytes)")
    .option(
      "--no-private",
      "use exit_to_l1_public (default is exit_to_l1_private — privacy-maximalist; " +
      "WARNING: exit_to_l1_private has NO L1 consumer until Sub-5c, funds will be locked)",
    )
    .action(async (_opts, cmd: Command) => {
      const opts = cmd.optsWithGlobals();
      const config = loadConfig(opts.config);
      const tokenAddress = resolveTokenAddress(config, String(opts.token));
      const amount = BigInt(opts.amount);
      const l1RecipientHex = String(opts.l1Recipient);
      validateL1Address(l1RecipientHex);
      const usePrivate = opts.private !== false;

      if (usePrivate) {
        console.error(
          "WARNING: exit_to_l1_private has NO L1 consumer in Sub-5b. " +
          "The L1 portal's withdraw() only handles WITHDRAW_PUBLIC_TAG content. " +
          "Calling this will burn your L2 balance and emit an Outbox message " +
          "that cannot be claimed on L1 until Sub-5c ships the withdrawPrivate path. " +
          "Use --no-private (exit_to_l1_public) instead unless you understand the implications.",
        );
      }

      // EthAddress on L2: zero-padded into 32-byte Field slot, left-padded with 12 zero bytes.
      const l1RecipientFr = new Fr(BigInt(l1RecipientHex));

      const ctx = await openCli(config, Number(opts.account));
      try {
        const token = await TokenContract.at(AztecAddress.fromString(tokenAddress), ctx.wallet);
        const tokenDyn = token as unknown as {
          methods: {
            exit_to_l1_public: (
              amount: bigint, l1Recipient: Fr,
            ) => { send: (args: { from: AztecAddress }) => Promise<unknown> };
            exit_to_l1_private: (
              amount: bigint, l1Recipient: Fr,
            ) => { send: (args: { from: AztecAddress }) => Promise<unknown> };
          };
        };
        const fn = usePrivate ? "exit_to_l1_private" : "exit_to_l1_public";
        await tokenDyn.methods[fn](amount, l1RecipientFr).send({ from: ctx.account });
        console.log(
          `${fn} submitted; query Outbox proof + claim on L1 via 'zswap bridge claim-l1'`,
        );
      } finally {
        await ctx.stop();
      }
    });

  // ── bridge claim-l1 ─────────────────────────────────────────────────────────────────────────────
  bridge
    .command("claim-l1")
    .description("Print the L1 cast-send command needed to consume a pending L2->L1 withdraw")
    .requiredOption("--l2-tx <hash>", "L2 tx hash of the exit_to_l1_* call")
    .requiredOption("--l1-recipient <addr>", "0x-prefixed L1 recipient address")
    .requiredOption("--amount <units>", "token amount (smallest unit)")
    .requiredOption("--bridge <addr>", "0x-prefixed L1 portal address (USDCBridge or WETHBridge)")
    .requiredOption("--content <hex>", "expected 0x-prefixed bytes32 content hash committed by L2")
    .action(async (_opts, cmd: Command) => {
      const opts = cmd.optsWithGlobals();
      const config = loadConfig(opts.config);
      const { buildOutboxProof, formatProofForCastSend, lookupOutboxMessage } = await import("../bridge-helpers.js");
      let proof;
      try {
        proof = await buildOutboxProof(config.nodeUrl, String(opts.l2Tx), String(opts.content));
      } catch (e) {
        // D2 lookup succeeds but siblingPath is a known follow-up. Print the lookup
        // values so the operator can complete the proof manually.
        console.error(String(e instanceof Error ? e.message : e));
        console.error("");
        console.error("Running lookup-only path...");
        const lookup = await lookupOutboxMessage(config.nodeUrl, String(opts.l2Tx), String(opts.content));
        console.error(`L2 epoch:     ${lookup.l2Epoch}`);
        console.error(`Leaf index:   ${lookup.leafIndex}`);
        console.error(`Content hash: ${lookup.content}`);
        console.error("");
        console.error(
          "Construct siblingPath via Aztec's L1 portal manager helper " +
          "(see @aztec/aztec.js/dest/ethereum/portal_manager.js withdrawFunds signature), " +
          "then paste into the cast send template below replacing <SIBLING_PATH>:",
        );
        // Print a template with placeholder for the siblingPath
        const template = [
          `cast send ${String(opts.bridge)} \\`,
          `  "withdraw(uint256,address,uint256,uint256,bytes32[])" \\`,
          `  ${BigInt(opts.amount)} ${String(opts.l1Recipient)} ${lookup.l2Epoch} ${lookup.leafIndex} <SIBLING_PATH>`,
        ].join("\n");
        console.log(template);
        return;
      }
      const cmdLine = formatProofForCastSend(
        proof,
        String(opts.bridge),
        BigInt(opts.amount),
        String(opts.l1Recipient),
      );
      console.log(cmdLine);
    });
}
