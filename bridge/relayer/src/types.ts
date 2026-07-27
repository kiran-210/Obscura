/**
 * Plain TypeScript mirror of the on-chain `LightClientUpdate` `#[contracttype]`
 * (contracts/eth-light-client/src/types.rs). The relayer assembles this from a
 * beacon `LightClientFinalityUpdate`; `scval.ts` encodes it into the Soroban
 * ScVal the contract consumes.
 *
 * IMPORTANT — point encoding. The on-chain type expects **UNCOMPRESSED** BLS
 * points: the sync-committee signature is a 192-byte G2 point (`be(x.c1) ||
 * be(x.c0) || be(y.c1) || be(y.c0)`), and committee pubkeys are 96-byte G1
 * (`be(x) || be(y)`). Ethereum serves both compressed (96 / 48 bytes); the
 * (untrusted) relayer decompresses off-chain — see `beacon.ts`. This adds no
 * trust: the on-chain pairing check binds the point to the signed message.
 */
import type { Hex } from "viem";

/** SSZ `BeaconBlockHeader` — the container the sync committee signs. */
export interface BeaconHeaderData {
  slot: bigint;
  proposerIndex: bigint;
  /** 32-byte hex. */
  parentRoot: Hex;
  /** 32-byte hex. */
  stateRoot: Hex;
  /** 32-byte hex. */
  bodyRoot: Hex;
}

/**
 * SSZ `ExecutionPayloadHeader` (Capella+Deneb, 17 fields). All 32-byte roots /
 * hashes are big-endian hex. `baseFeePerGas` is the uint256 in 32-byte
 * **little-endian** SSZ form (matches the on-chain `BytesN<32>` field).
 * `logsBloom` is 256 bytes; `extraData` is <= 32 bytes.
 */
export interface ExecutionPayloadHeaderData {
  parentHash: Hex;
  /** 20-byte hex. */
  feeRecipient: Hex;
  stateRoot: Hex;
  receiptsRoot: Hex;
  /** 256-byte hex. */
  logsBloom: Hex;
  prevRandao: Hex;
  blockNumber: bigint;
  gasLimit: bigint;
  gasUsed: bigint;
  timestamp: bigint;
  /** <= 32-byte hex. */
  extraData: Hex;
  /** uint256 base fee, 32-byte LITTLE-endian hex (SSZ hash_tree_root form). */
  baseFeePerGas: Hex;
  blockHash: Hex;
  transactionsRoot: Hex;
  withdrawalsRoot: Hex;
  blobGasUsed: bigint;
  excessBlobGas: bigint;
}

/** A `LightClientFinalityUpdate`, flattened for on-chain verification. */
export interface LightClientUpdateData {
  attestedHeader: BeaconHeaderData;
  finalizedHeader: BeaconHeaderData;
  /** SSZ Merkle proof of `finalizedHeader` vs `attestedHeader.stateRoot`. */
  finalityBranch: Hex[];
  finalizedExecution: ExecutionPayloadHeaderData;
  /** SSZ Merkle proof of `finalizedExecution` vs `finalizedHeader.bodyRoot`. */
  executionBranch: Hex[];
  /** 512-bit participation bitfield, 64-byte hex, little-endian bit order. */
  syncCommitteeBits: Hex;
  /** UNCOMPRESSED 192-byte G2 aggregate signature hex (decompressed off-chain). */
  syncCommitteeSignature: Hex;
  signatureSlot: bigint;
}

/** Result of fetching + decompressing a sync-committee bootstrap (for seeding). */
export interface BootstrapData {
  /** 512 committee G1 pubkeys, UNCOMPRESSED 96-byte hex each. */
  committee: Hex[];
  /** Aggregate of all 512, UNCOMPRESSED 96-byte hex (informational; the contract
   *  recomputes its own aggregate at construction). */
  aggregatePubkey: Hex;
  /** Beacon header the bootstrap is anchored to. */
  header: BeaconHeaderData;
  /** Sync-committee period the committee belongs to. */
  period: bigint;
}
