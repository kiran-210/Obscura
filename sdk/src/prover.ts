/**
 * UltraHonk proof generation via @noir-lang/noir_js (witness gen) + @aztec/bb.js
 * (`UltraHonkBackend`). SHARED.md sec 8.
 *
 * The KECCAK transcript is mandatory: the Soroban verifier only accepts the Keccak-256
 * transcript (`bb prove --oracle_hash keccak`). In bb.js this is the
 * `{ keccak: true }` option to `generateProof` / `verifyProof` / `getVerificationKey`
 * (confirmed against @aztec/bb.js@0.87.0 `UltraHonkBackendOptions`).
 *
 * Pending integration: the compiled circuit JSONs (`target/<circuit>.json`) live on the
 * `feat/circuits` branch and are not present here. This module is implemented against the
 * noir_js / bb.js interface; pass a loaded `CompiledCircuit` to {@link NoirProver}. The
 * end-to-end pipeline is exercised in prover.test.ts (skipped unless a circuit is
 * provided / compiled inline).
 *
 * bb.js and noir_js are imported dynamically so that simply importing `@obscura/sdk`
 * does not spin up the Barretenberg WASM/threads.
 */
import { fieldToHex, toField, type Field } from "./poseidon.js";
import { PROOF_BYTES } from "./constants.js";
import type { ProofData } from "./types.js";

/** A Noir-compiled circuit artifact (`nargo compile` output / `target/<name>.json`). */
export interface CompiledCircuit {
  bytecode: string;
  abi: unknown;
  // nargo also emits noir_version, hash, debug_symbols, etc.
  [key: string]: unknown;
}

/** Loose input map passed to the Noir ABI (field names must match the circuit's `main`). */
export type CircuitInput = string | number | bigint | boolean | CircuitInput[] | { [k: string]: CircuitInput };
export type CircuitInputMap = Record<string, CircuitInput>;

export interface ProverOptions {
  /** Use the keccak transcript (must be true to match the on-chain verifier). Default true. */
  keccak?: boolean;
  /** Worker threads for bb.js. Default: let bb.js choose. */
  threads?: number;
}

/**
 * Wraps a single compiled circuit and produces UltraHonk proofs with the keccak
 * transcript. One instance per circuit. Call {@link destroy} when finished to release
 * the bb.js backend.
 */
export class NoirProver {
  private readonly circuit: CompiledCircuit;
  private readonly keccak: boolean;
  private readonly threads?: number;
  // Loaded lazily on first use.
  private noir?: { execute(input: CircuitInputMap): Promise<{ witness: Uint8Array; returnValue: unknown }> };
  private backend?: {
    generateProof(w: Uint8Array, o?: { keccak?: boolean }): Promise<{ proof: Uint8Array; publicInputs: string[] }>;
    verifyProof(p: { proof: Uint8Array; publicInputs: string[] }, o?: { keccak?: boolean }): Promise<boolean>;
    getVerificationKey(o?: { keccak?: boolean }): Promise<Uint8Array>;
    destroy(): Promise<void>;
  };

  constructor(circuit: CompiledCircuit, opts: ProverOptions = {}) {
    this.circuit = circuit;
    this.keccak = opts.keccak ?? true;
    this.threads = opts.threads;
  }

  private async init(): Promise<void> {
    if (this.noir && this.backend) return;
    const { Noir } = await import("@noir-lang/noir_js");
    const { UltraHonkBackend } = await import("@aztec/bb.js");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.noir = new Noir(this.circuit as any) as any;
    const backendOpts = this.threads !== undefined ? { threads: this.threads } : undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.backend = new UltraHonkBackend(this.circuit.bytecode, backendOpts as any) as any;
  }

  /** Generate the witness for the given inputs (no proof). */
  async execute(inputs: CircuitInputMap): Promise<Uint8Array> {
    await this.init();
    const { witness } = await this.noir!.execute(inputs);
    return witness;
  }

  /**
   * Generate a proof. Returns the raw proof bytes (expected {@link PROOF_BYTES} = 14592
   * for the pinned toolchain) and the public inputs as field elements, in the circuit's
   * declared `pub` order. SHARED sec 6-7.
   */
  async prove(inputs: CircuitInputMap): Promise<ProofData> {
    await this.init();
    const { witness } = await this.noir!.execute(inputs);
    const result = await this.backend!.generateProof(witness, { keccak: this.keccak });
    return {
      proof: result.proof,
      publicInputs: result.publicInputs.map((h) => toField(h)),
    };
  }

  /** Verify a proof locally (off-chain sanity check) using the same transcript. */
  async verify(proofData: ProofData): Promise<boolean> {
    await this.init();
    return this.backend!.verifyProof(
      { proof: proofData.proof, publicInputs: proofData.publicInputs.map(fieldToHex) },
      { keccak: this.keccak },
    );
  }

  /** Export the verification key (keccak flavor), matching `bb write_vk --oracle_hash keccak`. */
  async getVerificationKey(): Promise<Uint8Array> {
    await this.init();
    return this.backend!.getVerificationKey({ keccak: this.keccak });
  }

  /** Release the bb.js backend. */
  async destroy(): Promise<void> {
    await this.backend?.destroy();
  }
}

/** Sanity-check that a proof has the expected on-chain length. SHARED sec 6. */
export function isValidProofLength(proof: Uint8Array): boolean {
  return proof.length === PROOF_BYTES;
}

// ---------------------------------------------------------------------------
// Circuit input builders.
//
// These assemble the logical input maps for the main flows using the field names
// from SPEC sec 8. The exact ABI key names must match each circuit's `main` parameters
// on the feat/circuits branch; treat these as the integration contract.
// ---------------------------------------------------------------------------

const fv = (x: Field | bigint | number | string): string => fieldToHex(toField(x));
const iv = (x: bigint | number): string => x.toString();

/** Build inputs for the `withdraw` circuit. SPEC sec 8.1. */
export function buildWithdrawInputs(p: {
  merkleRoot: Field;
  nullifier: Field;
  recipientHash: Field;
  amount: bigint;
  assetId: Field;
  noteOwnerKey: Field;
  noteBlinding: Field;
  spendingKey: Field;
  merklePath: Field[];
  merkleIndices: number[];
}): CircuitInputMap {
  return {
    merkle_root: fv(p.merkleRoot),
    nullifier: fv(p.nullifier),
    recipient_hash: fv(p.recipientHash),
    amount: iv(p.amount),
    asset_id: fv(p.assetId),
    note_amount: iv(p.amount),
    note_asset_id: fv(p.assetId),
    note_owner_key: fv(p.noteOwnerKey),
    note_blinding: fv(p.noteBlinding),
    spending_key: fv(p.spendingKey),
    merkle_path: p.merklePath.map(fv),
    merkle_indices: p.merkleIndices.map(iv),
  };
}

/** A single transfer input note's private data + Merkle proof. */
export interface TransferInputNote {
  amount: bigint;
  assetId: Field;
  spendingKey: Field;
  blinding: Field;
  merklePath: Field[];
  merkleIndices: number[];
}

/** A single transfer output note's data. */
export interface TransferOutputNote {
  amount: bigint;
  assetId: Field;
  ownerKey: Field;
  blinding: Field;
}

/**
 * Build inputs for the `transfer` circuit (2-in / 2-out). SPEC sec 8.2. `inNotes` and
 * `outNotes` must each have length 2 (pad a single input with a 0-amount dummy upstream).
 * Arrays are laid out as `[2]` / `[2][20]` matching the circuit private inputs.
 */
export function buildTransferInputs(p: {
  merkleRoot: Field;
  nullifiers: [Field, Field];
  outCommitments: [Field, Field];
  extDataHash: Field;
  inNotes: [TransferInputNote, TransferInputNote];
  outNotes: [TransferOutputNote, TransferOutputNote];
}): CircuitInputMap {
  return {
    // public
    merkle_root: fv(p.merkleRoot),
    nullifier_0: fv(p.nullifiers[0]),
    nullifier_1: fv(p.nullifiers[1]),
    out_commitment_0: fv(p.outCommitments[0]),
    out_commitment_1: fv(p.outCommitments[1]),
    ext_data_hash: fv(p.extDataHash),
    // private inputs (per SPEC sec 8.2)
    in_amount: p.inNotes.map((n) => iv(n.amount)),
    in_asset_id: p.inNotes.map((n) => fv(n.assetId)),
    in_spending_key: p.inNotes.map((n) => fv(n.spendingKey)),
    in_blinding: p.inNotes.map((n) => fv(n.blinding)),
    in_merkle_path: p.inNotes.map((n) => n.merklePath.map(fv)),
    in_merkle_indices: p.inNotes.map((n) => n.merkleIndices.map(iv)),
    out_amount: p.outNotes.map((n) => iv(n.amount)),
    out_owner_key: p.outNotes.map((n) => fv(n.ownerKey)),
    out_blinding: p.outNotes.map((n) => fv(n.blinding)),
    out_asset_id: p.outNotes.map((n) => fv(n.assetId)),
  };
}

/** Build inputs for the `place_order` circuit. SPEC sec 8.3. */
export function buildPlaceOrderInputs(p: {
  merkleRoot: Field;
  nullifier: Field;
  orderCommitment: Field;
  changeCommitment: Field;
  lockedAssetId: Field;
  noteAmount: bigint;
  noteAssetId: Field;
  noteBlinding: Field;
  spendingKey: Field;
  merklePath: Field[];
  merkleIndices: number[];
  orderSide: number;
  orderPrice: bigint;
  orderAmount: bigint;
  orderAssetBase: Field;
  orderAssetQuote: Field;
  orderNonce: Field;
  changeAmount: bigint;
  changeBlinding: Field;
}): CircuitInputMap {
  return {
    merkle_root: fv(p.merkleRoot),
    nullifier: fv(p.nullifier),
    order_commitment: fv(p.orderCommitment),
    change_commitment: fv(p.changeCommitment),
    locked_asset_id: fv(p.lockedAssetId),
    note_amount: iv(p.noteAmount),
    note_asset_id: fv(p.noteAssetId),
    note_blinding: fv(p.noteBlinding),
    spending_key: fv(p.spendingKey),
    merkle_path: p.merklePath.map(fv),
    merkle_indices: p.merkleIndices.map(iv),
    order_side: iv(p.orderSide),
    order_price: iv(p.orderPrice),
    order_amount: iv(p.orderAmount),
    order_asset_base: fv(p.orderAssetBase),
    order_asset_quote: fv(p.orderAssetQuote),
    order_nonce: fv(p.orderNonce),
    change_amount: iv(p.changeAmount),
    change_blinding: fv(p.changeBlinding),
  };
}

/** Build inputs for the `cancel_order` circuit. SPEC sec 8.5. */
export function buildCancelOrderInputs(p: {
  orderCommitment: Field;
  refundCommitment: Field;
  refundAssetId: Field;
  side: number;
  price: bigint;
  amount: bigint;
  assetBase: Field;
  assetQuote: Field;
  /** Order nonce — required to reopen the order commitment in-circuit. */
  nonce: Field;
  spendingKey: Field;
  refundBlinding: Field;
}): CircuitInputMap {
  return {
    order_commitment: fv(p.orderCommitment),
    refund_commitment: fv(p.refundCommitment),
    refund_asset_id: fv(p.refundAssetId),
    side: iv(p.side),
    price: iv(p.price),
    amount: iv(p.amount),
    asset_base: fv(p.assetBase),
    asset_quote: fv(p.assetQuote),
    nonce: fv(p.nonce),
    spending_key: fv(p.spendingKey),
    refund_blinding: fv(p.refundBlinding),
  };
}

/** Build inputs for the `match_orders` circuit (SPEC sec 8.4). Public inputs first, in the
 *  load-bearing order; then both orders' plaintext + the new-note blindings/nonces. */
export function buildMatchOrdersInputs(p: {
  orderCommitmentA: Field;
  orderCommitmentB: Field;
  fillNoteBuyer: Field;
  fillNoteSeller: Field;
  residualOrderA: Field;
  residualOrderB: Field;
  refundNoteA: Field;
  refundNoteB: Field;
  aSide: number;
  aPrice: bigint;
  aAmount: bigint;
  aAssetBase: Field;
  aAssetQuote: Field;
  aOwnerKey: Field;
  aNonce: Field;
  bSide: number;
  bPrice: bigint;
  bAmount: bigint;
  bAssetBase: Field;
  bAssetQuote: Field;
  bOwnerKey: Field;
  bNonce: Field;
  buyerFillBlinding: Field;
  sellerFillBlinding: Field;
  residualANonce: Field;
  residualBNonce: Field;
  refundABlinding: Field;
  refundBBlinding: Field;
}): CircuitInputMap {
  return {
    order_commitment_a: fv(p.orderCommitmentA),
    order_commitment_b: fv(p.orderCommitmentB),
    fill_note_buyer: fv(p.fillNoteBuyer),
    fill_note_seller: fv(p.fillNoteSeller),
    residual_order_a: fv(p.residualOrderA),
    residual_order_b: fv(p.residualOrderB),
    refund_note_a: fv(p.refundNoteA),
    refund_note_b: fv(p.refundNoteB),
    a_side: iv(p.aSide),
    a_price: iv(p.aPrice),
    a_amount: iv(p.aAmount),
    a_asset_base: fv(p.aAssetBase),
    a_asset_quote: fv(p.aAssetQuote),
    a_owner_key: fv(p.aOwnerKey),
    a_nonce: fv(p.aNonce),
    b_side: iv(p.bSide),
    b_price: iv(p.bPrice),
    b_amount: iv(p.bAmount),
    b_asset_base: fv(p.bAssetBase),
    b_asset_quote: fv(p.bAssetQuote),
    b_owner_key: fv(p.bOwnerKey),
    b_nonce: fv(p.bNonce),
    buyer_fill_blinding: fv(p.buyerFillBlinding),
    seller_fill_blinding: fv(p.sellerFillBlinding),
    residual_a_nonce: fv(p.residualANonce),
    residual_b_nonce: fv(p.residualBNonce),
    refund_a_blinding: fv(p.refundABlinding),
    refund_b_blinding: fv(p.refundBBlinding),
  };
}
