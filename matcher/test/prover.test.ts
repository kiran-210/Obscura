import { describe, expect, it } from "vitest";
import {
  PROOF_BYTES,
  PUBLIC_INPUT_ORDER,
  computeCommitment,
  computeOrderCommitment,
  deriveOwnerKey,
  fieldToHex,
  toField,
  type Field,
} from "@wraith/sdk";
import { computeMatch } from "../src/engine.js";
import {
  MATCH_PUBLIC_INPUT_LABELS,
  MockMatchProver,
  assembleMatchInputs,
  proveMatch,
} from "../src/prover.js";
import type { SubmittedOrder } from "../src/types.js";

// Canonical owner keys used by the circuit's own #[test]s (main.nr).
const okA = deriveOwnerKey(7n); // owner_key(7)
const okB = deriveOwnerKey(9n); // owner_key(9)

function buyOrder(amount: bigint): SubmittedOrder {
  const commitment = computeOrderCommitment({
    side: 0n,
    price: 20_000_000n,
    amount,
    assetBase: 0n,
    assetQuote: 1n,
    ownerKey: okA,
    nonce: 42n,
  });
  return {
    commitment: commitment.toString(),
    side: "buy",
    price: 20_000_000n,
    amount,
    assetBase: "0",
    assetQuote: "1",
    ownerKey: okA.toString(),
    nonce: "42",
  };
}

function sellOrder(amount: bigint): SubmittedOrder {
  const commitment = computeOrderCommitment({
    side: 1n,
    price: 10_000_000n,
    amount,
    assetBase: 0n,
    assetQuote: 1n,
    ownerKey: okB,
    nonce: 43n,
  });
  return {
    commitment: commitment.toString(),
    side: "sell",
    price: 10_000_000n,
    amount,
    assetBase: "0",
    assetQuote: "1",
    ownerKey: okB.toString(),
    nonce: "43",
  };
}

describe("assembleMatchInputs — public-input ORDER (SHARED sec 7)", () => {
  it("labels are exactly the circuit's declared pub-param order", () => {
    expect(MATCH_PUBLIC_INPUT_LABELS).toEqual([
      "order_commitment_a",
      "order_commitment_b",
      "fill_note_buyer",
      "fill_note_seller",
      "residual_order_a",
      "residual_order_b",
      "refund_note_a",
      "refund_note_b",
    ]);
    // and they agree with the SDK's source-of-truth table.
    expect(MATCH_PUBLIC_INPUT_LABELS).toEqual(PUBLIC_INPUT_ORDER.match_orders);
  });

  it("assembled publicInputs are aligned, in order, with the input-map keys", () => {
    const match = computeMatch(buyOrder(10n), sellOrder(10n));
    const a = assembleMatchInputs(match, {
      buyerFillBlinding: 701n,
      sellerFillBlinding: 702n,
      residualANonce: 801n,
      residualBNonce: 802n,
      refundABlinding: 703n,
      refundBBlinding: 804n,
    });
    expect(a.publicInputLabels).toEqual(MATCH_PUBLIC_INPUT_LABELS);
    expect(a.publicInputs).toHaveLength(8);
    // The i-th public input value must equal the input-map entry for the i-th label.
    a.publicInputLabels.forEach((label, i) => {
      expect(a.inputs[label]).toBe(fieldToHex(a.publicInputs[i]!));
    });
  });
});

describe("assembleMatchInputs — reproduces the circuit's golden settlement (main.nr #[test]s)", () => {
  it("full fill with buyer refund: matches test_match_full_fill_with_buyer_refund", () => {
    // A: BUY 10 @ 2.0 ; B: SELL 10 @ 1.0 -> exec 1.5, fill 10, quote 15, buyer refund 5.
    const buy = buyOrder(10n);
    const sell = sellOrder(10n);
    const match = computeMatch(buy, sell);

    const a = assembleMatchInputs(match, {
      buyerFillBlinding: 701n,
      sellerFillBlinding: 702n,
      residualANonce: 801n,
      residualBNonce: 802n,
      refundABlinding: 703n,
      refundBBlinding: 804n,
    });

    const oca = toField(buy.commitment);
    const ocb = toField(sell.commitment);
    const fnb = computeCommitment(0n, 10n, okA, 701n); // buyer gets 10 base
    const fns = computeCommitment(1n, 15n, okB, 702n); // seller gets 15 quote
    const rna = computeCommitment(1n, 5n, okA, 703n); // buyer refund 5 quote

    const expected: Field[] = [oca, ocb, fnb, fns, 0n, 0n, rna, 0n];
    expect(a.publicInputs).toEqual(expected);
  });

  it("partial fill residual: matches test_match_partial_fill_residual", () => {
    // A: BUY 10 @ 2.0 ; B: SELL 4 @ 1.0 -> exec 1.5, fill 4, quote 6, residual buy 6, no refund.
    const buy = buyOrder(10n);
    const sell = sellOrder(4n);
    const match = computeMatch(buy, sell);

    const a = assembleMatchInputs(match, {
      buyerFillBlinding: 701n,
      sellerFillBlinding: 702n,
      residualANonce: 801n,
      residualBNonce: 802n,
      refundABlinding: 703n,
      refundBBlinding: 804n,
    });

    const oca = toField(buy.commitment);
    const ocb = toField(sell.commitment);
    const fnb = computeCommitment(0n, 4n, okA, 701n); // buyer gets 4 base
    const fns = computeCommitment(1n, 6n, okB, 702n); // seller gets 6 quote
    const resA = computeOrderCommitment({
      side: 0n,
      price: 20_000_000n,
      amount: 6n,
      assetBase: 0n,
      assetQuote: 1n,
      ownerKey: okA,
      nonce: 801n,
    });

    const expected: Field[] = [oca, ocb, fnb, fns, resA, 0n, 0n, 0n];
    expect(a.publicInputs).toEqual(expected);
  });

  it("rejects an order whose commitment doesn't reopen to its preimage", () => {
    const buy = { ...buyOrder(10n), commitment: "12345" }; // wrong commitment
    const match = computeMatch(buy, sellOrder(10n));
    expect(() => assembleMatchInputs(match)).toThrow(/does not reopen/);
  });
});

describe("proveMatch with a mocked prover", () => {
  it("returns proof bytes of on-chain length and public inputs in SHARED order", async () => {
    const match = computeMatch(buyOrder(10n), sellOrder(10n));
    const { proof, assembled } = await proveMatch(match, new MockMatchProver(), {
      buyerFillBlinding: 701n,
      sellerFillBlinding: 702n,
      residualANonce: 801n,
      residualBNonce: 802n,
      refundABlinding: 703n,
      refundBBlinding: 804n,
    });
    expect(proof.proof).toHaveLength(PROOF_BYTES);
    // The prover re-derives the public inputs from the input map; they must match assembly.
    expect(proof.publicInputs).toEqual(assembled.publicInputs);
  });
});
