//! Minimal SSZ (Simple Serialize) needed to link a Signal-proven finalized
//! **beacon block root** to the Ethereum **execution** `state_root`:
//! `hash_tree_root` of the two fixed containers (`BeaconBlockHeader`,
//! `ExecutionPayloadHeader`) and generalized-index Merkle-branch verification.
//! All hashing is SHA-256 via the Soroban host (`env.crypto().sha256`).
//!
//! Vendored from `eth-light-client` (the consensus-verification half of that
//! module is gone — Boundless's Signal proof replaces it — but the
//! execution-linkage SSZ is identical and reused verbatim).

extern crate alloc;
use alloc::vec::Vec as AVec;
use soroban_sdk::{Bytes, BytesN, Env, Vec};

use crate::types::{BeaconHeader, ExecutionPayloadHeader};

#[inline]
fn zero32(env: &Env) -> BytesN<32> {
    BytesN::from_array(env, &[0u8; 32])
}

/// SHA-256 of `left ++ right` (two 32-byte chunks) — one internal Merkle node.
fn hash_pair(env: &Env, left: &BytesN<32>, right: &BytesN<32>) -> BytesN<32> {
    let mut b = Bytes::new(env);
    b.extend_from_array(&left.to_array());
    b.extend_from_array(&right.to_array());
    env.crypto().sha256(&b).to_bytes()
}

/// SSZ `hash_tree_root` of a `uintN` basic type: little-endian value,
/// right-padded with zeros to 32 bytes.
fn uint64_leaf(env: &Env, v: u64) -> BytesN<32> {
    let mut out = [0u8; 32];
    out[0..8].copy_from_slice(&v.to_le_bytes());
    BytesN::from_array(env, &out)
}

/// Merkleize a list of 32-byte leaves: pad with zero leaves up to the next power
/// of two, then reduce pairwise to a single root. (Sufficient for our
/// fixed-size containers and byte vectors — widths are tiny: <= 32.)
fn merkleize(env: &Env, mut nodes: AVec<BytesN<32>>) -> BytesN<32> {
    if nodes.is_empty() {
        return zero32(env);
    }
    let mut width = 1usize;
    while width < nodes.len() {
        width <<= 1;
    }
    while nodes.len() < width {
        nodes.push(zero32(env));
    }
    while nodes.len() > 1 {
        let mut next: AVec<BytesN<32>> = AVec::with_capacity(nodes.len() / 2);
        let mut i = 0;
        while i < nodes.len() {
            next.push(hash_pair(env, &nodes[i], &nodes[i + 1]));
            i += 2;
        }
        nodes = next;
    }
    nodes[0].clone()
}

/// `hash_tree_root(BeaconBlockHeader)` — fixed container of 5 fields. This is the
/// value the Signal finalized checkpoint commits to (`Checkpoint.root`).
pub fn beacon_header_root(env: &Env, h: &BeaconHeader) -> BytesN<32> {
    let mut leaves: AVec<BytesN<32>> = AVec::with_capacity(5);
    leaves.push(uint64_leaf(env, h.slot));
    leaves.push(uint64_leaf(env, h.proposer_index));
    leaves.push(h.parent_root.clone());
    leaves.push(h.state_root.clone());
    leaves.push(h.body_root.clone());
    merkleize(env, leaves)
}

/// `hash_tree_root` of a fixed byte vector whose length is a multiple of 32
/// (e.g. `logs_bloom`: 256 bytes -> 8 chunks).
fn byte_vector_root(env: &Env, data: &Bytes) -> BytesN<32> {
    let len = data.len();
    let chunks = (len / 32) as usize;
    let mut leaves: AVec<BytesN<32>> = AVec::with_capacity(chunks);
    let mut i = 0u32;
    while i < len {
        let mut c = [0u8; 32];
        data.slice(i..i + 32).copy_into_slice(&mut c);
        leaves.push(BytesN::from_array(env, &c));
        i += 32;
    }
    merkleize(env, leaves)
}

/// `hash_tree_root` of `extra_data: List[byte, 32]`: pack into one 32-byte chunk,
/// then `mix_in_length`. (`extra_data` is <= 32 bytes.)
fn extra_data_root(env: &Env, data: &Bytes) -> BytesN<32> {
    let len = data.len();
    let mut chunk = [0u8; 32];
    let n = core::cmp::min(len, 32);
    if n > 0 {
        data.slice(0..n).copy_into_slice(&mut chunk[0..n as usize]);
    }
    let root = BytesN::from_array(env, &chunk);
    let length_leaf = uint64_leaf(env, len as u64);
    hash_pair(env, &root, &length_leaf)
}

/// `hash_tree_root(ExecutionPayloadHeader)` — 17-field container (Deneb/Electra/
/// Fulu layout). Binds `state_root` and `block_number` to the verified header root.
pub fn execution_payload_root(env: &Env, e: &ExecutionPayloadHeader) -> BytesN<32> {
    // fee_recipient: Bytes20 right-padded to 32.
    let mut fee = [0u8; 32];
    fee[0..20].copy_from_slice(&e.fee_recipient.to_array());

    let mut leaves: AVec<BytesN<32>> = AVec::with_capacity(17);
    leaves.push(e.parent_hash.clone()); // 0
    leaves.push(BytesN::from_array(env, &fee)); // 1
    leaves.push(e.state_root.clone()); // 2
    leaves.push(e.receipts_root.clone()); // 3
    leaves.push(byte_vector_root(env, &e.logs_bloom)); // 4
    leaves.push(e.prev_randao.clone()); // 5
    leaves.push(uint64_leaf(env, e.block_number)); // 6
    leaves.push(uint64_leaf(env, e.gas_limit)); // 7
    leaves.push(uint64_leaf(env, e.gas_used)); // 8
    leaves.push(uint64_leaf(env, e.timestamp)); // 9
    leaves.push(extra_data_root(env, &e.extra_data)); // 10
    leaves.push(e.base_fee_per_gas.clone()); // 11 (uint256 LE, already 32 bytes)
    leaves.push(e.block_hash.clone()); // 12
    leaves.push(e.transactions_root.clone()); // 13
    leaves.push(e.withdrawals_root.clone()); // 14
    leaves.push(uint64_leaf(env, e.blob_gas_used)); // 15
    leaves.push(uint64_leaf(env, e.excess_blob_gas)); // 16
    merkleize(env, leaves)
}

/// `is_valid_merkle_branch`: walk `leaf` up through `branch` siblings, using the
/// bits of `index` (the subtree index = gindex % 2^depth) to order each hash,
/// and check the result equals `root`. `depth` is `branch.len()`.
pub fn verify_merkle_branch(
    env: &Env,
    leaf: &BytesN<32>,
    branch: &Vec<BytesN<32>>,
    index: u64,
    root: &BytesN<32>,
) -> bool {
    let mut node = leaf.clone();
    let depth = branch.len();
    let mut i = 0u32;
    while i < depth {
        let sibling = branch.get(i).unwrap();
        if (index >> i) & 1 == 1 {
            node = hash_pair(env, &sibling, &node);
        } else {
            node = hash_pair(env, &node, &sibling);
        }
        i += 1;
    }
    &node == root
}
