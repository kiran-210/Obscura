//! Obscura `redeem` circuit (LENDING_SPEC sec 3/4).
//!
//! Burns some or all of a supply note and returns the nominal value (principal
//! plus accrued interest, via the public `supply_index`) as a balance note.
//!
//! The contract MUST additionally check that the reserve holds enough free
//! liquidity: this circuit proves entitlement, not availability. A fully-utilised
//! reserve can leave a valid redemption temporarily unfillable.
//!
//! Public inputs (IN THIS ORDER):
//!   merkle_root, nullifier, out_note_commitment, remainder_commitment,
//!   asset, redeem_amount, supply_index

use dep::lending_lib as l;
use dep::obscura_lib as w;

fn main(
    // ---- public inputs ----
    merkle_root: pub Field,
    nullifier: pub Field,
    out_note_commitment: pub Field,
    remainder_commitment: pub Field,
    asset: pub Field,
    redeem_amount: pub Field,
    supply_index: pub Field,
    // ---- private inputs ----
    supply_scaled: Field,
    spending_key: Field,
    merkle_path: [Field; 20],
    merkle_indices: [Field; 20],
    old_nonce: Field,
    new_nonce: Field,
    out_blinding: Field,
) {
    w::assert_64(redeem_amount);
    assert(redeem_amount != 0, "redemption must be non-zero");

    // 1. Own the supply note.
    let owner_key = w::owner_key(spending_key);
    let old_supply = l::supply_commitment(asset, supply_scaled, owner_key, old_nonce);
    assert(w::nullifier(old_supply, spending_key) == nullifier, "bad nullifier");
    let root = w::compute_merkle_root(old_supply, merkle_path, merkle_indices);
    assert(root == merkle_root, "merkle root mismatch");

    // 2. Entitlement: nominal value of the scaled balance at the current index.
    let entitled = l::mul_div(supply_scaled, supply_index, l::INDEX_SCALE);
    assert(w::geq64(entitled, redeem_amount), "redeeming more than entitled");

    // 3. Remaining scaled balance after a partial redemption.
    let redeem_scaled = l::to_scaled(redeem_amount, supply_index);
    let remaining_scaled = supply_scaled - redeem_scaled;

    if remaining_scaled != 0 {
        let rem = l::supply_commitment(asset, remaining_scaled, owner_key, new_nonce);
        assert(rem == remainder_commitment, "remainder commitment mismatch");
    } else {
        assert(remainder_commitment == 0, "remainder must be 0 when fully redeemed");
    }

    // 4. Pay out as an ordinary balance note.
    let out = w::note_commitment(asset, redeem_amount, owner_key, out_blinding);
    assert(out == out_note_commitment, "out note commitment mismatch");
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
fn test_redeem_full_at_unit_index() {
    let sk = 7;
    let ok = w::owner_key(sk);
    let sup = l::supply_commitment(1, 1000, ok, 11);
    let nf = w::nullifier(sup, sk);
    let root = root_allzero(sup);
    let out = w::note_commitment(1, 1000, ok, 999);

    main(root, nf, out, 0, 1, 1000, ONE_INDEX, 1000, sk, [0; TD], [0; TD], 11, 12, 999);
}

#[test]
fn test_redeem_includes_accrued_interest() {
    // 500 scaled at index 2.0 is worth 1000 nominal.
    let sk = 7;
    let ok = w::owner_key(sk);
    let sup = l::supply_commitment(1, 500, ok, 11);
    let nf = w::nullifier(sup, sk);
    let root = root_allzero(sup);
    let out = w::note_commitment(1, 1000, ok, 999);

    main(root, nf, out, 0, 1, 1000, 2000000000, 500, sk, [0; TD], [0; TD], 11, 12, 999);
}

#[test(should_fail_with = "redeeming more than entitled")]
fn test_redeem_beyond_entitlement_rejected() {
    let sk = 7;
    let ok = w::owner_key(sk);
    let sup = l::supply_commitment(1, 1000, ok, 11);
    let nf = w::nullifier(sup, sk);
    let root = root_allzero(sup);
    let out = w::note_commitment(1, 1500, ok, 999);

    main(root, nf, out, 0, 1, 1500, ONE_INDEX, 1000, sk, [0; TD], [0; TD], 11, 12, 999);
}
