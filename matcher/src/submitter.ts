/**
 * Build and submit `obscura-pool.match_orders(proof, public_inputs)` invoke operations via
 * the SDK's Soroban module.
 *
 * `match_orders` takes exactly two args (SPEC sec 9.1): the UltraHonk proof bytes and the
 * `public_inputs` byte string (8 x 32-byte big-endian Fr, SHARED sec 7). Encoding is fully
 * deterministic and unit-tested here; the live `submit` path (RPC prepare -> sign -> send)
 * is integration-only and never exercised by the unit tests.
 *
 * The pool contract address is injectable: explicit option > `OBSCURA_POOL_CONTRACT` env >
 * a passed-in `deployments.json` object (`contracts.obscuraPool`).
 */
import { ObscuraContract, encodePublicInputs, isValidProofLength, type ProofData } from "@obscura/sdk";
import type { xdr } from "@stellar/stellar-sdk";
import type { MatchMemos } from "./memo.js";

/** Shape of the parts of `deployments.json` we read. Newer match-memo pool wins. */
export interface DeploymentsLike {
  network?: string;
  networkPassphrase?: string;
  contracts?: {
    obscuraPool?: string;
    obscuraPoolMemo?: { contract?: string };
    obscuraPoolMatchMemo?: { contract?: string };
  };
}

/** Sources for the pool contract id, in priority order. */
export interface ContractIdSources {
  /** Explicit contract id ("C..."). Highest priority. */
  contractId?: string;
  /** Environment (defaults to `process.env`); reads `OBSCURA_POOL_CONTRACT`. */
  env?: Record<string, string | undefined>;
  /** Parsed `deployments.json`; reads `contracts.obscuraPool`. */
  deployments?: DeploymentsLike;
}

/**
 * Resolve the ObscuraPool contract id: explicit option, then `OBSCURA_POOL_CONTRACT`, then
 * `deployments.contracts.obscuraPool`. Throws if none is set.
 */
export function resolveContractId(sources: ContractIdSources = {}): string {
  const env = sources.env ?? process.env;
  const c = sources.deployments?.contracts;
  const id =
    sources.contractId ??
    env.OBSCURA_POOL_CONTRACT ??
    c?.obscuraPoolMatchMemo?.contract ?? // the pool the frontend targets (match memos)
    c?.obscuraPoolMemo?.contract ??
    c?.obscuraPool;
  if (!id) {
    throw new Error(
      "no ObscuraPool contract id; set it explicitly, via OBSCURA_POOL_CONTRACT, or in deployments.json (contracts.obscuraPool)",
    );
  }
  return id;
}

/** Result of encoding a match proof for submission. */
export interface EncodedMatch {
  /** Raw UltraHonk proof bytes. */
  proof: Uint8Array;
  /** `public_inputs` = 8 x 32-byte big-endian Fr, in SHARED sec 7 order (256 bytes). */
  publicInputs: Uint8Array;
}

/** Options for a live submission (integration-only). */
export interface LiveSubmitOptions {
  /** Soroban RPC URL, e.g. https://soroban-testnet.stellar.org. */
  rpcUrl: string;
  /** Secret seed ("S...") of the fee-paying / submitting account. */
  sourceSecret: string;
  /** Override the network passphrase (defaults to the submitter's). */
  networkPassphrase?: string;
  /** Transaction timeout in seconds (default 30). */
  timeoutSeconds?: number;
}

/**
 * Builds (and, optionally, live-submits) `match_orders` invoke operations against a
 * deployed ObscuraPool contract using the SDK's {@link ObscuraContract}.
 */
export class MatchSubmitter {
  readonly contractId: string;
  readonly networkPassphrase: string | undefined;
  private readonly contract: ObscuraContract;

  constructor(config: { contractId: string; networkPassphrase?: string }) {
    this.contractId = config.contractId;
    this.networkPassphrase = config.networkPassphrase;
    this.contract = new ObscuraContract({
      contractId: config.contractId,
      ...(config.networkPassphrase !== undefined ? { networkPassphrase: config.networkPassphrase } : {}),
    });
  }

  /** Construct a submitter, resolving the contract id from {@link ContractIdSources}. */
  static fromSources(sources: ContractIdSources & { networkPassphrase?: string } = {}): MatchSubmitter {
    const contractId = resolveContractId(sources);
    const networkPassphrase = sources.networkPassphrase ?? sources.deployments?.networkPassphrase;
    return new MatchSubmitter({ contractId, ...(networkPassphrase ? { networkPassphrase } : {}) });
  }

  /** Encode a proof's `public_inputs` byte string (8 x 32-byte BE Fr). */
  encode(proof: ProofData): EncodedMatch {
    if (proof.publicInputs.length !== 8) {
      throw new Error(`match_orders expects 8 public inputs, got ${proof.publicInputs.length}`);
    }
    return { proof: proof.proof, publicInputs: encodePublicInputs(proof.publicInputs) };
  }

  /**
   * Build the unsigned `match_orders(proof, public_inputs, leaf_memos, residual_memos)` invoke
   * operation. Does not touch the network. The proof length is validated by the SDK (0 or
   * PROOF_BYTES); the memo counts are bound to the outputs on-chain.
   */
  buildOperation(proof: ProofData, memos?: MatchMemos): xdr.Operation {
    const { proof: proofBytes, publicInputs } = this.encode(proof);
    return this.contract.matchOrdersOp({
      proof: proofBytes,
      publicInputs,
      leafMemos: memos?.leafMemos ?? [],
      residualMemos: memos?.residualMemos ?? [],
    });
  }

  /**
   * Live submission (integration-only; not covered by unit tests). Lazily loads the
   * Stellar RPC client, fetches the source account, builds + prepares + signs + sends the
   * transaction, and returns the transaction hash. Requires a funded source account and a
   * real, verifier-accepted proof.
   */
  async submit(proof: ProofData, opts: LiveSubmitOptions, memos?: MatchMemos): Promise<string> {
    if (!isValidProofLength(proof.proof)) {
      throw new Error(`refusing to submit a non-on-chain-length proof (${proof.proof.length} bytes)`);
    }
    const { Keypair, TransactionBuilder, BASE_FEE, Networks, rpc } = await import("@stellar/stellar-sdk");
    const networkPassphrase = opts.networkPassphrase ?? this.networkPassphrase ?? Networks.TESTNET;
    const keypair = Keypair.fromSecret(opts.sourceSecret);
    const server = new rpc.Server(opts.rpcUrl);
    const source = await server.getAccount(keypair.publicKey());

    const tx = new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase })
      .addOperation(this.buildOperation(proof, memos))
      .setTimeout(opts.timeoutSeconds ?? 30)
      .build();

    const prepared = await server.prepareTransaction(tx);
    prepared.sign(keypair);
    const sent = await server.sendTransaction(prepared);
    if (sent.status === "ERROR") {
      throw new Error(`match_orders submission failed: ${JSON.stringify(sent.errorResult ?? sent)}`);
    }
    return sent.hash;
  }
}
