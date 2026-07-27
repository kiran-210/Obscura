//! Obscura shared circuit library.
//!
//! Centralises every cryptographic invariant that MUST be byte-for-byte identical
//! across the Noir circuits, the Soroban contract, and the TypeScript SDK.
//! See SHARED.md (sec 3-5) -- this file is the in-circuit realisation of those rules.
//!
//! Poseidon2: BN254, state width t=4, RATE 3, HADES, S-box x^5, variable-length
//! sponge with domain/IV = message_size << 64. The `poseidon` lib's
//! `Poseidon2::hash(input, message_size)` takes the *number of field elements
//! absorbed* as the second argument (NOT a capacity).

use dep::poseidon::poseidon2::Poseidon2;

/// Merkle tree depth (SHARED sec 4 / 5).
pub global TREE_DEPTH: u32 = 20;

/// Fixed-point price scale (SHARED sec 4): prices are multiplied by 10^7.
pub global PRICE_SCALE: Field = 10000000;

// ---------------------------------------------------------------------------
// Poseidon2 hash arities (SHARED sec 3)
// ---------------------------------------------------------------------------

/// 2-input Poseidon2 hash -- Merkle nodes, nullifiers, key derivation.
pub fn hash2(a: Field, b: Field) -> Field {
    Poseidon2::hash([a, b], 2)
}

/// 4-input Poseidon2 hash -- balance note commitments.
pub fn hash4(a: Field, b: Field, c: Field, d: Field) -> Field {
    Poseidon2::hash([a, b, c, d], 4)
}

/// 7-input Poseidon2 hash -- order commitments.
pub fn hash7(a: Field, b: Field, c: Field, d: Field, e: Field, f: Field, g: Field) -> Field {
    Poseidon2::hash([a, b, c, d, e, f, g], 7)
}

// ---------------------------------------------------------------------------
// Domain commitments (SHARED sec 4)
// ---------------------------------------------------------------------------

/// Balance-note commitment. Field order is fixed everywhere:
/// (asset_id, amount, owner_key, blinding).
pub fn note_commitment(asset_id: Field, amount: Field, owner_key: Field, blinding: Field) -> Field {
    hash4(asset_id, amount, owner_key, blinding)
}

/// Nullifier of a note: hash2(commitment, spending_key). Only the owner (who
/// knows spending_key) can derive it; deterministic, so one note => one nullifier.
pub fn nullifier(commitment: Field, spending_key: Field) -> Field {
    hash2(commitment, spending_key)
}

/// Public owner key derived from the secret spending key: hash2(spending_key, 0).
pub fn owner_key(spending_key: Field) -> Field {
    hash2(spending_key, 0)
}

/// Order commitment. Field order is fixed:
/// (side, price, amount, asset_base, asset_quote, owner_key, nonce).
pub fn order_commitment(
    side: Field,
    price: Field,
    amount: Field,
    asset_base: Field,
    asset_quote: Field,
    owner_key: Field,
    nonce: Field,
) -> Field {
    hash7(side, price, amount, asset_base, asset_quote, owner_key, nonce)
}

// ---------------------------------------------------------------------------
// Bounded integer arithmetic (SHARED: amounts/prices < 2^64)
// ---------------------------------------------------------------------------
//
// IMPORTANT: a `Field as u64` / `as u128` cast in Noir TRUNCATES silently (it
// does NOT range-check). Every value fed into the helpers below MUST first be
// constrained with `assert_64` (or otherwise proven < 2^64), otherwise the
// integer reasoning is unsound. The circuits call `assert_64` on every amount
// and price before using these helpers.

/// Range-check a Field to 64 bits. Wrapper around `assert_max_bit_size::<64>()`.
pub fn assert_64(x: Field) {
    x.assert_max_bit_size::<64>();
}

/// `a >= b`, assuming both already range-checked to < 2^64.
pub fn geq64(a: Field, b: Field) -> bool {
    (a as u64) >= (b as u64)
}

/// `a > b`, assuming both already range-checked to < 2^64.
pub fn gt64(a: Field, b: Field) -> bool {
    (a as u64) > (b as u64)
}

/// `min(a, b)` as a Field, assuming both already range-checked to < 2^64.
pub fn min64(a: Field, b: Field) -> Field {
    let au = a as u64;
    let bu = b as u64;
    (if au < bu { au } else { bu }) as Field
}

/// Floor of the midpoint `(a + b) / 2`, assuming a, b < 2^64.
/// Sum < 2^65 fits in u128; division is integer/floor (SHARED: midpoint, noted
/// as floor-rounded in the README).
pub fn midpoint(a: Field, b: Field) -> Field {
    let s: u128 = (a as u128) + (b as u128);
    (s / 2) as Field
}

/// Floor of `(a * b) / PRICE_SCALE`, assuming a, b < 2^64.
/// The product a*b < 2^128 fits in u128; division is integer/floor.
pub fn mul_div_price(a: Field, b: Field) -> Field {
    let prod: u128 = (a as u128) * (b as u128);
    let scale: u128 = 10000000; // PRICE_SCALE
    (prod / scale) as Field
}

// ---------------------------------------------------------------------------
// Merkle proof verification (SHARED sec 5)
// ---------------------------------------------------------------------------

/// Enforce that `bit` is boolean (0 or 1).
fn constrain_bit(bit: Field) {
    assert(bit * (1 - bit) == 0, "merkle path bit must be 0 or 1");
}

/// Recompute the Merkle root from `leaf` up the path.
///
/// Bit ordering (SHARED sec 5):
///   * bit == 0 -> current node is LEFT  -> hash2(cur, sibling)
///   * bit == 1 -> current node is RIGHT -> hash2(sibling, cur)
pub fn compute_merkle_root(
    leaf: Field,
    path_siblings: [Field; TREE_DEPTH],
    path_bits: [Field; TREE_DEPTH],
) -> Field {
    let mut cur = leaf;
    for i in 0..TREE_DEPTH {
        let sib = path_siblings[i];
        let bit = path_bits[i];
        constrain_bit(bit);
        if bit == 0 {
            cur = hash2(cur, sib);
        } else {
            cur = hash2(sib, cur);
        }
    }
    cur
}

// ---------------------------------------------------------------------------
// Library self-tests (commitment helpers + Merkle ordering)
// ---------------------------------------------------------------------------

#[test]
fn test_owner_key_matches_hash2() {
    let sk = 12345;
    assert(owner_key(sk) == hash2(sk, 0));
}

#[test]
fn test_note_commitment_then_nullifier_roundtrip() {
    let ok = owner_key(7);
    let c = note_commitment(0, 100, ok, 999);
    let nf = nullifier(c, 7);
    // Deterministic: same inputs => same nullifier.
    assert(nf == hash2(c, 7));
    assert(nf == nullifier(note_commitment(0, 100, ok, 999), 7));
}

#[test]
fn test_order_commitment_field_order() {
    let ok = owner_key(3);
    let oc = order_commitment(1, 50000000, 10, 0, 1, ok, 42);
    assert(oc == hash7(1, 50000000, 10, 0, 1, ok, 42));
}

#[test]
fn test_merkle_root_left_and_right_differ() {
    let leaf = 111;
    let sib = 222;
    let mut siblings = [0; TREE_DEPTH];
    siblings[0] = sib;
    let bits_left = [0; TREE_DEPTH];
    let mut bits_right = [0; TREE_DEPTH];
    bits_right[0] = 1;

    let root_left = compute_merkle_root(leaf, siblings, bits_left);
    let root_right = compute_merkle_root(leaf, siblings, bits_right);

    // Level-0 node differs by orientation; the two roots must not coincide.
    assert(root_left != root_right);
}

#[test(should_fail_with = "merkle path bit must be 0 or 1")]
fn test_merkle_rejects_non_boolean_bit() {
    let mut bits = [0; TREE_DEPTH];
    bits[0] = 2; // not a bit
    let _ = compute_merkle_root(5, [0; TREE_DEPTH], bits);
}

#[test]
fn test_int_helpers() {
    assert(midpoint(20000000, 10000000) == 15000000);
    assert(midpoint(7, 4) == 5); // floor((7+4)/2) = 5
    assert(mul_div_price(10, 20000000) == 20); // 10 * 2.0
    assert(mul_div_price(3, 15000000) == 4); // floor(45000000/10^7) = 4
    assert(min64(10, 4) == 4);
    assert(min64(4, 10) == 4);
    assert(geq64(100, 100));
    assert(geq64(101, 100));
    assert(!geq64(99, 100));
    assert(gt64(101, 100));
    assert(!gt64(100, 100));
}
