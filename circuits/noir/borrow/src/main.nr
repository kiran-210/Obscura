//! Obscura `borrow` circuit (LENDING_SPEC sec 5).
//!
//! Nullifies the current position note, mints a spendable note of the borrowed
//! asset to the owner, and re-commits the position with the increased debt.
//! Solvency is enforced at `max_ltv_bps` against fresh oracle prices.
//!
//! `borrow_amount` is PUBLIC: a pooled protocol cannot stay solvent without
//! tracking aggregate borrowings. This is the leak documented in
//! LENDING_SPEC sec 1.1 -- following one position's operation chain reveals its
//! debt by accumulation. The debt is still never *stored* on-chain.
//!
//! Public inputs (IN THIS ORDER):
//!   merkle_root, position_nullifier, new_position_commitment, out_note_commitment,
//!   collateral_asset, collateral_amount, debt_asset, borrow_amount,
//!   collateral_price, debt_price, borrow_index, max_ltv_bps

use dep::lending_lib as l;
use dep::obscura_lib as w;

fn main(
    // ---- public inputs ----
    merkle_root: pub Field,
    position_nullifier: pub Field,
    new_position_commitment: pub Field,
    out_note_commitment: pub Field,
    collateral_asset: pub Field,
    collateral_amount: pub Field,
    debt_asset: pub Field,
    borrow_amount: pub Field,
    collateral_price: pub Field,
    debt_price: pub Field,
    borrow_index: pub Field,
    max_ltv_bps: pub Field,
    // ---- private inputs ----
    old_debt_scaled: Field,
    spending_key: Field,
    merkle_path: [Field; 20],
    merkle_indices: [Field; 20],
    old_nonce: Field,
    new_nonce: Field,
    out_blinding: Field,
) {
    w::assert_64(borrow_amount);
    assert(borrow_amount != 0, "borrow must be non-zero");

    // 1. Own the existing position and prove membership.
    let owner_key = w::owner_key(spending_key);
    let old_position = l::position_commitment(
        collateral_asset,
        collateral_amount,
        debt_asset,
        old_debt_scaled,
        owner_key,
        old_nonce,
    );
    assert(
        w::nullifier(old_position, spending_key) == position_nullifier,
        "bad position nullifier",
    );
    let root = w::compute_merkle_root(old_position, merkle_path, merkle_indices);
    assert(root == merkle_root, "merkle root mismatch");

    // 2. Accrue the new borrowing into the scaled debt. Scaling against the
    //    public index is what lets interest accrue later without touching the note.
    let new_debt_scaled = old_debt_scaled + l::to_scaled(borrow_amount, borrow_index);
    w::assert_64(new_debt_scaled);

    // 3. Solvency AFTER the borrow, at the borrow ceiling (not the liquidation
    //    threshold -- you may not open a position that is instantly liquidatable).
    l::assert_solvent(
        collateral_amount,
        collateral_price,
        new_debt_scaled,
        debt_price,
        borrow_index,
        max_ltv_bps,
    );

    // 4. Re-commit the position with the same collateral and the new debt.
    let new_position = l::position_commitment(
        collateral_asset,
        collateral_amount,
        debt_asset,
        new_debt_scaled,
        owner_key,
        new_nonce,
    );
    assert(new_position == new_position_commitment, "new position commitment mismatch");

    // 5. Mint the borrowed funds as an ordinary spendable balance note.
    let out = w::note_commitment(debt_asset, borrow_amount, owner_key, out_blinding);
    assert(out == out_note_commitment, "out note commitment mismatch");
}

// ===========================================================================
// Tests
// ===========================================================================

global TD: u32 = 20;
global ONE_PRICE: Field = 10000000;
global ONE_INDEX: Field = 1000000000;

fn root_allzero(leaf: Field) -> Field {
    let mut cur = leaf;
    for _ in 0..TD {
        cur = w::hash2(cur, 0);
    }
    cur
}

#[test]
fn test_borrow_within_ltv() {
    let sk = 7;
    let ok = w::owner_key(sk);
    // 1000 collateral @1.0, no debt yet; borrow 700 @75% LTV (limit 750).
    let old_pos = l::position_commitment(0, 1000, 1, 0, ok, 11);
    let nf = w::nullifier(old_pos, sk);
    let root = root_allzero(old_pos);
    let new_pos = l::position_commitment(0, 1000, 1, 700, ok, 12);
    let out = w::note_commitment(1, 700, ok, 999);

    main(
        root, nf, new_pos, out, 0, 1000, 1, 700, ONE_PRICE, ONE_PRICE, ONE_INDEX, 7500, 0, sk,
        [0; TD], [0; TD], 11, 12, 999,
    );
}

#[test(should_fail_with = "position is not solvent")]
fn test_borrow_over_ltv_rejected() {
    let sk = 7;
    let ok = w::owner_key(sk);
    let old_pos = l::position_commitment(0, 1000, 1, 0, ok, 11);
    let nf = w::nullifier(old_pos, sk);
    let root = root_allzero(old_pos);
    // 751 > 750 ceiling.
    let new_pos = l::position_commitment(0, 1000, 1, 751, ok, 12);
    let out = w::note_commitment(1, 751, ok, 999);

    main(
        root, nf, new_pos, out, 0, 1000, 1, 751, ONE_PRICE, ONE_PRICE, ONE_INDEX, 7500, 0, sk,
        [0; TD], [0; TD], 11, 12, 999,
    );
}

#[test(should_fail_with = "position is not solvent")]
fn test_borrow_blocked_by_accrued_interest() {
    let sk = 7;
    let ok = w::owner_key(sk);
    // Existing scaled debt 400; index has doubled so real debt is 800 > 750.
    let old_pos = l::position_commitment(0, 1000, 1, 400, ok, 11);
    let nf = w::nullifier(old_pos, sk);
    let root = root_allzero(old_pos);
    let two_index = 2000000000;
    // Borrowing 1 more scales to 0 at index 2.0, but existing debt already breaches.
    let new_scaled = 400 + 0;
    let new_pos = l::position_commitment(0, 1000, 1, new_scaled, ok, 12);
    let out = w::note_commitment(1, 1, ok, 999);

    main(
        root, nf, new_pos, out, 0, 1000, 1, 1, ONE_PRICE, ONE_PRICE, two_index, 7500, 400, sk,
        [0; TD], [0; TD], 11, 12, 999,
    );
}

#[test(should_fail_with = "out note commitment mismatch")]
fn test_borrow_cannot_mint_more_than_declared() {
    let sk = 7;
    let ok = w::owner_key(sk);
    let old_pos = l::position_commitment(0, 1000, 1, 0, ok, 11);
    let nf = w::nullifier(old_pos, sk);
    let root = root_allzero(old_pos);
    let new_pos = l::position_commitment(0, 1000, 1, 700, ok, 12);
    // Debt says 700 but the minted note claims 900.
    let out = w::note_commitment(1, 900, ok, 999);

    main(
        root, nf, new_pos, out, 0, 1000, 1, 700, ONE_PRICE, ONE_PRICE, ONE_INDEX, 7500, 0, sk,
        [0; TD], [0; TD], 11, 12, 999,
    );
}
