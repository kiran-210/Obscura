//! Wraith `place_order` circuit (SPEC sec 8.3).
//!
//! Proves ownership of a balance note with enough funds to back a hidden order,
//! locks those funds by revealing the note's nullifier, commits to the order,
//! and creates a change note for any remainder.
//!
//! Public inputs (SHARED sec 7, IN THIS ORDER):
//!   merkle_root, nullifier, order_commitment, change_commitment, locked_asset_id

use dep::wraith_lib as w;

fn main(
    // ---- public inputs (order is load-bearing: SHARED sec 7) ----
    merkle_root: pub Field,
    nullifier: pub Field,
    order_commitment: pub Field,
    change_commitment: pub Field,
    locked_asset_id: pub Field,
    // ---- private inputs ----
    note_amount: Field,
    note_asset_id: Field,
    note_blinding: Field,
    spending_key: Field,
    merkle_path: [Field; 20],
    merkle_indices: [Field; 20],
    order_side: Field,
    order_price: Field,
    order_amount: Field,
    order_asset_base: Field,
    order_asset_quote: Field,
    order_nonce: Field,
    change_amount: Field,
    change_blinding: Field,
) {
    // 1. Note ownership + Merkle membership.
    let owner_key = w::owner_key(spending_key);
    let commitment = w::note_commitment(note_asset_id, note_amount, owner_key, note_blinding);
    assert(w::nullifier(commitment, spending_key) == nullifier, "bad nullifier");
    let root = w::compute_merkle_root(commitment, merkle_path, merkle_indices);
    assert(root == merkle_root, "merkle root mismatch");

    // 2. Order commitment (owner_key is the derived key, not free input).
    let computed_order = w::order_commitment(
        order_side,
        order_price,
        order_amount,
        order_asset_base,
        order_asset_quote,
        owner_key,
        order_nonce,
    );
    assert(computed_order == order_commitment, "order commitment mismatch");

    // Range checks (anti-overflow) before any integer reasoning.
    assert(order_side * (1 - order_side) == 0, "side must be 0 or 1");
    w::assert_64(note_amount);
    w::assert_64(order_amount);
    w::assert_64(order_price);
    w::assert_64(change_amount);

    // 3. Sufficient balance + asset lock, depending on side.
    if order_side == 0 {
        // BUY: lock quote asset to purchase base. required = amount * price / SCALE.
        assert(note_asset_id == order_asset_quote, "buy must lock quote asset");
        let required = w::mul_div_price(order_amount, order_price);
        assert(w::geq64(note_amount, required), "insufficient balance");
        assert(change_amount == note_amount - required, "bad change amount");
        assert(locked_asset_id == order_asset_quote, "locked asset must be quote");
    } else {
        // SELL: lock base asset. required = amount.
        assert(note_asset_id == order_asset_base, "sell must lock base asset");
        assert(w::geq64(note_amount, order_amount), "insufficient balance");
        assert(change_amount == note_amount - order_amount, "bad change amount");
        assert(locked_asset_id == order_asset_base, "locked asset must be base");
    }

    // 4. Change commitment (0 if no change).
    if change_amount != 0 {
        let change_comm =
            w::note_commitment(note_asset_id, change_amount, owner_key, change_blinding);
        assert(change_comm == change_commitment, "change commitment mismatch");
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
fn test_place_buy_valid() {
    let sk = 7;
    let ok = w::owner_key(sk);
    // note: 100 units of quote asset (id 1)
    let note_amount = 100;
    let note_asset = 1;
    let note_bl = 555;
    let commitment = w::note_commitment(note_asset, note_amount, ok, note_bl);
    let nf = w::nullifier(commitment, sk);
    let root = root_allzero(commitment);

    // BUY 10 base @ price 2.0 -> required = 20 quote, change = 80
    let (side, price, amt, base, qa, nonce) = (0, 20000000, 10, 0, 1, 42);
    let order = w::order_commitment(side, price, amt, base, qa, ok, nonce);
    let change_amount = 80;
    let change_bl = 666;
    let change = w::note_commitment(note_asset, change_amount, ok, change_bl);

    main(
        root, nf, order, change, qa,
        note_amount, note_asset, note_bl, sk, [0; 20], [0; 20],
        side, price, amt, base, qa, nonce, change_amount, change_bl,
    );
}

#[test]
fn test_place_sell_valid_no_change() {
    let sk = 7;
    let ok = w::owner_key(sk);
    // note: exactly 10 base asset (id 0); sell all of it -> no change
    let note_amount = 10;
    let note_asset = 0;
    let note_bl = 555;
    let commitment = w::note_commitment(note_asset, note_amount, ok, note_bl);
    let nf = w::nullifier(commitment, sk);
    let root = root_allzero(commitment);

    let (side, price, amt, base, qa, nonce) = (1, 30000000, 10, 0, 1, 7);
    let order = w::order_commitment(side, price, amt, base, qa, ok, nonce);
    // change_amount 0 -> change_commitment must be 0
    main(
        root, nf, order, 0, base,
        note_amount, note_asset, note_bl, sk, [0; 20], [0; 20],
        side, price, amt, base, qa, nonce, 0, 999,
    );
}

#[test(should_fail_with = "insufficient balance")]
fn test_place_buy_insufficient() {
    let sk = 7;
    let ok = w::owner_key(sk);
    let note_amount = 10; // only 10 quote, need 20
    let note_asset = 1;
    let note_bl = 555;
    let commitment = w::note_commitment(note_asset, note_amount, ok, note_bl);
    let nf = w::nullifier(commitment, sk);
    let root = root_allzero(commitment);
    let (side, price, amt, base, qa, nonce) = (0, 20000000, 10, 0, 1, 42);
    let order = w::order_commitment(side, price, amt, base, qa, ok, nonce);
    // change would be 10 - 20 (underflow); also insufficient
    main(
        root, nf, order, 0, qa,
        note_amount, note_asset, note_bl, sk, [0; 20], [0; 20],
        side, price, amt, base, qa, nonce, 0, 0,
    );
}

#[test(should_fail_with = "buy must lock quote asset")]
fn test_place_buy_wrong_locked_asset() {
    let sk = 7;
    let ok = w::owner_key(sk);
    let note_amount = 100;
    let note_asset = 0; // wrong: holding base, but buy must lock quote
    let note_bl = 555;
    let commitment = w::note_commitment(note_asset, note_amount, ok, note_bl);
    let nf = w::nullifier(commitment, sk);
    let root = root_allzero(commitment);
    let (side, price, amt, base, qa, nonce) = (0, 20000000, 10, 0, 1, 42);
    let order = w::order_commitment(side, price, amt, base, qa, ok, nonce);
    main(
        root, nf, order, 0, qa,
        note_amount, note_asset, note_bl, sk, [0; 20], [0; 20],
        side, price, amt, base, qa, nonce, 0, 0,
    );
}

#[test(should_fail_with = "order commitment mismatch")]
fn test_place_wrong_order_commitment() {
    let sk = 7;
    let ok = w::owner_key(sk);
    let note_amount = 100;
    let note_asset = 1;
    let note_bl = 555;
    let commitment = w::note_commitment(note_asset, note_amount, ok, note_bl);
    let nf = w::nullifier(commitment, sk);
    let root = root_allzero(commitment);
    let (side, price, amt, base, qa, nonce) = (0, 20000000, 10, 0, 1, 42);
    let wrong_order = 123456;
    let change = w::note_commitment(note_asset, 80, ok, 666);
    main(
        root, nf, wrong_order, change, qa,
        note_amount, note_asset, note_bl, sk, [0; 20], [0; 20],
        side, price, amt, base, qa, nonce, 80, 666,
    );
}
