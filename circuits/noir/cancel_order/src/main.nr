//! Wraith `cancel_order` circuit (SPEC sec 8.5).
//!
//! Proves ownership of an open order (via spending key -> owner key) and that
//! the refund balance note returning the locked funds is correctly formed.
//!
//! Refund amount / asset:
//!   * BUY  (side 0): refund = floor(amount * price / PRICE_SCALE) of QUOTE asset
//!   * SELL (side 1): refund = amount of BASE asset
//!
//! Public inputs (SHARED sec 7, IN THIS ORDER):
//!   order_commitment, refund_commitment, refund_asset_id

use dep::wraith_lib as w;

fn main(
    // ---- public inputs (order is load-bearing: SHARED sec 7) ----
    order_commitment: pub Field,
    refund_commitment: pub Field,
    refund_asset_id: pub Field,
    // ---- private inputs ----
    side: Field,
    price: Field,
    amount: Field,
    asset_base: Field,
    asset_quote: Field,
    nonce: Field,
    spending_key: Field,
    refund_blinding: Field,
) {
    // 1. Verify order commitment (owner_key derived from spending_key).
    let owner_key = w::owner_key(spending_key);
    let computed =
        w::order_commitment(side, price, amount, asset_base, asset_quote, owner_key, nonce);
    assert(computed == order_commitment, "order commitment mismatch");

    // Range checks before integer reasoning.
    assert(side * (1 - side) == 0, "side must be 0 or 1");
    w::assert_64(amount);
    w::assert_64(price);

    // 2. Compute refund amount + asset by side.
    let refund_amount = if side == 0 {
        w::mul_div_price(amount, price) // buy: locked quote
    } else {
        amount // sell: locked base
    };
    let refund_asset = if side == 0 { asset_quote } else { asset_base };

    // 3. Refund note must match, and the public asset id must match.
    let refund = w::note_commitment(refund_asset, refund_amount, owner_key, refund_blinding);
    assert(refund == refund_commitment, "refund commitment mismatch");
    assert(refund_asset == refund_asset_id, "refund asset mismatch");
}

// ===========================================================================
// Tests
// ===========================================================================

#[test]
fn test_cancel_buy_valid() {
    // BUY 10 base @ 2.0 -> refund 20 quote (asset 1)
    let sk = 7;
    let ok = w::owner_key(sk);
    let order = w::order_commitment(0, 20000000, 10, 0, 1, ok, 42);
    let refund = w::note_commitment(1, 20, ok, 901);
    main(order, refund, 1, 0, 20000000, 10, 0, 1, 42, sk, 901);
}

#[test]
fn test_cancel_sell_valid() {
    // SELL 10 base -> refund 10 base (asset 0)
    let sk = 9;
    let ok = w::owner_key(sk);
    let order = w::order_commitment(1, 30000000, 10, 0, 1, ok, 77);
    let refund = w::note_commitment(0, 10, ok, 902);
    main(order, refund, 0, 1, 30000000, 10, 0, 1, 77, sk, 902);
}

#[test(should_fail_with = "order commitment mismatch")]
fn test_cancel_wrong_owner_fails() {
    // Prover uses the wrong spending key -> derived owner key won't match.
    let sk = 7;
    let ok = w::owner_key(sk);
    let order = w::order_commitment(0, 20000000, 10, 0, 1, ok, 42);
    let refund = w::note_commitment(1, 20, ok, 901);
    let wrong_sk = 8;
    main(order, refund, 1, 0, 20000000, 10, 0, 1, 42, wrong_sk, 901);
}

#[test(should_fail_with = "refund commitment mismatch")]
fn test_cancel_wrong_refund_amount_fails() {
    let sk = 7;
    let ok = w::owner_key(sk);
    let order = w::order_commitment(0, 20000000, 10, 0, 1, ok, 42);
    // Refund claims 30 quote but correct is 20.
    let bad_refund = w::note_commitment(1, 30, ok, 901);
    main(order, bad_refund, 1, 0, 20000000, 10, 0, 1, 42, sk, 901);
}

#[test(should_fail_with = "refund asset mismatch")]
fn test_cancel_wrong_refund_asset_fails() {
    let sk = 7;
    let ok = w::owner_key(sk);
    let order = w::order_commitment(0, 20000000, 10, 0, 1, ok, 42);
    let refund = w::note_commitment(1, 20, ok, 901);
    // Public refund_asset_id says 0 (base) but a buy refunds quote (1).
    main(order, refund, 0, 0, 20000000, 10, 0, 1, 42, sk, 901);
}
