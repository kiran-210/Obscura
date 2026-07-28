//! Obscura `position_open` circuit (LENDING_SPEC sec 3).
//!
//! Spends a balance note as collateral and opens a lending position with zero
//! debt. The collateral asset and amount are PUBLIC -- that is what makes a
//! stale position seizable later without any keeper (LENDING_SPEC sec 1).
//!
//! Public inputs (IN THIS ORDER -- load-bearing, SHARED sec 7):
//!   merkle_root, nullifier, position_commitment, collateral_asset, collateral_amount

use dep::lending_lib as l;
use dep::obscura_lib as w;

fn main(
    // ---- public inputs ----
    merkle_root: pub Field,
    nullifier: pub Field,
    position_commitment: pub Field,
    collateral_asset: pub Field,
    collateral_amount: pub Field,
    // ---- private inputs ----
    note_blinding: Field,
    spending_key: Field,
    merkle_path: [Field; 20],
    merkle_indices: [Field; 20],
    debt_asset: Field,
    position_nonce: Field,
) {
    w::assert_64(collateral_amount);
    assert(collateral_amount != 0, "collateral must be non-zero");

    // 1. Own the collateral note and prove it is in the tree. Its amount is the
    //    public `collateral_amount`, so the spent note's value is disclosed --
    //    accepted by design (LENDING_SPEC sec 1).
    let owner_key = w::owner_key(spending_key);
    let note = w::note_commitment(collateral_asset, collateral_amount, owner_key, note_blinding);
    assert(w::nullifier(note, spending_key) == nullifier, "bad nullifier");
    let root = w::compute_merkle_root(note, merkle_path, merkle_indices);
    assert(root == merkle_root, "merkle root mismatch");

    // 2. Open the position with debt_scaled = 0. No solvency check is needed:
    //    zero debt is trivially solvent at any price.
    let computed = l::position_commitment(
        collateral_asset,
        collateral_amount,
        debt_asset,
        0,
        owner_key,
        position_nonce,
    );
    assert(computed == position_commitment, "position commitment mismatch");
}

// ===========================================================================
// Tests
// ===========================================================================

global TD: u32 = 20;

fn root_allzero(leaf: Field) -> Field {
    let mut cur = leaf;
    for _ in 0..TD {
        cur = w::hash2(cur, 0);
    }
    cur
}

#[test]
fn test_open_valid() {
    let sk = 7;
    let ok = w::owner_key(sk);
    let (asset, amount, bl) = (0, 1000, 555);
    let note = w::note_commitment(asset, amount, ok, bl);
    let nf = w::nullifier(note, sk);
    let root = root_allzero(note);
    let pos = l::position_commitment(asset, amount, 1, 0, ok, 42);

    main(root, nf, pos, asset, amount, bl, sk, [0; TD], [0; TD], 1, 42);
}

#[test(should_fail_with = "position commitment mismatch")]
fn test_open_rejects_nonzero_debt_claim() {
    let sk = 7;
    let ok = w::owner_key(sk);
    let (asset, amount, bl) = (0, 1000, 555);
    let note = w::note_commitment(asset, amount, ok, bl);
    let nf = w::nullifier(note, sk);
    let root = root_allzero(note);
    // A position claiming pre-existing debt must not open.
    let pos = l::position_commitment(asset, amount, 1, 500, ok, 42);

    main(root, nf, pos, asset, amount, bl, sk, [0; TD], [0; TD], 1, 42);
}

#[test(should_fail_with = "collateral must be non-zero")]
fn test_open_rejects_zero_collateral() {
    let sk = 7;
    let ok = w::owner_key(sk);
    let note = w::note_commitment(0, 0, ok, 555);
    let nf = w::nullifier(note, sk);
    let root = root_allzero(note);
    let pos = l::position_commitment(0, 0, 1, 0, ok, 42);

    main(root, nf, pos, 0, 0, 555, sk, [0; TD], [0; TD], 1, 42);
}
