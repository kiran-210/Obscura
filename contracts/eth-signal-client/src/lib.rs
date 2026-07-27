#![no_std]
//! # EthSignalClient — Ethereum finality light client on Soroban via Boundless "The Signal"
//!
//! Trustless provenance core of the Obscura bridge, **replacing** the native BLS
//! sync-committee client (`eth-light-client`). Instead of verifying Ethereum
//! consensus on-chain ourselves, we verify a **Boundless "The Signal"** RISC Zero
//! zkVM proof of Casper-FFG finality (the consensus check runs inside the zkVM;
//! Soroban verifies one BN254 Groth16 proof via a deployed RISC Zero verifier).
//! This makes the provenance layer a uniform, chain-agnostic verification path.
//!
//! Forked from Boundless's deployed `signal-on-stellar` `signal-receiver`
//! (testnet `CDSTMIX…`), extended with the two pieces a bridge needs:
//! * a `beacon_root(slot)` getter, and a long-range / monotonicity guard;
//! * [`Self::prove_execution`] — link the Signal-proven finalized **beacon block
//!   root** to the Ethereum **execution** `state_root` via an `execution_branch`
//!   SSZ Merkle proof, and expose it as `state_root_at(block_number)` — the exact
//!   interface `ObscuraBridge.bridge_in` already calls (so the bridge is unchanged).
//!
//! ## Two-step trust flow
//! 1. [`Self::receive`] `(seal, journal)` — verify the Signal proof, require the
//!    journal's `pre_state` to equal our trusted `ConsensusState` (FFG chaining),
//!    adopt `post_state`, and store the finalized beacon root for its slot.
//! 2. [`Self::prove_execution`] — prove the execution payload (hence `state_root`
//!    + `block_number`) against a stored, Signal-proven beacon block root.
//!
//! ## Signal journal (288 bytes, alloy static ABI), parsed by fixed offsets:
//! ```text
//! [  0..128) pre_state   = ConsensusState{ currentJustified(64), finalized(64) }
//! [128..256) post_state  = ConsensusState{ currentJustified(64), finalized(64) }
//! [256..288) finalized_slot (uint64, value in the last 8 bytes)
//! within a 64-byte Checkpoint: epoch(uint64 in bytes 24..32), root(bytes 32..64)
//! ```

extern crate alloc;

mod ssz;
mod types;

#[cfg(test)]
mod test;

use soroban_sdk::{
    contract, contractimpl, panic_with_error, Address, Bytes, BytesN, Env, IntoVal, InvokeError,
    Symbol, Vec,
};

use crate::types::{BeaconHeader, DataKey, ExecutionPayloadHeader, FinalizedEvent, HeadEvent, SignalError};

/// execution_branch subtree index. EXECUTION_PAYLOAD_GINDEX 25 % 16 == 9
/// (execution_payload is field 9 of the 16-wide `BeaconBlockBody` subtree).
const EXECUTION_SUBTREE_INDEX: u64 = 9;

/// Maximum allowed advance of the finalized epoch in a single `receive`. Bounds
/// the Casper-FFG balance-drift safety margin (which grows with the epoch gap)
/// and long-range exposure. Normal finalization advances by 1; a generous cap
/// still rejects anomalous catch-up jumps. Strict `pre_state == current` chaining
/// is the primary protection — this is defence in depth.
const MAX_EPOCH_GAP: u64 = 100;

const TTL_THRESHOLD: u32 = 100_000;
const TTL_EXTEND: u32 = 500_000;

#[contract]
pub struct EthSignalClient;

#[contractimpl]
impl EthSignalClient {
    /// Seed the client with a deployed RISC Zero verifier, the Signal guest
    /// `image_id` (per network/version — e.g. mainnet v1.3.0 `0ccb3d14…`), an
    /// initial trusted `ConsensusState` (128-byte ABI: currentJustified ++
    /// finalized), and an admin for the posted-root fallback.
    pub fn __constructor(
        env: Env,
        risc0_verifier: Address,
        image_id: BytesN<32>,
        initial_state: BytesN<128>,
        admin: Address,
    ) {
        let inst = env.storage().instance();
        inst.set(&DataKey::Verifier, &risc0_verifier);
        inst.set(&DataKey::ImageId, &image_id);
        inst.set(&DataKey::CurrentState, &initial_state);
        inst.set(&DataKey::Admin, &admin);
        inst.extend_ttl(TTL_THRESHOLD, TTL_EXTEND);
    }

    /// **Step 1 — advance finality.** Verify a Boundless Signal proof and, if it
    /// extends our trusted view, adopt its `post_state` and store the finalized
    /// beacon block root for its slot.
    ///
    /// 1. `verify(seal, image_id, sha256(journal))` on the RISC Zero verifier.
    /// 2. Require `journal.pre_state == CurrentState` (single-step FFG chaining).
    /// 3. Long-range guard: `0 <= post.finalized.epoch - pre.finalized.epoch <= MAX_EPOCH_GAP`.
    /// 4. Store `BeaconRoot(finalized_slot) = post.finalized.root`; set `CurrentState = post_state`.
    pub fn receive(env: Env, seal: Bytes, journal: BytesN<288>) -> Result<bool, SignalError> {
        // (1) Verify the Signal proof against the pinned image id.
        let image_id: BytesN<32> = env
            .storage()
            .instance()
            .get(&DataKey::ImageId)
            .ok_or(SignalError::NotInitialized)?;
        let digest = sha256_288(&env, &journal);
        verify_signal(&env, &seal, &image_id, &digest)?;

        // (2) Parse the journal (fixed offsets) and require it to extend our state.
        let j = journal.to_array();
        let pre = arr128(&j, 0);
        let post = arr128(&j, 128);
        let post_fin_root = arr32(&j, 224);
        let finalized_slot = u64_be(&j, 280);
        let pre_fin_epoch = u64_be(&j, 88);
        let post_fin_epoch = u64_be(&j, 216);

        let current: BytesN<128> = env
            .storage()
            .instance()
            .get(&DataKey::CurrentState)
            .ok_or(SignalError::NotInitialized)?;
        if pre != current.to_array() {
            return Err(SignalError::NotSuccessor);
        }

        // (3) Long-range / monotonicity guard.
        let gap = post_fin_epoch
            .checked_sub(pre_fin_epoch)
            .ok_or(SignalError::NotSuccessor)?;
        if gap > MAX_EPOCH_GAP {
            return Err(SignalError::EpochGapTooLarge);
        }

        // (4) Record the finalized beacon root and advance the trusted state.
        let beacon_root = BytesN::from_array(&env, &post_fin_root);
        let pkey = DataKey::BeaconRoot(finalized_slot);
        env.storage().persistent().set(&pkey, &beacon_root);
        env.storage()
            .persistent()
            .extend_ttl(&pkey, TTL_THRESHOLD, TTL_EXTEND);

        let inst = env.storage().instance();
        inst.set(&DataKey::CurrentState, &BytesN::from_array(&env, &post));
        inst.extend_ttl(TTL_THRESHOLD, TTL_EXTEND);

        FinalizedEvent {
            slot: finalized_slot,
            epoch: post_fin_epoch,
            beacon_root,
        }
        .publish(&env);
        Ok(true)
    }

    /// **Step 2 — derive the execution state root.** Prove the Ethereum execution
    /// payload (and thus its `state_root` + `block_number`) against a finalized
    /// **beacon block root** previously proven by [`Self::receive`].
    ///
    /// 1. Look up the Signal-proven beacon root for `finalized_slot`.
    /// 2. Require `hash_tree_root(finalized_header) == that root`.
    /// 3. `execution_branch`: `hash_tree_root(execution) -> finalized_header.body_root`.
    /// 4. Record `Root(execution.block_number) = execution.state_root`.
    pub fn prove_execution(
        env: Env,
        finalized_slot: u64,
        finalized_header: BeaconHeader,
        execution: ExecutionPayloadHeader,
        execution_branch: Vec<BytesN<32>>,
    ) -> Result<(), SignalError> {
        // (1) The Signal-proven finalized beacon block root at this slot.
        let beacon_root: BytesN<32> = env
            .storage()
            .persistent()
            .get(&DataKey::BeaconRoot(finalized_slot))
            .ok_or(SignalError::UnknownSlot)?;

        // (2) The supplied header must hash to that proven root.
        if ssz::beacon_header_root(&env, &finalized_header) != beacon_root {
            return Err(SignalError::HeaderMismatch);
        }

        // (3) execution_branch: ExecutionPayloadHeader vs finalized_header.body_root.
        let exec_root = ssz::execution_payload_root(&env, &execution);
        if !ssz::verify_merkle_branch(
            &env,
            &exec_root,
            &execution_branch,
            EXECUTION_SUBTREE_INDEX,
            &finalized_header.body_root,
        ) {
            return Err(SignalError::BadExecutionProof);
        }

        // (4) Record the proven execution state root for `bridge_in` to read.
        Self::record_root(
            &env,
            execution.block_number,
            &execution.state_root,
            false,
        );
        Ok(())
    }

    /// **Fallback (admin-gated, NOT trustless).** Post a trusted execution
    /// `state_root` without any Signal/SSZ verification — day-1 unblock, demo, and
    /// liveness backstop only. The trustless path is `receive` + `prove_execution`.
    pub fn post_root(env: Env, admin: Address, block_number: u64, state_root: BytesN<32>) {
        admin.require_auth();
        let stored: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .unwrap_or_else(|| panic_with_error!(&env, SignalError::NotInitialized));
        if admin != stored {
            panic_with_error!(&env, SignalError::NotAdmin);
        }
        Self::record_root(&env, block_number, &state_root, true);
    }

    // --- read-only interface (consumed by ObscuraBridge / relayer / frontend) ---

    /// The proven execution state root at a block — the value `bridge_in` reads.
    /// Identical signature to the superseded `eth-light-client`, so the bridge is
    /// unchanged.
    pub fn state_root_at(env: Env, block_number: u64) -> Option<BytesN<32>> {
        env.storage().persistent().get(&DataKey::Root(block_number))
    }

    /// The Signal-proven finalized beacon block root at a slot, if known.
    pub fn beacon_root(env: Env, slot: u64) -> Option<BytesN<32>> {
        env.storage().persistent().get(&DataKey::BeaconRoot(slot))
    }

    /// Current trusted execution head `(block_number, state_root)`; `(0, 0x00..)` if unset.
    pub fn head(env: Env) -> (u64, BytesN<32>) {
        let inst = env.storage().instance();
        let block: u64 = inst.get(&DataKey::HeadBlock).unwrap_or(0);
        let root: BytesN<32> = inst
            .get(&DataKey::HeadRoot)
            .unwrap_or_else(|| BytesN::from_array(&env, &[0u8; 32]));
        (block, root)
    }

    /// The current trusted `ConsensusState` (128-byte ABI) — the `pre_state` the
    /// next `receive` must carry. Lets the relayer pick the right successor proof.
    pub fn current_state(env: Env) -> BytesN<128> {
        env.storage()
            .instance()
            .get(&DataKey::CurrentState)
            .unwrap_or_else(|| panic_with_error!(&env, SignalError::NotInitialized))
    }

    /// The configured admin (fallback path only).
    pub fn admin(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .unwrap_or_else(|| panic_with_error!(&env, SignalError::NotInitialized))
    }
}

impl EthSignalClient {
    fn record_root(env: &Env, block_number: u64, state_root: &BytesN<32>, posted: bool) {
        let rkey = DataKey::Root(block_number);
        env.storage().persistent().set(&rkey, state_root);
        env.storage()
            .persistent()
            .extend_ttl(&rkey, TTL_THRESHOLD, TTL_EXTEND);

        let inst = env.storage().instance();
        let head_block: u64 = inst.get(&DataKey::HeadBlock).unwrap_or(0);
        if block_number >= head_block {
            inst.set(&DataKey::HeadBlock, &block_number);
            inst.set(&DataKey::HeadRoot, state_root);
        }
        inst.extend_ttl(TTL_THRESHOLD, TTL_EXTEND);

        HeadEvent {
            block_number,
            state_root: state_root.clone(),
            posted,
        }
        .publish(env);
    }
}

// ---------------------------------------------------------------------------
// Cross-contract call to the RISC Zero verifier (manual invoke, like
// ObscuraBridge — avoids depending on the sdk-25 `groth16-verifier` crate).
// ---------------------------------------------------------------------------

/// `verifier.verify(seal, image_id, journal_digest)` — panics/returns-Err on an
/// invalid proof. Mirrors `RiscZeroGroth16VerifierClient::verify` positionally.
fn verify_signal(
    env: &Env,
    seal: &Bytes,
    image_id: &BytesN<32>,
    journal_digest: &BytesN<32>,
) -> Result<(), SignalError> {
    let verifier: Address = env
        .storage()
        .instance()
        .get(&DataKey::Verifier)
        .ok_or(SignalError::NotInitialized)?;
    let mut args = Vec::new(env);
    args.push_back(seal.into_val(env));
    args.push_back(image_id.into_val(env));
    args.push_back(journal_digest.into_val(env));
    env.try_invoke_contract::<(), InvokeError>(&verifier, &Symbol::new(env, "verify"), args)
        .map_err(|_| SignalError::VerifierCallFailed)?
        .map_err(|_| SignalError::ProofInvalid)
}

// ---------------------------------------------------------------------------
// Fixed-offset journal parsing (alloy static ABI; see module docs).
// ---------------------------------------------------------------------------

fn u64_be(j: &[u8; 288], off: usize) -> u64 {
    let mut b = [0u8; 8];
    b.copy_from_slice(&j[off..off + 8]);
    u64::from_be_bytes(b)
}

fn arr32(j: &[u8; 288], off: usize) -> [u8; 32] {
    let mut b = [0u8; 32];
    b.copy_from_slice(&j[off..off + 32]);
    b
}

fn arr128(j: &[u8; 288], off: usize) -> [u8; 128] {
    let mut b = [0u8; 128];
    b.copy_from_slice(&j[off..off + 128]);
    b
}

/// SHA-256 of the 288-byte journal (the digest the verifier's DigestMatch checks).
fn sha256_288(env: &Env, journal: &BytesN<288>) -> BytesN<32> {
    let mut b = Bytes::new(env);
    b.extend_from_array(&journal.to_array());
    env.crypto().sha256(&b).to_bytes()
}
