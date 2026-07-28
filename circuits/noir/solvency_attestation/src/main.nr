//! Obscura `solvency_attestation` circuit (LENDING_SPEC sec 2).
//!
//! The periodic "still healthy" proof. Proves the caller knows the opening of a
//! registered position commitment AND that it satisfies the liquidation
//! threshold at a fresh oracle price -- without revealing the debt.
//!
//! Two deliberate design choices, both cheaper than the original spec:
//!
//!   * NO Merkle proof. The contract already holds `position_commitment` in its
//!     registry, so membership is established by the registry lookup rather than
//!     re-proven in-circuit. This is the cheapest circuit in the set (~1k gates).
//!   * NO nullify-and-recommit. `health_deadline` is contract state, not a note
//!     field, so a successful attestation mutates no notes at all -- it burns no
//!     nullifier, consumes no tree leaf, and creates no C1 -> C2 -> C3 linkage
//!     chain across periods.
//!
//! Checked at `liq_threshold_bps` (80%), NOT `max_ltv_bps` (75%): a position that
//! has drifted past the borrow ceiling but is still above the liquidation
//! threshold is not yet liquidatable and must remain able to attest.
//!
//! Public inputs (IN THIS ORDER):
//!   position_commitment, collateral_asset, collateral_amount, debt_asset,
//!   collateral_price, debt_price, borrow_index, liq_threshold_bps

use dep::lending_lib as l;
use dep::obscura_lib as w;

fn main(
    // ---- public inputs ----
    position_commitment: pub Field,
    collateral_asset: pub Field,
    collateral_amount: pub Field,
    debt_asset: pub Field,
    collateral_price: pub Field,
    debt_price: pub Field,
    borrow_index: pub Field,
    liq_threshold_bps: pub Field,
    // ---- private inputs ----
    debt_scaled: Field,
    spending_key: Field,
    nonce: Field,
) {
    // 1. Prove knowledge of the opening. Binding `owner_key` to the spending key
    //    means only the position owner can attest -- a third party cannot refresh
    //    someone else's deadline (nor could they, without knowing debt_scaled).
    let owner_key = w::owner_key(spending_key);
    let computed = l::position_commitment(
        collateral_asset,
        collateral_amount,
        debt_asset,
        debt_scaled,
        owner_key,
        nonce,
    );
    assert(computed == position_commitment, "position commitment mismatch");

    // 2. Health at the liquidation threshold, against the price the contract
    //    supplies. The contract MUST bind these prices to a fresh oracle read;
    //    otherwise a stale favourable price could be replayed indefinitely.
    l::assert_solvent(
        collateral_amount,
        collateral_price,
        debt_scaled,
        debt_price,
        borrow_index,
        liq_threshold_bps,
    );
}

// ===========================================================================
// Tests
// ===========================================================================

global ONE_PRICE: Field = 10000000;
global ONE_INDEX: Field = 1000000000;

#[test]
fn test_attest_healthy() {
    let sk = 7;
    let ok = w::owner_key(sk);
    // 1000 collateral, 800 debt, 80% threshold -> exactly at the limit, passes.
    let pos = l::position_commitment(0, 1000, 1, 800, ok, 11);
    main(pos, 0, 1000, 1, ONE_PRICE, ONE_PRICE, ONE_INDEX, 8000, 800, sk, 11);
}

#[test]
fn test_attest_above_ltv_but_below_liquidation_still_passes() {
    let sk = 7;
    let ok = w::owner_key(sk);
    // 780 debt is past the 750 borrow ceiling but under the 800 liquidation
    // threshold: the borrower must still be able to attest.
    let pos = l::position_commitment(0, 1000, 1, 780, ok, 11);
    main(pos, 0, 1000, 1, ONE_PRICE, ONE_PRICE, ONE_INDEX, 8000, 780, sk, 11);
}

#[test(should_fail_with = "position is not solvent")]
fn test_attest_underwater_rejected() {
    let sk = 7;
    let ok = w::owner_key(sk);
    let pos = l::position_commitment(0, 1000, 1, 801, ok, 11);
    main(pos, 0, 1000, 1, ONE_PRICE, ONE_PRICE, ONE_INDEX, 8000, 801, sk, 11);
}

#[test(should_fail_with = "position is not solvent")]
fn test_attest_fails_after_collateral_price_crash() {
    let sk = 7;
    let ok = w::owner_key(sk);
    // Collateral halves: 1000 @0.5 = 500, 80% -> 400 allowed, debt 600 breaches.
    let half = 5000000;
    let pos = l::position_commitment(0, 1000, 1, 600, ok, 11);
    main(pos, 0, 1000, 1, half, ONE_PRICE, ONE_INDEX, 8000, 600, sk, 11);
}

#[test(should_fail_with = "position commitment mismatch")]
fn test_cannot_attest_with_understated_debt() {
    let sk = 7;
    let ok = w::owner_key(sk);
    // Real position carries 900 debt; attesting with 100 must not verify.
    let pos = l::position_commitment(0, 1000, 1, 900, ok, 11);
    main(pos, 0, 1000, 1, ONE_PRICE, ONE_PRICE, ONE_INDEX, 8000, 100, sk, 11);
}

#[test(should_fail_with = "position commitment mismatch")]
fn test_third_party_cannot_attest() {
    let sk = 7;
    let attacker = 8;
    let ok = w::owner_key(sk);
    let pos = l::position_commitment(0, 1000, 1, 800, ok, 11);
    main(pos, 0, 1000, 1, ONE_PRICE, ONE_PRICE, ONE_INDEX, 8000, 800, attacker, 11);
}
