/**
 * Circuit input builders for the lending circuits.
 *
 * The ABI key names and the `pub` parameter ORDER are load-bearing: the contract
 * parses `public_inputs` positionally (SHARED §7), so a reordering here silently
 * mis-binds on-chain checks rather than failing loudly. Orderings below match
 * LENDING_SPEC §7 and the circuits' `main` signatures.
 *
 * NOTE: `old_position_commitment` is public input [1] of borrow / repay /
 * withdraw_collateral. It exists so the contract can bind the registry entry it
 * mutates to the position the proof is actually about — without it a caller
 * could prove against their own position while naming a victim's commitment.
 */
import { fieldToHex, toField, type Field } from "./poseidon.js";
import type { CircuitInputMap } from "./prover.js";

const fv = (x: Field | bigint | number | string): string => fieldToHex(toField(x));
const iv = (x: bigint | number): string => x.toString();

/**
 * `position_open` — public: merkle_root, nullifier, position_commitment,
 * collateral_asset, collateral_amount
 */
export function buildPositionOpenInputs(p: {
  merkleRoot: Field;
  nullifier: Field;
  positionCommitment: Field;
  collateralAsset: Field;
  collateralAmount: bigint;
  noteBlinding: Field;
  spendingKey: Field;
  merklePath: Field[];
  merkleIndices: number[];
  debtAsset: Field;
  positionNonce: Field;
}): CircuitInputMap {
  return {
    merkle_root: fv(p.merkleRoot),
    nullifier: fv(p.nullifier),
    position_commitment: fv(p.positionCommitment),
    collateral_asset: fv(p.collateralAsset),
    collateral_amount: iv(p.collateralAmount),
    note_blinding: fv(p.noteBlinding),
    spending_key: fv(p.spendingKey),
    merkle_path: p.merklePath.map(fv),
    merkle_indices: p.merkleIndices.map(iv),
    debt_asset: fv(p.debtAsset),
    position_nonce: fv(p.positionNonce),
  };
}

/**
 * `borrow` — public: merkle_root, old_position_commitment, position_nullifier,
 * new_position_commitment, out_note_commitment, collateral_asset,
 * collateral_amount, debt_asset, borrow_amount, collateral_price, debt_price,
 * borrow_index, max_ltv_bps
 */
export function buildBorrowInputs(p: {
  merkleRoot: Field;
  oldPositionCommitment: Field;
  positionNullifier: Field;
  newPositionCommitment: Field;
  outNoteCommitment: Field;
  collateralAsset: Field;
  collateralAmount: bigint;
  debtAsset: Field;
  borrowAmount: bigint;
  collateralPrice: bigint;
  debtPrice: bigint;
  borrowIndex: bigint;
  maxLtvBps: number;
  oldDebtScaled: bigint;
  spendingKey: Field;
  merklePath: Field[];
  merkleIndices: number[];
  oldNonce: Field;
  newNonce: Field;
  outBlinding: Field;
}): CircuitInputMap {
  return {
    merkle_root: fv(p.merkleRoot),
    old_position_commitment: fv(p.oldPositionCommitment),
    position_nullifier: fv(p.positionNullifier),
    new_position_commitment: fv(p.newPositionCommitment),
    out_note_commitment: fv(p.outNoteCommitment),
    collateral_asset: fv(p.collateralAsset),
    collateral_amount: iv(p.collateralAmount),
    debt_asset: fv(p.debtAsset),
    borrow_amount: iv(p.borrowAmount),
    collateral_price: iv(p.collateralPrice),
    debt_price: iv(p.debtPrice),
    borrow_index: iv(p.borrowIndex),
    max_ltv_bps: iv(p.maxLtvBps),
    old_debt_scaled: iv(p.oldDebtScaled),
    spending_key: fv(p.spendingKey),
    merkle_path: p.merklePath.map(fv),
    merkle_indices: p.merkleIndices.map(iv),
    old_nonce: fv(p.oldNonce),
    new_nonce: fv(p.newNonce),
    out_blinding: fv(p.outBlinding),
  };
}

/**
 * `repay` — public: merkle_root, old_position_commitment, position_nullifier,
 * note_nullifier, new_position_commitment, change_commitment, collateral_asset,
 * collateral_amount, debt_asset, repay_amount, borrow_index
 */
export function buildRepayInputs(p: {
  merkleRoot: Field;
  oldPositionCommitment: Field;
  positionNullifier: Field;
  noteNullifier: Field;
  newPositionCommitment: Field;
  changeCommitment: Field;
  collateralAsset: Field;
  collateralAmount: bigint;
  debtAsset: Field;
  repayAmount: bigint;
  borrowIndex: bigint;
  oldDebtScaled: bigint;
  spendingKey: Field;
  positionPath: Field[];
  positionIndices: number[];
  noteAmount: bigint;
  noteBlinding: Field;
  notePath: Field[];
  noteIndices: number[];
  oldNonce: Field;
  newNonce: Field;
  changeBlinding: Field;
}): CircuitInputMap {
  return {
    merkle_root: fv(p.merkleRoot),
    old_position_commitment: fv(p.oldPositionCommitment),
    position_nullifier: fv(p.positionNullifier),
    note_nullifier: fv(p.noteNullifier),
    new_position_commitment: fv(p.newPositionCommitment),
    change_commitment: fv(p.changeCommitment),
    collateral_asset: fv(p.collateralAsset),
    collateral_amount: iv(p.collateralAmount),
    debt_asset: fv(p.debtAsset),
    repay_amount: iv(p.repayAmount),
    borrow_index: iv(p.borrowIndex),
    old_debt_scaled: iv(p.oldDebtScaled),
    spending_key: fv(p.spendingKey),
    position_path: p.positionPath.map(fv),
    position_indices: p.positionIndices.map(iv),
    note_amount: iv(p.noteAmount),
    note_blinding: fv(p.noteBlinding),
    note_path: p.notePath.map(fv),
    note_indices: p.noteIndices.map(iv),
    old_nonce: fv(p.oldNonce),
    new_nonce: fv(p.newNonce),
    change_blinding: fv(p.changeBlinding),
  };
}

/**
 * `withdraw_collateral` — public: merkle_root, old_position_commitment,
 * position_nullifier, new_position_commitment, out_note_commitment,
 * collateral_asset, old_collateral_amount, new_collateral_amount, debt_asset,
 * collateral_price, debt_price, borrow_index, max_ltv_bps
 */
export function buildWithdrawCollateralInputs(p: {
  merkleRoot: Field;
  oldPositionCommitment: Field;
  positionNullifier: Field;
  newPositionCommitment: Field;
  outNoteCommitment: Field;
  collateralAsset: Field;
  oldCollateralAmount: bigint;
  newCollateralAmount: bigint;
  debtAsset: Field;
  collateralPrice: bigint;
  debtPrice: bigint;
  borrowIndex: bigint;
  maxLtvBps: number;
  debtScaled: bigint;
  spendingKey: Field;
  merklePath: Field[];
  merkleIndices: number[];
  oldNonce: Field;
  newNonce: Field;
  outBlinding: Field;
}): CircuitInputMap {
  return {
    merkle_root: fv(p.merkleRoot),
    old_position_commitment: fv(p.oldPositionCommitment),
    position_nullifier: fv(p.positionNullifier),
    new_position_commitment: fv(p.newPositionCommitment),
    out_note_commitment: fv(p.outNoteCommitment),
    collateral_asset: fv(p.collateralAsset),
    old_collateral_amount: iv(p.oldCollateralAmount),
    new_collateral_amount: iv(p.newCollateralAmount),
    debt_asset: fv(p.debtAsset),
    collateral_price: iv(p.collateralPrice),
    debt_price: iv(p.debtPrice),
    borrow_index: iv(p.borrowIndex),
    max_ltv_bps: iv(p.maxLtvBps),
    debt_scaled: iv(p.debtScaled),
    spending_key: fv(p.spendingKey),
    merkle_path: p.merklePath.map(fv),
    merkle_indices: p.merkleIndices.map(iv),
    old_nonce: fv(p.oldNonce),
    new_nonce: fv(p.newNonce),
    out_blinding: fv(p.outBlinding),
  };
}

/**
 * `solvency_attestation` — public: position_commitment, collateral_asset,
 * collateral_amount, debt_asset, collateral_price, debt_price, borrow_index,
 * liq_threshold_bps
 *
 * No merkle proof and no nullifier: the contract already holds the commitment in
 * its registry, and an attestation mutates no notes (LENDING_SPEC §2).
 */
export function buildSolvencyAttestationInputs(p: {
  positionCommitment: Field;
  collateralAsset: Field;
  collateralAmount: bigint;
  debtAsset: Field;
  collateralPrice: bigint;
  debtPrice: bigint;
  borrowIndex: bigint;
  liqThresholdBps: number;
  debtScaled: bigint;
  spendingKey: Field;
  nonce: Field;
}): CircuitInputMap {
  return {
    position_commitment: fv(p.positionCommitment),
    collateral_asset: fv(p.collateralAsset),
    collateral_amount: iv(p.collateralAmount),
    debt_asset: fv(p.debtAsset),
    collateral_price: iv(p.collateralPrice),
    debt_price: iv(p.debtPrice),
    borrow_index: iv(p.borrowIndex),
    liq_threshold_bps: iv(p.liqThresholdBps),
    debt_scaled: iv(p.debtScaled),
    spending_key: fv(p.spendingKey),
    nonce: fv(p.nonce),
  };
}

/**
 * `supply` — public: merkle_root, nullifier, supply_commitment, asset,
 * supply_amount, supply_index
 */
export function buildSupplyInputs(p: {
  merkleRoot: Field;
  nullifier: Field;
  supplyCommitment: Field;
  asset: Field;
  supplyAmount: bigint;
  supplyIndex: bigint;
  noteBlinding: Field;
  spendingKey: Field;
  merklePath: Field[];
  merkleIndices: number[];
  supplyNonce: Field;
}): CircuitInputMap {
  return {
    merkle_root: fv(p.merkleRoot),
    nullifier: fv(p.nullifier),
    supply_commitment: fv(p.supplyCommitment),
    asset: fv(p.asset),
    supply_amount: iv(p.supplyAmount),
    supply_index: iv(p.supplyIndex),
    note_blinding: fv(p.noteBlinding),
    spending_key: fv(p.spendingKey),
    merkle_path: p.merklePath.map(fv),
    merkle_indices: p.merkleIndices.map(iv),
    supply_nonce: fv(p.supplyNonce),
  };
}

/**
 * `redeem` — public: merkle_root, nullifier, out_note_commitment,
 * remainder_commitment, asset, redeem_amount, supply_index
 */
export function buildRedeemInputs(p: {
  merkleRoot: Field;
  nullifier: Field;
  outNoteCommitment: Field;
  remainderCommitment: Field;
  asset: Field;
  redeemAmount: bigint;
  supplyIndex: bigint;
  supplyScaled: bigint;
  spendingKey: Field;
  merklePath: Field[];
  merkleIndices: number[];
  oldNonce: Field;
  newNonce: Field;
  outBlinding: Field;
}): CircuitInputMap {
  return {
    merkle_root: fv(p.merkleRoot),
    nullifier: fv(p.nullifier),
    out_note_commitment: fv(p.outNoteCommitment),
    remainder_commitment: fv(p.remainderCommitment),
    asset: fv(p.asset),
    redeem_amount: iv(p.redeemAmount),
    supply_index: iv(p.supplyIndex),
    supply_scaled: iv(p.supplyScaled),
    spending_key: fv(p.spendingKey),
    merkle_path: p.merklePath.map(fv),
    merkle_indices: p.merkleIndices.map(iv),
    old_nonce: fv(p.oldNonce),
    new_nonce: fv(p.newNonce),
    out_blinding: fv(p.outBlinding),
  };
}
