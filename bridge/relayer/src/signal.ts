/**
 * Signal feed -> `EthSignalClient` Soroban contract.
 *
 * Replaces the BLS beacon header feed (`beacon.ts` -> `update_header`). Instead of
 * decompressing sync-committee points and submitting a `LightClientUpdate`, the
 * relayer pulls a **Boundless "The Signal"** RISC Zero finality proof and submits
 * `receive(seal, journal)`; the on-chain contract verifies the proof and advances
 * its trusted Ethereum consensus state. The relayer stays untrusted transport —
 * the seal is re-verified on-chain against the pinned image id.
 *
 * Live mainnet feed (verified 2026-06-30):
 *   - seal:    Boundless Market indexer (CloudFront), keyed by the requestor
 *   - journal: Signal artifacts host, keyed by Ethereum epoch (288-byte file)
 * `fulfill_journal` is null on-chain (DigestMatch predicate), so the seal and the
 * journal come from two sources; `sha256(journal)` is what the verifier checks.
 *
 * Building the operations + parsing the journal is pure and unit-tested; the live
 * fetch + submit paths are integration-only.
 */
import { Contract, Networks, xdr } from "@stellar/stellar-sdk";
import {
  encodeBeaconHeader,
  encodeExecutionPayloadHeader,
  scvBytesHex,
  scvU64,
  scvVecBytes32,
} from "./scval.js";
import { simulateView, submitInvoke, type LiveSubmitOptions, type ViewOptions } from "./soroban.js";
import type { BeaconHeaderData, ExecutionPayloadHeaderData } from "./types.js";
import type { Hex } from "viem";

/** Boundless Market indexer (Base mainnet) — serves Signal `fulfill_seal`s. */
export const SIGNAL_INDEXER_URL = "https://d2mdvlnmyov1e1.cloudfront.net";
/** The Signal Consensus Proof Requestor (Base) whose orders are the feed. */
export const SIGNAL_REQUESTOR = "0x734df7809c4ef94da037449c287166d114503198";
/** Signal artifacts host — serves the 288-byte journal per Ethereum epoch. */
export const SIGNAL_ARTIFACTS_URL = "https://signal-artifacts.beboundless.xyz/v3/consensus/mainnet";
/** Mainnet Signal-Ethereum guest image id (v1.3.0) — pin into the contract. */
export const SIGNAL_IMAGE_ID =
  "0x0ccb3d146a7f64e78cc1d146acc26912138ea39bb79b4ca74423389d61b2c30e" as Hex;
/** Deployed RISC Zero verifier on Stellar testnet (Boundless / Nethermind) — the
 *  `EthSignalClient` constructor's `risc0_verifier`. Handles the `0x73c457ba` seal. */
export const SIGNAL_RISC0_VERIFIER_TESTNET =
  "CANYRGDRBQPXPNEZRXDPETY7L4YVDTKTPP4QKHKZGMMHB74IR5HKIUXD";

/** A consumable Signal proof: seal from the indexer, journal from the artifacts host. */
export interface SignalProof {
  /** RISC Zero seal (set-inclusion -> Groth16 aggregation root), hex. */
  seal: Hex;
  /** 288-byte ABI journal, hex. */
  journal: Hex;
  /** Ethereum epoch the journal finalizes against. */
  epoch: number;
  requestId: string;
  fulfillTxHash?: string;
}

/** Decoded view of a 288-byte Signal journal (fixed alloy-ABI offsets). */
export interface JournalView {
  /** pre_state (128 bytes) hex — must equal the contract's current state. */
  preState: Hex;
  /** post_state (128 bytes) hex — adopted on a successful `receive`. */
  postState: Hex;
  /** finalized beacon block root (= post_state.finalized.root). */
  finalizedRoot: Hex;
  /** finalized checkpoint slot (= finalized.epoch * 32). */
  finalizedSlot: bigint;
  /** finalized checkpoint epoch (= post_state.finalized.epoch). */
  finalizedEpoch: bigint;
}

const trimSlash = (s: string): string => s.replace(/\/$/, "");

/** Options for hitting the live feed (override the public defaults for tests/forks). */
export interface SignalFeedOptions {
  indexerUrl?: string;
  requestor?: string;
  artifactsUrl?: string;
  limit?: number;
}

/** Fetch recent Signal market orders for the requestor (newest first). */
export async function fetchSignalRequests(opts: SignalFeedOptions = {}): Promise<any[]> {
  const base = trimSlash(opts.indexerUrl ?? SIGNAL_INDEXER_URL);
  const requestor = (opts.requestor ?? SIGNAL_REQUESTOR).toLowerCase();
  const limit = opts.limit ?? 20;
  const url = `${base}/v1/market/requestors/${requestor}/requests?limit=${limit}&sort_by=created_at`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Signal indexer ${res.status} for ${url}`);
  const body = (await res.json()) as { data?: any[] };
  return body.data ?? [];
}

/** Decode the Ethereum epoch from a request's hex-encoded `input_data` URL. */
export function epochFromInputData(inputData: string): number {
  const hex = inputData.startsWith("0x") ? inputData.slice(2) : inputData;
  const txt = Buffer.from(hex, "hex").toString("latin1");
  const m = txt.match(/(?:inputs|journals)\/(\d+)\.bin/);
  if (!m) throw new Error(`no epoch in input_data: ${txt.slice(0, 120)}`);
  return Number(m[1]);
}

/** Fetch the 288-byte journal for an Ethereum epoch from the artifacts host. */
export async function fetchJournal(
  epoch: number,
  artifactsUrl: string = SIGNAL_ARTIFACTS_URL,
): Promise<Hex> {
  const url = `${trimSlash(artifactsUrl)}/journals/${epoch}.bin`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Signal artifacts ${res.status} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length !== 288) throw new Error(`journal ${epoch} is ${buf.length} bytes, expected 288`);
  return `0x${buf.toString("hex")}` as Hex;
}

/** Pull the newest FULFILLED Signal proof (seal + journal) from the live feed. */
export async function fetchLatestSignalProof(opts: SignalFeedOptions = {}): Promise<SignalProof> {
  const reqs = await fetchSignalRequests(opts);
  const fulfilled = reqs.find((r) => r.request_status === "fulfilled" && r.fulfill_seal);
  if (!fulfilled) throw new Error("no fulfilled Signal request in the latest page");
  const epoch = epochFromInputData(fulfilled.input_data);
  const journal = await fetchJournal(epoch, opts.artifactsUrl ?? SIGNAL_ARTIFACTS_URL);
  return {
    seal: fulfilled.fulfill_seal as Hex,
    journal,
    epoch,
    requestId: fulfilled.request_id,
    fulfillTxHash: fulfilled.fulfill_tx_hash,
  };
}

/** Parse a 288-byte Signal journal by fixed offsets (mirrors the contract). */
export function parseJournal(journal: Hex): JournalView {
  const b = Buffer.from(journal.slice(2), "hex");
  if (b.length !== 288) throw new Error(`journal is ${b.length} bytes, expected 288`);
  const slice = (start: number, end: number): Hex =>
    `0x${b.subarray(start, end).toString("hex")}` as Hex;
  // A uint64 lives in the last 8 bytes of its 32-byte ABI word.
  return {
    preState: slice(0, 128),
    postState: slice(128, 256),
    finalizedRoot: slice(224, 256),
    finalizedSlot: b.readBigUInt64BE(280), // word [256..288]
    finalizedEpoch: b.readBigUInt64BE(216), // post.finalized.epoch word [192..224]
  };
}

/** Builds / submits operations against a deployed `EthSignalClient` contract. */
export class SignalClientSubmitter {
  readonly contract: Contract;
  readonly contractId: string;
  readonly networkPassphrase: string;

  constructor(opts: { contractId: string; networkPassphrase?: string }) {
    this.contractId = opts.contractId;
    this.contract = new Contract(opts.contractId);
    this.networkPassphrase = opts.networkPassphrase ?? Networks.TESTNET;
  }

  /** Build `receive(seal, journal)` (Step 1 — advance finality). No network. */
  receiveOp(seal: Hex, journal: Hex): xdr.Operation {
    return this.contract.call("receive", scvBytesHex(seal), scvBytesHex(journal));
  }

  /** Build `prove_execution(...)` (Step 2 — derive the execution state root). No network. */
  proveExecutionOp(args: {
    finalizedSlot: bigint | number;
    finalizedHeader: BeaconHeaderData;
    execution: ExecutionPayloadHeaderData;
    executionBranch: Hex[];
  }): xdr.Operation {
    return this.contract.call(
      "prove_execution",
      scvU64(args.finalizedSlot),
      encodeBeaconHeader(args.finalizedHeader),
      encodeExecutionPayloadHeader(args.execution),
      scvVecBytes32(args.executionBranch),
    );
  }

  /** Live-submit `receive`. Integration-only. Returns the tx hash. */
  async submitReceive(seal: Hex, journal: Hex, opts: LiveSubmitOptions): Promise<string> {
    return submitInvoke(this.receiveOp(seal, journal), {
      networkPassphrase: this.networkPassphrase,
      ...opts,
    });
  }

  /** Live-submit `prove_execution`. Integration-only. Returns the tx hash. */
  async submitProveExecution(
    args: Parameters<SignalClientSubmitter["proveExecutionOp"]>[0],
    opts: LiveSubmitOptions,
  ): Promise<string> {
    return submitInvoke(this.proveExecutionOp(args), {
      networkPassphrase: this.networkPassphrase,
      ...opts,
    });
  }

  /** Read the contract's current trusted `ConsensusState` (128-byte hex) by simulation. */
  async readCurrentState(opts: ViewOptions): Promise<Hex> {
    const v = (await simulateView(this.contractId, "current_state", {
      networkPassphrase: this.networkPassphrase,
      ...opts,
    })) as Uint8Array;
    return `0x${Buffer.from(v).toString("hex")}` as Hex;
  }

  /** Read the Signal-proven finalized beacon root at a slot (null if unknown). */
  async readBeaconRoot(slot: bigint | number, opts: ViewOptions): Promise<Hex | null> {
    const v = (await simulateView(
      this.contractId,
      "beacon_root",
      { networkPassphrase: this.networkPassphrase, ...opts },
      scvU64(slot),
    )) as Uint8Array | null | undefined;
    return v ? (`0x${Buffer.from(v).toString("hex")}` as Hex) : null;
  }

  /** Read the proven execution `state_root` at a block (null if unknown). */
  async readStateRootAt(blockNumber: bigint | number, opts: ViewOptions): Promise<Hex | null> {
    const v = (await simulateView(
      this.contractId,
      "state_root_at",
      { networkPassphrase: this.networkPassphrase, ...opts },
      scvU64(blockNumber),
    )) as Uint8Array | null | undefined;
    return v ? (`0x${Buffer.from(v).toString("hex")}` as Hex) : null;
  }

  /** Read the trusted execution head `(block_number, state_root)`. */
  async readHead(opts: ViewOptions): Promise<{ blockNumber: bigint; stateRoot: Hex }> {
    const head = (await simulateView(this.contractId, "head", {
      networkPassphrase: this.networkPassphrase,
      ...opts,
    })) as [bigint | number, Uint8Array];
    return {
      blockNumber: BigInt(head[0]),
      stateRoot: `0x${Buffer.from(head[1]).toString("hex")}` as Hex,
    };
  }
}
