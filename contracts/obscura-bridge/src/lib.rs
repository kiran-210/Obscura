#![no_std]
//! # ObscuraBridge — trustless ZK-private cross-chain bridge hub (BRIDGE_SPEC §7).
//!
//! The integration contract that composes the three Obscura bridge components into
//! one trust-minimised flow:
//!
//! * [`EthLightClient`](../eth_light_client) — a **separate deployed** contract.
//!   Cross-called for `state_root_at(block_number)` to obtain a trusted Ethereum
//!   execution `state_root` (provenance = the Ethereum sync committee, not us).
//! * [`bridge_mpt`] — a pure in-process **library** (rlib path dependency). Its
//!   `verify_storage` walks the EIP-1186 account+storage proof against that
//!   `state_root` using `keccak256`, returning the proven 32-byte `locks` word.
//!   No cross-contract call.
//! * [`ObscuraPool`](../obscura_pool) — a **separate deployed** contract. Cross-called
//!   for `bridge_mint(commitment)` (inbound) and `is_known_root` (outbound).
//!
//! ## `bridge_in` (inbound, fully implemented & trustless)
//! Prove an L1 `locks[commitment] == (token, amount)` under the light-client's
//! trusted state root, then mint the shielded note into the pool — without moving
//! any Stellar asset (the backing lives in the L1 escrow).
//!
//! ## `bridge_out` (outbound — see the method docs for what is verified vs pending)
//! Burn a bridged note by verifying the existing withdraw-circuit proof, binding
//! the L1 recipient to the proof's `recipient_hash`, guarding the nullifier, and
//! emitting an unlock authorization the relayer settles on Ethereum.

extern crate alloc;

mod types;

#[cfg(test)]
mod test;

use soroban_sdk::{
    contract, contractimpl, crypto::BnScalar, Address, Bytes, BytesN, Env, IntoVal, InvokeError,
    Symbol, Vec, U256,
};
use soroban_poseidon::{poseidon2_hash, Field};

use crate::types::{BridgeError, BridgeInEvent, BridgeOutEvent, DataKey};

/// Number of public-input field elements in the reused **withdraw** circuit
/// (SHARED.md §7): [0] merkle_root [1] nullifier [2] recipient_hash [3] amount
/// [4] asset_id.
const WITHDRAW_PUBLIC_INPUTS: u32 = 5;

#[contract]
pub struct ObscuraBridge;

#[contractimpl]
impl ObscuraBridge {
    /// Wire the bridge to its three collaborators. `light_client` and `pool` are
    /// the addresses of the already-deployed contracts; `l1_bridge_addr` is the
    /// `ObscuraBridgeL1` escrow on Ethereum whose `locks` mapping `bridge_in`
    /// proves; `withdraw_vf` is the existing UltraHonk withdraw verifier reused by
    /// `bridge_out`.
    pub fn __constructor(
        env: Env,
        light_client: Address,
        pool: Address,
        l1_chain_id: u32,
        l1_bridge_addr: BytesN<20>,
        withdraw_vf: Address,
    ) {
        let s = env.storage().instance();
        s.set(&DataKey::LightClient, &light_client);
        s.set(&DataKey::Pool, &pool);
        s.set(&DataKey::L1ChainId, &l1_chain_id);
        s.set(&DataKey::L1BridgeAddr, &l1_bridge_addr);
        s.set(&DataKey::WithdrawVf, &withdraw_vf);
    }

    /// **Trustless inbound mint** (BRIDGE_SPEC §7). Prove an Ethereum L1 lock and
    /// mint the matching shielded note into the pool.
    ///
    /// Flow:
    /// 1. Cross-call the light client for the trusted execution `state_root` at
    ///    `block_number` (error [`BridgeError::UnknownBlock`] if it has none).
    /// 2. Derive the L1 storage slot of `locks[commitment]` at declaration slot 0:
    ///    `slot = keccak256(commitment ‖ bytes32(0))` (BRIDGE_SPEC §4).
    /// 3. Verify the EIP-1186 account + storage proof **in-process** via
    ///    [`bridge_mpt::verify_storage`], obtaining the proven 32-byte word.
    /// 4. Decode `(token, amount)` from the word per the corrected §4 packing
    ///    (`token` = low 20 bytes, `amount` = high 12 bytes `>> 160`) and assert
    ///    both equal the caller's `token` / `amount`.
    /// 5. Replay guard: reject if `commitment` was already bridged; else mark it.
    /// 6. Cross-call `pool.bridge_mint(commitment)` to insert the note.
    /// 7. Emit [`BridgeInEvent`].
    pub fn bridge_in(
        env: Env,
        block_number: u64,
        commitment: BytesN<32>,
        token: BytesN<20>,
        amount: i128,
        account_proof: Vec<Bytes>,
        storage_proof: Vec<Bytes>,
    ) -> Result<(), BridgeError> {
        // (1) Trusted Ethereum execution state root at `block_number`.
        let state_root = lc_state_root_at(&env, block_number).ok_or(BridgeError::UnknownBlock)?;

        // (2) Storage slot of `locks[commitment]` (mapping at declaration slot 0).
        let slot = locks_slot(&env, &commitment);

        // (3) In-process MPT verification against the trusted root.
        let l1_bridge_addr: BytesN<20> = env
            .storage()
            .instance()
            .get(&DataKey::L1BridgeAddr)
            .unwrap();
        let value = bridge_mpt::verify_storage(
            &env,
            &state_root,
            &l1_bridge_addr.to_array(),
            &slot,
            &account_proof,
            &storage_proof,
        )
        .map_err(|_| BridgeError::ProofInvalid)?;

        // (4) Decode the packed LockRecord and bind it to the claimed args.
        let (decoded_token, decoded_amount) = decode_lock_value(&env, &value);
        if decoded_token != token {
            return Err(BridgeError::TokenMismatch);
        }
        if decoded_amount != amount {
            return Err(BridgeError::AmountMismatch);
        }

        // (5) Replay guard — one L1 lock mints exactly once.
        let bridged_key = DataKey::Bridged(commitment.clone());
        if env.storage().persistent().has(&bridged_key) {
            return Err(BridgeError::AlreadyBridged);
        }
        env.storage().persistent().set(&bridged_key, &true);

        // (6) Mint the shielded note in the pool (no SAC transfer; backing is on L1).
        pool_bridge_mint(&env, &commitment)?;

        // (7) Surface the inbound mint.
        BridgeInEvent {
            commitment,
            token,
            amount,
            block_number,
        }
        .publish(&env);
        Ok(())
    }

    /// **Outbound burn** (BRIDGE_SPEC §7). Spend a bridged note by reusing the
    /// existing withdraw circuit and emit an L1-unlock authorization.
    ///
    /// What this **verifies on-chain**:
    /// * The withdraw-circuit ZK proof (`withdraw_vf.verify_proof`) — proves note
    ///   ownership, the nullifier derivation, and the `recipient_hash` binding
    ///   inside the circuit.
    /// * The proof's `merkle_root` is a root the pool currently knows
    ///   (cross-call `pool.is_known_root`).
    /// * `l1_recipient` derives the proof's public `recipient_hash`
    ///   (`hash2(field(l1_recipient), 0)`, the same Poseidon binding the pool's
    ///   `withdraw` uses for a Stellar recipient) — so the proof authorizes that
    ///   exact Ethereum address.
    /// * Replay: the `nullifier` has not already been bridged out.
    ///
    /// **Pending / documented gaps (BRIDGE_SPEC §7, hackathon scope):**
    /// * The nullifier is marked spent in the *bridge's* set, not the *pool's*.
    ///   Preventing a note from being both `pool.withdraw`n and `bridge_out`-spent
    ///   requires a shared nullifier set — i.e. a new pool `bridge_burn` entrypoint
    ///   (pool change + redeploy). Until then double-spend across the two exit
    ///   paths is not prevented by this contract.
    /// * "Only a bridged-asset note may exit to L1" (asset-id binding, §3) is not
    ///   enforced here, since `bridge_out` takes no token argument to recompute the
    ///   bridged `asset_id`.
    pub fn bridge_out(
        env: Env,
        proof: Bytes,
        public_inputs: Bytes,
        l1_recipient: BytesN<20>,
    ) -> Result<(), BridgeError> {
        let fields = parse_fields(&env, &public_inputs, WITHDRAW_PUBLIC_INPUTS)?;
        let merkle_root = fields.get(0).unwrap();
        let nullifier = fields.get(1).unwrap();
        let recipient_hash = fields.get(2).unwrap();
        let amount = field_to_amount(&fields.get(3).unwrap());

        // The spent note must belong to a tree state the pool knows.
        if !pool_is_known_root(&env, &merkle_root) {
            return Err(BridgeError::UnknownRoot);
        }

        // Replay guard (bridge-local; see method docs re: pool nullifier sharing).
        let nullifier_key = DataKey::Nullifier(nullifier.clone());
        if env.storage().persistent().has(&nullifier_key) {
            return Err(BridgeError::NullifierUsed);
        }

        // Bind the L1 recipient to the value the circuit committed to.
        if recipient_hash_of_l1(&env, &l1_recipient) != recipient_hash {
            return Err(BridgeError::RecipientMismatch);
        }

        // Verify the withdraw-circuit proof (the cryptographic core).
        verify_withdraw(&env, &public_inputs, &proof)?;

        env.storage().persistent().set(&nullifier_key, &true);
        BridgeOutEvent {
            nullifier,
            l1_recipient,
            amount,
        }
        .publish(&env);
        Ok(())
    }

    // --- read-only accessors (relayer / frontend / tests) ----------------

    pub fn light_client(env: Env) -> Address {
        env.storage().instance().get(&DataKey::LightClient).unwrap()
    }

    pub fn pool(env: Env) -> Address {
        env.storage().instance().get(&DataKey::Pool).unwrap()
    }

    pub fn l1_bridge_addr(env: Env) -> BytesN<20> {
        env.storage()
            .instance()
            .get(&DataKey::L1BridgeAddr)
            .unwrap()
    }

    pub fn l1_chain_id(env: Env) -> u32 {
        env.storage().instance().get(&DataKey::L1ChainId).unwrap()
    }

    pub fn withdraw_vf(env: Env) -> Address {
        env.storage().instance().get(&DataKey::WithdrawVf).unwrap()
    }

    /// Has this inbound `commitment` already been bridged in?
    pub fn is_bridged(env: Env, commitment: BytesN<32>) -> bool {
        env.storage()
            .persistent()
            .has(&DataKey::Bridged(commitment))
    }

    /// Has this outbound note `nullifier` already been bridged out?
    pub fn is_spent(env: Env, nullifier: BytesN<32>) -> bool {
        env.storage()
            .persistent()
            .has(&DataKey::Nullifier(nullifier))
    }
}

// ---------------------------------------------------------------------------
// Slot derivation, value decoding, recipient binding (shared with tests).
// ---------------------------------------------------------------------------

/// Storage slot of `locks[commitment]` for a `mapping(bytes32 => …)` at
/// declaration slot 0: `keccak256(commitment ‖ bytes32(0))` (BRIDGE_SPEC §4).
pub(crate) fn locks_slot(env: &Env, commitment: &BytesN<32>) -> BytesN<32> {
    let mut preimage = Bytes::new(env);
    preimage.extend_from_array(&commitment.to_array());
    preimage.extend_from_array(&[0u8; 32]);
    env.crypto().keccak256(&preimage).to_bytes()
}

/// Decode the packed `LockRecord { address token; uint96 amount; }` from the
/// proven 32-byte word (already left-padded to 32 bytes by `verify_storage`),
/// per the **corrected** BRIDGE_SPEC §4 packing:
///
/// ```text
/// W = (uint256(amount) << 160) | uint256(uint160(token))
///   token  = address(uint160(W))  // LOW 20 bytes  (bits 0..159)
///   amount = uint96(W >> 160)     // HIGH 12 bytes (bits 160..255)
/// ```
pub(crate) fn decode_lock_value(env: &Env, value: &BytesN<32>) -> (BytesN<20>, i128) {
    let w = value.to_array();
    // token = low 20 bytes.
    let mut token = [0u8; 20];
    token.copy_from_slice(&w[12..32]);
    // amount = high 12 bytes, right-aligned into an i128 (uint96 < 2^96 < i128::MAX).
    let mut amount_be = [0u8; 16];
    amount_be[4..16].copy_from_slice(&w[0..12]);
    (
        BytesN::from_array(env, &token),
        i128::from_be_bytes(amount_be),
    )
}

/// Recover the `amount` field (last 16 bytes, big-endian) from a 32-byte field
/// element, matching the pool's `amount_to_field` canonical encoding.
pub(crate) fn field_to_amount(field: &BytesN<32>) -> i128 {
    let f = field.to_array();
    let mut be = [0u8; 16];
    be.copy_from_slice(&f[16..32]);
    i128::from_be_bytes(be)
}

/// `recipient_hash = hash2(field(l1_recipient), 0)` — the same Poseidon binding
/// the pool's `withdraw` uses (`recipient_hash_of`), but over a 20-byte Ethereum
/// address left-padded to a 32-byte big-endian field (160 bits < the BN254 scalar
/// modulus, so the reduction is the identity).
pub(crate) fn recipient_hash_of_l1(env: &Env, l1_recipient: &BytesN<20>) -> BytesN<32> {
    let mut padded = [0u8; 32];
    padded[12..32].copy_from_slice(&l1_recipient.to_array());
    let field = BytesN::from_array(env, &padded);
    poseidon2_hash2(env, &field, &zero_field(env))
}

fn zero_field(env: &Env) -> BytesN<32> {
    BytesN::from_array(env, &[0u8; 32])
}

/// Poseidon2 2-to-1 hash over BN254, byte-identical to the pool's
/// `merkle::poseidon2_hash2` (state width t = 4; inputs reduced mod the BN254
/// scalar modulus; output = `state[0]` big-endian).
fn poseidon2_hash2(env: &Env, a: &BytesN<32>, b: &BytesN<32>) -> BytesN<32> {
    let modulus = <BnScalar as Field>::modulus(env);
    let a_bytes = Bytes::from_array(env, &a.to_array());
    let b_bytes = Bytes::from_array(env, &b.to_array());
    let mut inputs = Vec::new(env);
    inputs.push_back(U256::from_be_bytes(env, &a_bytes).rem_euclid(&modulus));
    inputs.push_back(U256::from_be_bytes(env, &b_bytes).rem_euclid(&modulus));
    let out = poseidon2_hash::<4, BnScalar>(env, &inputs);
    let mut out_arr = [0u8; 32];
    out.to_be_bytes().copy_into_slice(&mut out_arr);
    BytesN::from_array(env, &out_arr)
}

/// Parse `public_inputs` as exactly `n` consecutive 32-byte field elements
/// (mirrors the pool's `parse_fields`).
fn parse_fields(env: &Env, public_inputs: &Bytes, n: u32) -> Result<Vec<BytesN<32>>, BridgeError> {
    if public_inputs.len() != n * 32 {
        return Err(BridgeError::InvalidPublicInputs);
    }
    let mut out = Vec::new(env);
    let mut i = 0u32;
    while i < n {
        let mut field = [0u8; 32];
        public_inputs
            .slice(i * 32..i * 32 + 32)
            .copy_into_slice(&mut field);
        out.push_back(BytesN::from_array(env, &field));
        i += 1;
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// Cross-contract calls.
// ---------------------------------------------------------------------------

/// `light_client.state_root_at(block_number) -> Option<BytesN<32>>`.
fn lc_state_root_at(env: &Env, block_number: u64) -> Option<BytesN<32>> {
    let light_client: Address = env.storage().instance().get(&DataKey::LightClient).unwrap();
    let mut args = Vec::new(env);
    args.push_back(block_number.into_val(env));
    env.invoke_contract(&light_client, &Symbol::new(env, "state_root_at"), args)
}

/// `pool.bridge_mint(commitment) -> u32` (mints the shielded note).
fn pool_bridge_mint(env: &Env, commitment: &BytesN<32>) -> Result<u32, BridgeError> {
    let pool: Address = env.storage().instance().get(&DataKey::Pool).unwrap();
    let mut args = Vec::new(env);
    args.push_back(commitment.into_val(env));
    env.try_invoke_contract::<u32, InvokeError>(&pool, &Symbol::new(env, "bridge_mint"), args)
        .map_err(|_| BridgeError::MintFailed)?
        .map_err(|_| BridgeError::MintFailed)
}

/// `pool.is_known_root(root) -> bool`.
fn pool_is_known_root(env: &Env, root: &BytesN<32>) -> bool {
    let pool: Address = env.storage().instance().get(&DataKey::Pool).unwrap();
    let mut args = Vec::new(env);
    args.push_back(root.into_val(env));
    env.invoke_contract(&pool, &Symbol::new(env, "is_known_root"), args)
}

/// `withdraw_vf.verify_proof(public_inputs, proof)` (public inputs first, then
/// the proof — exactly per SHARED.md §6, mirroring the pool's `verify`).
fn verify_withdraw(env: &Env, public_inputs: &Bytes, proof: &Bytes) -> Result<(), BridgeError> {
    let verifier: Address = env.storage().instance().get(&DataKey::WithdrawVf).unwrap();
    let mut args = Vec::new(env);
    args.push_back(public_inputs.into_val(env));
    args.push_back(proof.into_val(env));
    env.try_invoke_contract::<(), InvokeError>(&verifier, &Symbol::new(env, "verify_proof"), args)
        .map_err(|_| BridgeError::ProofVerifyFailed)?
        .map_err(|_| BridgeError::ProofVerifyFailed)
}
