import type { Command } from "commander";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { Fr } from "@aztec/aztec.js/fields";
import { TokenContract } from "../../../tests/integration/generated/Token.js";
import { loadConfig } from "../config.js";
import { openCli } from "../wallet.js";
import { parseField } from "../field.js";
import { queryRecentDeposits, isRoundTripRisk } from "../bridge/bridge-history.js";
import { loadBridgeState, saveBridgeState } from "../bridge/bridge-schedule.js";
import type { ScheduledExit } from "../bridge/bridge-schedule.js";

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
      "use exit_to_l1_public (default is exit_to_l1_private — privacy-maximalist)",
    )
    .option(
      "--relayer-fee <amount>",
      "opt-in relayer fee in token's smallest unit (0 = no relayer; default 0). " +
      "When > 0, queues a Treasury claim alongside the L2 exit so a bonded aggregator " +
      "can submit the L1 withdraw on your behalf (saves you the L1 cast send step).",
      "0",
    )
    .option(
      "--ack-delay",
      "acknowledge round-trip risk warning + proceed with exit",
    )
    .option(
      "--ack-round",
      "acknowledge round-amount fingerprint warning + proceed with exit",
    )
    .option("--split-into <n>", "split into N partial withdrawals staggered over time (default 1 = no split)", "1")
    .option("--interval-days <d>", "days between split exits (used with --split-into > 1; default 3)", "3")
    .action(async (_opts, cmd: Command) => {
      const opts = cmd.optsWithGlobals();
      const config = loadConfig(opts.config);
      const tokenAddress = resolveTokenAddress(config, String(opts.token));
      const amount = BigInt(opts.amount);
      const l1RecipientHex = String(opts.l1Recipient);
      validateL1Address(l1RecipientHex);
      const usePrivate = opts.private !== false;

      if (usePrivate) {
        console.log(
          "INFO: exit_to_l1_private uses WITHDRAW_PRIVATE_TAG content. After this L2 tx " +
          "settles to L1, claim via:  pnpm quetzal bridge claim-l1 --private --l2-tx <hash> ... " +
          "(or use --relayer-fee here to delegate the L1 step to a bonded aggregator).",
        );
      }

      // ── Sub-6a D2: amount-pattern fingerprint advisory ────────────────────
      {
        const { classifyAmount, formatAdvisory, resolveTokenDecimals } = await import("../amount-heuristic.js");
        const decimals = resolveTokenDecimals(String(opts.token));
        const heuristic = classifyAmount(amount, decimals);
        if (heuristic.classification !== "natural") {
          const advisory = formatAdvisory(heuristic, decimals, String(opts.token).toUpperCase());
          console.warn(advisory);
          if (opts.ackRound !== true) {
            console.warn("Pass --ack-round to acknowledge + proceed, or rerun with a perturbed amount.");
            process.exit(1);
          }
        }
      }
      // ── end amount-pattern check ──────────────────────────────────────────

      // ── Sub-6a C2: round-trip risk pre-check ─────────────────────────────
      const ackDelay = opts.ackDelay === true;
      const l1RpcUrl = (config as unknown as Record<string, unknown>).l1
        ? ((config as unknown as { l1: Record<string, string> }).l1.rpcUrl ?? "")
        : "";
      const l1Cfg = (config as unknown as { l1?: { usdcBridge?: string; wethBridge?: string; wbtcBridge?: string } }).l1;
      const bridgeAddrs = [
        l1Cfg?.usdcBridge,
        l1Cfg?.wethBridge,
        l1Cfg?.wbtcBridge,
      ].filter(Boolean) as `0x${string}`[];

      if (l1RpcUrl && bridgeAddrs.length > 0) {
        const l1MakerAddr = (process.env.L1_MAKER_ADDR ?? "") as `0x${string}`;
        if (!l1MakerAddr) {
          console.warn(
            "Skipping round-trip pre-check: L1_MAKER_ADDR not set. " +
            "Set env L1_MAKER_ADDR=0x... (your L1 deposit address) to enable.",
          );
        } else {
          let records: Awaited<ReturnType<typeof queryRecentDeposits>>;
          try {
            records = await queryRecentDeposits(l1RpcUrl, bridgeAddrs, l1MakerAddr, 7);
          } catch (e) {
            console.warn(
              `Round-trip pre-check failed (L1 query error): ${e instanceof Error ? e.message : String(e)}. ` +
              `Proceeding with exit; set --ack-delay to suppress this warning explicitly.`,
            );
            records = [];
          }
          const { risk, matched } = isRoundTripRisk(amount, records, 5);
          if (risk && matched && !ackDelay) {
            const daysAgo = Math.floor((Date.now() / 1000 - matched.timestamp) / 86400);
            console.error("");
            console.error("Round-trip detection risk");
            console.error("");
            console.error(`You deposited ${matched.amount} on ${new Date(matched.timestamp * 1000).toISOString()} (${daysAgo} days ago).`);
            console.error(`You're now exiting ${amount} -- within +/-5% of that deposit's amount.`);
            console.error("");
            console.error(`Observers on Etherscan can correlate L1 deposit + L1 withdraw timing + amount`);
            console.error(`and infer this is the same wallet round-tripping through Quetzal's L2 privacy.`);
            console.error(`L2 privacy stays intact; the L1 boundary becomes traceable.`);
            console.error("");
            console.error("Mitigations:");
            console.error("  - Wait >=7 days from last matching-size deposit (recommended: 14 days)");
            console.error("  - Use --split-into N to break exit into smaller staggered withdrawals (Sub-6a C3)");
            console.error("  - Use --ack-delay if you've considered the trade-off");
            console.error("");
            console.error("Aborting. Re-run with --ack-delay to proceed.");
            process.exit(1);
          }
        }
      }
      // ── end round-trip pre-check ──────────────────────────────────────────

      // ── Sub-6a C3: multi-hop split path ───────────────────────────────────
      const splitInto = Number(opts.splitInto);
      const intervalDays = Number(opts.intervalDays);

      if (splitInto > 1) {
        const { buildSplitSchedule, loadBridgeState, saveBridgeState } = await import("../bridge/bridge-schedule.js");
        const newExits = buildSplitSchedule(
          String(opts.token),
          amount,
          l1RecipientHex,
          splitInto,
          intervalDays,
        );
        const state = loadBridgeState();
        state.scheduledExits.push(...newExits);
        saveBridgeState(state);

        console.log(`Scheduled ${splitInto} partial exits:`);
        for (const e of newExits) {
          const when = new Date(e.submitAfterUnix * 1000).toISOString();
          console.log(`  ${e.id}  ${e.amount} ${e.token}  -> ${e.l1Recipient}  submit after ${when}`);
        }
        console.log("");
        console.log("Run 'quetzal bridge tick' periodically to submit pending exits.");
        console.log("Run 'quetzal bridge status' to see schedule progress.");
        return;
      }
      // ── end split path (splitInto === 1: fall through to single-exit) ─────

      // EthAddress on L2: zero-padded into 32-byte Field slot, left-padded with 12 zero bytes.
      const l1RecipientFr = new Fr(BigInt(l1RecipientHex));

      const ctx = await openCli(config, Number(opts.account));
      try {
        const token = await TokenContract.at(AztecAddress.fromString(tokenAddress), ctx.wallet);
        const tokenDyn = token as unknown as {
          methods: {
            exit_to_l1_public: (
              amount: bigint, l1Recipient: Fr,
            ) => { send: (args: { from: AztecAddress }) => { wait: () => Promise<{ txHash: { toString: () => string } }> } };
            exit_to_l1_private: (
              amount: bigint, l1Recipient: Fr,
            ) => { send: (args: { from: AztecAddress }) => { wait: () => Promise<{ txHash: { toString: () => string } }> } };
          };
        };
        const fn = usePrivate ? "exit_to_l1_private" : "exit_to_l1_public";
        const tx = tokenDyn.methods[fn](amount, l1RecipientFr).send({ from: ctx.account });
        const receipt = await tx.wait();
        const l2TxHash = receipt.txHash.toString();
        console.log(
          `${fn} submitted; query Outbox proof + claim on L1 via 'quetzal bridge claim-l1'`,
        );

        // Sub-5c D3: optionally queue a Treasury relayer claim so a bonded
        // aggregator can submit the L1 withdraw on the maker's behalf.
        const relayerFee = BigInt(opts.relayerFee);
        if (relayerFee > 0n) {
          if (!config.treasury) {
            console.error(
              "WARNING: --relayer-fee > 0 but config.treasury is not set. Skipping relayer queue. " +
              "Either set config.treasury or omit --relayer-fee for the manual L1 cast send path.",
            );
          } else {
            // Compute expectedContent: sha256_to_field(abi.encode(recipient, amount, tag))
            // Matches L1 TokenBridge._withdrawContent and L2 exit_to_l1_* emitted content.
            const { computeWithdrawContent } = await import("../sha256-content.js");
            const expectedContent = computeWithdrawContent(l1RecipientHex, amount, usePrivate);

            console.log(`Relayer fee ${relayerFee} → queueing Treasury claim`);

            const { TreasuryContract } = await import("../../../tests/integration/generated/Treasury.js");
            const treasury = await TreasuryContract.at(AztecAddress.fromString(config.treasury), ctx.wallet);
            const treasuryDyn = treasury as unknown as {
              methods: {
                queue_relayer_claim: (
                  l2TxHash: Fr, expectedContent: Fr, l1Recipient: Fr, amount: bigint, fee: bigint,
                ) => { send: (args: { from: AztecAddress }) => Promise<unknown> };
              };
            };
            await treasuryDyn.methods.queue_relayer_claim(
              Fr.fromString(l2TxHash),
              Fr.fromString(expectedContent),
              l1RecipientFr,
              amount,
              relayerFee,
            ).send({ from: ctx.account });

            console.log(`  queued. A bonded relayer should pick this up within ~60s + submit L1 withdraw.`);
          }
        }
      } finally {
        await ctx.stop();
      }
    });

  // ── bridge claim-l1 ─────────────────────────────────────────────────────────────────────────────
  bridge
    .command("claim-l1")
    .description("Print the L1 cast-send command needed to consume a pending L2→L1 withdraw")
    .requiredOption("--l2-tx <hash>", "L2 tx hash of the exit_to_l1_* call")
    .requiredOption("--l1-recipient <addr>", "0x-prefixed L1 recipient address")
    .requiredOption("--amount <units>", "token amount (smallest unit)")
    .requiredOption("--bridge <addr>", "0x-prefixed L1 portal address (USDCBridge or WETHBridge or wBTCBridge)")
    .requiredOption("--content <hex>", "expected 0x-prefixed bytes32 content hash committed by L2")
    .option("--private", "use withdrawPrivate L1 function (matches L2's exit_to_l1_private); default is withdraw")
    .action(async (_opts, cmd: Command) => {
      const opts = cmd.optsWithGlobals();
      const config = loadConfig(opts.config);
      const isPrivate = opts.private === true;
      const functionName = isPrivate ? "withdrawPrivate" : "withdraw";
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
          `  "${functionName}(uint256,address,uint256,uint256,bytes32[])" \\`,
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
        functionName,
      );
      console.log(cmdLine);
    });

  // ── bridge status ────────────────────────────────────────────────────────────────────────
  bridge
    .command("status")
    .description("show pending scheduled exits + statuses")
    .action(() => {
      const state = loadBridgeState();
      if (state.scheduledExits.length === 0) {
        console.log("No scheduled exits.");
        return;
      }
      console.log(`Pending scheduled exits (${state.scheduledExits.length}):`);
      for (const e of state.scheduledExits) {
        const when = new Date(e.submitAfterUnix * 1000).toISOString();
        console.log(`  ${e.id}  ${e.amount} ${e.token}  -> ${e.l1Recipient}  [${e.status}]  ${when}`);
      }
    });

  // ── bridge tick ──────────────────────────────────────────────────────────────────────────
  bridge
    .command("tick")
    .description("submit pending scheduled exits whose window has opened (and optionally auto-claim on L1)")
    .option("--auto-claim", "also auto-submit L1 withdraw after the L2 epoch settles")
    .action(async (_opts, cmd: Command) => {
      const opts = cmd.optsWithGlobals();
      const config = loadConfig(opts.config);
      const ctx = await openCli(config, Number(opts.account));
      try {
        const state = loadBridgeState();
        const now = Math.floor(Date.now() / 1000);
        let changed = false;

        for (const exit of state.scheduledExits as ScheduledExit[]) {
          if (exit.status === "pending" && exit.submitAfterUnix <= now) {
            console.log(`Submitting L2 exit for ${exit.id} (${exit.amount} ${exit.token})...`);
            // SCAFFOLD: implementer wires the actual L2 send.
            // Pattern reference: the existing 'bridge exit' single-exit path
            // already resolves the token alias + builds Fr for l1Recipient + calls
            // TokenContract.at(...).methods.exit_to_l1_public(amount, l1Recipient).send(...).
            // Copy that block here, parameterized by exit.token + exit.amount +
            // exit.l1Recipient.
            //
            // After successful send:
            //   const receipt = await tx.wait();
            //   exit.status = "submitted";
            //   exit.l2TxHash = receipt.txHash.toString();
            //   exit.l2EpochAtSubmit = <captured>;  // from receipt or node query
            //   changed = true;
            console.warn(`  [scaffold] L2 send not yet wired; operator session fills in.`);
          } else if (exit.status === "submitted" && opts.autoClaim === true) {
            console.log(`Checking L1 claim eligibility for ${exit.id}...`);
            // SCAFFOLD: implementer wires the L1 claim check + cast send.
            // Pattern reference: Sub-5c D2's relayer-mode loop + Sub-5b D2's
            // buildOutboxProof (cli/src/bridge-helpers.ts).
            // Flow:
            //   1. Query Aztec node: has epoch exit.l2EpochAtSubmit settled to L1 outbox?
            //   2. If yes: build outbox proof via Sub-5c A3's zswap-outbox-proof binary
            //      (now quetzal-outbox-proof; see scripts/measure-* for the spawn pattern)
            //   3. Call viem writeContract on TokenBridge.withdraw or withdrawPrivate
            //      with the proof + recipient + amount
            //   4. On L1 receipt:
            //        exit.status = "done";
            //        changed = true;
            console.warn(`  [scaffold] L1 claim not yet wired; operator session fills in.`);
          }
        }

        if (changed) saveBridgeState(state);
        console.log("Tick complete.");
      } finally {
        await ctx.stop();
      }
    });
}
