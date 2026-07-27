/**
 * Assemble `match_orders` circuit inputs and the 8 public-input fields for a {@link Match},
 * then produce a proof via an injectable prover.
 *
 * Public-input order is load-bearing (SHARED sec 7, mirrored by the circuit's `pub`
 * parameter declaration order):
 *
 *   0 order_commitment_a  1 order_commitment_b
 *   2 fill_note_buyer     3 fill_note_seller
 *   4 residual_order_a    5 residual_order_b
 *   6 refund_note_a       7 refund_note_b
 *
 * Real UltraHonk proving (noir_js + bb.js, keccak transcript) is an integration concern
 * handled by the SDK's `NoirProver`, which satisfies {@link MatchProver}. For unit tests
 * and a circuit-less dev loop, {@link MockMatchProver} returns the assembled public inputs
 * with a zero-filled proof — exercising the whole pipeline without generating a real proof.
 */
import {
  PRICE_SCALE,
  PROOF_BYTES,
  PUBLIC_INPUT_ORDER,
  computeCommitment,
  computeOrderCommitment,
  fieldToHex,
  randomField,
  toField,
  type CircuitInputMap,
  type Field,
  type ProofData,
} from "@wraith/sdk";
import type { Match, SubmittedOrder } from "./types.js";

/** Anything that can turn a Noir input map into a proof (the SDK's `NoirProver` fits). */
export interface MatchProver {
  prove(inputs: CircuitInputMap): Promise<ProofData>;
}

/** Fresh blindings / nonces for the settlement notes and residual orders a match mints. */
export interface MatchBlindings {
  buyerFillBlinding: Field;
  sellerFillBlinding: Field;
  residualANonce: Field;
  residualBNonce: Field;
  refundABlinding: Field;
  refundBBlinding: Field;
}

/** The 8 public-input field labels in SHARED sec 7 order (sourced from the SDK). */
export const MATCH_PUBLIC_INPUT_LABELS = PUBLIC_INPUT_ORDER.match_orders;

/** Result of {@link assembleMatchInputs}: circuit inputs plus the ordered public inputs. */
export interface AssembledMatch {
  /** Full Noir input map (public + private), keyed by the circuit's `main` parameters. */
  inputs: CircuitInputMap;
  /** The 8 public-input field elements, in SHARED sec 7 order. */
  publicInputs: Field[];
  /** The 8 public-input labels, in SHARED sec 7 order (parallel to {@link publicInputs}). */
  publicInputLabels: readonly string[];
  /** The blindings / nonces actually used (echoed so settlement notes can be recovered). */
  blindings: MatchBlindings;
}

const fv = (x: Field | bigint | number | string): string => fieldToHex(toField(x));
const iv = (x: bigint | number): string => x.toString();
const sideField = (side: SubmittedOrder["side"]): bigint => (side === "buy" ? 0n : 1n);

function fillBlindings(b?: Partial<MatchBlindings>): MatchBlindings {
  return {
    buyerFillBlinding: b?.buyerFillBlinding ?? randomField(),
    sellerFillBlinding: b?.sellerFillBlinding ?? randomField(),
    residualANonce: b?.residualANonce ?? randomField(),
    residualBNonce: b?.residualBNonce ?? randomField(),
    refundABlinding: b?.refundABlinding ?? randomField(),
    refundBBlinding: b?.refundBBlinding ?? randomField(),
  };
}

/**
 * Build the `match_orders` Noir input map and the ordered public inputs for a match.
 *
 * The settlement-note / residual-order / refund-note commitments are computed here with
 * the SDK's Poseidon2 helpers, byte-for-byte matching the circuit:
 *   fill_note_buyer  = hash4(asset_base,  fill,        buyer_key,  buyer_fill_blinding)
 *   fill_note_seller = hash4(asset_quote, quote_filled, seller_key, seller_fill_blinding)
 *   residual_order_x = hash7(side, price, residual_amount, base, quote, owner_key, nonce)
 *   refund_note_x    = hash4(asset_quote, refund_amount, owner_key, refund_blinding)
 * with each commitment forced to 0 when its amount is 0 (matching the circuit's branches).
 *
 * Pass `blindings` to make the output deterministic (tests); otherwise fresh random
 * blindings/nonces are drawn.
 */
export function assembleMatchInputs(match: Match, blindings?: Partial<MatchBlindings>): AssembledMatch {
  const bl = fillBlindings(blindings);

  const { buy, sell } = match;
  const assetBase = toField(buy.assetBase);
  const assetQuote = toField(buy.assetQuote);
  const buyerKey = toField(buy.ownerKey);
  const sellerKey = toField(sell.ownerKey);

  // Defensive: the submitted commitment must reopen to the order preimage, or the circuit
  // would reject the proof. Catch a bad submission here rather than after proving.
  const expectA = computeOrderCommitment({
    side: sideField(buy.side),
    price: buy.price,
    amount: buy.amount,
    assetBase,
    assetQuote,
    ownerKey: buyerKey,
    nonce: buy.nonce,
  });
  const expectB = computeOrderCommitment({
    side: sideField(sell.side),
    price: sell.price,
    amount: sell.amount,
    assetBase,
    assetQuote,
    ownerKey: sellerKey,
    nonce: sell.nonce,
  });
  if (expectA !== toField(buy.commitment)) {
    throw new Error(`order A commitment does not reopen to its preimage (${buy.commitment})`);
  }
  if (expectB !== toField(sell.commitment)) {
    throw new Error(`order B commitment does not reopen to its preimage (${sell.commitment})`);
  }

  // Settlement notes (always present).
  const fillNoteBuyer = computeCommitment(assetBase, match.fill, buyerKey, bl.buyerFillBlinding);
  const fillNoteSeller = computeCommitment(assetQuote, match.quoteFilled, sellerKey, bl.sellerFillBlinding);

  // Residual orders (A is the buy, B is the sell), 0 when the order is fully filled.
  const residualOrderA =
    match.residualAmountA !== 0n
      ? computeOrderCommitment({
          side: sideField(buy.side),
          price: buy.price,
          amount: match.residualAmountA,
          assetBase,
          assetQuote,
          ownerKey: buyerKey,
          nonce: bl.residualANonce,
        })
      : 0n;
  const residualOrderB =
    match.residualAmountB !== 0n
      ? computeOrderCommitment({
          side: sideField(sell.side),
          price: sell.price,
          amount: match.residualAmountB,
          assetBase,
          assetQuote,
          ownerKey: sellerKey,
          nonce: bl.residualBNonce,
        })
      : 0n;

  // Refund notes (quote asset), 0 unless the order is a fully-filled buy with improvement.
  const refundNoteA =
    match.refundAmountA !== 0n
      ? computeCommitment(assetQuote, match.refundAmountA, buyerKey, bl.refundABlinding)
      : 0n;
  const refundNoteB =
    match.refundAmountB !== 0n
      ? computeCommitment(assetQuote, match.refundAmountB, sellerKey, bl.refundBBlinding)
      : 0n;

  // Public inputs, in SHARED sec 7 order.
  const publicInputs: Field[] = [
    toField(buy.commitment), // order_commitment_a
    toField(sell.commitment), // order_commitment_b
    fillNoteBuyer, // fill_note_buyer
    fillNoteSeller, // fill_note_seller
    residualOrderA, // residual_order_a
    residualOrderB, // residual_order_b
    refundNoteA, // refund_note_a
    refundNoteB, // refund_note_b
  ];

  // Full Noir input map (the circuit's `main` takes the public inputs too). Side/price/
  // amount are decimal integers; assets/keys/nonces/blindings/commitments are field hex
  // (mirroring the SDK's place_order input builder).
  const inputs: CircuitInputMap = {
    // ---- public ----
    order_commitment_a: fv(publicInputs[0]!),
    order_commitment_b: fv(publicInputs[1]!),
    fill_note_buyer: fv(publicInputs[2]!),
    fill_note_seller: fv(publicInputs[3]!),
    residual_order_a: fv(publicInputs[4]!),
    residual_order_b: fv(publicInputs[5]!),
    refund_note_a: fv(publicInputs[6]!),
    refund_note_b: fv(publicInputs[7]!),
    // ---- order A (buy) ----
    a_side: iv(sideField(buy.side)),
    a_price: iv(buy.price),
    a_amount: iv(buy.amount),
    a_asset_base: fv(assetBase),
    a_asset_quote: fv(assetQuote),
    a_owner_key: fv(buyerKey),
    a_nonce: fv(buy.nonce),
    // ---- order B (sell) ----
    b_side: iv(sideField(sell.side)),
    b_price: iv(sell.price),
    b_amount: iv(sell.amount),
    b_asset_base: fv(assetBase),
    b_asset_quote: fv(assetQuote),
    b_owner_key: fv(sellerKey),
    b_nonce: fv(sell.nonce),
    // ---- blindings / nonces for new notes ----
    buyer_fill_blinding: fv(bl.buyerFillBlinding),
    seller_fill_blinding: fv(bl.sellerFillBlinding),
    residual_a_nonce: fv(bl.residualANonce),
    residual_b_nonce: fv(bl.residualBNonce),
    refund_a_blinding: fv(bl.refundABlinding),
    refund_b_blinding: fv(bl.refundBBlinding),
  };

  return { inputs, publicInputs, publicInputLabels: MATCH_PUBLIC_INPUT_LABELS, blindings: bl };
}

/**
 * Assemble inputs and produce a proof for a match via the given prover. Returns the
 * {@link ProofData} (proof bytes + public inputs in SHARED sec 7 order) plus the assembled
 * inputs (so the caller can recover the minted settlement notes from the blindings).
 */
export async function proveMatch(
  match: Match,
  prover: MatchProver,
  blindings?: Partial<MatchBlindings>,
): Promise<{ proof: ProofData; assembled: AssembledMatch }> {
  const assembled = assembleMatchInputs(match, blindings);
  const proof = await prover.prove(assembled.inputs);
  return { proof, assembled };
}

/** Sanity-check that a proof has the expected on-chain length (SHARED sec 6). */
export function isValidProofLength(proof: Uint8Array): boolean {
  return proof.length === PROOF_BYTES;
}

/**
 * A circuit-less stand-in for the SDK's `NoirProver`. It re-derives the public inputs from
 * the same input map and returns them with a zero-filled proof of the correct length, so
 * the assemble -> prove -> submit pipeline can be exercised end-to-end without generating a
 * real ZK proof. NOT a valid on-chain proof — the verifier will reject it.
 */
export class MockMatchProver implements MatchProver {
  async prove(inputs: CircuitInputMap): Promise<ProofData> {
    const publicInputs = MATCH_PUBLIC_INPUT_LABELS.map((label) => toField(inputs[label] as string));
    return { proof: new Uint8Array(PROOF_BYTES), publicInputs };
  }
}

export { PRICE_SCALE };
