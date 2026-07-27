/**
 * `@obscura/relayer` — UNTRUSTED transport for the Obscura cross-chain bridge.
 *
 * The relayer holds **no authority**. It only moves bytes:
 *   - header feed: beacon `LightClientFinalityUpdate` -> `EthLightClient.update_header`
 *     (decompressing the BLS signature off-chain; the on-chain pairing check is
 *     the trust root);
 *   - inclusion feed: `eth_getProof(bridgeL1, slot)` -> `ObscuraBridge.bridge_in`
 *     (the on-chain MPT verifier re-checks every node against the trusted root);
 *   - out feed: Soroban `bridge_out` authorization -> `ObscuraBridgeL1.unlock`
 *     (governor-gated, hackathon scope).
 *
 * CLI:
 *   obscura-relayer relay-header [--post-root] [--submit]
 *   obscura-relayer relay-in <commitment> [--block N] [--token 0x..] [--amount N] [--submit]
 *   obscura-relayer watch [--interval-ms N]
 *   obscura-relayer help
 *
 * Without `--submit` (and without the relevant signer secrets) every command is a
 * safe dry run: it fetches/derives and prints the operation it WOULD submit. Live
 * submission requires deployed contracts + funded keys (see README).
 */
import { pathToFileURL } from "node:url";
import { createPublicClient, createWalletClient, http, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";

import {
  fetchBootstrap,
  fetchFinalityUpdate,
  fetchFinalizedRoot,
} from "./beacon.js";
import { loadConfig, require_, type RelayerConfig } from "./config.js";
import {
  BridgeInSubmitter,
  decodeLockWord,
  deriveStorageSlot,
  fetchInclusionProof,
} from "./inclusion.js";
import { LightClientSubmitter } from "./lightclient.js";
import {
  SIGNAL_IMAGE_ID,
  SIGNAL_RISC0_VERIFIER_TESTNET,
  SignalClientSubmitter,
  fetchLatestSignalProof,
  parseJournal,
} from "./signal.js";
import { readLock, unlockOnL1, watchBridgeOut, watchLocked } from "./l1.js";

export * from "./types.js";
export * from "./beacon.js";
export * from "./scval.js";
export * from "./soroban.js";
export * from "./lightclient.js";
export * from "./signal.js";
export * from "./inclusion.js";
export * from "./l1.js";
export * from "./config.js";

const jsonReplacer = (_k: string, v: unknown): unknown => (typeof v === "bigint" ? v.toString() : v);
const log = (...a: unknown[]): void => console.log(...a);
const fail = (msg: string): never => {
  console.error(`error: ${msg}`);
  process.exit(1);
};

function makePublicClient(rpcUrl: string): PublicClient {
  return createPublicClient({ chain: sepolia, transport: http(rpcUrl) }) as PublicClient;
}

/** Parse `--flag value` / `--flag` pairs and positionals out of argv. */
function parseArgs(argv: string[]): { positionals: string[]; flags: Record<string, string | true> } {
  const positionals: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positionals.push(a);
    }
  }
  return { positionals, flags };
}

function stellarSubmitOpts(cfg: RelayerConfig, secret: string) {
  return {
    rpcUrl: require_(cfg, "stellarRpc", "STELLAR_RPC"),
    sourceSecret: secret,
    ...(cfg.stellarNetworkPassphrase ? { networkPassphrase: cfg.stellarNetworkPassphrase } : {}),
  };
}

// ---------------------------------------------------------------------------
// relay-header
// ---------------------------------------------------------------------------

async function relayHeader(cfg: RelayerConfig, flags: Record<string, string | true>): Promise<void> {
  const beacon = require_(cfg, "sepoliaBeaconApi", "SEPOLIA_BEACON_API");
  const update = await fetchFinalityUpdate(beacon, { timeoutMs: 20_000 });

  log("fetched finality update:");
  log(
    JSON.stringify(
      {
        signatureSlot: update.signatureSlot,
        attestedSlot: update.attestedHeader.slot,
        finalizedSlot: update.finalizedHeader.slot,
        executionBlock: update.finalizedExecution.blockNumber,
        executionStateRoot: update.finalizedExecution.stateRoot,
        participationBits: update.syncCommitteeBits.slice(0, 18) + "…",
        signatureUncompressedBytes: (update.syncCommitteeSignature.length - 2) / 2,
        finalityBranchLen: update.finalityBranch.length,
        executionBranchLen: update.executionBranch.length,
      },
      jsonReplacer,
      2,
    ),
  );

  const lcId = cfg.lightClientContract;
  if (!lcId) {
    log("\nno LIGHT_CLIENT_CONTRACT set — dry run only.");
    return;
  }
  const submitter = new LightClientSubmitter({
    contractId: lcId,
    ...(cfg.stellarNetworkPassphrase ? { networkPassphrase: cfg.stellarNetworkPassphrase } : {}),
  });

  if (flags["post-root"]) {
    // Fallback path (NOT trustless): post the proven exec state root via the admin key.
    if (!flags["submit"]) {
      log("\n[dry-run] post_root fallback op built (NOT trustless). Pass --submit + LIGHT_CLIENT_ADMIN_SECRET to send.");
      return;
    }
    const admin = cfg.lightClientAdminSecret ?? fail("post_root --submit needs LIGHT_CLIENT_ADMIN_SECRET");
    const { Keypair } = await import("@stellar/stellar-sdk");
    const adminPub = Keypair.fromSecret(admin).publicKey();
    const hash = await submitter.submitPostRoot(
      {
        admin: adminPub,
        blockNumber: update.finalizedExecution.blockNumber,
        stateRoot: update.finalizedExecution.stateRoot,
      },
      stellarSubmitOpts(cfg, admin),
    );
    log(`\nsubmitted post_root (fallback) -> ${hash}`);
    return;
  }

  const op = submitter.updateHeaderOp(update);
  if (!flags["submit"] || !cfg.stellarSignerSecret) {
    log(`\n[dry-run] update_header op built. XDR(base64):`);
    log(op.toXDR("base64"));
    log("Pass --submit + STELLAR_SIGNER_SECRET + STELLAR_RPC to send.");
    return;
  }
  const hash = await submitter.submitUpdateHeader(update, stellarSubmitOpts(cfg, cfg.stellarSignerSecret));
  log(`\nsubmitted update_header -> ${hash}`);
}

// ---------------------------------------------------------------------------
// relay-signal  (Boundless "The Signal" finality feed -> EthSignalClient.receive)
// ---------------------------------------------------------------------------

async function relaySignal(cfg: RelayerConfig, flags: Record<string, string | true>): Promise<void> {
  const proof = await fetchLatestSignalProof();
  const view = parseJournal(proof.journal);

  log("fetched Signal proof (Boundless mainnet Ethereum finality):");
  log(
    JSON.stringify(
      {
        epoch: proof.epoch,
        requestId: proof.requestId,
        fulfillTxHash: proof.fulfillTxHash,
        sealSelector: proof.seal.slice(0, 10),
        sealBytes: (proof.seal.length - 2) / 2,
        finalizedSlot: view.finalizedSlot,
        finalizedEpoch: view.finalizedEpoch,
        finalizedRoot: view.finalizedRoot,
      },
      jsonReplacer,
      2,
    ),
  );

  const id = cfg.signalClientContract;
  if (!id) {
    log("\nno SIGNAL_CLIENT_CONTRACT set — dry run only.");
    return;
  }
  const submitter = new SignalClientSubmitter({
    contractId: id,
    ...(cfg.stellarNetworkPassphrase ? { networkPassphrase: cfg.stellarNetworkPassphrase } : {}),
  });

  const op = submitter.receiveOp(proof.seal, proof.journal);
  if (!flags["submit"] || !cfg.stellarSignerSecret) {
    log("\n[dry-run] receive op built. XDR(base64):");
    log(op.toXDR("base64"));
    log("Pass --submit + STELLAR_SIGNER_SECRET + STELLAR_RPC to send.");
    log("(receive rejects any journal whose pre_state != the contract's current state — submit epochs in order.)");
    return;
  }
  const hash = await submitter.submitReceive(
    proof.seal,
    proof.journal,
    stellarSubmitOpts(cfg, cfg.stellarSignerSecret),
  );
  log(`\nsubmitted receive -> ${hash}`);
}

// ---------------------------------------------------------------------------
// signal-seed  (print the EthSignalClient deploy constructor args, fresh)
// ---------------------------------------------------------------------------

async function signalSeed(_cfg: RelayerConfig, _flags: Record<string, string | true>): Promise<void> {
  const proof = await fetchLatestSignalProof();
  const view = parseJournal(proof.journal);
  log("EthSignalClient deploy parameters (mainnet Ethereum finality -> Stellar):");
  log(
    JSON.stringify(
      {
        risc0_verifier: SIGNAL_RISC0_VERIFIER_TESTNET,
        image_id: SIGNAL_IMAGE_ID,
        // seed = the latest fulfilled journal's pre_state (128-byte ConsensusState).
        initial_state: view.preState,
        firstEpochToSubmit: proof.epoch,
      },
      jsonReplacer,
      2,
    ),
  );
  log(
    "\nDeploy, then submit this same epoch first with `relay-signal --submit` (receive chains" +
      " strictly from pre_state). The seed ages as finality advances — re-run signal-seed right before deploying.",
  );
}

// ---------------------------------------------------------------------------
// relay-in <commitment>
// ---------------------------------------------------------------------------

async function relayIn(
  cfg: RelayerConfig,
  positionals: string[],
  flags: Record<string, string | true>,
): Promise<void> {
  const commitment = positionals[0] as Hex | undefined;
  if (!commitment || !/^0x[0-9a-fA-F]{64}$/.test(commitment)) {
    fail("usage: relay-in <commitment(0x..32 bytes)> [--block N] [--token 0x..] [--amount N] [--submit]");
  }
  const c = commitment as Hex;
  const execRpc = require_(cfg, "sepoliaExecRpc", "SEPOLIA_EXEC_RPC");
  const bridgeL1 = require_(cfg, "bridgeL1Address", "BRIDGE_L1_ADDRESS");
  const client = makePublicClient(execRpc);

  // Determine the block to prove against: explicit --block, else the light client head.
  let blockNumber: bigint;
  if (typeof flags["block"] === "string") {
    blockNumber = BigInt(flags["block"]);
  } else if (cfg.lightClientContract && cfg.stellarRpc && cfg.stellarSignerSecret) {
    const { Keypair } = await import("@stellar/stellar-sdk");
    const lc = new LightClientSubmitter({
      contractId: cfg.lightClientContract,
      ...(cfg.stellarNetworkPassphrase ? { networkPassphrase: cfg.stellarNetworkPassphrase } : {}),
    });
    const head = await lc.readHead({
      rpcUrl: cfg.stellarRpc,
      sourceAccount: Keypair.fromSecret(cfg.stellarSignerSecret).publicKey(),
      ...(cfg.stellarNetworkPassphrase ? { networkPassphrase: cfg.stellarNetworkPassphrase } : {}),
    });
    blockNumber = head.blockNumber;
    log(`light client head block = ${blockNumber} (root ${head.stateRoot})`);
  } else {
    return fail("no --block given and light-client head unreadable (need LIGHT_CLIENT_CONTRACT + STELLAR_RPC + STELLAR_SIGNER_SECRET)");
  }

  const slot = deriveStorageSlot(c);
  log(`commitment ${c}`);
  log(`storage slot keccak256(abi.encode(commitment,0)) = ${slot}`);

  // token/amount: from flags, else read locks(commitment) on L1.
  let token = typeof flags["token"] === "string" ? (flags["token"] as Hex) : undefined;
  let amount = typeof flags["amount"] === "string" ? BigInt(flags["amount"]) : undefined;
  if (token === undefined || amount === undefined) {
    const rec = await readLock(client, bridgeL1, c);
    token = token ?? (rec.token as Hex);
    amount = amount ?? rec.amount;
    log(`locks(commitment) = { token: ${rec.token}, amount: ${rec.amount} }`);
  }

  const proof = await fetchInclusionProof(client, { bridgeL1, commitment: c, blockNumber });
  log(`eth_getProof @ block ${blockNumber}: account nodes=${proof.accountProof.length}, storage nodes=${proof.storageProof.length}`);
  const decoded = decodeLockWord(proof.value);
  log(`proven value decodes to { token: ${decoded.token}, amount: ${decoded.amount} }`);
  if (decoded.token.toLowerCase() !== token.toLowerCase() || decoded.amount !== amount) {
    log("WARNING: proven (token, amount) does not match the requested values; the contract will reject.");
  }

  if (!cfg.obscuraBridgeContract) {
    log("\nno OBSCURA_BRIDGE_CONTRACT set — dry run only (proof packaged, not submitted).");
    return;
  }
  const bridge = new BridgeInSubmitter({
    contractId: cfg.obscuraBridgeContract,
    ...(cfg.stellarNetworkPassphrase ? { networkPassphrase: cfg.stellarNetworkPassphrase } : {}),
  });
  const op = bridge.bridgeInOp({
    blockNumber,
    commitment: c,
    token,
    amount,
    accountProof: proof.accountProof,
    storageProof: proof.storageProof,
  });
  if (!flags["submit"] || !cfg.stellarSignerSecret) {
    log(`\n[dry-run] bridge_in op built. XDR(base64):`);
    log(op.toXDR("base64"));
    log("Pass --submit + STELLAR_SIGNER_SECRET + STELLAR_RPC to send.");
    return;
  }
  const hash = await bridge.submitBridgeIn(
    { blockNumber, commitment: c, token, amount, accountProof: proof.accountProof, storageProof: proof.storageProof },
    stellarSubmitOpts(cfg, cfg.stellarSignerSecret),
  );
  log(`\nsubmitted bridge_in -> ${hash}`);
}

// ---------------------------------------------------------------------------
// watch
// ---------------------------------------------------------------------------

async function watch(cfg: RelayerConfig, flags: Record<string, string | true>): Promise<void> {
  const intervalMs = typeof flags["interval-ms"] === "string" ? Number(flags["interval-ms"]) : 60_000;
  const stops: Array<() => void> = [];

  // Header loop.
  if (cfg.sepoliaBeaconApi && cfg.lightClientContract && cfg.stellarRpc && cfg.stellarSignerSecret) {
    const beacon = cfg.sepoliaBeaconApi;
    const submitter = new LightClientSubmitter({
      contractId: cfg.lightClientContract,
      ...(cfg.stellarNetworkPassphrase ? { networkPassphrase: cfg.stellarNetworkPassphrase } : {}),
    });
    const signer = cfg.stellarSignerSecret;
    let busy = false;
    const tick = async (): Promise<void> => {
      if (busy) return;
      busy = true;
      try {
        const update = await fetchFinalityUpdate(beacon, { timeoutMs: 20_000 });
        const hash = await submitter.submitUpdateHeader(update, stellarSubmitOpts(cfg, signer));
        log(`[header] finalized block ${update.finalizedExecution.blockNumber} -> update_header ${hash}`);
      } catch (err) {
        console.error("[header] failed:", err);
      } finally {
        busy = false;
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), intervalMs);
    timer.unref?.();
    stops.push(() => clearInterval(timer));
    log(`[watch] header loop every ${intervalMs}ms`);
  } else {
    log("[watch] header loop inactive (need SEPOLIA_BEACON_API + LIGHT_CLIENT_CONTRACT + STELLAR_RPC + STELLAR_SIGNER_SECRET)");
  }

  // Inclusion: watch L1 Locked -> relay-in.
  if (cfg.sepoliaExecRpc && cfg.bridgeL1Address && cfg.obscuraBridgeContract && cfg.stellarRpc && cfg.stellarSignerSecret) {
    const client = makePublicClient(cfg.sepoliaExecRpc);
    const bridgeL1 = cfg.bridgeL1Address;
    const bridge = new BridgeInSubmitter({
      contractId: cfg.obscuraBridgeContract,
      ...(cfg.stellarNetworkPassphrase ? { networkPassphrase: cfg.stellarNetworkPassphrase } : {}),
    });
    const lc =
      cfg.lightClientContract
        ? new LightClientSubmitter({
            contractId: cfg.lightClientContract,
            ...(cfg.stellarNetworkPassphrase ? { networkPassphrase: cfg.stellarNetworkPassphrase } : {}),
          })
        : undefined;
    const signer = cfg.stellarSignerSecret;
    const w = watchLocked(client, bridgeL1, async (ev) => {
      log(`[locked] commitment ${ev.commitment} token ${ev.token} amount ${ev.amount} @ block ${ev.blockNumber}`);
      try {
        const { Keypair } = await import("@stellar/stellar-sdk");
        const head = lc
          ? await lc.readHead({
              rpcUrl: cfg.stellarRpc!,
              sourceAccount: Keypair.fromSecret(signer).publicKey(),
              ...(cfg.stellarNetworkPassphrase ? { networkPassphrase: cfg.stellarNetworkPassphrase } : {}),
            })
          : { blockNumber: ev.blockNumber };
        const proof = await fetchInclusionProof(client, {
          bridgeL1,
          commitment: ev.commitment,
          blockNumber: head.blockNumber,
        });
        const hash = await bridge.submitBridgeIn(
          {
            blockNumber: head.blockNumber,
            commitment: ev.commitment,
            token: ev.token as Hex,
            amount: ev.amount,
            accountProof: proof.accountProof,
            storageProof: proof.storageProof,
          },
          stellarSubmitOpts(cfg, signer),
        );
        log(`[bridge_in] ${ev.commitment} -> ${hash}`);
      } catch (err) {
        console.error("[bridge_in] failed:", err);
      }
    });
    stops.push(() => w.stop());
    log("[watch] L1 Locked -> bridge_in active");
  } else {
    log("[watch] inclusion loop inactive (need SEPOLIA_EXEC_RPC + BRIDGE_L1_ADDRESS + OBSCURA_BRIDGE_CONTRACT + STELLAR_RPC + STELLAR_SIGNER_SECRET)");
  }

  // Out: watch Stellar bridge_out -> L1 unlock.
  if (cfg.stellarRpc && cfg.obscuraBridgeContract && cfg.bridgeL1Address && cfg.sepoliaExecRpc && cfg.governorPrivateKey) {
    const account = privateKeyToAccount(cfg.governorPrivateKey);
    const wallet = createWalletClient({ account, chain: sepolia, transport: http(cfg.sepoliaExecRpc) });
    const bridgeL1 = cfg.bridgeL1Address;
    const w = watchBridgeOut(
      { rpcUrl: cfg.stellarRpc, contractId: cfg.obscuraBridgeContract },
      async (ev) => {
        log(`[bridge_out] commitment ${ev.commitment} -> unlock to ${ev.l1Recipient}`);
        try {
          const hash = await unlockOnL1(wallet, bridgeL1, ev.commitment, ev.l1Recipient);
          log(`[unlock] ${ev.commitment} -> ${hash}`);
        } catch (err) {
          console.error("[unlock] failed:", err);
        }
      },
    );
    stops.push(() => w.stop());
    log("[watch] Stellar bridge_out -> L1 unlock active (governor)");
  } else {
    log("[watch] out loop inactive (need STELLAR_RPC + OBSCURA_BRIDGE_CONTRACT + BRIDGE_L1_ADDRESS + SEPOLIA_EXEC_RPC + GOVERNOR_PRIVATE_KEY)");
  }

  log("[watch] running; Ctrl-C to stop.");
  const shutdown = (): void => {
    log("\n[watch] stopping…");
    for (const s of stops) s();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  // Keep the process alive.
  await new Promise<void>(() => {});
}

// ---------------------------------------------------------------------------
// seed-committee (deploy-time helper)
// ---------------------------------------------------------------------------

async function seedCommittee(cfg: RelayerConfig, flags: Record<string, string | true>): Promise<void> {
  const beacon = require_(cfg, "sepoliaBeaconApi", "SEPOLIA_BEACON_API");
  const root =
    typeof flags["root"] === "string" ? (flags["root"] as Hex) : await fetchFinalizedRoot(beacon, { timeoutMs: 20_000 });
  log(`bootstrap anchor root = ${root}`);
  const bs = await fetchBootstrap(beacon, root, { timeoutMs: 30_000 });
  log(
    JSON.stringify(
      {
        period: bs.period,
        anchorSlot: bs.header.slot,
        committeeSize: bs.committee.length,
        firstPubkeyUncompressedBytes: bs.committee[0] ? (bs.committee[0].length - 2) / 2 : 0,
        aggregatePubkeyUncompressedBytes: (bs.aggregatePubkey.length - 2) / 2,
      },
      jsonReplacer,
      2,
    ),
  );
  log("\nUse these 512 uncompressed (96-byte) pubkeys as the EthLightClient constructor `committee` Vec<BytesN<96>>.");
  log("(Constructor seeding happens at deploy time via `stellar contract deploy`; see README.)");
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

function usage(): void {
  log(
    [
      "obscura-relayer — UNTRUSTED transport for the Obscura bridge",
      "",
      "Commands:",
      "  relay-header [--post-root] [--submit]            fetch finality update -> update_header (or post_root fallback)",
      "  relay-signal [--submit]                          fetch a Boundless Signal proof -> EthSignalClient.receive",
      "  signal-seed                                      print fresh EthSignalClient deploy args (verifier, image_id, initial_state)",
      "  relay-in <commitment> [--block N] [--token 0x..] [--amount N] [--submit]",
      "                                                   eth_getProof -> bridge_in",
      "  seed-committee [--root 0x..]                     fetch + decompress the 512-pubkey committee (deploy-time)",
      "  watch [--interval-ms N]                          poll headers + watch Locked + watch bridge_out",
      "  help                                             this message",
      "",
      "Config is read from the environment (see README). Without --submit / signer secrets, commands dry-run.",
    ].join("\n"),
  );
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const { positionals, flags } = parseArgs(argv);
  const command = positionals.shift() ?? "help";
  const cfg = loadConfig();
  switch (command) {
    case "relay-header":
      return relayHeader(cfg, flags);
    case "relay-signal":
      return relaySignal(cfg, flags);
    case "signal-seed":
      return signalSeed(cfg, flags);
    case "relay-in":
      return relayIn(cfg, positionals, flags);
    case "seed-committee":
      return seedCommittee(cfg, flags);
    case "watch":
      return watch(cfg, flags);
    case "help":
    case "--help":
    case "-h":
      return usage();
    default:
      console.error(`unknown command: ${command}\n`);
      usage();
      process.exit(1);
  }
}

// Auto-run when executed directly (not when imported).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
