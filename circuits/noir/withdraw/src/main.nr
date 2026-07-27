//! Wraith `withdraw` circuit (SPEC sec 8.1).
//!
//! Proves ownership of a shielded balance note and authorises a withdrawal of
//! its full amount to a classic Stellar address.
//!
//! Public inputs (SHARED sec 7, IN THIS ORDER):
//!   merkle_root, nullifier, recipient_hash, amount, asset_id

use dep::wraith_lib as w;

fn main(
    // ---- public inputs (order is load-bearing: SHARED sec 7) ----
    merkle_root: pub Field,
    nullifier: pub Field,
    recipient_hash: pub Field,
    amount: pub Field,
    asset_id: pub Field,
    // ---- private inputs ----
    note_amount: Field,
    note_asset_id: Field,
    note_blinding: Field,
    spending_key: Field,
    merkle_path: [Field; 20],
    merkle_indices: [Field; 20],
) {
    // 1. Derive the public owner key from the secret spending key.
    let owner_key = w::owner_key(spending_key);

    // 2. Recompute the note commitment.
    let commitment = w::note_commitment(note_asset_id, note_amount, owner_key, note_blinding);

    // 3. Verify the nullifier was correctly derived (binds spend authority).
    assert(w::nullifier(commitment, spending_key) == nullifier, "bad nullifier");

    // 4. Merkle membership: the note must be in the tree at `merkle_root`.
    let computed_root = w::compute_merkle_root(commitment, merkle_path, merkle_indices);
    assert(computed_root == merkle_root, "merkle root mismatch");

    // 5. Amount and asset must match the public values driving the SAC transfer.
    assert(note_amount == amount, "amount mismatch");
    assert(note_asset_id == asset_id, "asset mismatch");

    // 6. Range-check the withdrawn amount (anti-overflow, SHARED amounts < 2^64).
    w::assert_64(amount);

    // 7. Bind `recipient_hash` into the constraint system. It is otherwise an
    //    unconstrained public input; squaring it ensures the prover cannot drop
    //    it and ties the proof to a specific recipient.
    let _ = recipient_hash * recipient_hash;
}

// ===========================================================================
// Tests
// ===========================================================================

global TD: u32 = 20;

// Root produced by an all-zero Merkle path (leaf is LEFT at every level).
fn root_allzero(leaf: Field) -> Field {
    let mut cur = leaf;
    for _ in 0..TD {
        cur = w::hash2(cur, 0);
    }
    cur
}

#[test]
fn test_withdraw_valid() {
    let sk = 7;
    let ok = w::owner_key(sk);
    let amount = 1000;
    let asset = 0;
    let blinding = 12345;
    let commitment = w::note_commitment(asset, amount, ok, blinding);
    let nf = w::nullifier(commitment, sk);
    let root = root_allzero(commitment);
    let rcpt = w::hash2(99, 0);

    main(
        root, nf, rcpt, amount, asset,
        amount, asset, blinding, sk, [0; 20], [0; 20],
    );
}

#[test(should_fail_with = "bad nullifier")]
fn test_withdraw_wrong_nullifier() {
    let sk = 7;
    let ok = w::owner_key(sk);
    let amount = 1000;
    let asset = 0;
    let blinding = 12345;
    let commitment = w::note_commitment(asset, amount, ok, blinding);
    let root = root_allzero(commitment);
    let rcpt = w::hash2(99, 0);
    let bad_nf = 999999; // not the real nullifier

    main(
        root, bad_nf, rcpt, amount, asset,
        amount, asset, blinding, sk, [0; 20], [0; 20],
    );
}

#[test(should_fail_with = "merkle root mismatch")]
fn test_withdraw_wrong_root() {
    let sk = 7;
    let ok = w::owner_key(sk);
    let amount = 1000;
    let asset = 0;
    let blinding = 12345;
    let commitment = w::note_commitment(asset, amount, ok, blinding);
    let nf = w::nullifier(commitment, sk);
    let rcpt = w::hash2(99, 0);
    let bad_root = 123456; // not the computed root

    main(
        bad_root, nf, rcpt, amount, asset,
        amount, asset, blinding, sk, [0; 20], [0; 20],
    );
}

#[test(should_fail_with = "amount mismatch")]
fn test_withdraw_amount_mismatch() {
    let sk = 7;
    let ok = w::owner_key(sk);
    let note_amount = 1000;
    let asset = 0;
    let blinding = 12345;
    let commitment = w::note_commitment(asset, note_amount, ok, blinding);
    let nf = w::nullifier(commitment, sk);
    let root = root_allzero(commitment);
    let rcpt = w::hash2(99, 0);

    // Public amount (500) does not match note amount (1000).
    main(
        root, nf, rcpt, 500, asset,
        note_amount, asset, blinding, sk, [0; 20], [0; 20],
    );
}
