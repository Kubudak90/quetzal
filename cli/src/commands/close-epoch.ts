import { readFileSync } from "node:fs";
import type { Command } from "commander";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { Fr } from "@aztec/aztec.js/fields";
import type { ContractFunctionInteraction } from "@aztec/aztec.js/contracts";
import { OrderbookContract } from "../../../tests/integration/generated/Orderbook.js";
import { loadConfig } from "../config.js";
import { openCli } from "../wallet.js";

// ---------------------------------------------------------------------------
// Proof / VK bridging helpers
//
// bb prove writes a 500-field UltraHonk proof file; the contract's
// close_epoch_and_clear_verified takes [Field; 456]. Truncate the tail.
//
// bb write_vk writes a 115-field vk file; the contract expects [Field; 127].
// Pad with Fr.ZERO at the tail (same convention used at deploy time so the
// vk_hash check inside std::verify_proof_with_type passes).
// ---------------------------------------------------------------------------

const CONTRACT_PROOF_SIZE = 456;
const CONTRACT_VK_SIZE = 127;

function readProofFile(path: string): Fr[] {
  const buf = readFileSync(path);
  const numFields = Math.floor(buf.length / 32);
  const fields: Fr[] = [];
  for (let i = 0; i < numFields; i++) {
    fields.push(Fr.fromBuffer(buf.subarray(i * 32, (i + 1) * 32)));
  }
  if (fields.length > CONTRACT_PROOF_SIZE) return fields.slice(0, CONTRACT_PROOF_SIZE);
  while (fields.length < CONTRACT_PROOF_SIZE) fields.push(Fr.ZERO);
  return fields;
}

function readVkFile(path: string): Fr[] {
  const buf = readFileSync(path);
  const numFields = Math.floor(buf.length / 32);
  const fields: Fr[] = [];
  for (let i = 0; i < numFields; i++) {
    fields.push(Fr.fromBuffer(buf.subarray(i * 32, (i + 1) * 32)));
  }
  if (fields.length > CONTRACT_VK_SIZE) return fields.slice(0, CONTRACT_VK_SIZE);
  while (fields.length < CONTRACT_VK_SIZE) fields.push(Fr.ZERO);
  return fields;
}

/**
 * JSON reviver that converts bigint-shaped strings (e.g. "12345" or "12345n")
 * to native bigint. Aztec.js method arguments often require bigint rather than
 * number for field-sized values.
 */
function bigintReviver(_key: string, value: unknown): unknown {
  if (typeof value === "string" && /^-?\d+n?$/.test(value)) {
    return BigInt(value.replace(/n$/, ""));
  }
  return value;
}

// ---------------------------------------------------------------------------
// Command registrations
// ---------------------------------------------------------------------------

export function registerCloseEpoch(program: Command): void {
  program
    .command("close-epoch")
    .description("advance the orderbook to the next epoch (only works once the current epoch has expired)")
    .action(async (_opts, cmd: Command) => {
      const opts = cmd.optsWithGlobals();
      const config = loadConfig(opts.config);
      const ctx = await openCli(config, Number(opts.account));
      try {
        const orderbook = await OrderbookContract.at(
          AztecAddress.fromString(config.orderbook),
          ctx.wallet,
        );
        await orderbook.methods.close_epoch().send({ from: ctx.account });

        const sim = await orderbook.methods.get_epoch().simulate({ from: ctx.account });
        const epoch = (sim as { result: { epoch_id: bigint; closes_at_block: bigint } }).result;
        console.log(
          `epoch advanced: now epoch ${epoch.epoch_id}, closes at block ${epoch.closes_at_block}`,
        );
      } finally {
        await ctx.stop();
      }
    });

  program
    .command("close-epoch-verified")
    .description(
      "advance the epoch and apply clearing by submitting a recursive ZK proof " +
      "(reads bb prove's binary proof file, bb write_vk's binary vk file, and a JSON " +
      "public_inputs file; bridges proof 500→456 and vk 115→127 to match the contract)",
    )
    .requiredOption("--proof <path>", "path to bb prove's binary proof file (e.g. circuits/clearing/target/proofdir/proof)")
    .requiredOption("--vk <path>", "path to bb write_vk's binary vk file (e.g. circuits/clearing/target/vk.bin/vk)")
    .requiredOption("--public-inputs <path>", "path to a JSON file containing the ClearingPublic struct")
    .action(async (opts, cmd: Command) => {
      const globalOpts = cmd.optsWithGlobals();
      const config = loadConfig(globalOpts.config);
      const ctx = await openCli(config, Number(globalOpts.account));
      try {
        const orderbook = await OrderbookContract.at(
          AztecAddress.fromString(config.orderbook),
          ctx.wallet,
        );

        const proofFields = readProofFile(opts.proof as string);
        const vkFields = readVkFile(opts.vk as string);
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        const publicInputsStruct = JSON.parse(
          readFileSync(opts.publicInputs as string, "utf8"),
          bigintReviver,
        ) as unknown;

        console.log(
          `Submitting close_epoch_and_clear_verified ` +
          `(proof: ${proofFields.length} fields, vk: ${vkFields.length} fields)...`,
        );
        // The generated Orderbook type is behind the deployed contract — it predates
        // the W5d-3 close_epoch_and_clear_verified function. Cast to access the method
        // dynamically (same pattern used for `wallet.stop()` throughout the codebase).
        const orderbookDyn = orderbook as unknown as {
          methods: {
            close_epoch_and_clear_verified: (
              publicInputs: unknown,
              proof: Fr[],
              vk: Fr[],
            ) => ContractFunctionInteraction;
          };
        };
        await orderbookDyn.methods
          .close_epoch_and_clear_verified(publicInputsStruct, proofFields, vkFields)
          .send({ from: ctx.account });

        const sim = await orderbook.methods.get_epoch().simulate({ from: ctx.account });
        const epoch = (sim as { result: { epoch_id: bigint; closes_at_block: bigint } }).result;
        console.log(
          `Epoch advanced + clearing applied: now epoch ${epoch.epoch_id}, ` +
          `closes at block ${epoch.closes_at_block}`,
        );
      } finally {
        await ctx.stop();
      }
    });
}
