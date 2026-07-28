//! Private collateralised lending, inside the pool contract.
//!
//! Lives here rather than in a separate contract because position, supply and
//! balance notes MUST share one Merkle tree. A separate tree would force a public
//! `withdraw` to move collateral in, whose `amount` is a public input — leaking
//! the collateral at the boundary and shrinking the anonymity set
//! (LENDING_SPEC §8).
//!
//! ## Why liquidation is not public-scan based
//!
//! Aave/Compound-style protocols let liquidator bots read every position's
//! collateral and debt. Hiding both breaks that: a stale position whose amounts
//! only the borrower knows can never be seized, because no liquidator can build a
//! spend proof for a commitment they cannot open, and the contract cannot compute
//! a payout it cannot see.
//!
//! So collateral is PUBLIC (stored in `Position`) and debt is PRIVATE (lives only
//! inside the position commitment). Borrowers prove continued health with
//! `attest_solvency`; miss the deadline and anyone may `liquidate_stale`, which
//! needs no proof precisely because the collateral figure is already public.

use soroban_sdk::{token, Address, Bytes, BytesN, Env, MuxedAddress, Vec};

use crate::types::{
    AttestedEvent, BorrowEvent, CollateralWithdrawnEvent, ObscuraError, Position,
    PositionOpenedEvent, PriceData, RedeemedEvent, RepayEvent, Reserve, RiskParams, SeizedEvent,
    SuppliedEvent,
};
use crate::{amount_to_field, asset_id_of, is_spent, is_zero, mark_spent, merkle, parse_fields, verify, DataKey};

/// Interest index fixed-point scale — must equal `lending_lib::INDEX_SCALE`.
pub const INDEX_SCALE: i128 = 1_000_000_000;
/// Basis-points denominator — must equal `lending_lib::BPS_SCALE`.
pub const BPS_SCALE: i128 = 10_000;

/// Placeholder risk parameters (`Verdex_PRD.md` not supplied). Every one of these
/// reaches the circuits as a public input, so changing them recompiles nothing.
pub const DEFAULT_MAX_LTV_BPS: u32 = 7_500; // 75%
pub const DEFAULT_LIQ_THRESHOLD_BPS: u32 = 8_000; // 80%
pub const DEFAULT_ATTESTATION_PERIOD: u32 = 17_280; // ~1 day at 5s ledgers
pub const DEFAULT_MAX_PRICE_AGE: u32 = 60; // ~5 minutes

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

pub fn risk_params(env: &Env) -> RiskParams {
    env.storage()
        .instance()
        .get(&DataKey::RiskParams)
        .unwrap_or(RiskParams {
            max_ltv_bps: DEFAULT_MAX_LTV_BPS,
            liq_threshold_bps: DEFAULT_LIQ_THRESHOLD_BPS,
            attestation_period: DEFAULT_ATTESTATION_PERIOD,
            max_price_age: DEFAULT_MAX_PRICE_AGE,
        })
}

pub fn get_position(env: &Env, c: &BytesN<32>) -> Option<Position> {
    env.storage().persistent().get(&DataKey::Position(c.clone()))
}

fn put_position(env: &Env, c: &BytesN<32>, p: &Position) {
    env.storage()
        .persistent()
        .set(&DataKey::Position(c.clone()), p);
}

fn drop_position(env: &Env, c: &BytesN<32>) {
    env.storage()
        .persistent()
        .remove(&DataKey::Position(c.clone()));
}

/// Reserve for an asset, accrued to the current ledger. A reserve that has never
/// been touched starts at index 1.0.
pub fn reserve_accrued(env: &Env, asset_id: &BytesN<32>) -> Reserve {
    let now = env.ledger().sequence();
    let mut r: Reserve = env
        .storage()
        .persistent()
        .get(&DataKey::Reserve(asset_id.clone()))
        .unwrap_or(Reserve {
            total_supplied: 0,
            total_borrowed: 0,
            borrow_index: INDEX_SCALE,
            supply_index: INDEX_SCALE,
            last_accrual: now,
        });

    let elapsed = now.saturating_sub(r.last_accrual) as i128;
    if elapsed > 0 && r.total_borrowed > 0 && r.total_supplied > 0 {
        // PLACEHOLDER kinked rate model — replace with Verdex's curve.
        // utilisation in bps, then a two-slope curve; per-ledger accrual is
        // linear (not compounded) which is the usual on-chain simplification.
        let util_bps = r.total_borrowed.saturating_mul(BPS_SCALE) / r.total_supplied;
        let kink_bps: i128 = 8_000;
        let base_bps: i128 = 200; // 2% APR floor
        let slope1_bps: i128 = 600; // -> 8% at the kink
        let slope2_bps: i128 = 6_000; // steep above the kink

        let rate_bps = if util_bps <= kink_bps {
            base_bps + slope1_bps * util_bps / kink_bps
        } else {
            let over = util_bps - kink_bps;
            let span = BPS_SCALE - kink_bps;
            base_bps + slope1_bps + slope2_bps * over / span
        };

        // Ledgers per year at ~5s.
        let ledgers_per_year: i128 = 6_307_200;
        let growth = r.borrow_index.saturating_mul(rate_bps).saturating_mul(elapsed)
            / (BPS_SCALE * ledgers_per_year);
        r.borrow_index = r.borrow_index.saturating_add(growth);

        // Suppliers receive interest in proportion to utilisation.
        let s_growth = growth.saturating_mul(util_bps) / BPS_SCALE;
        r.supply_index = r.supply_index.saturating_add(s_growth);
        r.last_accrual = now;
    } else if elapsed > 0 {
        r.last_accrual = now;
    }
    r
}

fn put_reserve(env: &Env, asset_id: &BytesN<32>, r: &Reserve) {
    env.storage()
        .persistent()
        .set(&DataKey::Reserve(asset_id.clone()), r);
}

/// Free liquidity available to borrow or redeem.
fn available(r: &Reserve) -> i128 {
    r.total_supplied.saturating_sub(r.total_borrowed)
}

// ---------------------------------------------------------------------------
// Binding helpers
// ---------------------------------------------------------------------------

/// Reject unless the SAC `asset` derives the proof's public `asset_id`. Without
/// this, a valid proof for one asset could draw a different pool-held asset —
/// exactly the binding `withdraw` performs (SHARED §7).
fn bind_asset(env: &Env, asset: &Address, field: &BytesN<32>) -> Result<(), ObscuraError> {
    if &asset_id_of(env, asset) != field {
        return Err(ObscuraError::AssetMismatch);
    }
    Ok(())
}

fn bind_amount(amount: i128, field: &BytesN<32>) -> Result<(), ObscuraError> {
    if amount <= 0 {
        return Err(ObscuraError::InvalidAmount);
    }
    if field.to_array() != amount_to_field(amount) {
        return Err(ObscuraError::AmountMismatch);
    }
    Ok(())
}

fn bind_i128(value: i128, field: &BytesN<32>) -> Result<(), ObscuraError> {
    if value < 0 || field.to_array() != amount_to_field(value) {
        return Err(ObscuraError::AmountMismatch);
    }
    Ok(())
}

/// Current oracle price for an asset, refused if older than `max_price_age`.
///
/// PLACEHOLDER: this reads an admin-pushed price rather than calling Reflector.
/// That makes the price publisher a TRUSTED party — a wrong price lets a healthy
/// position be seized, or an unhealthy one attest. Swapping in Reflector means
/// replacing this one function; the staleness gate stays either way.
pub fn oracle_price(env: &Env, asset_id: &BytesN<32>) -> Result<i128, ObscuraError> {
    let p: PriceData = env
        .storage()
        .persistent()
        .get(&DataKey::Price(asset_id.clone()))
        .ok_or(ObscuraError::PriceNotSet)?;
    let age = env.ledger().sequence().saturating_sub(p.ledger);
    if age > risk_params(env).max_price_age {
        return Err(ObscuraError::StalePrice);
    }
    Ok(p.price)
}

/// Bind a proof's public price to the contract's own oracle reading.
fn bind_price(env: &Env, asset_id: &BytesN<32>, field: &BytesN<32>) -> Result<(), ObscuraError> {
    let price = oracle_price(env, asset_id)?;
    if field.to_array() != amount_to_field(price) {
        return Err(ObscuraError::PriceMismatch);
    }
    Ok(())
}

fn bind_bps(value: u32, field: &BytesN<32>) -> Result<(), ObscuraError> {
    if field.to_array() != amount_to_field(value as i128) {
        return Err(ObscuraError::InvalidPublicInputs);
    }
    Ok(())
}

/// Positions that have gone stale are frozen: they may only be seized, never
/// mutated. Otherwise a borrower could dodge liquidation by borrowing 1 unit to
/// mint a fresh commitment.
fn require_live(env: &Env, p: &Position) -> Result<(), ObscuraError> {
    if env.ledger().sequence() > p.deadline {
        return Err(ObscuraError::PositionStale);
    }
    Ok(())
}

fn new_deadline(env: &Env) -> u32 {
    env.ledger()
        .sequence()
        .saturating_add(risk_params(env).attestation_period)
}

// ---------------------------------------------------------------------------
// Entrypoint bodies (called from the #[contractimpl] in lib.rs)
// ---------------------------------------------------------------------------

/// `position_open` public inputs:
///   [0] merkle_root [1] nullifier [2] position_commitment
///   [3] collateral_asset [4] collateral_amount
pub fn open_position(
    env: &Env,
    proof: Bytes,
    public_inputs: Bytes,
    collateral_asset: Address,
    collateral_amount: i128,
) -> Result<(), ObscuraError> {
    let f = parse_fields(env, &public_inputs, 5)?;
    let (root, nullifier, position) = (f.get(0).unwrap(), f.get(1).unwrap(), f.get(2).unwrap());

    if !merkle::is_known_root(env, &root) {
        return Err(ObscuraError::UnknownRoot);
    }
    if is_spent(env, &nullifier) {
        return Err(ObscuraError::NullifierUsed);
    }
    if get_position(env, &position).is_some() {
        return Err(ObscuraError::PositionExists);
    }
    bind_asset(env, &collateral_asset, &f.get(3).unwrap())?;
    bind_amount(collateral_amount, &f.get(4).unwrap())?;

    verify(env, DataKey::PositionOpenVf, &public_inputs, &proof)?;

    mark_spent(env, &nullifier);
    let deadline = new_deadline(env);
    put_position(
        env,
        &position,
        &Position {
            collateral_asset: collateral_asset.clone(),
            collateral_amount,
            // Debt asset is chosen at open time but only matters once borrowed;
            // it is bound into the commitment, and re-bound on `borrow`.
            debt_asset: collateral_asset.clone(),
            deadline,
        },
    );
    PositionOpenedEvent {
        position,
        collateral_asset,
        collateral_amount,
        deadline,
    }
    .publish(env);
    Ok(())
}

/// `borrow` public inputs:
///   [0] merkle_root [1] old_position_commitment [2] position_nullifier
///   [3] new_position_commitment [4] out_note_commitment [5] collateral_asset
///   [6] collateral_amount [7] debt_asset [8] borrow_amount [9] collateral_price
///   [10] debt_price [11] borrow_index [12] max_ltv_bps
pub fn borrow(
    env: &Env,
    proof: Bytes,
    public_inputs: Bytes,
    old_position: BytesN<32>,
    debt_asset: Address,
    borrow_amount: i128,
    memo: Bytes,
) -> Result<(), ObscuraError> {
    let f = parse_fields(env, &public_inputs, 13)?;
    let (root, nullifier, new_position, out_note) = (
        f.get(0).unwrap(),
        f.get(2).unwrap(),
        f.get(3).unwrap(),
        f.get(4).unwrap(),
    );

    // Bind the registry entry we are about to mutate to the position this proof
    // is actually about. Without this the caller chooses `old_position` freely and
    // could prove against their own position while naming a victim's, deleting the
    // victim's entry.
    if f.get(1).unwrap() != old_position {
        return Err(ObscuraError::InvalidPublicInputs);
    }

    let pos = get_position(env, &old_position).ok_or(ObscuraError::PositionNotFound)?;
    require_live(env, &pos)?;
    if !merkle::is_known_root(env, &root) {
        return Err(ObscuraError::UnknownRoot);
    }
    if is_spent(env, &nullifier) {
        return Err(ObscuraError::NullifierUsed);
    }
    if get_position(env, &new_position).is_some() {
        return Err(ObscuraError::PositionExists);
    }

    // The collateral in the proof must be the collateral the registry holds,
    // otherwise a borrower could prove solvency against someone else's collateral.
    bind_asset(env, &pos.collateral_asset, &f.get(5).unwrap())?;
    bind_i128(pos.collateral_amount, &f.get(6).unwrap())?;
    bind_asset(env, &debt_asset, &f.get(7).unwrap())?;
    bind_amount(borrow_amount, &f.get(8).unwrap())?;

    let c_id = asset_id_of(env, &pos.collateral_asset);
    let d_id = asset_id_of(env, &debt_asset);
    bind_price(env, &c_id, &f.get(9).unwrap())?;
    bind_price(env, &d_id, &f.get(10).unwrap())?;

    let params = risk_params(env);
    let mut reserve = reserve_accrued(env, &d_id);
    bind_i128(reserve.borrow_index, &f.get(11).unwrap())?;
    bind_bps(params.max_ltv_bps, &f.get(12).unwrap())?;

    if available(&reserve) < borrow_amount {
        return Err(ObscuraError::InsufficientLiquidity);
    }

    verify(env, DataKey::BorrowVf, &public_inputs, &proof)?;

    mark_spent(env, &nullifier);
    drop_position(env, &old_position);
    put_position(
        env,
        &new_position,
        &Position {
            collateral_asset: pos.collateral_asset.clone(),
            collateral_amount: pos.collateral_amount,
            debt_asset: debt_asset.clone(),
            // Borrowing does NOT extend the deadline: it is not a health
            // attestation. Only `attest_solvency` refreshes it.
            deadline: pos.deadline,
        },
    );

    reserve.total_borrowed = reserve.total_borrowed.saturating_add(borrow_amount);
    put_reserve(env, &d_id, &reserve);

    let index = merkle::insert(env, &out_note);
    BorrowEvent {
        old_position,
        new_position,
        asset: debt_asset,
        amount: borrow_amount,
        index,
        memo,
    }
    .publish(env);
    Ok(())
}

/// `repay` public inputs:
///   [0] merkle_root [1] old_position_commitment [2] position_nullifier
///   [3] note_nullifier [4] new_position_commitment [5] change_commitment
///   [6] collateral_asset [7] collateral_amount [8] debt_asset [9] repay_amount
///   [10] borrow_index
pub fn repay(
    env: &Env,
    proof: Bytes,
    public_inputs: Bytes,
    old_position: BytesN<32>,
    debt_asset: Address,
    repay_amount: i128,
) -> Result<(), ObscuraError> {
    let f = parse_fields(env, &public_inputs, 11)?;
    let (root, pos_nf, note_nf, new_position, change) = (
        f.get(0).unwrap(),
        f.get(2).unwrap(),
        f.get(3).unwrap(),
        f.get(4).unwrap(),
        f.get(5).unwrap(),
    );

    if f.get(1).unwrap() != old_position {
        return Err(ObscuraError::InvalidPublicInputs);
    }

    let pos = get_position(env, &old_position).ok_or(ObscuraError::PositionNotFound)?;
    // NB: repaying a stale position is still refused. Once seizable, a position is
    // frozen; the borrower's remedy is to attest, which repay does not do.
    require_live(env, &pos)?;

    if !merkle::is_known_root(env, &root) {
        return Err(ObscuraError::UnknownRoot);
    }
    if is_spent(env, &pos_nf) || is_spent(env, &note_nf) {
        return Err(ObscuraError::NullifierUsed);
    }
    if pos_nf == note_nf {
        return Err(ObscuraError::DuplicateNullifier);
    }
    if get_position(env, &new_position).is_some() {
        return Err(ObscuraError::PositionExists);
    }

    bind_asset(env, &pos.collateral_asset, &f.get(6).unwrap())?;
    bind_i128(pos.collateral_amount, &f.get(7).unwrap())?;
    bind_asset(env, &debt_asset, &f.get(8).unwrap())?;
    bind_amount(repay_amount, &f.get(9).unwrap())?;

    let d_id = asset_id_of(env, &debt_asset);
    let mut reserve = reserve_accrued(env, &d_id);
    bind_i128(reserve.borrow_index, &f.get(10).unwrap())?;

    verify(env, DataKey::RepayVf, &public_inputs, &proof)?;

    mark_spent(env, &pos_nf);
    mark_spent(env, &note_nf);
    drop_position(env, &old_position);
    put_position(
        env,
        &new_position,
        &Position {
            collateral_asset: pos.collateral_asset.clone(),
            collateral_amount: pos.collateral_amount,
            debt_asset: debt_asset.clone(),
            deadline: pos.deadline,
        },
    );

    // Clamp: the circuit floors the scaled debt at zero on overpayment, so the
    // reserve must floor too or the aggregate would go negative.
    reserve.total_borrowed = (reserve.total_borrowed - repay_amount).max(0);
    put_reserve(env, &d_id, &reserve);

    if !is_zero(&change) {
        merkle::insert(env, &change);
    }
    RepayEvent {
        old_position,
        new_position,
        asset: debt_asset,
        amount: repay_amount,
    }
    .publish(env);
    Ok(())
}

/// `withdraw_collateral` public inputs:
///   [0] merkle_root [1] old_position_commitment [2] position_nullifier
///   [3] new_position_commitment [4] out_note_commitment [5] collateral_asset
///   [6] old_collateral_amount [7] new_collateral_amount [8] debt_asset
///   [9] collateral_price [10] debt_price [11] borrow_index [12] max_ltv_bps
pub fn withdraw_collateral(
    env: &Env,
    proof: Bytes,
    public_inputs: Bytes,
    old_position: BytesN<32>,
    new_collateral_amount: i128,
    memo: Bytes,
) -> Result<(), ObscuraError> {
    let f = parse_fields(env, &public_inputs, 13)?;
    let (root, nullifier, new_position, out_note) = (
        f.get(0).unwrap(),
        f.get(2).unwrap(),
        f.get(3).unwrap(),
        f.get(4).unwrap(),
    );

    if f.get(1).unwrap() != old_position {
        return Err(ObscuraError::InvalidPublicInputs);
    }

    let pos = get_position(env, &old_position).ok_or(ObscuraError::PositionNotFound)?;
    require_live(env, &pos)?;
    if !merkle::is_known_root(env, &root) {
        return Err(ObscuraError::UnknownRoot);
    }
    if is_spent(env, &nullifier) {
        return Err(ObscuraError::NullifierUsed);
    }
    if get_position(env, &new_position).is_some() {
        return Err(ObscuraError::PositionExists);
    }
    if new_collateral_amount < 0 || new_collateral_amount >= pos.collateral_amount {
        return Err(ObscuraError::InvalidAmount);
    }

    bind_asset(env, &pos.collateral_asset, &f.get(5).unwrap())?;
    bind_i128(pos.collateral_amount, &f.get(6).unwrap())?;
    bind_i128(new_collateral_amount, &f.get(7).unwrap())?;
    bind_asset(env, &pos.debt_asset, &f.get(8).unwrap())?;

    let c_id = asset_id_of(env, &pos.collateral_asset);
    let d_id = asset_id_of(env, &pos.debt_asset);
    bind_price(env, &c_id, &f.get(9).unwrap())?;
    bind_price(env, &d_id, &f.get(10).unwrap())?;

    let params = risk_params(env);
    let reserve = reserve_accrued(env, &d_id);
    bind_i128(reserve.borrow_index, &f.get(11).unwrap())?;
    bind_bps(params.max_ltv_bps, &f.get(12).unwrap())?;

    verify(env, DataKey::WithdrawCollateralVf, &public_inputs, &proof)?;

    let withdrawn = pos.collateral_amount - new_collateral_amount;
    mark_spent(env, &nullifier);
    drop_position(env, &old_position);
    put_position(
        env,
        &new_position,
        &Position {
            collateral_asset: pos.collateral_asset.clone(),
            collateral_amount: new_collateral_amount,
            debt_asset: pos.debt_asset.clone(),
            deadline: pos.deadline,
        },
    );

    let index = merkle::insert(env, &out_note);
    CollateralWithdrawnEvent {
        old_position,
        new_position,
        asset: pos.collateral_asset,
        amount: withdrawn,
        index,
        memo,
    }
    .publish(env);
    Ok(())
}

/// `solvency_attestation` public inputs:
///   [0] position_commitment [1] collateral_asset [2] collateral_amount
///   [3] debt_asset [4] collateral_price [5] debt_price [6] borrow_index
///   [7] liq_threshold_bps
///
/// Mutates no notes: no nullifier is burned and no leaf is consumed. It only
/// pushes the deadline forward (LENDING_SPEC §2).
pub fn attest_solvency(
    env: &Env,
    proof: Bytes,
    public_inputs: Bytes,
) -> Result<u32, ObscuraError> {
    let f = parse_fields(env, &public_inputs, 8)?;
    let position = f.get(0).unwrap();

    let mut pos = get_position(env, &position).ok_or(ObscuraError::PositionNotFound)?;
    // Deliberately NOT `require_live`: attesting is exactly what a borrower does
    // to stay alive, and a position remains attestable right up to its deadline.
    // Once past it, seizure wins — first-come, and the borrower has had a full
    // period to act.
    if env.ledger().sequence() > pos.deadline {
        return Err(ObscuraError::PositionStale);
    }

    bind_asset(env, &pos.collateral_asset, &f.get(1).unwrap())?;
    bind_i128(pos.collateral_amount, &f.get(2).unwrap())?;
    bind_asset(env, &pos.debt_asset, &f.get(3).unwrap())?;

    let c_id = asset_id_of(env, &pos.collateral_asset);
    let d_id = asset_id_of(env, &pos.debt_asset);
    bind_price(env, &c_id, &f.get(4).unwrap())?;
    bind_price(env, &d_id, &f.get(5).unwrap())?;

    let params = risk_params(env);
    let reserve = reserve_accrued(env, &d_id);
    bind_i128(reserve.borrow_index, &f.get(6).unwrap())?;
    // Attestation is judged at the LIQUIDATION threshold, not the borrow ceiling:
    // a position past 75% but under 80% is not liquidatable and must stay alive.
    bind_bps(params.liq_threshold_bps, &f.get(7).unwrap())?;

    verify(env, DataKey::AttestVf, &public_inputs, &proof)?;

    pos.deadline = new_deadline(env);
    put_position(env, &position, &pos);
    AttestedEvent {
        position,
        new_deadline: pos.deadline,
    }
    .publish(env);
    Ok(pos.deadline)
}

/// Seize a position whose attestation deadline has elapsed.
///
/// No proof: the collateral figure is already public, which is the entire reason
/// the design puts it there. All-or-nothing — the caller takes the full
/// collateral and the protocol writes off the hidden debt, because computing a
/// surplus would require knowing that debt.
pub fn liquidate_stale(
    env: &Env,
    liquidator: Address,
    position: BytesN<32>,
) -> Result<i128, ObscuraError> {
    liquidator.require_auth();
    let pos = get_position(env, &position).ok_or(ObscuraError::PositionNotFound)?;
    if env.ledger().sequence() <= pos.deadline {
        return Err(ObscuraError::PositionNotStale);
    }

    // The written-off debt is unknown, so the reserve cannot be credited for it.
    // Bad debt is therefore absorbed by suppliers via the index — documented in
    // LENDING_SPEC as a consequence of all-or-nothing seizure.
    drop_position(env, &position);

    let tok = token::Client::new(env, &pos.collateral_asset);
    let to: MuxedAddress = liquidator.clone().into();
    tok.transfer(&env.current_contract_address(), &to, &pos.collateral_amount);

    SeizedEvent {
        position,
        liquidator,
        collateral_asset: pos.collateral_asset,
        collateral_amount: pos.collateral_amount,
    }
    .publish(env);
    Ok(pos.collateral_amount)
}

/// `supply` public inputs:
///   [0] merkle_root [1] nullifier [2] supply_commitment [3] asset
///   [4] supply_amount [5] supply_index
pub fn supply(
    env: &Env,
    proof: Bytes,
    public_inputs: Bytes,
    asset: Address,
    amount: i128,
    memo: Bytes,
) -> Result<(), ObscuraError> {
    let f = parse_fields(env, &public_inputs, 6)?;
    let (root, nullifier, supply_commitment) =
        (f.get(0).unwrap(), f.get(1).unwrap(), f.get(2).unwrap());

    if !merkle::is_known_root(env, &root) {
        return Err(ObscuraError::UnknownRoot);
    }
    if is_spent(env, &nullifier) {
        return Err(ObscuraError::NullifierUsed);
    }
    bind_asset(env, &asset, &f.get(3).unwrap())?;
    bind_amount(amount, &f.get(4).unwrap())?;

    let a_id = asset_id_of(env, &asset);
    let mut reserve = reserve_accrued(env, &a_id);
    bind_i128(reserve.supply_index, &f.get(5).unwrap())?;

    verify(env, DataKey::SupplyVf, &public_inputs, &proof)?;

    mark_spent(env, &nullifier);
    reserve.total_supplied = reserve.total_supplied.saturating_add(amount);
    put_reserve(env, &a_id, &reserve);

    let index = merkle::insert(env, &supply_commitment);
    SuppliedEvent {
        supply_commitment,
        asset,
        amount,
        index,
        memo,
    }
    .publish(env);
    Ok(())
}

/// `redeem` public inputs:
///   [0] merkle_root [1] nullifier [2] out_note_commitment
///   [3] remainder_commitment [4] asset [5] redeem_amount [6] supply_index
pub fn redeem(
    env: &Env,
    proof: Bytes,
    public_inputs: Bytes,
    asset: Address,
    amount: i128,
    memos: Vec<Bytes>,
) -> Result<(), ObscuraError> {
    let f = parse_fields(env, &public_inputs, 7)?;
    let (root, nullifier, out_note, remainder) = (
        f.get(0).unwrap(),
        f.get(1).unwrap(),
        f.get(2).unwrap(),
        f.get(3).unwrap(),
    );

    if !merkle::is_known_root(env, &root) {
        return Err(ObscuraError::UnknownRoot);
    }
    if is_spent(env, &nullifier) {
        return Err(ObscuraError::NullifierUsed);
    }
    bind_asset(env, &asset, &f.get(4).unwrap())?;
    bind_amount(amount, &f.get(5).unwrap())?;

    let a_id = asset_id_of(env, &asset);
    let mut reserve = reserve_accrued(env, &a_id);
    bind_i128(reserve.supply_index, &f.get(6).unwrap())?;

    // The circuit proves entitlement, not availability: a fully-utilised reserve
    // can leave a legitimate redemption temporarily unfillable.
    if available(&reserve) < amount {
        return Err(ObscuraError::InsufficientLiquidity);
    }

    verify(env, DataKey::RedeemVf, &public_inputs, &proof)?;

    mark_spent(env, &nullifier);
    reserve.total_supplied = (reserve.total_supplied - amount).max(0);
    put_reserve(env, &a_id, &reserve);

    let mut indices: Vec<u32> = Vec::new(env);
    indices.push_back(merkle::insert(env, &out_note));
    if !is_zero(&remainder) {
        indices.push_back(merkle::insert(env, &remainder));
    }

    RedeemedEvent {
        nullifier,
        asset,
        amount,
        indices,
        memos,
    }
    .publish(env);
    Ok(())
}
