//! ShieldBid `position_open` circuit.
//!
//! Locks PART of a shielded note as collateral and opens a loan with zero debt.
//! The remainder returns to the portfolio as a change note, so a user can choose
//! exactly how much collateral to commit (SHIELDBID_SPEC sec 8.1 step 4) instead of
//! being forced to lock a whole note.
//!
//! The collateral asset and amount are PUBLIC: that is what lets a stale loan be
//! acted on without a keeper. The note's TOTAL balance stays private -- only the
//! locked portion is disclosed, so the size of the user's portfolio is not.
//!
//! Public inputs (IN THIS ORDER -- load-bearing, SHARED sec 7):
//!   merkle_root, nullifier, position_commitment, change_commitment,
//!   collateral_asset, collateral_amount

use dep::lending_lib as l;
use dep::obscura_lib as w;

fn main(
    // ---- public inputs ----
    merkle_root: pub Field,
    nullifier: pub Field,
    position_commitment: pub Field,
    change_commitment: pub Field,
    collateral_asset: pub Field,
    collateral_amount: pub Field,
    // ---- private inputs ----
    note_amount: Field,
    note_blinding: Field,
    spending_key: Field,
    merkle_path: [Field; 20],
    merkle_indices: [Field; 20],
    debt_asset: Field,
    position_nonce: Field,
    change_blinding: Field,
) {
    w::assert_64(note_amount);
    w::assert_64(collateral_amount);
    assert(collateral_amount != 0, "collateral must be non-zero");

    // 1. Own the funding note and prove it is in the tree. `note_amount` is
    //    private, so the portfolio balance behind the collateral stays hidden.
    let owner_key = w::owner_key(spending_key);
    let note = w::note_commitment(collateral_asset, note_amount, owner_key, note_blinding);
    assert(w::nullifier(note, spending_key) == nullifier, "bad nullifier");
    let root = w::compute_merkle_root(note, merkle_path, merkle_indices);
    assert(root == merkle_root, "merkle root mismatch");

    // 2. Value conservation: the note splits exactly into collateral + change.
    //    Without the range check above this subtraction could wrap and mint value.
    assert(w::geq64(note_amount, collateral_amount), "note does not cover the collateral");
    let change_amount = note_amount - collateral_amount;

    // 3. Open the loan with debt_scaled = 0 -- trivially solvent at any price.
    let computed = l::position_commitment(
        collateral_asset,
        collateral_amount,
        debt_asset,
        0,
        owner_key,
        position_nonce,
    );
    assert(computed == position_commitment, "position commitment mismatch");

    // 4. Change returns to the portfolio (zero commitment when the note is fully used).
    if change_amount != 0 {
        let change =
            w::note_commitment(collateral_asset, change_amount, owner_key, change_blinding);
        assert(change == change_commitment, "change commitment mismatch");
    } else {
        assert(change_commitment == 0, "change must be 0 when no remainder");
    }
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
fn test_partial_collateral_with_change() {
    // 2000 note, lock 500, 1500 returns to the portfolio.
    let sk = 7;
    let ok = w::owner_key(sk);
    let note = w::note_commitment(0, 2000, ok, 555);
    let nf = w::nullifier(note, sk);
    let root = root_allzero(note);
    let pos = l::position_commitment(0, 500, 1, 0, ok, 42);
    let change = w::note_commitment(0, 1500, ok, 777);

    main(root, nf, pos, change, 0, 500, 2000, 555, sk, [0; TD], [0; TD], 1, 42, 777);
}

#[test]
fn test_whole_note_has_no_change() {
    let sk = 7;
    let ok = w::owner_key(sk);
    let note = w::note_commitment(0, 1000, ok, 555);
    let nf = w::nullifier(note, sk);
    let root = root_allzero(note);
    let pos = l::position_commitment(0, 1000, 1, 0, ok, 42);

    main(root, nf, pos, 0, 0, 1000, 1000, 555, sk, [0; TD], [0; TD], 1, 42, 0);
}

#[test(should_fail_with = "note does not cover the collateral")]
fn test_cannot_lock_more_than_the_note_holds() {
    let sk = 7;
    let ok = w::owner_key(sk);
    let note = w::note_commitment(0, 500, ok, 555);
    let nf = w::nullifier(note, sk);
    let root = root_allzero(note);
    let pos = l::position_commitment(0, 900, 1, 0, ok, 42);

    main(root, nf, pos, 0, 0, 900, 500, 555, sk, [0; TD], [0; TD], 1, 42, 0);
}

#[test(should_fail_with = "change commitment mismatch")]
fn test_change_cannot_exceed_the_remainder() {
    // Lock 500 of 2000 but try to mint 1900 of change -- value creation.
    let sk = 7;
    let ok = w::owner_key(sk);
    let note = w::note_commitment(0, 2000, ok, 555);
    let nf = w::nullifier(note, sk);
    let root = root_allzero(note);
    let pos = l::position_commitment(0, 500, 1, 0, ok, 42);
    let change = w::note_commitment(0, 1900, ok, 777);

    main(root, nf, pos, change, 0, 500, 2000, 555, sk, [0; TD], [0; TD], 1, 42, 777);
}

#[test(should_fail_with = "collateral must be non-zero")]
fn test_rejects_zero_collateral() {
    let sk = 7;
    let ok = w::owner_key(sk);
    let note = w::note_commitment(0, 1000, ok, 555);
    let nf = w::nullifier(note, sk);
    let root = root_allzero(note);
    let pos = l::position_commitment(0, 0, 1, 0, ok, 42);

    main(root, nf, pos, 0, 0, 0, 1000, 555, sk, [0; TD], [0; TD], 1, 42, 0);
}
