//! Obscura `match_orders` circuit (SPEC sec 8.4).
//!
//! Proves two hidden orders are compatible and that the settlement notes,
//! residual orders, and refund notes are correctly formed.
//!
//! Trading model:
//!   * opposite sides, same (base, quote) pair, buy_price >= sell_price
//!   * execution price = floor((buy_price + sell_price) / 2)   (midpoint)
//!   * fill_amount     = min(buy_amount, sell_amount)
//!   * quote_filled    = floor(fill_amount * exec_price / PRICE_SCALE)
//!   * buyer receives `fill_amount` of the BASE asset
//!   * seller receives `quote_filled` of the QUOTE asset
//!
//! Residual / refund policy (mapped to order A and order B, NOT buyer/seller):
//!   * If an order's amount > fill_amount it is PARTIALLY filled: a residual
//!     order (same side, same price, remaining amount) is created and NO refund
//!     is issued for that order (its funds stay locked in the residual).
//!   * If an order is FULLY filled (amount == fill_amount):
//!       - a BUY order gets a quote-asset refund of its price improvement,
//!         floor(amount*buy_price/SCALE) - quote_filled, when positive;
//!       - a SELL order gets no refund (its locked base is fully delivered).
//!
//! KNOWN SIMPLIFICATION (MVP, documented in circuits/README.md): a partially
//! filled order receives no price-improvement refund on its filled portion;
//! that overpayment remains locked. See README "Assumptions".
//!
//! Public inputs (SHARED sec 7, IN THIS ORDER):
//!   order_commitment_a, order_commitment_b, fill_note_buyer, fill_note_seller,
//!   residual_order_a, residual_order_b, refund_note_a, refund_note_b

use dep::obscura_lib as w;

// Compute the (residual_commitment, refund_commitment) expected for ONE order.
// `amount` and `price` must be range-checked to < 2^64 by the caller.
fn settle_order(
    side: Field,
    price: Field,
    amount: Field,
    asset_base: Field,
    asset_quote: Field,
    owner_key: Field,
    fill: Field,
    quote_filled: Field,
    residual_nonce: Field,
    refund_blinding: Field,
) -> (Field, Field) {
    // fill = min(buy_amount, sell_amount) <= amount, so this is a non-negative
    // 64-bit integer.
    let residual_amount = amount - fill;
    w::assert_64(residual_amount);

    let mut residual = 0;
    let mut refund = 0;

    if residual_amount != 0 {
        // Partially filled: re-commit the remaining order (same side & price).
        residual = w::order_commitment(
            side,
            price,
            residual_amount,
            asset_base,
            asset_quote,
            owner_key,
            residual_nonce,
        );
        // No refund on the partially filled side (MVP).
    } else {
        // Fully filled.
        if side == 0 {
            // BUY: refund quote-asset price improvement (exec_price <= buy_price).
            let locked = w::mul_div_price(amount, price);
            let refund_amount = locked - quote_filled; // >= 0
            if refund_amount != 0 {
                refund =
                    w::note_commitment(asset_quote, refund_amount, owner_key, refund_blinding);
            }
        }
        // SELL fully filled: locked base fully delivered, no refund.
    }

    (residual, refund)
}

fn main(
    // ---- public inputs (order is load-bearing: SHARED sec 7) ----
    order_commitment_a: pub Field,
    order_commitment_b: pub Field,
    fill_note_buyer: pub Field,
    fill_note_seller: pub Field,
    residual_order_a: pub Field,
    residual_order_b: pub Field,
    refund_note_a: pub Field,
    refund_note_b: pub Field,
    // ---- private inputs: order A ----
    a_side: Field,
    a_price: Field,
    a_amount: Field,
    a_asset_base: Field,
    a_asset_quote: Field,
    a_owner_key: Field,
    a_nonce: Field,
    // ---- private inputs: order B ----
    b_side: Field,
    b_price: Field,
    b_amount: Field,
    b_asset_base: Field,
    b_asset_quote: Field,
    b_owner_key: Field,
    b_nonce: Field,
    // ---- private inputs: blindings / nonces for new notes ----
    buyer_fill_blinding: Field,
    seller_fill_blinding: Field,
    residual_a_nonce: Field,
    residual_b_nonce: Field,
    refund_a_blinding: Field,
    refund_b_blinding: Field,
) {
    // 1. Both order commitments must reproduce the public values.
    let ca = w::order_commitment(
        a_side, a_price, a_amount, a_asset_base, a_asset_quote, a_owner_key, a_nonce,
    );
    assert(ca == order_commitment_a, "order A commitment mismatch");
    let cb = w::order_commitment(
        b_side, b_price, b_amount, b_asset_base, b_asset_quote, b_owner_key, b_nonce,
    );
    assert(cb == order_commitment_b, "order B commitment mismatch");

    // 2. Sides must be boolean and opposite.
    assert(a_side * (1 - a_side) == 0, "A side must be 0 or 1");
    assert(b_side * (1 - b_side) == 0, "B side must be 0 or 1");
    assert(a_side != b_side, "orders must be opposite sides");

    // 3. Same trading pair.
    assert(a_asset_base == b_asset_base, "base asset mismatch");
    assert(a_asset_quote == b_asset_quote, "quote asset mismatch");

    // Range checks before integer reasoning.
    w::assert_64(a_price);
    w::assert_64(b_price);
    w::assert_64(a_amount);
    w::assert_64(b_amount);

    // 4. Identify buyer and seller.
    let a_is_buy = a_side == 0;
    let buy_price = if a_is_buy { a_price } else { b_price };
    let sell_price = if a_is_buy { b_price } else { a_price };
    let buy_amount = if a_is_buy { a_amount } else { b_amount };
    let sell_amount = if a_is_buy { b_amount } else { a_amount };
    let buyer_key = if a_is_buy { a_owner_key } else { b_owner_key };
    let seller_key = if a_is_buy { b_owner_key } else { a_owner_key };

    // 5. Price compatibility.
    assert(w::geq64(buy_price, sell_price), "prices incompatible");

    // 6. Execution price = floor midpoint.
    let exec_price = w::midpoint(buy_price, sell_price);

    // 7. Fill amount + quote filled.
    let fill = w::min64(buy_amount, sell_amount);
    let quote_filled = w::mul_div_price(fill, exec_price);
    w::assert_64(fill);
    w::assert_64(quote_filled);

    // 8. Settlement notes (pair-wide assets; both orders agree on base/quote).
    let asset_base = a_asset_base;
    let asset_quote = a_asset_quote;
    let buyer_note = w::note_commitment(asset_base, fill, buyer_key, buyer_fill_blinding);
    assert(buyer_note == fill_note_buyer, "buyer fill note mismatch");
    let seller_note = w::note_commitment(asset_quote, quote_filled, seller_key, seller_fill_blinding);
    assert(seller_note == fill_note_seller, "seller fill note mismatch");

    // 9. Residual orders + refunds, computed per order and mapped to A / B.
    let (res_a, ref_a) = settle_order(
        a_side, a_price, a_amount, asset_base, asset_quote, a_owner_key, fill, quote_filled,
        residual_a_nonce, refund_a_blinding,
    );
    assert(res_a == residual_order_a, "residual A mismatch");
    assert(ref_a == refund_note_a, "refund A mismatch");

    let (res_b, ref_b) = settle_order(
        b_side, b_price, b_amount, asset_base, asset_quote, b_owner_key, fill, quote_filled,
        residual_b_nonce, refund_b_blinding,
    );
    assert(res_b == residual_order_b, "residual B mismatch");
    assert(ref_b == refund_note_b, "refund B mismatch");
}

// ===========================================================================
// Tests
// ===========================================================================

#[test]
fn test_match_full_fill_with_buyer_refund() {
    // A: BUY 10 base @ 2.0 ; B: SELL 10 base @ 1.0 -> exec 1.5, fill 10, quote 15
    let ok_a = w::owner_key(7);
    let ok_b = w::owner_key(9);
    let oca = w::order_commitment(0, 20000000, 10, 0, 1, ok_a, 42);
    let ocb = w::order_commitment(1, 10000000, 10, 0, 1, ok_b, 43);

    let fnb = w::note_commitment(0, 10, ok_a, 701); // buyer gets 10 base
    let fns = w::note_commitment(1, 15, ok_b, 702); // seller gets 15 quote
    let rna = w::note_commitment(1, 5, ok_a, 703); // buyer refund 5 quote (20 - 15)

    main(
        oca, ocb, fnb, fns, 0, 0, rna, 0,
        0, 20000000, 10, 0, 1, ok_a, 42,
        1, 10000000, 10, 0, 1, ok_b, 43,
        701, 702, 801, 802, 703, 804,
    );
}

#[test]
fn test_match_partial_fill_residual() {
    // A: BUY 10 base @ 2.0 ; B: SELL 4 base @ 1.0 -> exec 1.5, fill 4, quote 6
    let ok_a = w::owner_key(7);
    let ok_b = w::owner_key(9);
    let oca = w::order_commitment(0, 20000000, 10, 0, 1, ok_a, 42);
    let ocb = w::order_commitment(1, 10000000, 4, 0, 1, ok_b, 43);

    let fnb = w::note_commitment(0, 4, ok_a, 701); // buyer gets 4 base
    let fns = w::note_commitment(1, 6, ok_b, 702); // seller gets 6 quote
    // A is partially filled: residual buy order for 6 base @ 2.0, no refund
    let res_a = w::order_commitment(0, 20000000, 6, 0, 1, ok_a, 801);

    main(
        oca, ocb, fnb, fns, res_a, 0, 0, 0,
        0, 20000000, 10, 0, 1, ok_a, 42,
        1, 10000000, 4, 0, 1, ok_b, 43,
        701, 702, 801, 802, 703, 804,
    );
}

#[test(should_fail_with = "orders must be opposite sides")]
fn test_match_same_side_fails() {
    let ok_a = w::owner_key(7);
    let ok_b = w::owner_key(9);
    // both BUY
    let oca = w::order_commitment(0, 20000000, 10, 0, 1, ok_a, 42);
    let ocb = w::order_commitment(0, 10000000, 10, 0, 1, ok_b, 43);
    let fnb = w::note_commitment(0, 10, ok_a, 701);
    let fns = w::note_commitment(1, 15, ok_a, 702);
    main(
        oca, ocb, fnb, fns, 0, 0, 0, 0,
        0, 20000000, 10, 0, 1, ok_a, 42,
        0, 10000000, 10, 0, 1, ok_b, 43,
        701, 702, 801, 802, 703, 804,
    );
}

#[test(should_fail_with = "prices incompatible")]
fn test_match_price_incompatible_fails() {
    // A: BUY @ 1.0 ; B: SELL @ 2.0 -> buy_price < sell_price
    let ok_a = w::owner_key(7);
    let ok_b = w::owner_key(9);
    let oca = w::order_commitment(0, 10000000, 10, 0, 1, ok_a, 42);
    let ocb = w::order_commitment(1, 20000000, 10, 0, 1, ok_b, 43);
    let fnb = w::note_commitment(0, 10, ok_a, 701);
    let fns = w::note_commitment(1, 15, ok_b, 702);
    main(
        oca, ocb, fnb, fns, 0, 0, 0, 0,
        0, 10000000, 10, 0, 1, ok_a, 42,
        1, 20000000, 10, 0, 1, ok_b, 43,
        701, 702, 801, 802, 703, 804,
    );
}

#[test(should_fail_with = "buyer fill note mismatch")]
fn test_match_wrong_buyer_note_fails() {
    let ok_a = w::owner_key(7);
    let ok_b = w::owner_key(9);
    let oca = w::order_commitment(0, 20000000, 10, 0, 1, ok_a, 42);
    let ocb = w::order_commitment(1, 10000000, 10, 0, 1, ok_b, 43);
    let bad_fnb = 123456; // wrong buyer settlement note
    let fns = w::note_commitment(1, 15, ok_b, 702);
    let rna = w::note_commitment(1, 5, ok_a, 703);
    main(
        oca, ocb, bad_fnb, fns, 0, 0, rna, 0,
        0, 20000000, 10, 0, 1, ok_a, 42,
        1, 10000000, 10, 0, 1, ok_b, 43,
        701, 702, 801, 802, 703, 804,
    );
}
