/**
 * Soroban transaction scaffolding for the ObscuraPool contract via @stellar/stellar-sdk.
 *
 * Builds invoke operations for deposit / withdraw / transfer / place_order /
 * match_orders / cancel_order (SPEC sec 9.1), and encodes `public_inputs` as the
 * concatenation of 32-byte big-endian field elements in the circuit's declared `pub`
 * order (SHARED sec 6-7).
 *
 * The address->field convention used by {@link addressToField} (StrKey raw 32 bytes
 * interpreted big-endian, reduced mod r) is the canonical `address_as_field` rule of
 * SHARED §4. The deployed contract derives `asset_id` / `recipient_hash` identically
 * (`contracts/obscura-pool/src/lib.rs::address_to_field`), pinned by the cross-impl golden
 * test `address_to_field_matches_sdk_golden`. Native XLM keeps `asset_id = 0` (see
 * {@link assetIdFromAddress}); the contract maps the configured native SAC Address to 0.
 */
import {
  Account,
  Address,
  Asset as StellarAsset,
  BASE_FEE,
  Contract,
  Networks,
  StrKey,
  TransactionBuilder,
  nativeToScVal,
  xdr,
  type Transaction,
} from "@stellar/stellar-sdk";
import { FIELD_BYTES, NATIVE_ASSET_ID, PROOF_BYTES } from "./constants.js";
import { bytesToField, fieldToBytes, hash2, toField, type Field } from "./poseidon.js";
import type { Asset, ProofData } from "./types.js";

/** Public-input field order per circuit. SHARED sec 7 (authoritative). */
export const PUBLIC_INPUT_ORDER = {
  withdraw: ["merkle_root", "nullifier", "recipient_hash", "amount", "asset_id"],
  transfer: [
    "merkle_root",
    "nullifier_0",
    "nullifier_1",
    "out_commitment_0",
    "out_commitment_1",
    "ext_data_hash",
  ],
  place_order: ["merkle_root", "nullifier", "order_commitment", "change_commitment", "locked_asset_id"],
  match_orders: [
    "order_commitment_a",
    "order_commitment_b",
    "fill_note_buyer",
    "fill_note_seller",
    "residual_order_a",
    "residual_order_b",
    "refund_note_a",
    "refund_note_b",
  ],
  cancel_order: ["order_commitment", "refund_commitment", "refund_asset_id"],

  // --- lending (LENDING_SPEC sec 7) ---
  // `old_position_commitment` is index [1] of borrow / repay / withdraw_collateral:
  // the contract binds the registry entry it mutates to the position the proof is
  // about. Reordering these silently mis-binds on-chain checks.
  position_open: ["merkle_root", "nullifier", "position_commitment", "collateral_asset", "collateral_amount"],
  borrow: [
    "merkle_root",
    "old_position_commitment",
    "position_nullifier",
    "new_position_commitment",
    "out_note_commitment",
    "collateral_asset",
    "collateral_amount",
    "debt_asset",
    "borrow_amount",
    "collateral_price",
    "debt_price",
    "borrow_index",
    "max_ltv_bps",
  ],
  repay: [
    "merkle_root",
    "old_position_commitment",
    "position_nullifier",
    "note_nullifier",
    "new_position_commitment",
    "change_commitment",
    "collateral_asset",
    "collateral_amount",
    "debt_asset",
    "repay_amount",
    "borrow_index",
  ],
  withdraw_collateral: [
    "merkle_root",
    "old_position_commitment",
    "position_nullifier",
    "new_position_commitment",
    "out_note_commitment",
    "collateral_asset",
    "old_collateral_amount",
    "new_collateral_amount",
    "debt_asset",
    "collateral_price",
    "debt_price",
    "borrow_index",
    "max_ltv_bps",
  ],
  solvency_attestation: [
    "position_commitment",
    "collateral_asset",
    "collateral_amount",
    "debt_asset",
    "collateral_price",
    "debt_price",
    "borrow_index",
    "liq_threshold_bps",
  ],
  supply: ["merkle_root", "nullifier", "supply_commitment", "asset", "supply_amount", "supply_index"],
  redeem: [
    "merkle_root",
    "nullifier",
    "out_note_commitment",
    "remainder_commitment",
    "asset",
    "redeem_amount",
    "supply_index",
  ],
} as const;

export type CircuitName = keyof typeof PUBLIC_INPUT_ORDER;

/**
 * Decode a Stellar address (contract "C..." or account "G...") to its raw 32 bytes and
 * interpret them as a big-endian field element (reduced mod r). See the module note on
 * matching the contract convention.
 */
export function addressToField(address: string): Field {
  let raw: Uint8Array;
  if (StrKey.isValidContract(address)) {
    raw = StrKey.decodeContract(address);
  } else if (StrKey.isValidEd25519PublicKey(address)) {
    raw = StrKey.decodeEd25519PublicKey(address);
  } else {
    throw new Error(`unsupported Stellar address: ${address}`);
  }
  return toField(bytesToField(raw));
}

/** asset_id for a SAC address, or 0 for native XLM. SHARED sec 4 / SPEC sec 5.3. */
export function assetIdFromAddress(address?: string | null): Field {
  if (!address || address === "native" || address === "XLM") return NATIVE_ASSET_ID;
  return hash2(addressToField(address), 0);
}

/** recipient_hash = hash2(recipient_address_as_field, 0). SHARED sec 7. */
export function recipientHash(address: string): Field {
  return hash2(addressToField(address), 0);
}

/**
 * The native-XLM {@link Asset}: `assetId = 0`, `address` = the native SAC contract on
 * the given network. SHARED sec 4 / SPEC sec 5.3.
 */
export function nativeAsset(networkPassphrase: string = Networks.TESTNET): Asset {
  return { assetId: NATIVE_ASSET_ID, address: StellarAsset.native().contractId(networkPassphrase), code: "XLM" };
}

/**
 * Build an {@link Asset} for a deployed SAC contract: `assetId = hash2(addressAsField, 0)`,
 * `address` = the SAC StrKey. For a classic asset, derive the SAC address first via
 * `new StellarAsset(code, issuer).contractId(passphrase)`.
 */
export function assetFromSac(sacAddress: string, code?: string): Asset {
  const asset: Asset = { assetId: hash2(addressToField(sacAddress), 0), address: sacAddress };
  if (code !== undefined) asset.code = code;
  return asset;
}

/** Concatenate field elements into the `public_inputs` byte string (32-byte BE each). */
export function encodePublicInputs(fields: readonly Field[]): Uint8Array {
  const out = new Uint8Array(fields.length * FIELD_BYTES);
  fields.forEach((f, i) => out.set(fieldToBytes(f), i * FIELD_BYTES));
  return out;
}

/** Parse a `public_inputs` byte string back into field elements. */
export function decodePublicInputs(bytes: Uint8Array): Field[] {
  if (bytes.length % FIELD_BYTES !== 0) {
    throw new Error(`public_inputs length ${bytes.length} is not a multiple of ${FIELD_BYTES}`);
  }
  const out: Field[] = [];
  for (let i = 0; i < bytes.length; i += FIELD_BYTES) {
    out.push(bytesToField(bytes.subarray(i, i + FIELD_BYTES)));
  }
  return out;
}

const scvBytes = (b: Uint8Array): xdr.ScVal => xdr.ScVal.scvBytes(Buffer.from(b));
const scvAddress = (addr: string): xdr.ScVal => new Address(addr).toScVal();
const scvI128 = (n: bigint): xdr.ScVal => nativeToScVal(n, { type: "i128" });
const scvField = (f: Field): xdr.ScVal => scvBytes(fieldToBytes(f));

/**
 * Builds Soroban invoke operations against a deployed ObscuraPool contract. The returned
 * values are `xdr.Operation`s; wrap them with {@link buildTransaction} (or your own
 * TransactionBuilder) to produce a submittable, signable transaction.
 */
export class ObscuraContract {
  readonly contract: Contract;
  readonly networkPassphrase: string;

  constructor(opts: { contractId: string; networkPassphrase?: string }) {
    this.contract = new Contract(opts.contractId);
    this.networkPassphrase = opts.networkPassphrase ?? Networks.TESTNET;
  }

  /** deposit(from, asset, amount, commitment) -> u32. SPEC sec 9.1. */
  depositOp(args: { from: string; asset: string; amount: bigint; commitment: Field }): xdr.Operation {
    return this.contract.call(
      "deposit",
      scvAddress(args.from),
      scvAddress(args.asset),
      scvI128(args.amount),
      scvField(args.commitment),
    );
  }

  /** withdraw(proof, public_inputs, recipient, amount, asset). SPEC sec 9.1. */
  withdrawOp(args: {
    proof: Uint8Array;
    publicInputs: Uint8Array;
    recipient: string;
    amount: bigint;
    asset: string;
  }): xdr.Operation {
    this.assertProofLen(args.proof);
    return this.contract.call(
      "withdraw",
      scvBytes(args.proof),
      scvBytes(args.publicInputs),
      scvAddress(args.recipient),
      scvI128(args.amount),
      scvAddress(args.asset),
    );
  }

  /**
   * transfer(proof, public_inputs, memos). SPEC sec 9.1.
   * `memos` are opaque encrypted note payloads (sealed to each output owner's viewing
   * key), aligned with the two output commitments; the contract re-emits them in
   * `TransferEvent` for recipient note discovery. Defaults to empty.
   */
  transferOp(args: {
    proof: Uint8Array;
    publicInputs: Uint8Array;
    memos?: Uint8Array[];
  }): xdr.Operation {
    this.assertProofLen(args.proof);
    const memos = xdr.ScVal.scvVec((args.memos ?? []).map(scvBytes));
    return this.contract.call("transfer", scvBytes(args.proof), scvBytes(args.publicInputs), memos);
  }

  /** place_order(proof, public_inputs). SPEC sec 9.1. */
  placeOrderOp(args: { proof: Uint8Array; publicInputs: Uint8Array }): xdr.Operation {
    this.assertProofLen(args.proof);
    return this.contract.call("place_order", scvBytes(args.proof), scvBytes(args.publicInputs));
  }

  /** match_orders(proof, public_inputs, leaf_memos, residual_memos). SPEC sec 9.1.
   *  `leafMemos` deliver the inserted fill/refund notes' secrets (aligned with the emitted
   *  leaf commitments); `residualMemos` deliver the residual orders' secrets. Both are
   *  untrusted transport re-emitted in `OrderMatchedEvent`. */
  matchOrdersOp(args: {
    proof: Uint8Array;
    publicInputs: Uint8Array;
    leafMemos?: Uint8Array[];
    residualMemos?: Uint8Array[];
  }): xdr.Operation {
    this.assertProofLen(args.proof);
    const leaf = xdr.ScVal.scvVec((args.leafMemos ?? []).map(scvBytes));
    const residual = xdr.ScVal.scvVec((args.residualMemos ?? []).map(scvBytes));
    return this.contract.call("match_orders", scvBytes(args.proof), scvBytes(args.publicInputs), leaf, residual);
  }

  /** cancel_order(proof, public_inputs). SPEC sec 9.1. */
  cancelOrderOp(args: { proof: Uint8Array; publicInputs: Uint8Array }): xdr.Operation {
    this.assertProofLen(args.proof);
    return this.contract.call("cancel_order", scvBytes(args.proof), scvBytes(args.publicInputs));
  }

  // --- Lending (LENDING_SPEC) --------------------------------------------
  //
  // Collateral asset/amount appear as plain args because they are public by
  // design; the contract binds them to the proof's public inputs. Debt never
  // appears — the contract does not know it.

  /** open_position(proof, public_inputs, collateral_asset, collateral_amount). */
  openPositionOp(args: {
    proof: Uint8Array;
    publicInputs: Uint8Array;
    collateralAsset: string;
    collateralAmount: bigint;
  }): xdr.Operation {
    this.assertProofLen(args.proof);
    return this.contract.call(
      "open_position",
      scvBytes(args.proof),
      scvBytes(args.publicInputs),
      scvAddress(args.collateralAsset),
      scvI128(args.collateralAmount),
    );
  }

  /** borrow(proof, public_inputs, old_position, debt_asset, borrow_amount, memo). */
  borrowOp(args: {
    proof: Uint8Array;
    publicInputs: Uint8Array;
    oldPosition: Field;
    debtAsset: string;
    borrowAmount: bigint;
    memo?: Uint8Array;
  }): xdr.Operation {
    this.assertProofLen(args.proof);
    return this.contract.call(
      "borrow",
      scvBytes(args.proof),
      scvBytes(args.publicInputs),
      scvField(args.oldPosition),
      scvAddress(args.debtAsset),
      scvI128(args.borrowAmount),
      scvBytes(args.memo ?? new Uint8Array()),
    );
  }

  /** repay(proof, public_inputs, old_position, debt_asset, repay_amount). */
  repayOp(args: {
    proof: Uint8Array;
    publicInputs: Uint8Array;
    oldPosition: Field;
    debtAsset: string;
    repayAmount: bigint;
  }): xdr.Operation {
    this.assertProofLen(args.proof);
    return this.contract.call(
      "repay",
      scvBytes(args.proof),
      scvBytes(args.publicInputs),
      scvField(args.oldPosition),
      scvAddress(args.debtAsset),
      scvI128(args.repayAmount),
    );
  }

  /** withdraw_collateral(proof, public_inputs, old_position, new_collateral_amount, memo). */
  withdrawCollateralOp(args: {
    proof: Uint8Array;
    publicInputs: Uint8Array;
    oldPosition: Field;
    newCollateralAmount: bigint;
    memo?: Uint8Array;
  }): xdr.Operation {
    this.assertProofLen(args.proof);
    return this.contract.call(
      "withdraw_collateral",
      scvBytes(args.proof),
      scvBytes(args.publicInputs),
      scvField(args.oldPosition),
      scvI128(args.newCollateralAmount),
      scvBytes(args.memo ?? new Uint8Array()),
    );
  }

  /** attest_solvency(proof, public_inputs). Refreshes the deadline; mutates no notes. */
  attestSolvencyOp(args: { proof: Uint8Array; publicInputs: Uint8Array }): xdr.Operation {
    this.assertProofLen(args.proof);
    return this.contract.call("attest_solvency", scvBytes(args.proof), scvBytes(args.publicInputs));
  }

  /** liquidate_stale(liquidator, position). No proof — collateral is public. */
  liquidateStaleOp(args: { liquidator: string; position: Field }): xdr.Operation {
    return this.contract.call(
      "liquidate_stale",
      scvAddress(args.liquidator),
      scvField(args.position),
    );
  }

  /** supply(proof, public_inputs, asset, amount, memo). */
  supplyOp(args: {
    proof: Uint8Array;
    publicInputs: Uint8Array;
    asset: string;
    amount: bigint;
    memo?: Uint8Array;
  }): xdr.Operation {
    this.assertProofLen(args.proof);
    return this.contract.call(
      "supply",
      scvBytes(args.proof),
      scvBytes(args.publicInputs),
      scvAddress(args.asset),
      scvI128(args.amount),
      scvBytes(args.memo ?? new Uint8Array()),
    );
  }

  /** redeem(proof, public_inputs, asset, amount, memos). */
  redeemOp(args: {
    proof: Uint8Array;
    publicInputs: Uint8Array;
    asset: string;
    amount: bigint;
    memos?: Uint8Array[];
  }): xdr.Operation {
    this.assertProofLen(args.proof);
    return this.contract.call(
      "redeem",
      scvBytes(args.proof),
      scvBytes(args.publicInputs),
      scvAddress(args.asset),
      scvI128(args.amount),
      xdr.ScVal.scvVec((args.memos ?? []).map(scvBytes)),
    );
  }

  /**
   * Convenience: build an op directly from a {@link ProofData} for a two-arg
   * (proof, public_inputs) method. Use {@link withdrawOp} for withdraw and
   * {@link matchOrdersOp} for match_orders (both take extra args).
   */
  proofOp(method: "transfer" | "place_order" | "cancel_order", proofData: ProofData): xdr.Operation {
    const proof = proofData.proof;
    const publicInputs = encodePublicInputs(proofData.publicInputs);
    switch (method) {
      case "transfer":
        return this.transferOp({ proof, publicInputs });
      case "place_order":
        return this.placeOrderOp({ proof, publicInputs });
      case "cancel_order":
        return this.cancelOrderOp({ proof, publicInputs });
      default:
        throw new Error(`use withdrawOp / matchOrdersOp directly for method ${method}`);
    }
  }

  private assertProofLen(proof: Uint8Array): void {
    if (proof.length !== 0 && proof.length !== PROOF_BYTES) {
      throw new Error(`proof must be ${PROOF_BYTES} bytes (got ${proof.length})`);
    }
  }
}

/**
 * Assemble an unsigned transaction wrapping a single invoke operation. The caller is
 * responsible for Soroban footprint preparation (`rpc.Server.prepareTransaction`) and
 * signing before submission.
 */
export function buildTransaction(
  source: Account,
  operation: xdr.Operation,
  opts: { networkPassphrase?: string; fee?: string; timeoutSeconds?: number } = {},
): Transaction {
  return new TransactionBuilder(source, { fee: opts.fee ?? BASE_FEE })
    .setNetworkPassphrase(opts.networkPassphrase ?? Networks.TESTNET)
    .addOperation(operation)
    .setTimeout(opts.timeoutSeconds ?? 30)
    .build();
}
