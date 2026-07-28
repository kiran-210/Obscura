/**
 * @obscura/sdk — TypeScript client for the Obscura privacy platform on Stellar.
 *
 * Re-exports every module plus a {@link Obscura} orchestrator implementing the
 * {@link ObscuraSdk} surface the frontend expects. All cryptographic invariants
 * (Poseidon2, commitments, Merkle tree, public-input encoding) follow SHARED.md.
 */
import type { xdr } from "@stellar/stellar-sdk";

import { TREE_DEPTH, ZEROS } from "./constants.js";
import { MerkleTree } from "./merkle.js";
import { computeNullifier, createNote, createOutputNote, deriveKeys, noteNullifier } from "./note.js";
import { createOrder, orderLockedAmount } from "./order.js";
import { createPosition, isSolvent, toScaled, type Position } from "./lending.js";
import {
  buildBorrowInputs,
  buildPositionOpenInputs,
  buildRepayInputs,
  buildSolvencyAttestationInputs,
  buildWithdrawCollateralInputs,
} from "./lending-inputs.js";
import { fieldToHex, randomField, toField, type Field } from "./poseidon.js";
import {
  NoirProver,
  buildCancelOrderInputs,
  buildPlaceOrderInputs,
  buildTransferInputs,
  buildWithdrawInputs,
  type CircuitInputMap,
  type TransferInputNote,
} from "./prover.js";
import { ObscuraContract, encodePublicInputs, recipientHash, type CircuitName } from "./stellar.js";
import type { Asset, BalanceNote, KeyPair, Order, OrderParams, ProofData } from "./types.js";
import { Wallet } from "./wallet.js";

// ---- Re-exports -----------------------------------------------------------
export * from "./constants.js";
export * from "./poseidon.js";
export * from "./types.js";
export * from "./merkle.js";
export * from "./note.js";
export * from "./order.js";
export * from "./match.js";
export * from "./note-crypto.js";
export * from "./wallet.js";
export * from "./prover.js";
export * from "./stellar.js";
export * from "./lending.js";
export * from "./lending-inputs.js";

// ---- Public SDK surface ---------------------------------------------------

/** Result of a deposit: the new note and the unsigned Soroban operation. */
export interface DepositResult {
  note: BalanceNote;
  operation: xdr.Operation;
  commitment: Field;
}

/** Result of a proof-gated action: the unsigned operation plus the proof + state deltas. */
export interface ProvenResult {
  operation: xdr.Operation;
  proof: ProofData;
  /** Nullifiers published by this action. */
  nullifiers: Field[];
  /** New output notes this wallet owns (await on-chain confirmation for leafIndex). */
  outputNotes: BalanceNote[];
}

/**
 * The high-level SDK surface mirrored by the frontend (SPEC sec 10.2). Proof-gated
 * methods require the corresponding compiled circuit to be configured (see
 * {@link ObscuraConfig.provers}); the deterministic crypto/encoding around them runs
 * regardless.
 */
export interface ObscuraSdk {
  deposit(params: { asset: Asset; amount: bigint; from: string }): DepositResult;
  withdraw(params: { note: BalanceNote; recipient: string }): Promise<ProvenResult>;
  transfer(params: {
    fromNotes: BalanceNote[];
    recipientOwnerKey: Field;
    amount: bigint;
    extDataHash?: Field;
  }): Promise<ProvenResult>;
  placeOrder(params: { note: BalanceNote; order: OrderParams }): Promise<ProvenResult & { order: Order }>;
  cancelOrder(params: { order: Order; spendingKey: Field }): Promise<ProvenResult>;
  getShieldedBalances(): Map<Field, bigint>;
  getOpenOrders(): Order[];
}

/** Construction options for {@link Obscura}. */
export interface ObscuraConfig {
  contractId: string;
  networkPassphrase?: string;
  /** Wallet spending key; a random one is generated if omitted. */
  spendingKey?: Field;
  /** Compiled-circuit provers, one per circuit (pending feat/circuits). */
  provers?: Partial<Record<CircuitName, NoirProver>>;
  /** Local mirror of the on-chain Merkle tree (kept in sync via {@link Obscura.observeCommitment}). */
  tree?: MerkleTree;
  /** Pre-seeded wallet. */
  wallet?: Wallet;
}

/**
 * Orchestrates notes, the local Merkle mirror, proof generation, and Soroban tx
 * building. The local tree must be kept in sync with on-chain Deposit/Transfer/
 * settlement commitments via {@link observeCommitment}, in global insertion order, for
 * Merkle proofs to be valid.
 */
export class Obscura implements ObscuraSdk {
  readonly keys: KeyPair;
  readonly wallet: Wallet;
  readonly tree: MerkleTree;
  readonly contract: ObscuraContract;
  private readonly provers: Partial<Record<CircuitName, NoirProver>>;

  constructor(config: ObscuraConfig) {
    this.keys = deriveKeys(config.spendingKey ?? randomField());
    this.wallet = config.wallet ?? new Wallet();
    this.tree = config.tree ?? new MerkleTree(TREE_DEPTH);
    this.contract = new ObscuraContract({
      contractId: config.contractId,
      networkPassphrase: config.networkPassphrase,
    });
    this.provers = config.provers ?? {};
  }

  /** This wallet's public owner key. */
  get ownerKey(): Field {
    return this.keys.ownerKey;
  }

  /**
   * Mirror an on-chain commitment into the local tree (call for EVERY deposit/output
   * commitment in global order). If it matches an owned note missing a leafIndex, that
   * note is bound to the inserted index. Returns the leaf index.
   */
  observeCommitment(commitment: Field): number {
    const index = this.tree.insert(commitment);
    const owned = this.wallet.getNotes().find((n) => n.commitment === commitment && n.leafIndex === undefined);
    if (owned) owned.leafIndex = index;
    return index;
  }

  // --- Bridge ---

  deposit(params: { asset: Asset; amount: bigint; from: string }): DepositResult {
    if (!params.asset.address) {
      throw new Error("deposit requires asset.address (the SAC contract address); use nativeAsset()/assetFromSac()");
    }
    const note = createNote({
      assetId: params.asset.assetId,
      amount: params.amount,
      spendingKey: this.keys.spendingKey,
    });
    note.assetAddress = params.asset.address;
    const operation = this.contract.depositOp({
      from: params.from,
      asset: params.asset.address,
      amount: params.amount,
      commitment: note.commitment,
    });
    this.wallet.addNote(note);
    return { note, operation, commitment: note.commitment };
  }

  async withdraw(params: { note: BalanceNote; recipient: string }): Promise<ProvenResult> {
    const { note } = params;
    const merkle = this.merkleProofFor(note);
    const nullifier = noteNullifier(note);
    const rHash = recipientHash(params.recipient);
    const inputs = buildWithdrawInputs({
      merkleRoot: merkle.root,
      nullifier,
      recipientHash: rHash,
      amount: note.amount,
      assetId: note.assetId,
      noteOwnerKey: note.ownerKey,
      noteBlinding: note.blinding,
      spendingKey: note.spendingKey,
      merklePath: merkle.pathElements,
      merkleIndices: merkle.pathIndices,
    });
    const proof = await this.prove("withdraw", inputs);
    const operation = this.contract.withdrawOp({
      proof: proof.proof,
      publicInputs: encodePublicInputs(proof.publicInputs),
      recipient: params.recipient,
      amount: note.amount,
      asset: this.assetAddressOrThrow(note),
    });
    this.wallet.markNoteSpent(note);
    return { operation, proof, nullifiers: [nullifier], outputNotes: [] };
  }

  // --- Pay ---

  async transfer(params: {
    fromNotes: BalanceNote[];
    recipientOwnerKey: Field;
    amount: bigint;
    extDataHash?: Field;
  }): Promise<ProvenResult> {
    if (params.fromNotes.length === 0) throw new Error("transfer requires at least one input note");
    if (params.fromNotes.length > 2) throw new Error("transfer circuit supports at most 2 input notes");
    const assetId = params.fromNotes[0]!.assetId;
    const total = params.fromNotes.reduce((s, n) => s + n.amount, 0n);
    if (total < params.amount) throw new Error("input notes do not cover transfer amount");
    const change = total - params.amount;

    const recipientNote = createOutputNote({
      assetId,
      amount: params.amount,
      ownerKey: params.recipientOwnerKey,
    });
    const changeNote = createNote({ assetId, amount: change, spendingKey: this.keys.spendingKey });

    // Pad to the circuit's fixed 2-input shape with a 0-amount dummy (the circuit skips
    // the Merkle check for 0-amount inputs; SPEC sec 8.2).
    const realInputs = params.fromNotes;
    const dummy =
      realInputs.length < 2
        ? createNote({ assetId, amount: 0n, spendingKey: this.keys.spendingKey })
        : undefined;
    const inputNotes = dummy ? [...realInputs, dummy] : realInputs;

    const nullifiers = inputNotes.map(noteNullifier) as [Field, Field];
    const extDataHash = toField(params.extDataHash ?? 0n);

    const zerosPath = ZEROS.slice(0, TREE_DEPTH);
    const zerosIdx = new Array<number>(TREE_DEPTH).fill(0);
    const inNotes = inputNotes.map((n): TransferInputNote => {
      const mp = n.amount === 0n ? { pathElements: zerosPath, pathIndices: zerosIdx } : this.merkleProofFor(n);
      return {
        amount: n.amount,
        assetId: n.assetId,
        spendingKey: n.spendingKey,
        blinding: n.blinding,
        merklePath: mp.pathElements,
        merkleIndices: mp.pathIndices,
      };
    }) as [TransferInputNote, TransferInputNote];

    const inputs = buildTransferInputs({
      merkleRoot: this.tree.root,
      nullifiers,
      outCommitments: [recipientNote.commitment, changeNote.commitment],
      extDataHash,
      inNotes,
      outNotes: [
        { amount: recipientNote.amount, assetId: recipientNote.assetId, ownerKey: recipientNote.ownerKey, blinding: recipientNote.blinding },
        { amount: changeNote.amount, assetId: changeNote.assetId, ownerKey: changeNote.ownerKey, blinding: changeNote.blinding },
      ],
    });
    const proof = await this.prove("transfer", inputs);
    const operation = this.contract.transferOp({
      proof: proof.proof,
      publicInputs: encodePublicInputs(proof.publicInputs),
    });
    for (const n of params.fromNotes) this.wallet.markNoteSpent(n);
    this.wallet.addNote(changeNote);
    return { operation, proof, nullifiers, outputNotes: [changeNote] };
  }

  // --- Swap ---

  async placeOrder(params: { note: BalanceNote; order: OrderParams }): Promise<ProvenResult & { order: Order }> {
    const { note } = params;
    const order = createOrder({ ...params.order, spendingKey: note.spendingKey });
    const locked = orderLockedAmount(order);
    if (note.assetId !== locked.assetId) throw new Error("note asset does not match order's locked asset");
    if (note.amount < locked.amount) throw new Error("note balance insufficient to lock order");
    const changeAmount = note.amount - locked.amount;

    const merkle = this.merkleProofFor(note);
    const nullifier = noteNullifier(note);
    const changeNote =
      changeAmount > 0n
        ? createNote({ assetId: note.assetId, amount: changeAmount, spendingKey: note.spendingKey })
        : undefined;
    const changeCommitment = changeNote?.commitment ?? 0n;

    const inputs = buildPlaceOrderInputs({
      merkleRoot: merkle.root,
      nullifier,
      orderCommitment: order.commitment,
      changeCommitment,
      lockedAssetId: locked.assetId,
      noteAmount: note.amount,
      noteAssetId: note.assetId,
      noteBlinding: note.blinding,
      spendingKey: note.spendingKey,
      merklePath: merkle.pathElements,
      merkleIndices: merkle.pathIndices,
      orderSide: order.side,
      orderPrice: order.price,
      orderAmount: order.amount,
      orderAssetBase: order.assetBase,
      orderAssetQuote: order.assetQuote,
      orderNonce: order.nonce,
      changeAmount,
      changeBlinding: changeNote?.blinding ?? 0n,
    });
    const proof = await this.prove("place_order", inputs);
    const operation = this.contract.placeOrderOp({
      proof: proof.proof,
      publicInputs: encodePublicInputs(proof.publicInputs),
    });
    this.wallet.markNoteSpent(note);
    this.wallet.addOrder(order);
    const outputNotes = changeNote ? [changeNote] : [];
    if (changeNote) this.wallet.addNote(changeNote);
    return { operation, proof, nullifiers: [nullifier], outputNotes, order };
  }

  async cancelOrder(params: { order: Order; spendingKey: Field }): Promise<ProvenResult> {
    const { order } = params;
    const locked = orderLockedAmount(order);
    const refundNote = createNote({
      assetId: locked.assetId,
      amount: locked.amount,
      spendingKey: params.spendingKey,
    });
    const inputs = buildCancelOrderInputs({
      orderCommitment: order.commitment,
      refundCommitment: refundNote.commitment,
      refundAssetId: locked.assetId,
      side: order.side,
      price: order.price,
      amount: order.amount,
      assetBase: order.assetBase,
      assetQuote: order.assetQuote,
      nonce: order.nonce,
      spendingKey: params.spendingKey,
      refundBlinding: refundNote.blinding,
    });
    const proof = await this.prove("cancel_order", inputs);
    const operation = this.contract.cancelOrderOp({
      proof: proof.proof,
      publicInputs: encodePublicInputs(proof.publicInputs),
    });
    this.wallet.removeOrder(order.commitment);
    this.wallet.addNote(refundNote);
    return { operation, proof, nullifiers: [], outputNotes: [refundNote] };
  }

  // --- Views ---

  getShieldedBalances(): Map<Field, bigint> {
    return this.wallet.getShieldedBalances();
  }

  getOpenOrders(): Order[] {
    return this.wallet.getOpenOrders();
  }

  // --- internals ---

  // =======================================================================
  // Lending (LENDING_SPEC)
  //
  // Collateral amounts are PUBLIC — that is what lets a stale position be seized
  // with no keeper. Debt is private and lives only inside the position
  // commitment, so THE CALLER must retain the returned Position object: losing
  // `debtScaled` or `nonce` makes the position unprovable and the collateral
  // unrecoverable until the deadline lapses and it is seized.
  // =======================================================================

  /** Spend a balance note as collateral, opening a position with zero debt. */
  async openPosition(params: {
    collateralNote: BalanceNote;
    debtAssetId: Field;
  }): Promise<ProvenResult & { position: Position }> {
    const { collateralNote: note } = params;
    const merkle = this.merkleProofFor(note);
    const nullifier = noteNullifier(note);
    const position = createPosition({
      collateralAsset: note.assetId,
      collateralAmount: note.amount,
      debtAsset: params.debtAssetId,
      spendingKey: this.keys.spendingKey,
    });

    const inputs = buildPositionOpenInputs({
      merkleRoot: merkle.root,
      nullifier,
      positionCommitment: position.commitment,
      collateralAsset: note.assetId,
      collateralAmount: note.amount,
      noteBlinding: note.blinding,
      spendingKey: note.spendingKey,
      merklePath: merkle.pathElements,
      merkleIndices: merkle.pathIndices,
      debtAsset: position.debtAsset,
      positionNonce: position.nonce,
    });
    const proof = await this.prove("position_open", inputs);
    const operation = this.contract.openPositionOp({
      proof: proof.proof,
      publicInputs: encodePublicInputs(proof.publicInputs),
      collateralAsset: this.assetAddressOrThrow(note),
      collateralAmount: note.amount,
    });
    this.wallet.markNoteSpent(note);
    return { operation, proof, nullifiers: [nullifier], outputNotes: [], position };
  }

  /**
   * Borrow against a position. Returns the replacement position (the old one is
   * nullified) and the minted balance note.
   *
   * `borrowAmount` is public — a pooled protocol cannot track solvency without it
   * (LENDING_SPEC §1.1).
   */
  async borrow(params: {
    position: Position;
    positionLeafIndex: number;
    debtAsset: Asset;
    borrowAmount: bigint;
    collateralPrice: bigint;
    debtPrice: bigint;
    borrowIndex: bigint;
    maxLtvBps: number;
    memo?: Uint8Array;
  }): Promise<ProvenResult & { position: Position }> {
    const { position: old } = params;
    if (!old.spendingKey) throw new Error("borrow requires a position with its spendingKey");

    // Fail here rather than burning a proof on something the circuit will reject.
    const newDebtScaled = old.debtScaled + toScaled(params.borrowAmount, params.borrowIndex);
    if (
      !isSolvent({
        collateralAmount: old.collateralAmount,
        collateralPrice: params.collateralPrice,
        debtScaled: newDebtScaled,
        debtPrice: params.debtPrice,
        borrowIndex: params.borrowIndex,
        bps: params.maxLtvBps,
      })
    ) {
      throw new Error(
        `borrowing ${params.borrowAmount} would breach the ${params.maxLtvBps / 100}% LTV ceiling`,
      );
    }

    const merkle = this.tree.generateProof(params.positionLeafIndex);
    const nullifier = computeNullifier(old.commitment, old.spendingKey);
    const next = createPosition({
      collateralAsset: old.collateralAsset,
      collateralAmount: old.collateralAmount,
      debtAsset: old.debtAsset,
      debtScaled: newDebtScaled,
      spendingKey: old.spendingKey,
    });
    const outNote = createNote({
      assetId: params.debtAsset.assetId,
      amount: params.borrowAmount,
      spendingKey: this.keys.spendingKey,
    });
    if (params.debtAsset.address) outNote.assetAddress = params.debtAsset.address;

    const inputs = buildBorrowInputs({
      merkleRoot: merkle.root,
      oldPositionCommitment: old.commitment,
      positionNullifier: nullifier,
      newPositionCommitment: next.commitment,
      outNoteCommitment: outNote.commitment,
      collateralAsset: old.collateralAsset,
      collateralAmount: old.collateralAmount,
      debtAsset: old.debtAsset,
      borrowAmount: params.borrowAmount,
      collateralPrice: params.collateralPrice,
      debtPrice: params.debtPrice,
      borrowIndex: params.borrowIndex,
      maxLtvBps: params.maxLtvBps,
      oldDebtScaled: old.debtScaled,
      spendingKey: old.spendingKey,
      merklePath: merkle.pathElements,
      merkleIndices: merkle.pathIndices,
      oldNonce: old.nonce,
      newNonce: next.nonce,
      outBlinding: outNote.blinding,
    });
    const proof = await this.prove("borrow", inputs);
    const operation = this.contract.borrowOp({
      proof: proof.proof,
      publicInputs: encodePublicInputs(proof.publicInputs),
      oldPosition: old.commitment,
      debtAsset: params.debtAsset.address ?? "",
      borrowAmount: params.borrowAmount,
      ...(params.memo ? { memo: params.memo } : {}),
    });
    this.wallet.addNote(outNote);
    return { operation, proof, nullifiers: [nullifier], outputNotes: [outNote], position: next };
  }

  /** Repay debt from a balance note of the debt asset. */
  async repay(params: {
    position: Position;
    positionLeafIndex: number;
    fromNote: BalanceNote;
    repayAmount: bigint;
    borrowIndex: bigint;
  }): Promise<ProvenResult & { position: Position }> {
    const { position: old, fromNote } = params;
    if (!old.spendingKey) throw new Error("repay requires a position with its spendingKey");
    if (fromNote.amount < params.repayAmount) {
      throw new Error("funding note does not cover the repayment");
    }

    const posMerkle = this.tree.generateProof(params.positionLeafIndex);
    const noteMerkle = this.merkleProofFor(fromNote);
    const posNullifier = computeNullifier(old.commitment, old.spendingKey);
    const noteNf = noteNullifier(fromNote);

    // The circuit floors the scaled debt at zero, so overpayment is allowed.
    const repayScaled = toScaled(params.repayAmount, params.borrowIndex);
    const nextScaled = old.debtScaled >= repayScaled ? old.debtScaled - repayScaled : 0n;
    const next = createPosition({
      collateralAsset: old.collateralAsset,
      collateralAmount: old.collateralAmount,
      debtAsset: old.debtAsset,
      debtScaled: nextScaled,
      spendingKey: old.spendingKey,
    });

    const changeAmount = fromNote.amount - params.repayAmount;
    const changeNote =
      changeAmount > 0n
        ? createNote({
            assetId: fromNote.assetId,
            amount: changeAmount,
            spendingKey: this.keys.spendingKey,
          })
        : undefined;

    const inputs = buildRepayInputs({
      merkleRoot: posMerkle.root,
      oldPositionCommitment: old.commitment,
      positionNullifier: posNullifier,
      noteNullifier: noteNf,
      newPositionCommitment: next.commitment,
      changeCommitment: changeNote ? changeNote.commitment : toField(0n),
      collateralAsset: old.collateralAsset,
      collateralAmount: old.collateralAmount,
      debtAsset: old.debtAsset,
      repayAmount: params.repayAmount,
      borrowIndex: params.borrowIndex,
      oldDebtScaled: old.debtScaled,
      spendingKey: old.spendingKey,
      positionPath: posMerkle.pathElements,
      positionIndices: posMerkle.pathIndices,
      noteAmount: fromNote.amount,
      noteBlinding: fromNote.blinding,
      notePath: noteMerkle.pathElements,
      noteIndices: noteMerkle.pathIndices,
      oldNonce: old.nonce,
      newNonce: next.nonce,
      changeBlinding: changeNote ? changeNote.blinding : toField(0n),
    });
    const proof = await this.prove("repay", inputs);
    const operation = this.contract.repayOp({
      proof: proof.proof,
      publicInputs: encodePublicInputs(proof.publicInputs),
      oldPosition: old.commitment,
      debtAsset: this.assetAddressOrThrow(fromNote),
      repayAmount: params.repayAmount,
    });
    this.wallet.markNoteSpent(fromNote);
    if (changeNote) this.wallet.addNote(changeNote);
    return {
      operation,
      proof,
      nullifiers: [posNullifier, noteNf],
      outputNotes: changeNote ? [changeNote] : [],
      position: next,
    };
  }

  /** Withdraw part of a position's collateral; solvency is re-checked afterwards. */
  async withdrawCollateral(params: {
    position: Position;
    positionLeafIndex: number;
    withdrawAmount: bigint;
    collateralAsset: Asset;
    collateralPrice: bigint;
    debtPrice: bigint;
    borrowIndex: bigint;
    maxLtvBps: number;
    memo?: Uint8Array;
  }): Promise<ProvenResult & { position: Position }> {
    const { position: old } = params;
    if (!old.spendingKey) throw new Error("withdrawCollateral requires a position with its spendingKey");
    if (params.withdrawAmount <= 0n || params.withdrawAmount >= old.collateralAmount) {
      throw new Error("withdrawAmount must be positive and leave some collateral behind");
    }
    const remaining = old.collateralAmount - params.withdrawAmount;
    if (
      !isSolvent({
        collateralAmount: remaining,
        collateralPrice: params.collateralPrice,
        debtScaled: old.debtScaled,
        debtPrice: params.debtPrice,
        borrowIndex: params.borrowIndex,
        bps: params.maxLtvBps,
      })
    ) {
      throw new Error("withdrawal would leave the position under-collateralised");
    }

    const merkle = this.tree.generateProof(params.positionLeafIndex);
    const nullifier = computeNullifier(old.commitment, old.spendingKey);
    const next = createPosition({
      collateralAsset: old.collateralAsset,
      collateralAmount: remaining,
      debtAsset: old.debtAsset,
      debtScaled: old.debtScaled,
      spendingKey: old.spendingKey,
    });
    const outNote = createNote({
      assetId: old.collateralAsset,
      amount: params.withdrawAmount,
      spendingKey: this.keys.spendingKey,
    });
    if (params.collateralAsset.address) outNote.assetAddress = params.collateralAsset.address;

    const inputs = buildWithdrawCollateralInputs({
      merkleRoot: merkle.root,
      oldPositionCommitment: old.commitment,
      positionNullifier: nullifier,
      newPositionCommitment: next.commitment,
      outNoteCommitment: outNote.commitment,
      collateralAsset: old.collateralAsset,
      oldCollateralAmount: old.collateralAmount,
      newCollateralAmount: remaining,
      debtAsset: old.debtAsset,
      collateralPrice: params.collateralPrice,
      debtPrice: params.debtPrice,
      borrowIndex: params.borrowIndex,
      maxLtvBps: params.maxLtvBps,
      debtScaled: old.debtScaled,
      spendingKey: old.spendingKey,
      merklePath: merkle.pathElements,
      merkleIndices: merkle.pathIndices,
      oldNonce: old.nonce,
      newNonce: next.nonce,
      outBlinding: outNote.blinding,
    });
    const proof = await this.prove("withdraw_collateral", inputs);
    const operation = this.contract.withdrawCollateralOp({
      proof: proof.proof,
      publicInputs: encodePublicInputs(proof.publicInputs),
      oldPosition: old.commitment,
      newCollateralAmount: remaining,
      ...(params.memo ? { memo: params.memo } : {}),
    });
    this.wallet.addNote(outNote);
    return { operation, proof, nullifiers: [nullifier], outputNotes: [outNote], position: next };
  }

  /**
   * Prove a position is still above the liquidation threshold, refreshing its
   * deadline. Mutates no notes: the position commitment is unchanged, so the
   * caller keeps using the same {@link Position}.
   */
  async attestSolvency(params: {
    position: Position;
    collateralPrice: bigint;
    debtPrice: bigint;
    borrowIndex: bigint;
    liqThresholdBps: number;
  }): Promise<{ operation: xdr.Operation; proof: ProofData }> {
    const { position } = params;
    if (!position.spendingKey) throw new Error("attestSolvency requires a position with its spendingKey");
    if (
      !isSolvent({
        collateralAmount: position.collateralAmount,
        collateralPrice: params.collateralPrice,
        debtScaled: position.debtScaled,
        debtPrice: params.debtPrice,
        borrowIndex: params.borrowIndex,
        bps: params.liqThresholdBps,
      })
    ) {
      // No proof exists for an underwater position — the circuit would reject it.
      throw new Error(
        "position is below the liquidation threshold and cannot attest; repay or add collateral first",
      );
    }

    const inputs = buildSolvencyAttestationInputs({
      positionCommitment: position.commitment,
      collateralAsset: position.collateralAsset,
      collateralAmount: position.collateralAmount,
      debtAsset: position.debtAsset,
      collateralPrice: params.collateralPrice,
      debtPrice: params.debtPrice,
      borrowIndex: params.borrowIndex,
      liqThresholdBps: params.liqThresholdBps,
      debtScaled: position.debtScaled,
      spendingKey: position.spendingKey,
      nonce: position.nonce,
    });
    const proof = await this.prove("solvency_attestation", inputs);
    const operation = this.contract.attestSolvencyOp({
      proof: proof.proof,
      publicInputs: encodePublicInputs(proof.publicInputs),
    });
    return { operation, proof };
  }

  private merkleProofFor(note: BalanceNote) {
    if (note.leafIndex === undefined) {
      throw new Error(
        `note ${fieldToHex(note.commitment)} has no leafIndex; call observeCommitment for it (sync the local tree) before proving`,
      );
    }
    return this.tree.generateProof(note.leafIndex);
  }

  private async prove(circuit: CircuitName, inputs: CircuitInputMap): Promise<ProofData> {
    const prover = this.provers[circuit];
    if (!prover) {
      throw new Error(
        `no prover configured for circuit "${circuit}". Provide a compiled circuit via ObscuraConfig.provers (pending feat/circuits integration).`,
      );
    }
    return prover.prove(inputs);
  }

  private assetAddressOrThrow(note: BalanceNote): string {
    // The withdraw SAC transfer needs the asset's SAC address (set at deposit time).
    if (!note.assetAddress) {
      throw new Error("withdraw requires note.assetAddress (the SAC address) to drive the on-chain transfer");
    }
    return note.assetAddress;
  }
}

export default Obscura;
