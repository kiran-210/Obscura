/**
 * Soroban ScVal encoding for the bridge contracts' argument types.
 *
 * The on-chain `#[contracttype]` structs (`LightClientUpdate`, `BeaconHeader`,
 * `ExecutionPayloadHeader`) cross the host boundary as an `ScVal::Map` keyed by
 * the field names as **Symbols**, and the host requires the map entries to be in
 * ascending key order. {@link structToScVal} sorts entries with the exact
 * Soroban symbol comparator so the produced map is accepted as-is (and decodes
 * back to the struct by field lookup, independent of declaration order).
 */
import { Address, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { hexToBytes, type Hex } from "viem";
import type { BeaconHeaderData, ExecutionPayloadHeaderData, LightClientUpdateData } from "./types.js";

/** u64 ScVal. */
export const scvU64 = (n: bigint | number): xdr.ScVal => nativeToScVal(BigInt(n), { type: "u64" });

/** i128 ScVal. */
export const scvI128 = (n: bigint | number): xdr.ScVal => nativeToScVal(BigInt(n), { type: "i128" });

/** Bytes ScVal from hex or raw bytes (also encodes `BytesN<N>` — length is the caller's contract). */
export const scvBytesHex = (h: Hex | Uint8Array): xdr.ScVal =>
  xdr.ScVal.scvBytes(Buffer.from(typeof h === "string" ? hexToBytes(h) : h));

/** Vec<Bytes> ScVal from an array of hex/byte items. */
export const scvVecBytes = (items: (Hex | Uint8Array)[]): xdr.ScVal =>
  xdr.ScVal.scvVec(items.map(scvBytesHex));

/** Vec<BytesN<32>> ScVal (same wire form as Vec<Bytes>). */
export const scvVecBytes32 = scvVecBytes;

/** Address ScVal ("C..." contract or "G..." account). */
export const scvAddress = (addr: string): xdr.ScVal => new Address(addr).toScVal();

// ---------------------------------------------------------------------------
// Soroban symbol ordering (for valid, host-accepted struct maps)
// ---------------------------------------------------------------------------

/**
 * Soroban symbol character code: `_`=1, `0-9`=2..11, `A-Z`=12..37, `a-z`=38..63.
 * This is the order the host compares symbols by (not raw ASCII). Throws on any
 * character outside the symbol alphabet.
 */
function symbolCode(ch: number): number {
  if (ch === 0x5f) return 1; // '_'
  if (ch >= 0x30 && ch <= 0x39) return 2 + (ch - 0x30); // '0'..'9'
  if (ch >= 0x41 && ch <= 0x5a) return 12 + (ch - 0x41); // 'A'..'Z'
  if (ch >= 0x61 && ch <= 0x7a) return 38 + (ch - 0x61); // 'a'..'z'
  throw new Error(`invalid Soroban symbol character: 0x${ch.toString(16)}`);
}

/** Compare two field names in Soroban symbol order. */
export function compareSymbol(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = symbolCode(a.charCodeAt(i)) - symbolCode(b.charCodeAt(i));
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  if (a.length === b.length) return 0;
  return a.length < b.length ? -1 : 1;
}

/**
 * Encode a named-field struct as an `ScVal::Map` with symbol keys, sorted in
 * Soroban order (so the host accepts it without re-sorting).
 */
export function structToScVal(fields: Record<string, xdr.ScVal>): xdr.ScVal {
  const entries = Object.keys(fields)
    .sort(compareSymbol)
    .map(
      (key) =>
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol(key),
          val: fields[key]!,
        }),
    );
  return xdr.ScVal.scvMap(entries);
}

// ---------------------------------------------------------------------------
// Bridge struct encoders
// ---------------------------------------------------------------------------

/** Encode a {@link BeaconHeaderData} as the on-chain `BeaconHeader` struct. */
export function encodeBeaconHeader(h: BeaconHeaderData): xdr.ScVal {
  return structToScVal({
    slot: scvU64(h.slot),
    proposer_index: scvU64(h.proposerIndex),
    parent_root: scvBytesHex(h.parentRoot),
    state_root: scvBytesHex(h.stateRoot),
    body_root: scvBytesHex(h.bodyRoot),
  });
}

/** Encode an {@link ExecutionPayloadHeaderData} as the on-chain `ExecutionPayloadHeader` struct. */
export function encodeExecutionPayloadHeader(e: ExecutionPayloadHeaderData): xdr.ScVal {
  return structToScVal({
    parent_hash: scvBytesHex(e.parentHash),
    fee_recipient: scvBytesHex(e.feeRecipient),
    state_root: scvBytesHex(e.stateRoot),
    receipts_root: scvBytesHex(e.receiptsRoot),
    logs_bloom: scvBytesHex(e.logsBloom),
    prev_randao: scvBytesHex(e.prevRandao),
    block_number: scvU64(e.blockNumber),
    gas_limit: scvU64(e.gasLimit),
    gas_used: scvU64(e.gasUsed),
    timestamp: scvU64(e.timestamp),
    extra_data: scvBytesHex(e.extraData),
    base_fee_per_gas: scvBytesHex(e.baseFeePerGas),
    block_hash: scvBytesHex(e.blockHash),
    transactions_root: scvBytesHex(e.transactionsRoot),
    withdrawals_root: scvBytesHex(e.withdrawalsRoot),
    blob_gas_used: scvU64(e.blobGasUsed),
    excess_blob_gas: scvU64(e.excessBlobGas),
  });
}

/** Encode a {@link LightClientUpdateData} as the on-chain `LightClientUpdate` struct. */
export function encodeLightClientUpdate(u: LightClientUpdateData): xdr.ScVal {
  return structToScVal({
    attested_header: encodeBeaconHeader(u.attestedHeader),
    finalized_header: encodeBeaconHeader(u.finalizedHeader),
    finality_branch: scvVecBytes32(u.finalityBranch),
    finalized_execution: encodeExecutionPayloadHeader(u.finalizedExecution),
    execution_branch: scvVecBytes32(u.executionBranch),
    sync_committee_bits: scvBytesHex(u.syncCommitteeBits),
    sync_committee_signature: scvBytesHex(u.syncCommitteeSignature),
    signature_slot: scvU64(u.signatureSlot),
  });
}
