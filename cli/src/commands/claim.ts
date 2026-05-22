import type { Command } from "commander";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { Fr } from "@aztec/aztec.js/fields";
import { OrderbookContract } from "../../../tests/integration/generated/Orderbook.js";
import { loadConfig } from "../config.js";
import { openCli } from "../wallet.js";
import { parseField } from "../field.js";
import { findEpochForNonce } from "../../../aggregator/src/snapshot.js";

const DEFAULT_SNAPSHOT_DIR = process.env.ZSWAP_SNAPSHOT_DIR ?? "aggregator/snapshots";

// ---------------------------------------------------------------------------
// Sub-4 snapshot types (hop-fill format).
// The aggregator writes these during close_epoch_and_clear_verified (Task F1).
// ---------------------------------------------------------------------------

/** One hop-fill entry as stored in a Sub-4 epoch-<N>.json snapshot. */
interface HopFillLeafJson {
  order_nonce: string;  // 0x-prefixed Field hex
  hop_index: number;    // 0 or 1
  amount_out: string;   // decimal bigint string
  pool_id: number;
  leaf_index: number;   // position in the 64-leaf tree
}

/**
 * Sub-4 snapshot JSON written by the aggregator.
 * The `hop_paths` map is keyed by "<order_nonce_hex>:<hop_index>" and holds the
 * 6-element sibling path for the 64-leaf hop-fill Merkle tree.
 */
interface HopSnapshotJson {
  epoch_id: number;
  fills_root: string;                            // 0x-prefixed Field hex
  hop_fills: HopFillLeafJson[];                  // all populated hop-fill leaves
  hop_paths: Record<string, string[]>;           // key: "<nonce>:<hop>" → siblings[6]
}

// ---------------------------------------------------------------------------
// Snapshot loader helpers
// TODO Task F1: replace stubs with real aggregator snapshot writes once the
//               Sub-4 witness builder serialises HopFillLeafJson + hop_paths.
// ---------------------------------------------------------------------------

/**
 * Load the Sub-4 hop-fills snapshot for a specific epoch.
 * TODO Task F1: real implementation once aggregator writes Sub-4 snapshots.
 */
function loadHopSnapshot(snapshotsDir: string, epochId: number): HopSnapshotJson {
  // TODO Task F1: read and parse `${snapshotsDir}/epoch-${epochId}.json` as HopSnapshotJson.
  throw new Error(
    `TODO Task F1: Sub-4 hop snapshot loader not yet wired. ` +
    `Expected file: ${snapshotsDir}/epoch-${epochId}.json (HopSnapshotJson format).`,
  );
}

/**
 * Compute the 6-sibling Merkle proof for a specific hop-fill leaf from the snapshot.
 * Returns { leaf_index, sibling_path } ready for claim_fill.
 * TODO Task F1: real implementation once aggregator writes sub-path arrays.
 */
function computeHopMerkleProof(
  snap: HopSnapshotJson,
  leaf: HopFillLeafJson,
): { leaf_index: number; sibling_path: Fr[] } {
  // TODO Task F1: look up snap.hop_paths[`${leaf.order_nonce}:${leaf.hop_index}`]
  //              and parse into Fr[].
  void snap;
  void leaf;
  throw new Error(
    `TODO Task F1: computeHopMerkleProof not yet implemented — ` +
    `wire after aggregator emits hop_paths in Sub-4 snapshot format.`,
  );
}

// ---------------------------------------------------------------------------
// Per-hop claim dispatch
// ---------------------------------------------------------------------------

async function claimSingleHop(
  ctx: Awaited<ReturnType<typeof openCli>>,
  config: ReturnType<typeof loadConfig>,
  orderNonce: Fr,
  hop: 0 | 1,
  snapshotsDir: string,
  epochId: number,
): Promise<void> {
  const snap = loadHopSnapshot(snapshotsDir, epochId);  // TODO Task F1

  const nonceHex = orderNonce.toString();
  const leaf = snap.hop_fills.find(
    (f) => f.order_nonce === nonceHex && f.hop_index === hop,
  );
  if (!leaf) {
    throw new Error(
      `no fill for nonce=${nonceHex} hop=${hop} in epoch-${epochId} snapshot`,
    );
  }
  if (leaf.amount_out === "0") {
    throw new Error(
      `order ${nonceHex} hop ${hop} has amount_out = 0 (not filled). ` +
      `Use cancel_order during the next OPEN epoch instead.`,
    );
  }

  const merkleProof = computeHopMerkleProof(snap, leaf);  // TODO Task F1

  const orderbook = await OrderbookContract.at(
    AztecAddress.fromString(config.orderbook),
    ctx.wallet,
  );

  // Cast through `any`: the generated TS bindings are stale relative to the
  // Sub-4 claim_fill signature until `pnpm codegen` runs after a Noir build.
  const orderbookDyn = orderbook as unknown as {
    methods: {
      claim_fill: (
        epochId: number,
        orderNonce: Fr,
        hopIndex: bigint,
        amountOut: bigint,
        poolId: bigint,
        leafIndex: bigint,
        siblingPath: Fr[],
      ) => { send: (args: { from: AztecAddress }) => Promise<unknown> };
    };
  };

  await orderbookDyn.methods
    .claim_fill(
      epochId,
      orderNonce,
      BigInt(hop),
      BigInt(leaf.amount_out),
      BigInt(leaf.pool_id),
      BigInt(merkleProof.leaf_index),
      merkleProof.sibling_path,
    )
    .send({ from: ctx.account });

  console.log(
    `claimed hop=${hop} amount=${leaf.amount_out} token via pool ${leaf.pool_id} ` +
    `for order ${nonceHex} (epoch ${epochId}, leaf_index ${merkleProof.leaf_index})`,
  );
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function registerClaim(program: Command): void {
  program
    .command("claim")
    .description("claim the output of a filled order via Merkle inclusion proof")
    .requiredOption("--nonce <field>", "order-identity nonce of the filled order")
    .option("--epoch <num>", "epoch_id the order was filled in (auto-discovered if omitted)")
    .option(
      "--hop <n>",
      "which hop fill to claim: 0, 1, or 'all' (default: 0). Use 'all' to claim both hops of a 2-hop order sequentially.",
      "0",
    )
    .option(
      "--snapshots <dir>",
      "directory containing aggregator/snapshots/epoch-<N>.json (default: aggregator/snapshots; override via $ZSWAP_SNAPSHOT_DIR)",
      DEFAULT_SNAPSHOT_DIR,
    )
    .action(async (_opts, cmd: Command) => {
      const opts = cmd.optsWithGlobals();
      // parseField returns bigint; wrap in Fr so .toString() yields the 0x-hex
      // form that matches snapshot map keys.
      const orderNonce = new Fr(parseField(String(opts.nonce)));
      const snapshotsDir: string = opts.snapshots as string;
      const hopOpt = String(opts.hop);

      // Validate --hop early before connecting wallet.
      if (hopOpt !== "0" && hopOpt !== "1" && hopOpt !== "all") {
        throw new Error(`--hop must be 0, 1, or 'all', got '${hopOpt}'`);
      }

      // Resolve the epoch the maker's nonce was filled in.
      const nonceHex = orderNonce.toString();
      const epochId: number | null =
        opts.epoch !== undefined
          ? Number(opts.epoch)
          : findEpochForNonce(snapshotsDir, nonceHex);
      if (epochId === null) {
        throw new Error(
          `could not locate a snapshot file containing nonce ${nonceHex} under ${snapshotsDir}. ` +
          `Pass --epoch <N> explicitly, or check the aggregator wrote a snapshot for that epoch.`,
        );
      }

      const config = loadConfig(opts.config);
      const ctx = await openCli(config, Number(opts.account));
      try {
        if (hopOpt === "all") {
          // Claim hop 0 then hop 1 in sequence (two separate txs).
          await claimSingleHop(ctx, config, orderNonce, 0, snapshotsDir, epochId);
          await claimSingleHop(ctx, config, orderNonce, 1, snapshotsDir, epochId);
        } else {
          const hop = Number(hopOpt) as 0 | 1;
          await claimSingleHop(ctx, config, orderNonce, hop, snapshotsDir, epochId);
        }
      } finally {
        await ctx.stop();
      }
    });
}
