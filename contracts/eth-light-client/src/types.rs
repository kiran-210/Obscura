use soroban_sdk::{contracterror, contractevent, contracttype, Bytes, BytesN, Vec};

/// Storage keys. Config + head live in instance storage (loaded on every call);
/// the 512-pubkey committee lives in persistent storage (loaded only by
/// `update_header`, never by `post_root`), and per-block roots are persistent.
#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    /// `Bytes`: 512 * 96 bytes — the committee G1 pubkeys in UNCOMPRESSED form,
    /// concatenated. See README for why uncompressed (host has no decompression).
    Committee,
    /// `BytesN<96>`: precomputed aggregate (sum) of all 512 committee pubkeys, G1
    /// uncompressed. Computed in-contract at construction (not a trusted input).
    CommitteeAgg,
    /// `BytesN<32>`: genesis_validators_root (domain separation).
    GenesisRoot,
    /// `BytesN<4>`: active fork version used in `compute_domain`.
    ForkVersion,
    /// `u64`: the sync-committee period the seeded committee belongs to,
    /// pinned on the first successful `update_header`.
    CommitteePeriod,
    /// `u64`: execution block number of the current trusted head.
    HeadBlock,
    /// `BytesN<32>`: execution state root of the current trusted head.
    HeadRoot,
    /// `Address`: admin for the (non-trustless) posted-root fallback only.
    Admin,
    /// `BytesN<32>`: execution state root proven for a given block number.
    Root(u64),
}

#[contracterror]
#[repr(u32)]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum LcError {
    /// Committee seed was not exactly 512 pubkeys.
    BadCommitteeSize = 1,
    /// Slot ordering invariant violated
    /// (need current >= signature_slot > attested_slot >= finalized_slot).
    BadSlotOrder = 2,
    /// signature_slot is outside the seeded committee's single sync-committee period.
    WrongPeriod = 3,
    /// Sync-committee participation below the strict > 2/3 threshold.
    InsufficientParticipation = 4,
    /// `sync_committee_bits` was not exactly 64 bytes (512 bits).
    BadBitsLength = 5,
    /// Aggregate pubkey is not a valid point in the G1 prime-order subgroup.
    BadAggregate = 6,
    /// Signature is not a valid point in the G2 prime-order subgroup.
    BadSignaturePoint = 7,
    /// BLS pairing check failed — the aggregate signature is invalid for this header.
    BadSignature = 8,
    /// finality_branch Merkle proof did not reconstruct the attested state root.
    BadFinalityProof = 9,
    /// execution_branch Merkle proof did not reconstruct the finalized body root.
    BadExecutionProof = 10,
    /// A provided branch had an unexpected length / malformed field.
    Malformed = 11,
    /// Caller is not the configured admin.
    NotAdmin = 12,
    /// logs_bloom field was not exactly 256 bytes.
    BadBloomLength = 13,
}

/// Minimal SSZ `BeaconBlockHeader` (a fixed container of 5 fields). Its
/// `hash_tree_root` is what the sync committee signs (after domain mixing).
#[contracttype]
#[derive(Clone)]
pub struct BeaconHeader {
    pub slot: u64,
    pub proposer_index: u64,
    pub parent_root: BytesN<32>,
    pub state_root: BytesN<32>,
    pub body_root: BytesN<32>,
}

/// SSZ `ExecutionPayloadHeader` (Capella+Deneb field layout, 17 fields, used by
/// Sepolia at Deneb/Electra/Fulu). We merkleize ALL fields so the proven
/// `state_root` and `block_number` are cryptographically bound to the header
/// root checked by `execution_branch`. `base_fee_per_gas` is the uint256 value
/// in 32-byte little-endian SSZ form; `logs_bloom` is the raw 256-byte vector.
#[contracttype]
#[derive(Clone)]
pub struct ExecutionPayloadHeader {
    pub parent_hash: BytesN<32>,
    pub fee_recipient: BytesN<20>,
    pub state_root: BytesN<32>,
    pub receipts_root: BytesN<32>,
    pub logs_bloom: Bytes, // 256 bytes
    pub prev_randao: BytesN<32>,
    pub block_number: u64,
    pub gas_limit: u64,
    pub gas_used: u64,
    pub timestamp: u64,
    pub extra_data: Bytes, // <= 32 bytes
    pub base_fee_per_gas: BytesN<32>,
    pub block_hash: BytesN<32>,
    pub transactions_root: BytesN<32>,
    pub withdrawals_root: BytesN<32>,
    pub blob_gas_used: u64,
    pub excess_blob_gas: u64,
}

/// A `LightClientFinalityUpdate`, flattened for on-chain verification.
///
/// `sync_committee_signature` is the UNCOMPRESSED (192-byte) G2 aggregate
/// signature. Ethereum serves it 96-byte compressed; the (untrusted) relayer
/// decompresses it off-chain. This adds no trust: the final pairing check binds
/// the point to the signed message, so any wrong decompression is rejected.
#[contracttype]
#[derive(Clone)]
pub struct LightClientUpdate {
    pub attested_header: BeaconHeader,
    pub finalized_header: BeaconHeader,
    /// Merkle proof of `finalized_header` vs `attested_header.state_root`.
    /// Length encodes the fork (6 = Capella/Deneb gindex 105, 7 = Electra+ gindex 169).
    pub finality_branch: Vec<BytesN<32>>,
    pub finalized_execution: ExecutionPayloadHeader,
    /// Merkle proof of `finalized_execution` vs `finalized_header.body_root` (gindex 25).
    pub execution_branch: Vec<BytesN<32>>,
    /// 512-bit participation bitfield, 64 bytes, little-endian bit order.
    pub sync_committee_bits: BytesN<64>,
    /// Uncompressed (192-byte) G2 aggregate signature.
    pub sync_committee_signature: BytesN<192>,
    pub signature_slot: u64,
}

#[contractevent(topics = ["head"], data_format = "map")]
pub struct HeadEvent {
    #[topic]
    pub block_number: u64,
    pub state_root: BytesN<32>,
    /// false = trustless (`update_header`); true = admin posted-root fallback.
    pub posted: bool,
}
