use soroban_poseidon::{poseidon2_hash, Field};
use soroban_sdk::{crypto::BnScalar, panic_with_error, Bytes, BytesN, Env, Vec, U256};

use crate::types::{DataKey, ObscuraError};

pub const TREE_DEPTH: u32 = 20;
pub const MAX_LEAVES: u32 = 1u32 << TREE_DEPTH;
pub const ROOT_HISTORY: u32 = 100;

/// Poseidon2 2-to-1 hash over BN254, byte-identical to the reference mixer:
/// inputs are reduced mod the BN254 scalar modulus before hashing, state width
/// t = 4, output = state[0] as 32-byte big-endian. See SHARED.md §3 and §5.
pub fn poseidon2_hash2(env: &Env, a: &BytesN<32>, b: &BytesN<32>) -> BytesN<32> {
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

/// Precomputed empty-subtree values: zeros[0] = 0; zeros[i+1] = H(zeros[i], zeros[i]).
fn zeros(env: &Env) -> Vec<BytesN<32>> {
    let mut z = Vec::new(env);
    let mut cur = BytesN::from_array(env, &[0u8; 32]);
    z.push_back(cur.clone());
    let mut i = 0u32;
    while i < TREE_DEPTH {
        cur = poseidon2_hash2(env, &cur, &cur);
        z.push_back(cur.clone());
        i += 1;
    }
    z
}

pub fn empty_root(env: &Env) -> BytesN<32> {
    zeros(env).get(TREE_DEPTH).unwrap()
}

/// Append `leaf` to the incremental tree, push the new root into history, and
/// return its leaf index. Panics with `TreeFull` once capacity is reached, so the
/// caller's mutation phase is infallible (a panic rolls the whole tx back).
pub fn insert(env: &Env, leaf: &BytesN<32>) -> u32 {
    let z = zeros(env);
    let next_index: u32 = env
        .storage()
        .instance()
        .get(&DataKey::NextIndex)
        .unwrap_or(0u32);
    if next_index >= MAX_LEAVES {
        panic_with_error!(env, ObscuraError::TreeFull);
    }
    let idx = next_index;
    let mut cur = leaf.clone();
    let mut i = 0u32;
    while i < TREE_DEPTH {
        let bit = (idx >> i) & 1;
        if bit == 0 {
            env.storage().instance().set(&DataKey::Frontier(i), &cur);
            cur = poseidon2_hash2(env, &cur, &z.get(i).unwrap());
        } else {
            let left: BytesN<32> = env
                .storage()
                .instance()
                .get(&DataKey::Frontier(i))
                .unwrap_or_else(|| z.get(i).unwrap());
            cur = poseidon2_hash2(env, &left, &cur);
        }
        i += 1;
    }
    push_root(env, &cur);
    env.storage()
        .instance()
        .set(&DataKey::NextIndex, &idx.saturating_add(1));
    idx
}

fn roots(env: &Env) -> Vec<BytesN<32>> {
    env.storage()
        .instance()
        .get(&DataKey::Roots)
        .unwrap_or(Vec::new(env))
}

fn push_root(env: &Env, root: &BytesN<32>) {
    let mut r = roots(env);
    r.push_back(root.clone());
    while r.len() > ROOT_HISTORY {
        r.remove(0);
    }
    env.storage().instance().set(&DataKey::Roots, &r);
}

pub fn is_known_root(env: &Env, root: &BytesN<32>) -> bool {
    roots(env).contains(root)
}

pub fn last_root(env: &Env) -> BytesN<32> {
    roots(env).last().unwrap_or_else(|| empty_root(env))
}
