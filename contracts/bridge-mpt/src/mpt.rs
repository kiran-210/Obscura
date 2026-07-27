//! In-contract Ethereum Merkle-Patricia-Trie inclusion verifier.
//!
//! Walks a hexary MPT from a trusted `root` hash down to a leaf, following the
//! 64-nibble key path (`keccak256(address)` for the account trie,
//! `keccak256(slot)` for a storage trie), verifying each node by
//! `keccak256(node) == expected_hash`. Returns the leaf value on success.
//!
//! Node shapes (RLP lists):
//!   * 17 items  -> branch     (16 child slots + a value slot)
//!   * 2 items   -> extension or leaf, distinguished by the hex-prefix (HP) flag
//!
//! Child references are either a 32-byte hash (descend to the next proof node) or
//! an inline (embedded) node < 32 bytes (descend without a hash check). Empty
//! children / non-matching leaves mean the key is absent -> rejected.

extern crate alloc;
use alloc::vec::Vec;

use soroban_sdk::{contracterror, Bytes, BytesN, Env, Vec as SorobanVec};

use crate::rlp::{decode_list, Item};

#[contracterror]
#[repr(u32)]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum MptError {
    /// `keccak256(node) != expected_hash`: a node was tampered with or the proof
    /// is for a different root.
    HashMismatch = 1,
    /// A node was neither a 17-item branch nor a 2-item extension/leaf.
    InvalidNodeArity = 2,
    /// The key path diverges from the trie (exclusion proof): the proven key is
    /// not present, so no value exists to return.
    KeyNotFound = 3,
    /// The proof ran out of nodes before reaching a leaf value.
    ProofExhausted = 4,
    /// A child reference had an illegal length (not empty, not 32, not inline).
    BadChildRef = 5,
    /// Malformed RLP encoding inside a node.
    RlpError = 6,
    /// The account RLP did not have the expected `[nonce,balance,root,code]` shape.
    BadAccountRlp = 7,
}

/// The nibble at index `i` (0-based, MSB-first) of a 32-byte key hash.
#[inline]
fn nibble(key: &[u8; 32], i: usize) -> u8 {
    let byte = key[i / 2];
    if i % 2 == 0 {
        byte >> 4
    } else {
        byte & 0x0f
    }
}

/// Decode the hex-prefix (compact) encoding of an extension/leaf path.
/// Returns `(is_leaf, path_nibbles)`.
///
/// First byte high nibble = flag: bit1 (`0x2`) set => leaf (terminator);
/// bit0 (`0x1`) set => odd number of path nibbles (the low nibble of byte 0 is the
/// first path nibble). Even paths pad the low nibble of byte 0 with zero.
fn decode_hp(path: &[u8]) -> Result<(bool, Vec<u8>), MptError> {
    if path.is_empty() {
        return Err(MptError::RlpError);
    }
    let flag = path[0] >> 4;
    if flag > 3 {
        return Err(MptError::RlpError);
    }
    let is_leaf = flag & 0x2 != 0;
    let odd = flag & 0x1 != 0;
    let mut nibbles = Vec::new();
    if odd {
        nibbles.push(path[0] & 0x0f);
    } else if path[0] & 0x0f != 0 {
        // Even path: the low nibble of byte 0 must be zero padding.
        return Err(MptError::RlpError);
    }
    for &b in &path[1..] {
        nibbles.push(b >> 4);
        nibbles.push(b & 0x0f);
    }
    Ok((is_leaf, nibbles))
}

/// Where the next node to process comes from.
enum NextNode {
    /// Fetch the next entry from the proof list and check `keccak256 == hash`.
    Hash([u8; 32]),
    /// An inline node embedded in its parent; process directly (no hash check).
    Inline(Vec<u8>),
}

/// Interpret a child reference (a branch slot or an extension's target) and
/// produce the [`NextNode`] to descend into.
fn child_to_next(child: &Item) -> Result<NextNode, MptError> {
    match child {
        Item::Str(s) => {
            if s.is_empty() {
                // Empty slot -> the key path dead-ends here.
                Err(MptError::KeyNotFound)
            } else if s.len() == 32 {
                let mut h = [0u8; 32];
                h.copy_from_slice(s);
                Ok(NextNode::Hash(h))
            } else {
                Err(MptError::BadChildRef)
            }
        }
        // Inline node (its RLP encoding is < 32 bytes, embedded in the parent).
        Item::List(raw) => Ok(NextNode::Inline(raw.to_vec())),
    }
}

/// Copy a Soroban `Bytes` into an owned `Vec<u8>` for slice-based RLP decoding.
fn to_vec(b: &Bytes) -> Vec<u8> {
    let len = b.len() as usize;
    let mut v = alloc::vec![0u8; len];
    if len > 0 {
        b.copy_into_slice(&mut v);
    }
    v
}

/// Verify an MPT inclusion proof for `key_hash` under `root` and return the leaf
/// value (the raw trie value bytes; for storage this is `RLP(word)`, for the
/// account trie it is `RLP([nonce,balance,storageRoot,codeHash])`).
///
/// `proof` is the ordered list of nodes from `eth_getProof`, root first.
pub fn mpt_verify(
    env: &Env,
    root: &BytesN<32>,
    key_hash: &[u8; 32],
    proof: &SorobanVec<Bytes>,
) -> Result<Bytes, MptError> {
    let mut next = NextNode::Hash(root.to_array());
    let mut proof_idx = 0u32;
    let mut key_pos = 0usize; // nibbles consumed so far (0..=64)

    loop {
        // Obtain the bytes of the node we are about to process.
        let node: Vec<u8> = match next {
            NextNode::Hash(expected) => {
                if proof_idx >= proof.len() {
                    return Err(MptError::ProofExhausted);
                }
                let entry = proof.get(proof_idx).unwrap();
                proof_idx += 1;
                let got = env.crypto().keccak256(&entry);
                if got.to_array() != expected {
                    return Err(MptError::HashMismatch);
                }
                to_vec(&entry)
            }
            NextNode::Inline(v) => v,
        };

        let items = decode_list(&node)?;
        match items.len() {
            17 => {
                if key_pos >= 64 {
                    // Key path exhausted exactly at a branch: value is slot 16.
                    let val = items[16].as_str()?;
                    if val.is_empty() {
                        return Err(MptError::KeyNotFound);
                    }
                    return Ok(Bytes::from_slice(env, val));
                }
                let nib = nibble(key_hash, key_pos) as usize;
                key_pos += 1;
                next = child_to_next(&items[nib])?;
            }
            2 => {
                let path = items[0].as_str()?;
                let (is_leaf, path_nibbles) = decode_hp(path)?;
                // The shared path nibbles must match the key here.
                if key_pos + path_nibbles.len() > 64 {
                    return Err(MptError::KeyNotFound);
                }
                for (j, &pn) in path_nibbles.iter().enumerate() {
                    if nibble(key_hash, key_pos + j) != pn {
                        return Err(MptError::KeyNotFound);
                    }
                }
                key_pos += path_nibbles.len();

                if is_leaf {
                    // A leaf only proves inclusion if it consumes the whole key.
                    if key_pos != 64 {
                        return Err(MptError::KeyNotFound);
                    }
                    let val = items[1].as_str()?;
                    return Ok(Bytes::from_slice(env, val));
                } else {
                    // Extension: descend into the referenced child.
                    next = child_to_next(&items[1])?;
                }
            }
            _ => return Err(MptError::InvalidNodeArity),
        }
    }
}
