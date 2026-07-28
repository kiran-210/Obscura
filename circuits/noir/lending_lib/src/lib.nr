//! Obscura lending circuit library.
//!
//! Shared invariants for the private lending layer. See LENDING_SPEC.md.
//! Cryptographic primitives (Poseidon2, Merkle, nullifiers) come from
//! `obscura_lib` unchanged -- nothing here redefines them.
//!
//! Privacy model (LENDING_SPEC sec 1): collateral amounts are PUBLIC so that a
//! stale position can be seized by anyone with no keeper and no trusted party;
//! debt is PRIVATE and never stored on-chain. Hiding both is not achievable
//! together with executable liquidation.

use dep::obscura_lib as w;

// ---------------------------------------------------------------------------
// Domain separation (LENDING_SPEC sec 3)
// ---------------------------------------------------------------------------
//
// Order commitments are ALSO hash7. Without a distinct leading domain tag a
// crafted order could be replayed as a position (or vice versa), so slot 0 of
// every lending commitment carries one of these tags. They must match the SDK
// and the Soroban contract exactly.

pub global POSITION_DOMAIN: Field = 7001;
pub global SUPPLY_DOMAIN: Field = 7002;

// ---------------------------------------------------------------------------
// Scales (LENDING_SPEC sec 4/6)
// ---------------------------------------------------------------------------

/// Interest index precision. `debt_now = debt_scaled * index / INDEX_SCALE`.
pub global INDEX_SCALE: u128 = 1000000000; // 1e9
/// Basis points denominator for LTV / liquidation thresholds.
pub global BPS_SCALE: u128 = 10000; // 1e4
/// Price fixed-point scale -- same as the pool's (SHARED sec 4).
pub global PRICE_SCALE_U: u128 = 10000000; // 1e7

// ---------------------------------------------------------------------------
// Commitments (LENDING_SPEC sec 3)
// ---------------------------------------------------------------------------

/// Position note. Field order is fixed everywhere:
/// (DOMAIN, collateral_asset, collateral_amount, debt_asset, debt_scaled, owner_key, nonce)
///
/// `collateral_amount` is also published on-chain; it is committed here so the
/// contract's public copy is cryptographically bound to the position.
pub fn position_commitment(
    collateral_asset: Field,
    collateral_amount: Field,
    debt_asset: Field,
    debt_scaled: Field,
    owner_key: Field,
    nonce: Field,
) -> Field {
    w::hash7(
        POSITION_DOMAIN,
        collateral_asset,
        collateral_amount,
        debt_asset,
        debt_scaled,
        owner_key,
        nonce,
    )
}

/// Supply note. Suppliers are never liquidated, so the amount stays private.
/// (DOMAIN, asset, supply_scaled, owner_key, nonce, 0, 0)
pub fn supply_commitment(
    asset: Field,
    supply_scaled: Field,
    owner_key: Field,
    nonce: Field,
) -> Field {
    w::hash7(SUPPLY_DOMAIN, asset, supply_scaled, owner_key, nonce, 0, 0)
}

// ---------------------------------------------------------------------------
// Bounded arithmetic
// ---------------------------------------------------------------------------

/// Floor of `a * b / scale`, with range checks on both inputs AND the result.
///
/// A `Field as u128` cast in Noir TRUNCATES and does NOT range-check, so an
/// unchecked input would wrap and could forge solvency. Both operands are
/// constrained to < 2^64 (product < 2^128, fits u128) and the quotient is
/// constrained to < 2^64 so it stays sound when fed into a later `mul_div`.
pub fn mul_div(a: Field, b: Field, scale: u128) -> Field {
    w::assert_64(a);
    w::assert_64(b);
    let prod: u128 = (a as u128) * (b as u128);
    let out = (prod / scale) as Field;
    w::assert_64(out);
    out
}

/// Current debt from a scaled balance: `debt_scaled * borrow_index / INDEX_SCALE`.
pub fn debt_now(debt_scaled: Field, borrow_index: Field) -> Field {
    mul_div(debt_scaled, borrow_index, INDEX_SCALE)
}

/// Scaled debt from a nominal amount: `amount * INDEX_SCALE / borrow_index`.
/// `borrow_index` must be non-zero (enforced by the caller / contract).
pub fn to_scaled(amount: Field, index: Field) -> Field {
    w::assert_64(amount);
    w::assert_64(index);
    assert(index != 0, "index must be non-zero");
    let num: u128 = (amount as u128) * INDEX_SCALE;
    let out = (num / (index as u128)) as Field;
    w::assert_64(out);
    out
}

/// Value of `amount` units of an asset at `price`, in PRICE_SCALE units.
pub fn value_of(amount: Field, price: Field) -> Field {
    mul_div(amount, price, PRICE_SCALE_U)
}

// ---------------------------------------------------------------------------
// Solvency (LENDING_SPEC sec 5)
// ---------------------------------------------------------------------------

/// The core inequality, shared by borrow / withdraw_collateral / attestation:
///
///   collateral_value * bps / BPS_SCALE  >=  debt_value
///
/// Callers pass `max_ltv_bps` when opening risk (borrow, withdraw collateral)
/// and `liq_threshold_bps` when merely attesting continued health.
pub fn assert_solvent(
    collateral_amount: Field,
    collateral_price: Field,
    debt_scaled: Field,
    debt_price: Field,
    borrow_index: Field,
    bps: Field,
) {
    let collateral_value = value_of(collateral_amount, collateral_price);
    let allowed = mul_div(collateral_value, bps, BPS_SCALE);

    let d_now = debt_now(debt_scaled, borrow_index);
    let debt_value = value_of(d_now, debt_price);

    assert(w::geq64(allowed, debt_value), "position is not solvent");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[test]
fn test_domains_differ_from_order_shape() {
    // A position and an order with otherwise-identical operands must not collide.
    let ok = w::owner_key(1);
    let pos = position_commitment(0, 100, 1, 0, ok, 9);
    let ord = w::order_commitment(0, 100, 1, 0, 1, ok, 9);
    assert(pos != ord);
}

#[test]
fn test_scaled_debt_roundtrip() {
    // At index == INDEX_SCALE (1.0) scaling is the identity.
    let one = 1000000000;
    assert(to_scaled(500, one) == 500);
    assert(debt_now(500, one) == 500);
    // At index 2.0 the same scaled balance is worth twice as much.
    assert(debt_now(500, 2000000000) == 1000);
}

#[test]
fn test_solvent_at_exactly_the_limit() {
    // 1000 collateral @ 1.0, 75% LTV -> 750 allowed. Debt of exactly 750 passes.
    let one_price = 10000000;
    let one_index = 1000000000;
    assert_solvent(1000, one_price, 750, one_price, one_index, 7500);
}

#[test(should_fail_with = "position is not solvent")]
fn test_insolvent_one_over_the_limit() {
    let one_price = 10000000;
    let one_index = 1000000000;
    assert_solvent(1000, one_price, 751, one_price, one_index, 7500);
}

#[test(should_fail_with = "position is not solvent")]
fn test_interest_accrual_can_push_into_insolvency() {
    // Same scaled debt, but the index has doubled: 750 -> 1500 > 750 allowed.
    let one_price = 10000000;
    assert_solvent(1000, one_price, 750, one_price, 2000000000, 7500);
}

#[test]
fn test_price_drop_reduces_borrowing_power() {
    // Collateral halves in price: 1000 @ 0.5 = 500 value, 75% -> 375 allowed.
    let half = 5000000;
    let one_price = 10000000;
    let one_index = 1000000000;
    assert_solvent(1000, half, 375, one_price, one_index, 7500);
}
