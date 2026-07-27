use soroban_sdk::{contracterror, contractevent, contracttype, Bytes, BytesN};

/// Storage keys. Config + head + trusted consensus state live in instance storage
/// (loaded on most calls); per-slot beacon roots and per-block execution roots are
/// persistent.
#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    /// `Address`: the deployed RISC Zero (Groth16/SetVerifier) verifier contract
    /// cross-called to check each Signal proof.
    Verifier,
    /// `BytesN<32>`: the Signal-Ethereum guest image id (per network/version). Pins
    /// what "proof verifies" means; a constructor param, not hardcoded.
    ImageId,
    /// `BytesN<128>`: the trusted Casper-FFG `ConsensusState` (currentJustified ++
    /// finalized checkpoints, ABI layout). Each `receive` must start from this.
    CurrentState,
    /// `BytesN<32>`: the Signal-proven finalized **beacon block root** at a slot.
    BeaconRoot(u64),
    /// `BytesN<32>`: the proven **execution** state root at a block number — the
    /// value `ObscuraBridge.bridge_in` reads via `state_root_at`. Same key shape as
    /// the superseded `eth-light-client`, so the bridge is unchanged.
    Root(u64),
    /// `u64`: execution block number of the current trusted head.
    HeadBlock,
    /// `BytesN<32>`: execution state root of the current trusted head.
    HeadRoot,
    /// `Address`: admin for the (non-trustless) posted-root fallback only.
    Admin,
}

#[contracterror]
#[repr(u32)]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum SignalError {
    /// Contract storage was not initialized (missing verifier / image id / state).
    NotInitialized = 1,
    /// The cross-contract call to the RISC Zero verifier itself failed.
    VerifierCallFailed = 2,
    /// The verifier rejected the proof (invalid seal for this image id + journal).
    ProofInvalid = 3,
    /// `journal.pre_state` does not match the contract's current trusted state —
    /// this proof does not extend our view (submit epochs in order).
    NotSuccessor = 4,
    /// The finalized-epoch advance exceeds `MAX_EPOCH_GAP` (long-range guard).
    EpochGapTooLarge = 5,
    /// `prove_execution` referenced a slot with no Signal-proven beacon root yet.
    UnknownSlot = 6,
    /// The supplied beacon header does not hash to the Signal-proven root.
    HeaderMismatch = 7,
    /// The `execution_branch` Merkle proof did not reconstruct the body root.
    BadExecutionProof = 8,
    /// Caller is not the configured admin.
    NotAdmin = 9,
}

/// Minimal SSZ `BeaconBlockHeader` (a fixed container of 5 fields). Its
/// `hash_tree_root` is the value a Signal finalized `Checkpoint.root` commits to.
#[contracttype]
#[derive(Clone)]
pub struct BeaconHeader {
    pub slot: u64,
    pub proposer_index: u64,
    pub parent_root: BytesN<32>,
    pub state_root: BytesN<32>,
    pub body_root: BytesN<32>,
}

/// SSZ `ExecutionPayloadHeader` (Deneb/Electra/Fulu field layout, 17 fields). We
/// merkleize ALL fields so the proven `state_root` and `block_number` are
/// cryptographically bound to the header root checked by `execution_branch`.
/// `base_fee_per_gas` is the uint256 value in 32-byte little-endian SSZ form;
/// `logs_bloom` is the raw 256-byte vector.
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

/// Emitted when `receive` advances the trusted finalized checkpoint.
#[contractevent(topics = ["finalized"], data_format = "map")]
pub struct FinalizedEvent {
    #[topic]
    pub slot: u64,
    pub epoch: u64,
    pub beacon_root: BytesN<32>,
}

/// Emitted when a proven execution `state_root` is recorded for a block.
#[contractevent(topics = ["head"], data_format = "map")]
pub struct HeadEvent {
    #[topic]
    pub block_number: u64,
    pub state_root: BytesN<32>,
    /// false = trustless (`prove_execution`); true = admin `post_root` fallback.
    pub posted: bool,
}
