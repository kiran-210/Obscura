/**
 * Beacon-chain header feed for the Obscura bridge relayer.
 *
 * Responsibilities:
 *   1. BLS12-381 point **decompression** (the relayer's core off-chain job): the
 *      Ethereum beacon API serves committee pubkeys 48-byte compressed and the
 *      sync signature 96-byte compressed; the Soroban `EthLightClient` has no
 *      decompression host function and consumes UNCOMPRESSED points (G1 96 bytes,
 *      G2 192 bytes). We decompress with `@noble/curves/bls12-381` into the exact
 *      `be(x)||be(y)` (G1) / `be(x.c1)||be(x.c0)||be(y.c1)||be(y.c0)` (G2) layout
 *      the host expects — byte-for-byte identical to the zkcrypto `bls12_381`
 *      crate the contract's own test vectors are produced with.
 *   2. Fetching the `LightClientFinalityUpdate` (+ `bootstrap` for seeding) and
 *      assembling the flattened `LightClientUpdateData` the contract verifies.
 *
 * Trust: decompression adds **no** trust. The on-chain pairing check binds the
 * signature point to the signed message, so any wrong decompression is rejected;
 * the committee (seeded at construction) is the trust root.
 */
import { bls12_381 } from "@noble/curves/bls12-381";
import { bytesToHex, hexToBytes, type Hex } from "viem";
import type {
  BeaconHeaderData,
  BootstrapData,
  ExecutionPayloadHeaderData,
  LightClientUpdateData,
} from "./types.js";

const G1 = bls12_381.G1.ProjectivePoint;
const G2 = bls12_381.G2.ProjectivePoint;

/** SLOTS_PER_EPOCH(32) * EPOCHS_PER_SYNC_COMMITTEE_PERIOD(256). */
export const SLOTS_PER_PERIOD = 8192n;

const COMMITTEE_SIZE = 512;

function toBytes(input: Hex | Uint8Array): Uint8Array {
  return typeof input === "string" ? hexToBytes(input) : input;
}

/**
 * Decompress a 48-byte compressed BLS12-381 G1 point (an Ethereum sync-committee
 * pubkey) into the 96-byte uncompressed `be(x) || be(y)` form the Soroban host
 * expects. Throws if the input is not 48 bytes or not a valid curve point.
 */
export function decompressG1(compressed: Hex | Uint8Array): Hex {
  const b = toBytes(compressed);
  if (b.length !== 48) throw new Error(`G1 compressed pubkey must be 48 bytes, got ${b.length}`);
  const uncompressed = G1.fromHex(b).toRawBytes(false);
  return bytesToHex(uncompressed);
}

/**
 * Decompress a 96-byte compressed BLS12-381 G2 point (an aggregate sync
 * signature) into the 192-byte uncompressed form the Soroban host expects.
 * Throws if the input is not 96 bytes or not a valid curve point.
 */
export function decompressG2(compressed: Hex | Uint8Array): Hex {
  const b = toBytes(compressed);
  if (b.length !== 96) throw new Error(`G2 compressed signature must be 96 bytes, got ${b.length}`);
  const uncompressed = G2.fromHex(b).toRawBytes(false);
  return bytesToHex(uncompressed);
}

/** Re-compress a 96-byte uncompressed G1 point back to 48-byte compressed (round-trip / testing). */
export function compressG1(uncompressed: Hex | Uint8Array): Hex {
  const b = toBytes(uncompressed);
  if (b.length !== 96) throw new Error(`G1 uncompressed must be 96 bytes, got ${b.length}`);
  return bytesToHex(G1.fromHex(b).toRawBytes(true));
}

/** Re-compress a 192-byte uncompressed G2 point back to 96-byte compressed (round-trip / testing). */
export function compressG2(uncompressed: Hex | Uint8Array): Hex {
  const b = toBytes(uncompressed);
  if (b.length !== 192) throw new Error(`G2 uncompressed must be 192 bytes, got ${b.length}`);
  return bytesToHex(G2.fromHex(b).toRawBytes(true));
}

/** Decompress 512 compressed committee pubkeys into 96-byte uncompressed hex each. */
export function decompressCommittee(pubkeys: (Hex | string)[]): Hex[] {
  if (pubkeys.length !== COMMITTEE_SIZE) {
    throw new Error(`expected ${COMMITTEE_SIZE} committee pubkeys, got ${pubkeys.length}`);
  }
  return pubkeys.map((pk) => decompressG1(normalizeHex(pk)));
}

/** Convert a uint256 (decimal string or bigint) to 32-byte little-endian hex (SSZ form). */
export function u256ToLe32(value: bigint | string | number): Hex {
  let v = typeof value === "bigint" ? value : BigInt(value);
  if (v < 0n) throw new Error("base_fee_per_gas must be non-negative");
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  if (v !== 0n) throw new Error("base_fee_per_gas exceeds uint256");
  return bytesToHex(out);
}

/** Ensure a value is `0x`-prefixed hex. */
function normalizeHex(h: string): Hex {
  return (h.startsWith("0x") ? h : `0x${h}`) as Hex;
}

function assertByteLen(h: Hex, n: number, field: string): void {
  const len = (h.length - 2) / 2;
  if (len !== n) throw new Error(`${field}: expected ${n} bytes, got ${len}`);
}

// ---------------------------------------------------------------------------
// Beacon JSON -> LightClientUpdateData assembly (pure; network-free, testable)
// ---------------------------------------------------------------------------

/** Minimal shape of the beacon `light_client/finality_update` `data` object. */
export interface RawFinalityUpdate {
  attested_header: { beacon: RawBeaconHeader };
  finalized_header: {
    beacon: RawBeaconHeader;
    execution: RawExecutionHeader;
    execution_branch: string[];
  };
  finality_branch: string[];
  sync_aggregate: { sync_committee_bits: string; sync_committee_signature: string };
  signature_slot: string;
}

interface RawBeaconHeader {
  slot: string;
  proposer_index: string;
  parent_root: string;
  state_root: string;
  body_root: string;
}

interface RawExecutionHeader {
  parent_hash: string;
  fee_recipient: string;
  state_root: string;
  receipts_root: string;
  logs_bloom: string;
  prev_randao: string;
  block_number: string;
  gas_limit: string;
  gas_used: string;
  timestamp: string;
  extra_data: string;
  base_fee_per_gas: string;
  block_hash: string;
  transactions_root: string;
  withdrawals_root: string;
  blob_gas_used: string;
  excess_blob_gas: string;
}

function assembleHeader(b: RawBeaconHeader): BeaconHeaderData {
  return {
    slot: BigInt(b.slot),
    proposerIndex: BigInt(b.proposer_index),
    parentRoot: normalizeHex(b.parent_root),
    stateRoot: normalizeHex(b.state_root),
    bodyRoot: normalizeHex(b.body_root),
  };
}

function assembleExecution(e: RawExecutionHeader): ExecutionPayloadHeaderData {
  const logsBloom = normalizeHex(e.logs_bloom);
  assertByteLen(logsBloom, 256, "logs_bloom");
  return {
    parentHash: normalizeHex(e.parent_hash),
    feeRecipient: normalizeHex(e.fee_recipient),
    stateRoot: normalizeHex(e.state_root),
    receiptsRoot: normalizeHex(e.receipts_root),
    logsBloom,
    prevRandao: normalizeHex(e.prev_randao),
    blockNumber: BigInt(e.block_number),
    gasLimit: BigInt(e.gas_limit),
    gasUsed: BigInt(e.gas_used),
    timestamp: BigInt(e.timestamp),
    extraData: normalizeHex(e.extra_data),
    baseFeePerGas: u256ToLe32(e.base_fee_per_gas),
    blockHash: normalizeHex(e.block_hash),
    transactionsRoot: normalizeHex(e.transactions_root),
    withdrawalsRoot: normalizeHex(e.withdrawals_root),
    blobGasUsed: BigInt(e.blob_gas_used),
    excessBlobGas: BigInt(e.excess_blob_gas),
  };
}

/**
 * Assemble a flattened {@link LightClientUpdateData} from a parsed beacon
 * `finality_update` `data` object, **decompressing** the G2 sync signature.
 * Pure — no network. The committee pubkeys are not part of a finality update
 * (they are seeded from the bootstrap); only the bits + signature are carried.
 */
export function assembleLightClientUpdate(data: RawFinalityUpdate): LightClientUpdateData {
  const bits = normalizeHex(data.sync_aggregate.sync_committee_bits);
  assertByteLen(bits, 64, "sync_committee_bits");
  const signature = decompressG2(normalizeHex(data.sync_aggregate.sync_committee_signature));
  assertByteLen(signature, 192, "sync_committee_signature (uncompressed)");
  return {
    attestedHeader: assembleHeader(data.attested_header.beacon),
    finalizedHeader: assembleHeader(data.finalized_header.beacon),
    finalityBranch: data.finality_branch.map(normalizeHex),
    finalizedExecution: assembleExecution(data.finalized_header.execution),
    executionBranch: data.finalized_header.execution_branch.map(normalizeHex),
    syncCommitteeBits: bits,
    syncCommitteeSignature: signature,
    signatureSlot: BigInt(data.signature_slot),
  };
}

/** Sync-committee period of a slot. */
export function periodOfSlot(slot: bigint): bigint {
  return slot / SLOTS_PER_PERIOD;
}

// ---------------------------------------------------------------------------
// Network fetch (integration; timeouts on every call)
// ---------------------------------------------------------------------------

/** Options for beacon HTTP requests. */
export interface FetchOptions {
  /** Abort the request after this many ms (default 15000). */
  timeoutMs?: number;
  /** Extra headers. */
  headers?: Record<string, string>;
}

/** GET `url`, parse JSON, with a hard timeout (never hangs silently). */
export async function fetchJson<T = unknown>(url: string, opts: FetchOptions = {}): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 15_000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { accept: "application/json", ...opts.headers },
    });
    if (!res.ok) {
      throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/$/, "")}${path}`;
}

/**
 * Fetch the current Sepolia `LightClientFinalityUpdate` and assemble it
 * (decompressing the signature). Integration: hits the beacon API.
 */
export async function fetchFinalityUpdate(
  beaconUrl: string,
  opts: FetchOptions = {},
): Promise<LightClientUpdateData> {
  const body = await fetchJson<{ version?: string; data: RawFinalityUpdate }>(
    joinUrl(beaconUrl, "/eth/v1/beacon/light_client/finality_update"),
    opts,
  );
  return assembleLightClientUpdate(body.data);
}

/** Fetch the current finalized beacon block root (anchor for a bootstrap). */
export async function fetchFinalizedRoot(beaconUrl: string, opts: FetchOptions = {}): Promise<Hex> {
  const body = await fetchJson<{ data: { root: string } }>(
    joinUrl(beaconUrl, "/eth/v1/beacon/headers/finalized"),
    opts,
  );
  return normalizeHex(body.data.root);
}

/**
 * Fetch a sync-committee `bootstrap` at `blockRoot` and decompress its 512 G1
 * pubkeys to the uncompressed form used to seed `EthLightClient`'s constructor.
 * Integration: hits the beacon API.
 */
export async function fetchBootstrap(
  beaconUrl: string,
  blockRoot: Hex,
  opts: FetchOptions = {},
): Promise<BootstrapData> {
  const body = await fetchJson<{
    data: {
      header: { beacon: RawBeaconHeader };
      current_sync_committee: { pubkeys: string[]; aggregate_pubkey: string };
    };
  }>(joinUrl(beaconUrl, `/eth/v1/beacon/light_client/bootstrap/${blockRoot}`), opts);

  const header = assembleHeader(body.data.header.beacon);
  return {
    committee: decompressCommittee(body.data.current_sync_committee.pubkeys),
    aggregatePubkey: decompressG1(normalizeHex(body.data.current_sync_committee.aggregate_pubkey)),
    header,
    period: periodOfSlot(header.slot),
  };
}
