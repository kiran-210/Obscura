//! Obscura `supply` circuit (LENDING_SPEC sec 3/4).
//!
//! Spends a balance note into the lending reserve and mints a supply note that
//! accrues interest via the public `supply_index`.
//!
//! Suppliers are never liquidated, so unlike a position a supply note discloses
//! nothing structural -- the scaled amount stays private inside the commitment.
//! `supply_amount` is still public because the reserve's aggregate liquidity has
//! to move by a known quantity (LENDING_SPEC sec 1.1).
//!
//! Public inputs (IN THIS ORDER):
//!   merkle_root, nullifier, supply_commitment, asset, supply_amount, supply_index

use dep::lending_lib as l;
use dep::obscura_lib as w;

fn main(
    // ---- public inputs ----
    merkle_root: pub Field,
    nullifier: pub Field,
    supply_commitment: pub Field,
    asset: pub Field,
    supply_amount: pub Field,
    supply_index: pub Field,
    // ---- private inputs ----
    note_blinding: Field,
    spending_key: Field,
    merkle_path: [Field; 20],
    merkle_indices: [Field; 20],
    supply_nonce: Field,
) {
    w::assert_64(supply_amount);
    assert(supply_amount != 0, "supply must be non-zero");

    // 1. Own and spend the funding note.
    let owner_key = w::owner_key(spending_key);
    let note = w::note_commitment(asset, supply_amount, owner_key, note_blinding);
    assert(w::nullifier(note, spending_key) == nullifier, "bad nullifier");
    let root = w::compute_merkle_root(note, merkle_path, merkle_indices);
    assert(root == merkle_root, "merkle root mismatch");

    // 2. Mint the supply position, scaled so interest accrues without touching it.
    let scaled = l::to_scaled(supply_amount, supply_index);
    let computed = l::supply_commitment(asset, scaled, owner_key, supply_nonce);
    assert(computed == supply_commitment, "supply commitment mismatch");
}

// ===========================================================================
// Tests
// ===========================================================================

global TD: u32 = 20;
global ONE_INDEX: Field = 1000000000;

fn root_allzero(leaf: Field) -> Field {
    let mut cur = leaf;
    for _ in 0..TD {
        cur = w::hash2(cur, 0);
    }
    cur
}

#[test]
fn test_supply_at_unit_index() {
    let sk = 7;
    let ok = w::owner_key(sk);
    let note = w::note_commitment(1, 1000, ok, 555);
    let nf = w::nullifier(note, sk);
    let root = root_allzero(note);
    let sup = l::supply_commitment(1, 1000, ok, 42);

    main(root, nf, sup, 1, 1000, ONE_INDEX, 555, sk, [0; TD], [0; TD], 42);
}

#[test]
fn test_supply_scales_down_as_index_grows() {
    // Index 2.0 -> 1000 nominal becomes 500 scaled, so later redemption at the
    // same index returns the original 1000.
    let sk = 7;
    let ok = w::owner_key(sk);
    let note = w::note_commitment(1, 1000, ok, 555);
    let nf = w::nullifier(note, sk);
    let root = root_allzero(note);
    let sup = l::supply_commitment(1, 500, ok, 42);

    main(root, nf, sup, 1, 1000, 2000000000, 555, sk, [0; TD], [0; TD], 42);
}

#[test(should_fail_with = "supply commitment mismatch")]
fn test_supply_cannot_overstate_scaled_balance() {
    let sk = 7;
    let ok = w::owner_key(sk);
    let note = w::note_commitment(1, 1000, ok, 555);
    let nf = w::nullifier(note, sk);
    let root = root_allzero(note);
    // Claiming 5000 scaled from a 1000 deposit at index 1.0.
    let sup = l::supply_commitment(1, 5000, ok, 42);

    main(root, nf, sup, 1, 1000, ONE_INDEX, 555, sk, [0; TD], [0; TD], 42);
}
