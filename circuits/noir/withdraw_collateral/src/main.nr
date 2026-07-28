//! Obscura `withdraw_collateral` circuit (LENDING_SPEC sec 5).
//!
//! Reduces a position's collateral and returns it as a spendable balance note.
//! Solvency is re-checked AFTER the withdrawal at `max_ltv_bps` -- this is the
//! circuit that stops a borrower from walking away with collateral and leaving
//! the hidden debt behind.
//!
//! `old_position_commitment` is public so the contract can bind the registry entry
//! it mutates to the position this proof is about (see `borrow` for the attack it
//! prevents).
//!
//! Public inputs (IN THIS ORDER):
//!   merkle_root, old_position_commitment, position_nullifier,
//!   new_position_commitment, out_note_commitment, collateral_asset,
//!   old_collateral_amount, new_collateral_amount, debt_asset, collateral_price,
//!   debt_price, borrow_index, max_ltv_bps

use dep::lending_lib as l;
use dep::obscura_lib as w;

fn main(
    // ---- public inputs ----
    merkle_root: pub Field,
    old_position_commitment: pub Field,
    position_nullifier: pub Field,
    new_position_commitment: pub Field,
    out_note_commitment: pub Field,
    collateral_asset: pub Field,
    old_collateral_amount: pub Field,
    new_collateral_amount: pub Field,
    debt_asset: pub Field,
    collateral_price: pub Field,
    debt_price: pub Field,
    borrow_index: pub Field,
    max_ltv_bps: pub Field,
    // ---- private inputs ----
    debt_scaled: Field,
    spending_key: Field,
    merkle_path: [Field; 20],
    merkle_indices: [Field; 20],
    old_nonce: Field,
    new_nonce: Field,
    out_blinding: Field,
) {
    w::assert_64(old_collateral_amount);
    w::assert_64(new_collateral_amount);
    assert(
        w::geq64(old_collateral_amount, new_collateral_amount),
        "collateral may only decrease here",
    );

    let withdraw_amount = old_collateral_amount - new_collateral_amount;
    assert(withdraw_amount != 0, "withdrawal must be non-zero");

    // 1. Own the position.
    let owner_key = w::owner_key(spending_key);
    let old_position = l::position_commitment(
        collateral_asset,
        old_collateral_amount,
        debt_asset,
        debt_scaled,
        owner_key,
        old_nonce,
    );
    assert(old_position == old_position_commitment, "old position commitment mismatch");
    assert(
        w::nullifier(old_position, spending_key) == position_nullifier,
        "bad position nullifier",
    );
    let root = w::compute_merkle_root(old_position, merkle_path, merkle_indices);
    assert(root == merkle_root, "merkle root mismatch");

    // 2. Solvency on the REMAINING collateral. Checked at the borrow ceiling, not
    //    the liquidation threshold, so a withdrawal cannot leave the position
    //    immediately liquidatable.
    l::assert_solvent(
        new_collateral_amount,
        collateral_price,
        debt_scaled,
        debt_price,
        borrow_index,
        max_ltv_bps,
    );

    // 3. Re-commit with the reduced collateral (debt unchanged).
    let new_position = l::position_commitment(
        collateral_asset,
        new_collateral_amount,
        debt_asset,
        debt_scaled,
        owner_key,
        new_nonce,
    );
    assert(new_position == new_position_commitment, "new position commitment mismatch");

    // 4. Return the withdrawn collateral as a balance note.
    let out = w::note_commitment(collateral_asset, withdraw_amount, owner_key, out_blinding);
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
fn test_withdraw_leaving_healthy_position() {
    let sk = 7;
    let ok = w::owner_key(sk);
    // 1000 collateral, 300 debt. Withdraw 500 -> 500 left, 75% of 500 = 375 >= 300. OK.
    let old_pos = l::position_commitment(0, 1000, 1, 300, ok, 11);
    let nf = w::nullifier(old_pos, sk);
    let root = root_allzero(old_pos);
    let new_pos = l::position_commitment(0, 500, 1, 300, ok, 12);
    let out = w::note_commitment(0, 500, ok, 999);

    main(
        root, old_pos, nf, new_pos, out, 0, 1000, 500, 1, ONE_PRICE, ONE_PRICE, ONE_INDEX, 7500, 300, sk,
        [0; TD], [0; TD], 11, 12, 999,
    );
}

#[test(should_fail_with = "position is not solvent")]
fn test_withdraw_breaching_ltv_rejected() {
    let sk = 7;
    let ok = w::owner_key(sk);
    // Withdraw down to 300 collateral against 300 debt: 75% of 300 = 225 < 300.
    let old_pos = l::position_commitment(0, 1000, 1, 300, ok, 11);
    let nf = w::nullifier(old_pos, sk);
    let root = root_allzero(old_pos);
    let new_pos = l::position_commitment(0, 300, 1, 300, ok, 12);
    let out = w::note_commitment(0, 700, ok, 999);

    main(
        root, old_pos, nf, new_pos, out, 0, 1000, 300, 1, ONE_PRICE, ONE_PRICE, ONE_INDEX, 7500, 300, sk,
        [0; TD], [0; TD], 11, 12, 999,
    );
}

#[test(should_fail_with = "collateral may only decrease here")]
fn test_withdraw_cannot_inflate_collateral() {
    let sk = 7;
    let ok = w::owner_key(sk);
    let old_pos = l::position_commitment(0, 1000, 1, 0, ok, 11);
    let nf = w::nullifier(old_pos, sk);
    let root = root_allzero(old_pos);
    let new_pos = l::position_commitment(0, 5000, 1, 0, ok, 12);
    let out = w::note_commitment(0, 1, ok, 999);

    main(
        root, old_pos, nf, new_pos, out, 0, 1000, 5000, 1, ONE_PRICE, ONE_PRICE, ONE_INDEX, 7500, 0, sk,
        [0; TD], [0; TD], 11, 12, 999,
    );
}
