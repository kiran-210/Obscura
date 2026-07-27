#![cfg(test)]
//! Tests for the MPT storage-proof verifier.
//!
//! The primary vector is a **real** Sepolia `eth_getProof` (WETH9 at block
//! 11173387 — see `vectors.rs`), verified against the block's real execution
//! `state_root`. We assert both an inclusion proof for a direct slot and for a
//! `mapping(address=>uint)` slot, and that tampering is rejected.

extern crate std;
use std::vec::Vec as StdVec;

use soroban_sdk::{
    testutils::budget::ContractCostType, Bytes, BytesN, Env, Vec as SorobanVec,
};

use crate::vectors as v;
use crate::{mpt::MptError, verify_storage};
#[cfg(feature = "contract")]
use crate::{BridgeMpt, BridgeMptClient};

// ---------------------------------------------------------------------------
// hex helpers (tests run on the host with std available)
// ---------------------------------------------------------------------------

fn unhex(s: &str) -> StdVec<u8> {
    assert!(s.len() % 2 == 0, "odd hex length");
    let b = s.as_bytes();
    let mut out = StdVec::with_capacity(s.len() / 2);
    let hexval = |c: u8| -> u8 {
        match c {
            b'0'..=b'9' => c - b'0',
            b'a'..=b'f' => c - b'a' + 10,
            b'A'..=b'F' => c - b'A' + 10,
            _ => panic!("bad hex char"),
        }
    };
    let mut i = 0;
    while i < b.len() {
        out.push((hexval(b[i]) << 4) | hexval(b[i + 1]));
        i += 2;
    }
    out
}

fn bytes(env: &Env, s: &str) -> Bytes {
    Bytes::from_slice(env, &unhex(s))
}

fn b32(env: &Env, s: &str) -> BytesN<32> {
    let v = unhex(s);
    assert_eq!(v.len(), 32);
    let mut a = [0u8; 32];
    a.copy_from_slice(&v);
    BytesN::from_array(env, &a)
}

fn b20(env: &Env, s: &str) -> BytesN<20> {
    let v = unhex(s);
    assert_eq!(v.len(), 20);
    let mut a = [0u8; 20];
    a.copy_from_slice(&v);
    BytesN::from_array(env, &a)
}

fn proof(env: &Env, nodes: &[&str]) -> SorobanVec<Bytes> {
    let mut p = SorobanVec::new(env);
    for n in nodes {
        p.push_back(bytes(env, n));
    }
    p
}

fn addr_array(s: &str) -> [u8; 20] {
    let v = unhex(s);
    let mut a = [0u8; 20];
    a.copy_from_slice(&v);
    a
}

// ---------------------------------------------------------------------------
// REAL Sepolia data: account proof + storage proof for a direct slot
// ---------------------------------------------------------------------------

#[test]
fn real_sepolia_direct_slot_decimals() {
    let env = Env::default();
    let state_root = b32(&env, v::STATE_ROOT);
    let addr = addr_array(v::WETH_ADDR);
    let slot = b32(&env, v::SLOT_DECIMALS);
    let account_proof = proof(&env, v::ACCOUNT_PROOF);
    let storage_proof = proof(&env, v::STORAGE_PROOF_DECIMALS);

    let word = verify_storage(
        &env,
        &state_root,
        &addr,
        &slot,
        &account_proof,
        &storage_proof,
    )
    .expect("real Sepolia proof must verify");

    // WETH `decimals` == 18 (0x12), right-aligned in a 32-byte word.
    assert_eq!(word, b32(&env, v::VALUE_DECIMALS));
}

// ---------------------------------------------------------------------------
// REAL Sepolia data: a mapping(address=>uint) slot (balanceOf), same slot
// derivation shape as the bridge's locks mapping.
// ---------------------------------------------------------------------------

#[test]
fn real_sepolia_mapping_slot_balance() {
    let env = Env::default();
    let state_root = b32(&env, v::STATE_ROOT);
    let addr = addr_array(v::WETH_ADDR);
    let slot = b32(&env, v::SLOT_BALANCE);
    let account_proof = proof(&env, v::ACCOUNT_PROOF);
    let storage_proof = proof(&env, v::STORAGE_PROOF_BALANCE);

    let word = verify_storage(
        &env,
        &state_root,
        &addr,
        &slot,
        &account_proof,
        &storage_proof,
    )
    .expect("real Sepolia mapping proof must verify");

    assert_eq!(word, b32(&env, v::VALUE_BALANCE));
}

// ---------------------------------------------------------------------------
// Same proof, but driven through the deployed Soroban contract entrypoint.
// ---------------------------------------------------------------------------

#[cfg(feature = "contract")]
#[test]
fn via_contract_client() {
    let env = Env::default();
    let id = env.register(BridgeMpt, ());
    let client = BridgeMptClient::new(&env, &id);

    let word = client.verify_storage(
        &b32(&env, v::STATE_ROOT),
        &b20(&env, v::WETH_ADDR),
        &b32(&env, v::SLOT_BALANCE),
        &proof(&env, v::ACCOUNT_PROOF),
        &proof(&env, v::STORAGE_PROOF_BALANCE),
    );
    assert_eq!(word, b32(&env, v::VALUE_BALANCE));
}

// ---------------------------------------------------------------------------
// Rejection: a corrupted node must NOT verify.
// ---------------------------------------------------------------------------

#[test]
fn reject_corrupted_account_node() {
    let env = Env::default();
    let addr = addr_array(v::WETH_ADDR);

    // Flip one byte deep inside an account-proof node (a branch node).
    let mut nodes: StdVec<std::string::String> =
        v::ACCOUNT_PROOF.iter().map(|s| (*s).into()).collect();
    let target = &mut nodes[4];
    // mutate a byte in the middle of the hex string (keep it valid hex)
    let mut chars: StdVec<u8> = target.as_bytes().to_vec();
    let mid = chars.len() / 2;
    chars[mid] = if chars[mid] == b'a' { b'b' } else { b'a' };
    *target = std::string::String::from_utf8(chars).unwrap();

    let mut corrupt = SorobanVec::new(&env);
    for n in &nodes {
        corrupt.push_back(bytes(&env, n));
    }

    let res = verify_storage(
        &env,
        &b32(&env, v::STATE_ROOT),
        &addr,
        &b32(&env, v::SLOT_DECIMALS),
        &corrupt,
        &proof(&env, v::STORAGE_PROOF_DECIMALS),
    );
    assert_eq!(res, Err(MptError::HashMismatch));
}

#[test]
fn reject_corrupted_storage_node() {
    let env = Env::default();
    let addr = addr_array(v::WETH_ADDR);

    let mut nodes: StdVec<std::string::String> =
        v::STORAGE_PROOF_DECIMALS.iter().map(|s| (*s).into()).collect();
    // Corrupt the storage leaf (last node).
    let last = nodes.len() - 1;
    let mut chars: StdVec<u8> = nodes[last].as_bytes().to_vec();
    let mid = chars.len() / 2;
    chars[mid] = if chars[mid] == b'a' { b'b' } else { b'a' };
    nodes[last] = std::string::String::from_utf8(chars).unwrap();

    let mut corrupt = SorobanVec::new(&env);
    for n in &nodes {
        corrupt.push_back(bytes(&env, n));
    }

    let res = verify_storage(
        &env,
        &b32(&env, v::STATE_ROOT),
        &addr,
        &b32(&env, v::SLOT_DECIMALS),
        &proof(&env, v::ACCOUNT_PROOF),
        &corrupt,
    );
    assert!(res.is_err(), "corrupted storage node must be rejected");
}

#[test]
fn reject_wrong_state_root() {
    let env = Env::default();
    let addr = addr_array(v::WETH_ADDR);

    // A different (but well-formed) state root: the real one with its first
    // byte flipped.
    let mut sr = unhex(v::STATE_ROOT);
    sr[0] ^= 0xff;
    let mut a = [0u8; 32];
    a.copy_from_slice(&sr);
    let wrong_root = BytesN::from_array(&env, &a);

    let res = verify_storage(
        &env,
        &wrong_root,
        &addr,
        &b32(&env, v::SLOT_DECIMALS),
        &proof(&env, v::ACCOUNT_PROOF),
        &proof(&env, v::STORAGE_PROOF_DECIMALS),
    );
    assert_eq!(res, Err(MptError::HashMismatch));
}

#[test]
fn reject_wrong_account_address() {
    let env = Env::default();
    // A different account address -> its key path diverges from the proof.
    let mut a = addr_array(v::WETH_ADDR);
    a[0] ^= 0xff;
    let res = verify_storage(
        &env,
        &b32(&env, v::STATE_ROOT),
        &a,
        &b32(&env, v::SLOT_DECIMALS),
        &proof(&env, v::ACCOUNT_PROOF),
        &proof(&env, v::STORAGE_PROOF_DECIMALS),
    );
    assert!(res.is_err(), "wrong account address must be rejected");
}

// ---------------------------------------------------------------------------
// Slot-derivation: the contract caller (`bridge_in`) derives the storage slot.
// These tests prove our keccak-based derivation matches Ethereum's.
// ---------------------------------------------------------------------------

#[test]
fn mapping_slot_derivation_matches() {
    let env = Env::default();
    // mapping(address=>uint) at decl slot 3: slot = keccak256(pad32(addr) || pad32(3)).
    let mut preimage = StdVec::new();
    preimage.extend_from_slice(&[0u8; 12]); // left-pad address to 32 bytes
    preimage.extend_from_slice(&unhex(v::HOLDER));
    preimage.extend_from_slice(&[0u8; 31]);
    preimage.push(3u8); // slot index 3
    let pre = Bytes::from_slice(&env, &preimage);
    let got = env.crypto().keccak256(&pre).to_bytes();
    assert_eq!(got, b32(&env, v::SLOT_BALANCE));
}

#[test]
fn bridge_locks_slot_derivation_matches() {
    let env = Env::default();
    // Bridge `locks` mapping(bytes32=>...) at decl slot 0:
    //   slot = keccak256(commitment || bytes32(0))
    let mut preimage = StdVec::new();
    preimage.extend_from_slice(&unhex(v::LOCKS_COMMITMENT)); // 32-byte commitment
    preimage.extend_from_slice(&[0u8; 32]); // bytes32(0) = declaration slot 0
    let pre = Bytes::from_slice(&env, &preimage);
    let got = env.crypto().keccak256(&pre).to_bytes();
    assert_eq!(got, b32(&env, v::LOCKS_SLOT0));
}

// ---------------------------------------------------------------------------
// Cost / keccak-invocation accounting.
// ---------------------------------------------------------------------------

#[test]
fn report_cost() {
    let env = Env::default();
    let mut budget = env.cost_estimate().budget();
    budget.reset_default();

    let _ = verify_storage(
        &env,
        &b32(&env, v::STATE_ROOT),
        &addr_array(v::WETH_ADDR),
        &b32(&env, v::SLOT_BALANCE),
        &proof(&env, v::ACCOUNT_PROOF),
        &proof(&env, v::STORAGE_PROOF_BALANCE),
    )
    .unwrap();

    let b2 = env.cost_estimate().budget();
    let keccak = b2.tracker(ContractCostType::ComputeKeccak256Hash);
    let cpu = b2.cpu_instruction_cost();
    let mem = b2.memory_bytes_cost();

    std::println!(
        "[bridge-mpt cost] block={} keccak_calls={} keccak_input_bytes={:?} keccak_cpu={} total_cpu_insns={} mem_bytes={}",
        v::BLOCK_NUMBER,
        keccak.iterations,
        keccak.inputs,
        keccak.cpu,
        cpu,
        mem
    );

    // 9 account-proof nodes + 6 storage-proof nodes + 2 key hashes (addr, slot).
    assert_eq!(keccak.iterations, 9 + 6 + 2);
}
