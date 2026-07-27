/**
 * Seal a match's settlement secrets to their owners for on-chain delivery.
 *
 * The matcher chooses the fresh blindings/nonces for the fill/refund notes and residual
 * orders, so the owners must LEARN them to spend the fills / manage the residual. We seal each
 * one to the owner's viewing key (from their receive code) and hand the memos to `match_orders`,
 * which re-emits them in `OrderMatchedEvent` for the owner's indexer to discover — the same
 * untrusted-transport model as `transfer` (a memo can't forge balance; its commitment must be a
 * real emitted output).
 *
 * Ordering is load-bearing: it must match the contract's insertion order exactly —
 *   leafMemos:     fill_buyer, fill_seller, [refund_a], [refund_b]   (non-zero refunds only)
 *   residualMemos: [residual_a], [residual_b]                        (non-zero residuals only)
 * — or the contract's count-binding check rejects the submission.
 */
import {
  decodeReceiveCode,
  encryptNote,
  encryptOrder,
  fieldToHex,
  toField,
  type Field,
  type NotePayload,
  type OrderPayload,
} from "@wraith/sdk";
import type { AssembledMatch } from "./prover.js";
import type { Match, SubmittedOrder } from "./types.js";

export interface MatchMemos {
  /** Aligned with the contract's inserted leaves (fills, then non-zero refunds). */
  leafMemos: Uint8Array[];
  /** Aligned with the contract's non-zero residual orders (a, then b). */
  residualMemos: Uint8Array[];
}

const fv = (x: string | bigint | number | Field): string => fieldToHex(toField(x));

function encPubOf(order: SubmittedOrder): Uint8Array {
  if (!order.receiveCode) {
    throw new Error(`order ${order.commitment} has no receiveCode; cannot seal its settlement memos`);
  }
  const rc = decodeReceiveCode(order.receiveCode);
  if (fv(rc.ownerKey) !== fv(order.ownerKey)) {
    throw new Error(`order ${order.commitment} receiveCode owner key does not match the order's owner key`);
  }
  return rc.encPub;
}

function noteMemo(
  encPub: Uint8Array,
  code: string | undefined,
  assetId: string,
  amount: bigint,
  ownerKey: string,
  blinding: Field,
  commitment: Field,
): Uint8Array {
  const payload: NotePayload = {
    v: 1,
    ...(code ? { code } : { code: "" }),
    assetId: fv(assetId),
    amount: amount.toString(),
    ownerKey: fv(ownerKey),
    blinding: fieldToHex(blinding),
    commitment: fieldToHex(commitment),
  };
  return encryptNote(encPub, payload);
}

function orderMemo(encPub: Uint8Array, order: SubmittedOrder, amount: bigint, nonce: Field, commitment: Field): Uint8Array {
  const payload: OrderPayload = {
    v: 1,
    kind: "order",
    side: order.side === "buy" ? 0 : 1,
    price: order.price.toString(),
    amount: amount.toString(),
    assetBase: fv(order.assetBase),
    assetQuote: fv(order.assetQuote),
    ownerKey: fv(order.ownerKey),
    nonce: fieldToHex(nonce),
    commitment: fieldToHex(commitment),
    ...(order.baseCode ? { baseCode: order.baseCode } : {}),
    ...(order.quoteCode ? { quoteCode: order.quoteCode } : {}),
  };
  return encryptOrder(encPub, payload);
}

/**
 * Build the `leafMemos` + `residualMemos` for a match, sealed to each output's owner. `match.a`
 * is the buy, `match.b` the sell; `assembled.publicInputs` are the 8 commitments in SHARED §7
 * order and `assembled.blindings` the fresh secrets used.
 */
export function buildMatchMemos(match: Match, assembled: AssembledMatch): MatchMemos {
  const { buy, sell } = match;
  const buyerEnc = encPubOf(buy);
  const sellerEnc = encPubOf(sell);
  const pub = assembled.publicInputs; // [oa, ob, fillBuyer, fillSeller, resA, resB, refA, refB]
  const bl = assembled.blindings;

  const leafMemos: Uint8Array[] = [
    // fill_buyer: buyer receives `fill` of BASE.
    noteMemo(buyerEnc, buy.baseCode, buy.assetBase, match.fill, buy.ownerKey, bl.buyerFillBlinding, pub[2]!),
    // fill_seller: seller receives `quoteFilled` of QUOTE.
    noteMemo(sellerEnc, sell.quoteCode, sell.assetQuote, match.quoteFilled, sell.ownerKey, bl.sellerFillBlinding, pub[3]!),
  ];
  if (match.refundAmountA !== 0n) {
    // refund_a: buyer (order A) quote-asset price-improvement refund.
    leafMemos.push(noteMemo(buyerEnc, buy.quoteCode, buy.assetQuote, match.refundAmountA, buy.ownerKey, bl.refundABlinding, pub[6]!));
  }
  if (match.refundAmountB !== 0n) {
    leafMemos.push(noteMemo(sellerEnc, sell.quoteCode, sell.assetQuote, match.refundAmountB, sell.ownerKey, bl.refundBBlinding, pub[7]!));
  }

  const residualMemos: Uint8Array[] = [];
  if (match.residualAmountA !== 0n) {
    residualMemos.push(orderMemo(buyerEnc, buy, match.residualAmountA, bl.residualANonce, pub[4]!));
  }
  if (match.residualAmountB !== 0n) {
    residualMemos.push(orderMemo(sellerEnc, sell, match.residualAmountB, bl.residualBNonce, pub[5]!));
  }

  return { leafMemos, residualMemos };
}
