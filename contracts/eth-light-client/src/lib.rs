#![no_std]
//! # EthLightClient — Ethereum sync-committee light client on Soroban
//!
//! Verifies the Ethereum Altair/Capella(+Electra/Fulu) light-client protocol
//! natively on Stellar using the CAP-0059 BLS12-381 host functions and SHA-256.
//! This is the trustless provenance core of the Wraith bridge (BRIDGE_SPEC §5).
//!
//! ## Trust model (see README for full detail)
//! - **Trustless path** = [`EthLightClient::update_header`]. A header is accepted
//!   only if > 2/3 of the seeded 512-member sync committee signed it (verified by
//!   a BLS pairing check), and the finalized execution state root is proven by SSZ
//!   Merkle branches. The relayer is untrusted transport.
//! - **Fallback path** = [`EthLightClient::post_root`]. Admin-gated, **NOT
//!   trustless**, clearly isolated, for day-1 unblock / demo only.
//!
//! ## Deliberate, documented simplifications (hackathon scope)
//! - **Single committee period.** The 512 pubkeys are seeded at construction; no
//!   `next_sync_committee` rotation (~27h validity window).
//! - **PoP-trust for pubkeys.** Per-pubkey subgroup checks are skipped — Ethereum
//!   validators register with proof-of-possession, which already defeats the
//!   rogue-key attack. Only the final aggregate (G1) and the signature (G2) are
//!   subgroup-checked.
//! - **Uncompressed point I/O.** The Soroban host has no point-decompression host
//!   function, so committee pubkeys are seeded, and the signature is supplied, in
//!   UNCOMPRESSED form (the untrusted relayer decompresses Ethereum's 48/96-byte
//!   compressed wire format off-chain). This adds no trust: the pairing check
//!   binds the signature to the message, and the committee is the trust root.

extern crate alloc;

mod ssz;
mod types;
mod verify;

#[cfg(test)]
mod test;
#[cfg(test)]
mod test_vectors;

use soroban_sdk::{
    contract, contractimpl, crypto::bls12_381::Bls12381G1Affine,
    crypto::bls12_381::Bls12381G2Affine, panic_with_error, Address, Bytes, BytesN, Env, Vec,
};

use crate::types::{DataKey, HeadEvent, LcError, LightClientUpdate};

/// Slots per sync-committee period = SLOTS_PER_EPOCH(32) * EPOCHS_PER_PERIOD(256).
const SLOTS_PER_PERIOD: u64 = 32 * 256;
/// finality_branch subtree index. gindex 105 (Capella/Deneb) % 64 == 169 (Electra+) % 128 == 41.
const FINALIZED_SUBTREE_INDEX: u64 = 41;
/// execution_branch subtree index. EXECUTION_PAYLOAD_GINDEX 25 % 16 == 9.
const EXECUTION_SUBTREE_INDEX: u64 = 9;

const TTL_THRESHOLD: u32 = 100_000;
const TTL_EXTEND: u32 = 500_000;

#[contract]
pub struct EthLightClient;

#[contractimpl]
impl EthLightClient {
    /// Seed the light client with one sync-committee period.
    ///
    /// `committee` is the 512 sync-committee G1 pubkeys in **uncompressed**
    /// (96-byte) form — `be(x) || be(y)`, the off-chain decompression of
    /// Ethereum's 48-byte compressed pubkeys (the host has no decompression host
    /// fn; see module docs). The all-512 aggregate is computed here in-contract
    /// (it is therefore verified, not a trusted input).
    pub fn __constructor(
        env: Env,
        committee: Vec<BytesN<96>>,
        genesis_root: BytesN<32>,
        fork_version: BytesN<4>,
        admin: Address,
    ) {
        if committee.len() != verify::COMMITTEE_SIZE {
            panic_with_error!(&env, LcError::BadCommitteeSize);
        }
        let bls = env.crypto().bls12_381();

        // Pack pubkeys into one Bytes blob and fold the aggregate.
        let mut packed = Bytes::new(&env);
        let mut agg: Option<Bls12381G1Affine> = None;
        for pk in committee.iter() {
            packed.extend_from_array(&pk.to_array());
            let p = Bls12381G1Affine::from_bytes(pk);
            agg = Some(match agg {
                None => p,
                Some(a) => bls.g1_add(&a, &p),
            });
        }
        let committee_agg: BytesN<96> = agg.unwrap().to_bytes();

        let inst = env.storage().instance();
        inst.set(&DataKey::CommitteeAgg, &committee_agg);
        inst.set(&DataKey::GenesisRoot, &genesis_root);
        inst.set(&DataKey::ForkVersion, &fork_version);
        inst.set(&DataKey::Admin, &admin);
        inst.extend_ttl(TTL_THRESHOLD, TTL_EXTEND);

        env.storage().persistent().set(&DataKey::Committee, &packed);
        env.storage()
            .persistent()
            .extend_ttl(&DataKey::Committee, TTL_THRESHOLD, TTL_EXTEND);
    }

    /// **Trustless path.** Verify an Ethereum `LightClientFinalityUpdate` and, on
    /// success, record the proven finalized execution `state_root` at its
    /// `block_number`. See [`Self`] module docs for the full verification list.
    pub fn update_header(env: Env, update: LightClientUpdate) -> Result<(), LcError> {
        // (1) Slot ordering: signature_slot > attested_slot >= finalized_slot.
        // NOTE: the Altair `current_slot >= signature_slot` (no-future) check needs
        // an Ethereum wall-clock oracle, which a single-period seeded client on
        // Soroban does not have; the ~27h committee window bounds validity instead.
        let sig_slot = update.signature_slot;
        let att_slot = update.attested_header.slot;
        let fin_slot = update.finalized_header.slot;
        if !(sig_slot > att_slot && att_slot >= fin_slot) {
            return Err(LcError::BadSlotOrder);
        }

        // signature period must match the seeded committee period (pinned on
        // first use; ultimately also enforced by the BLS check below).
        let period = sig_slot / SLOTS_PER_PERIOD;
        let inst = env.storage().instance();
        match inst.get::<DataKey, u64>(&DataKey::CommitteePeriod) {
            Some(p) if p != period => return Err(LcError::WrongPeriod),
            None => inst.set(&DataKey::CommitteePeriod, &period),
            _ => {}
        }

        // (2) Participation: strictly > 2/3 (BRIDGE_SPEC §12; not MIN=1).
        let bits = update.sync_committee_bits.to_array();
        let participation = verify::count_participation(&bits);
        if participation * 3 < verify::COMMITTEE_SIZE * 2 {
            return Err(LcError::InsufficientParticipation);
        }

        // (3) Aggregate participating pubkeys (committee_agg minus non-signers).
        let committee: Bytes = env
            .storage()
            .persistent()
            .get(&DataKey::Committee)
            .ok_or(LcError::Malformed)?;
        let committee_agg: BytesN<96> =
            inst.get(&DataKey::CommitteeAgg).ok_or(LcError::Malformed)?;
        let agg_pk = verify::aggregate_signers(&env, &committee, &committee_agg, &bits);
        if !verify::g1_in_subgroup(&env, &agg_pk) {
            return Err(LcError::BadAggregate);
        }

        // Signature point (untrusted): must be a valid G2 subgroup element.
        let signature = Bls12381G2Affine::from_bytes(update.sync_committee_signature.clone());
        if !verify::g2_in_subgroup(&env, &signature) {
            return Err(LcError::BadSignaturePoint);
        }

        // (4) signing_root = compute_signing_root(attested_header, domain).
        let genesis_root: BytesN<32> = inst.get(&DataKey::GenesisRoot).ok_or(LcError::Malformed)?;
        let fork_version: BytesN<4> = inst.get(&DataKey::ForkVersion).ok_or(LcError::Malformed)?;
        let domain = ssz::compute_domain(&env, &fork_version, &genesis_root);
        let signing_root = ssz::signing_root(&env, &update.attested_header, &domain);

        // (5) 2-pairing FastAggregateVerify.
        if !verify::fast_aggregate_verify(&env, &agg_pk, &signing_root, &signature) {
            return Err(LcError::BadSignature);
        }

        // (6) finality_branch: finalized_header vs attested_header.state_root.
        let finalized_root = ssz::beacon_header_root(&env, &update.finalized_header);
        if !ssz::verify_merkle_branch(
            &env,
            &finalized_root,
            &update.finality_branch,
            FINALIZED_SUBTREE_INDEX,
            &update.attested_header.state_root,
        ) {
            return Err(LcError::BadFinalityProof);
        }

        // (7) execution_branch: ExecutionPayloadHeader vs finalized_header.body_root.
        let exec_root = ssz::execution_payload_root(&env, &update.finalized_execution);
        if !ssz::verify_merkle_branch(
            &env,
            &exec_root,
            &update.execution_branch,
            EXECUTION_SUBTREE_INDEX,
            &update.finalized_header.body_root,
        ) {
            return Err(LcError::BadExecutionProof);
        }

        // Trusted output: store the proven execution state root.
        let block_number = update.finalized_execution.block_number;
        let state_root = update.finalized_execution.state_root.clone();
        Self::record_root(&env, block_number, &state_root, false);
        Ok(())
    }

    /// **Fallback (admin-gated, NOT trustless).** A day-1 unblock / demo path that
    /// posts a trusted execution `state_root` without any consensus verification.
    /// The trustless path is [`Self::update_header`].
    pub fn post_root(env: Env, admin: Address, block_number: u64, state_root: BytesN<32>) {
        admin.require_auth();
        let stored: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .unwrap_optimized_or_panic(&env);
        if admin != stored {
            panic_with_error!(&env, LcError::NotAdmin);
        }
        Self::record_root(&env, block_number, &state_root, true);
    }

    /// The proven execution state root at a given block, if known.
    pub fn state_root_at(env: Env, block_number: u64) -> Option<BytesN<32>> {
        env.storage().persistent().get(&DataKey::Root(block_number))
    }

    /// Current trusted head `(block_number, state_root)`. `(0, 0x00..)` if unset.
    pub fn head(env: Env) -> (u64, BytesN<32>) {
        let inst = env.storage().instance();
        let block: u64 = inst.get(&DataKey::HeadBlock).unwrap_or(0);
        let root: BytesN<32> = inst
            .get(&DataKey::HeadRoot)
            .unwrap_or_else(|| BytesN::from_array(&env, &[0u8; 32]));
        (block, root)
    }

    /// The configured admin (fallback path only).
    pub fn admin(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .unwrap_optimized_or_panic(&env)
    }
}

impl EthLightClient {
    fn record_root(env: &Env, block_number: u64, state_root: &BytesN<32>, posted: bool) {
        env.storage()
            .persistent()
            .set(&DataKey::Root(block_number), state_root);
        env.storage().persistent().extend_ttl(
            &DataKey::Root(block_number),
            TTL_THRESHOLD,
            TTL_EXTEND,
        );

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

// Small helper trait so we can `.unwrap_optimized_or_panic` on Option in no_std.
trait UnwrapOrPanic<T> {
    fn unwrap_optimized_or_panic(self, env: &Env) -> T;
}
impl<T> UnwrapOrPanic<T> for Option<T> {
    fn unwrap_optimized_or_panic(self, env: &Env) -> T {
        match self {
            Some(v) => v,
            None => panic_with_error!(env, LcError::Malformed),
        }
    }
}
