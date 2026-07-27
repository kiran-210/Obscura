//! Wraith `transfer` circuit (SPEC sec 8.2).
//!
//! Proves a private payment: consumes up to two input notes and creates two
//! output notes (recipient + change), conserving value, all of the same asset.
//! A second input note with amount 0 is a "phantom"/dummy (its Merkle proof is
//! skipped).
//!
//! Public inputs (SHARED sec 7, IN THIS ORDER):
//!   merkle_root, nullifier_0, nullifier_1,
//!   out_commitment_0, out_commitment_1, ext_data_hash

use dep::wraith_lib as w;

fn main(
    // ---- public inputs (order is load-bearing: SHARED sec 7) ----
    merkle_root: pub Field,
    nullifier_0: pub Field,
    nullifier_1: pub Field,
    out_commitment_0: pub Field,
    out_commitment_1: pub Field,
    ext_data_hash: pub Field,
    // ---- private inputs ----
    in_amount: [Field; 2],
    in_asset_id: [Field; 2],
    in_spending_key: [Field; 2],
    in_blinding: [Field; 2],
    in_merkle_path: [[Field; 20]; 2],
    in_merkle_indices: [[Field; 20]; 2],
    out_amount: [Field; 2],
    out_owner_key: [Field; 2],
    out_blinding: [Field; 2],
    out_asset_id: [Field; 2],
) {
    let public_nullifiers = [nullifier_0, nullifier_1];
    let public_out_commitments = [out_commitment_0, out_commitment_1];

    let mut sum_in: Field = 0;
    let mut sum_out: Field = 0;

    // 1. Verify each input note.
    for i in 0..2 {
        w::assert_64(in_amount[i]);
        let owner_key = w::owner_key(in_spending_key[i]);
        let commitment =
            w::note_commitment(in_asset_id[i], in_amount[i], owner_key, in_blinding[i]);
        let nf = w::nullifier(commitment, in_spending_key[i]);

        // Nullifier must match the published value.
        assert(nf == public_nullifiers[i], "input nullifier mismatch");

        // Merkle membership + same-asset constraint, skipped for dummy (amount 0).
        if in_amount[i] != 0 {
            let root = w::compute_merkle_root(commitment, in_merkle_path[i], in_merkle_indices[i]);
            assert(root == merkle_root, "input merkle root mismatch");
            assert(in_asset_id[i] == in_asset_id[0], "input asset mismatch");
        }

        sum_in += in_amount[i];
    }

    // 2. Verify each output note.
    for j in 0..2 {
        w::assert_64(out_amount[j]);
        let commitment =
            w::note_commitment(out_asset_id[j], out_amount[j], out_owner_key[j], out_blinding[j]);
        assert(commitment == public_out_commitments[j], "output commitment mismatch");

        // Outputs must be the same asset as the inputs.
        if out_amount[j] != 0 {
            assert(out_asset_id[j] == in_asset_id[0], "output asset mismatch");
        }

        sum_out += out_amount[j];
    }

    // 3. Value conservation.
    assert(sum_in == sum_out, "value not conserved");

    // 4. No duplicate nullifiers (double-spend within the same tx).
    assert(nullifier_0 != nullifier_1, "duplicate nullifier");

    // 5. Bind external data (recipient/fee/replay protection) into the proof.
    let _ = ext_data_hash * ext_data_hash;
}

// ===========================================================================
// Tests
// ===========================================================================

global TD: u32 = 20;
global Z: [Field; 20] = [0; 20];

fn root_allzero(leaf: Field) -> Field {
    let mut cur = leaf;
    for _ in 0..TD {
        cur = w::hash2(cur, 0);
    }
    cur
}

// Build a standard valid 1-real + 1-dummy witness, returning all fields needed
// to call `main`.
fn valid_witness() -> (Field, Field, Field, Field, Field, Field, // publics
    [Field; 2], [Field; 2], [Field; 2], [Field; 2], [[Field; 20]; 2], [[Field; 20]; 2], [Field; 2], [Field; 2], [Field; 2], [Field; 2]) {
    let sk0 = 7;
    let ok0 = w::owner_key(sk0);
    let c0 = w::note_commitment(0, 1000, ok0, 111);
    let nf0 = w::nullifier(c0, sk0);
    let root = root_allzero(c0);

    // dummy second input (amount 0)
    let sk1 = 8;
    let ok1 = w::owner_key(sk1);
    let c1 = w::note_commitment(0, 0, ok1, 222);
    let nf1 = w::nullifier(c1, sk1);

    // outputs: 700 to recipient (owner key from sk=13), 300 change to sender
    let ok_rcpt = w::owner_key(13);
    let outc0 = w::note_commitment(0, 700, ok_rcpt, 333);
    let outc1 = w::note_commitment(0, 300, ok0, 444);
    let ext = 987654321;

    let in_amount = [1000, 0];
    let in_asset = [0, 0];
    let in_sk = [sk0, sk1];
    let in_bl = [111, 222];
    let in_path = [Z, Z];
    let in_idx = [Z, Z];
    let out_amount = [700, 300];
    let out_ok = [ok_rcpt, ok0];
    let out_bl = [333, 444];
    let out_asset = [0, 0];

    (
        root, nf0, nf1, outc0, outc1, ext,
        in_amount, in_asset, in_sk, in_bl, in_path, in_idx,
        out_amount, out_ok, out_bl, out_asset,
    )
}

#[test]
fn test_transfer_valid() {
    let (root, nf0, nf1, outc0, outc1, ext, ia, ias, isk, ibl, ip, ii, oa, ook, obl, oas) =
        valid_witness();
    main(root, nf0, nf1, outc0, outc1, ext, ia, ias, isk, ibl, ip, ii, oa, ook, obl, oas);
}

#[test]
fn test_transfer_two_real_inputs() {
    // Two real notes in a 2-leaf tree (index 0 and 1 under a common root).
    let sk0 = 7;
    let ok0 = w::owner_key(sk0);
    let c0 = w::note_commitment(0, 600, ok0, 11);
    let sk1 = 9;
    let ok1 = w::owner_key(sk1);
    let c1 = w::note_commitment(0, 400, ok1, 22);

    // zeros for empty subtrees
    let mut zeros = [0; 20];
    for i in 1..20 {
        zeros[i] = w::hash2(zeros[i - 1], zeros[i - 1]);
    }
    // level-0 parent = hash2(c0, c1); both notes share the rest of the path.
    let mut path0 = [0; 20];
    let mut idx0 = [0; 20];
    path0[0] = c1; // sibling of c0 is c1
    idx0[0] = 0; // c0 is LEFT
    let mut path1 = [0; 20];
    let mut idx1 = [0; 20];
    path1[0] = c0; // sibling of c1 is c0
    idx1[0] = 1; // c1 is RIGHT
    for i in 1..20 {
        path0[i] = zeros[i];
        path1[i] = zeros[i];
    }
    let root = w::compute_merkle_root(c0, path0, idx0);

    let nf0 = w::nullifier(c0, sk0);
    let nf1 = w::nullifier(c1, sk1);
    let ok_rcpt = w::owner_key(13);
    let outc0 = w::note_commitment(0, 1000, ok_rcpt, 33); // all to recipient
    let outc1 = w::note_commitment(0, 0, ok0, 44); // zero change
    let ext = 7;

    main(
        root, nf0, nf1, outc0, outc1, ext,
        [600, 400], [0, 0], [sk0, sk1], [11, 22], [path0, path1], [idx0, idx1],
        [1000, 0], [ok_rcpt, ok0], [33, 44], [0, 0],
    );
}

#[test(should_fail_with = "value not conserved")]
fn test_transfer_value_mismatch() {
    let (root, nf0, nf1, _outc0, _outc1, ext, ia, ias, isk, ibl, ip, ii, _oa, ook, _obl, oas) =
        valid_witness();
    // Outputs sum to 900 != inputs 1000.
    let ok_rcpt = w::owner_key(13);
    let ok0 = w::owner_key(7);
    let bad_outc0 = w::note_commitment(0, 600, ok_rcpt, 333);
    let bad_outc1 = w::note_commitment(0, 300, ok0, 444);
    main(
        root, nf0, nf1, bad_outc0, bad_outc1, ext, ia, ias, isk, ibl, ip, ii,
        [600, 300], ook, [333, 444], oas,
    );
}

#[test(should_fail_with = "duplicate nullifier")]
fn test_transfer_duplicate_nullifier() {
    // Force nullifier_0 == nullifier_1 by using identical input notes.
    let sk = 7;
    let ok = w::owner_key(sk);
    let c = w::note_commitment(0, 500, ok, 11);
    let nf = w::nullifier(c, sk);
    let root = root_allzero(c);
    let ok_rcpt = w::owner_key(13);
    let outc0 = w::note_commitment(0, 1000, ok_rcpt, 33);
    let outc1 = w::note_commitment(0, 0, ok, 44);

    main(
        root, nf, nf, outc0, outc1, 7,
        [500, 500], [0, 0], [sk, sk], [11, 11], [Z, Z], [Z, Z],
        [1000, 0], [ok_rcpt, ok], [33, 44], [0, 0],
    );
}

#[test(should_fail_with = "output commitment mismatch")]
fn test_transfer_bad_output_commitment() {
    let (root, nf0, nf1, _outc0, outc1, ext, ia, ias, isk, ibl, ip, ii, oa, ook, obl, oas) =
        valid_witness();
    let wrong_outc0 = 424242; // not the real commitment
    main(root, nf0, nf1, wrong_outc0, outc1, ext, ia, ias, isk, ibl, ip, ii, oa, ook, obl, oas);
}
