/** Shared, network-free fixtures for the relayer unit tests. */
import type { Hex } from "viem";
import type { RawFinalityUpdate } from "../src/beacon.js";
import type { LightClientUpdateData } from "../src/types.js";

const b32 = (fill: string): Hex => `0x${fill.repeat(32)}` as Hex;
const b20 = (fill: string): Hex => `0x${fill.repeat(20)}` as Hex;

/** A 192-byte uncompressed G2 (the generator) — a structurally valid signature value. */
export const G2_UNCOMPRESSED: Hex =
  "0x13e02b6052719f607dacd3a088274f65596bd0d09920b61ab5da61bbdc7f5049334cf11213945d57e5ac7d055d042b7e024aa2b2f08f0a91260805272dc51051c6e47ad4fa403b02b4510b647ae3d1770bac0326a805bbefd48056c8c121bdb80606c4a02ea734cc32acd2b02bc28b99cb3e287e85a763af267492ab572e99ab3f370d275cec1da1aaa9075ff05f79be0ce5d527727d6e118cc9cdc6da2e351aadfd9baa8cbdd3a76d429a695160d12c923ac9cc3baca289e193548608b82801";

/** A minimal, structurally-correct {@link LightClientUpdateData} (not a real update). */
export function minimalUpdate(): LightClientUpdateData {
  return {
    attestedHeader: {
      slot: 100n,
      proposerIndex: 7n,
      parentRoot: b32("aa"),
      stateRoot: b32("bb"),
      bodyRoot: b32("cc"),
    },
    finalizedHeader: {
      slot: 96n,
      proposerIndex: 9n,
      parentRoot: b32("dd"),
      stateRoot: b32("ee"),
      bodyRoot: b32("ff"),
    },
    finalityBranch: [b32("01"), b32("02"), b32("03"), b32("04"), b32("05"), b32("06")],
    finalizedExecution: {
      parentHash: b32("10"),
      feeRecipient: b20("11"),
      stateRoot: b32("12"),
      receiptsRoot: b32("13"),
      logsBloom: (`0x${"00".repeat(256)}`) as Hex,
      prevRandao: b32("14"),
      blockNumber: 11_173_338n,
      gasLimit: 30_000_000n,
      gasUsed: 12_345n,
      timestamp: 1_700_000_000n,
      extraData: "0x" as Hex,
      baseFeePerGas: b32("00"),
      blockHash: b32("15"),
      transactionsRoot: b32("16"),
      withdrawalsRoot: b32("17"),
      blobGasUsed: 0n,
      excessBlobGas: 0n,
    },
    executionBranch: [b32("21"), b32("22"), b32("23"), b32("24")],
    syncCommitteeBits: (`0x${"ff".repeat(64)}`) as Hex,
    syncCommitteeSignature: G2_UNCOMPRESSED,
    signatureSlot: 101n,
  };
}

/**
 * A minimal raw beacon `finality_update` `data` object with a COMPRESSED G2
 * signature (the generator) so `assembleLightClientUpdate` exercises real
 * decompression. Field values are placeholders, not a real consensus update.
 */
export function rawFinalityUpdate(): RawFinalityUpdate {
  return {
    attested_header: {
      beacon: {
        slot: "100",
        proposer_index: "7",
        parent_root: b32("aa"),
        state_root: b32("bb"),
        body_root: b32("cc"),
      },
    },
    finalized_header: {
      beacon: {
        slot: "96",
        proposer_index: "9",
        parent_root: b32("dd"),
        state_root: b32("ee"),
        body_root: b32("ff"),
      },
      execution: {
        parent_hash: b32("10"),
        fee_recipient: b20("11"),
        state_root: b32("12"),
        receipts_root: b32("13"),
        logs_bloom: `0x${"00".repeat(256)}`,
        prev_randao: b32("14"),
        block_number: "11173338",
        gas_limit: "30000000",
        gas_used: "12345",
        timestamp: "1700000000",
        extra_data: "0x",
        base_fee_per_gas: "1000000007",
        block_hash: b32("15"),
        transactions_root: b32("16"),
        withdrawals_root: b32("17"),
        blob_gas_used: "0",
        excess_blob_gas: "0",
      },
      execution_branch: [b32("21"), b32("22"), b32("23"), b32("24")],
    },
    finality_branch: [b32("01"), b32("02"), b32("03"), b32("04"), b32("05"), b32("06")],
    sync_aggregate: {
      sync_committee_bits: `0x${"ff".repeat(64)}`,
      // COMPRESSED G2 generator (96 bytes) — decompresses to G2_UNCOMPRESSED.
      sync_committee_signature:
        "0x93e02b6052719f607dacd3a088274f65596bd0d09920b61ab5da61bbdc7f5049334cf11213945d57e5ac7d055d042b7e024aa2b2f08f0a91260805272dc51051c6e47ad4fa403b02b4510b647ae3d1770bac0326a805bbefd48056c8c121bdb8",
    },
    signature_slot: "101",
  };
}
