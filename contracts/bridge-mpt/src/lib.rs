#![no_std]
//! Obscura bridge — in-contract Ethereum MPT storage-proof verifier (BRIDGE_SPEC §6).
//!
//! Pure Rust, `no_std`, Soroban-compatible. Verifies an EIP-1186 `eth_getProof`
//! (account proof + storage proof) against a trusted Ethereum execution
//! `state_root` using only `env.crypto().keccak256()` — no ZK. Returns the proven
//! 32-byte storage word.
//!
//! Trie walk and RLP live in [`mpt`] and [`rlp`]; this module ties them together:
//! account proof -> `storageRoot` (3rd account field) -> storage proof -> value.

extern crate alloc;
use alloc::vec::Vec;

use soroban_sdk::{contract, contractimpl, Bytes, BytesN, Env, Vec as SorobanVec};

pub mod mpt;
pub mod rlp;

#[cfg(test)]
mod test;
#[cfg(test)]
mod vectors;

pub use mpt::{mpt_verify, MptError};

/// `keccak256` of a byte slice, returned as a `[u8; 32]`.
fn keccak(env: &Env, data: &[u8]) -> [u8; 32] {
    let bytes = Bytes::from_slice(env, data);
    env.crypto().keccak256(&bytes).to_array()
}

/// Copy a Soroban `Bytes` into an owned `Vec<u8>`.
fn to_vec(b: &Bytes) -> Vec<u8> {
    let len = b.len() as usize;
    let mut v = alloc::vec![0u8; len];
    if len > 0 {
        b.copy_into_slice(&mut v);
    }
    v
}

/// Verify `locks[...]` (or any storage slot) under a trusted `state_root`.
///
/// 1. Walk the account trie from `state_root` using `keccak256(bridge_addr)` as
///    the key; RLP-decode the account leaf `[nonce, balance, storageRoot,
///    codeHash]` and take `storageRoot` (the 3rd field).
/// 2. Walk the storage trie from `storageRoot` using `keccak256(storage_slot)` as
///    the key; the leaf value is `RLP(word)` (a uint256 with leading zeros
///    stripped). Decode that one RLP layer and right-align into a 32-byte word.
///
/// Returns the proven storage word, or an [`MptError`] on any mismatch.
pub fn verify_storage(
    env: &Env,
    state_root: &BytesN<32>,
    bridge_addr: &[u8; 20],
    storage_slot: &BytesN<32>,
    account_proof: &SorobanVec<Bytes>,
    storage_proof: &SorobanVec<Bytes>,
) -> Result<BytesN<32>, MptError> {
    // --- 1. account proof -> storageRoot ---------------------------------
    let addr_key = keccak(env, bridge_addr);
    let account_rlp = mpt_verify(env, state_root, &addr_key, account_proof)?;
    let account_buf = to_vec(&account_rlp);
    let account_items = rlp::decode_list(&account_buf)?;
    // [nonce, balance, storageRoot, codeHash]
    if account_items.len() != 4 {
        return Err(MptError::BadAccountRlp);
    }
    let storage_root_bytes = account_items[2].as_str()?;
    if storage_root_bytes.len() != 32 {
        return Err(MptError::BadAccountRlp);
    }
    let mut sr = [0u8; 32];
    sr.copy_from_slice(storage_root_bytes);
    let storage_root = BytesN::from_array(env, &sr);

    // --- 2. storage proof -> 32-byte word --------------------------------
    let slot_key = keccak(env, &storage_slot.to_array());
    let value_rlp = mpt_verify(env, &storage_root, &slot_key, storage_proof)?;
    let value_buf = to_vec(&value_rlp);
    // The trie value is `RLP(word)`; strip that one RLP layer.
    let (item, _) = rlp::parse_one(&value_buf)?;
    let word = item.as_str()?;
    if word.len() > 32 {
        return Err(MptError::RlpError);
    }
    // Right-align (left-pad with zeros) into a 32-byte word.
    let mut out = [0u8; 32];
    out[32 - word.len()..].copy_from_slice(word);
    Ok(BytesN::from_array(env, &out))
}

/// Thin Soroban contract wrapper so `stellar contract build` produces a WASM and
/// the verifier is callable cross-contract.
///
/// Gated behind the (default-on) `contract` feature: `ObscuraBridge` depends on
/// this crate as an in-process **library** (`default-features = false`) and calls
/// [`verify_storage`] directly, so it must NOT pull this contract wrapper into the
/// bridge WASM's exported interface.
#[cfg(feature = "contract")]
#[contract]
pub struct BridgeMpt;

#[cfg(feature = "contract")]
#[contractimpl]
impl BridgeMpt {
    /// Verify a storage proof and return the proven 32-byte word. See
    /// [`verify_storage`].
    pub fn verify_storage(
        env: Env,
        state_root: BytesN<32>,
        bridge_addr: BytesN<20>,
        storage_slot: BytesN<32>,
        account_proof: soroban_sdk::Vec<Bytes>,
        storage_proof: soroban_sdk::Vec<Bytes>,
    ) -> Result<BytesN<32>, MptError> {
        let addr = bridge_addr.to_array();
        verify_storage(
            &env,
            &state_root,
            &addr,
            &storage_slot,
            &account_proof,
            &storage_proof,
        )
    }
}
