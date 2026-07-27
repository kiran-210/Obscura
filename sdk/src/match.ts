/**
 * Dark-pool matching: the off-chain mirror of the `match_orders` circuit (SPEC sec 8.4).
 *
 * The circuit takes BOTH orders' full plaintext as its private witness and enforces the
 * settlement; the matcher must compute the exact same fills + settlement commitments off-chain
 * to build the proof. This module is that computation — kept byte-identical to
 * `circuits/noir/match_orders` + `obscura_lib` (midpoint exec price, min fill, floor quote,
 * residual/refund policy) and golden-tested against the circuit's own `#[test]` vectors.
 *
 * Trading model (fixed by the deployed circuit):
 *   opposite sides, same (base, quote), buy_price >= sell_price
 *   exec_price   = floor((buy_price + sell_price) / 2)
 *   fill         = min(buy_amount, sell_amount)
 *   quote_filled = floor(fill * exec_price / PRICE_SCALE)
 *   buyer gets `fill` of BASE; seller gets `quote_filled` of QUOTE
 *   partial fill -> residual order (same side/price, remaining amount, new nonce), no refund
 *   fully-filled BUY  -> quote refund of price improvement floor(amount*buy_price/SCALE) - quote_filled
 *   fully-filled SELL -> no refund
 */
import { PRICE_SCALE } from "./constants.js";
import { computeCommitment } from "./note.js";
import { computeOrderCommitment } from "./order.js";
import { OrderSide, type Order } from "./types.js";
import type { Field } from "./poseidon.js";

// obscura_lib integer helpers (all operands are range-checked < 2^64 in-circuit).
const midpoint = (a: bigint, b: bigint): bigint => (a + b) / 2n;
const min64 = (a: bigint, b: bigint): bigint => (a < b ? a : b);
const mulDivPrice = (a: bigint, b: bigint): bigint => (a * b) / PRICE_SCALE;

/** Matcher-chosen blindings/nonces for the settlement notes + residual orders. */
export interface MatchSecrets {
  buyerFillBlinding: Field;
  sellerFillBlinding: Field;
  residualANonce: Field;
  residualBNonce: Field;
  refundABlinding: Field;
  refundBBlinding: Field;
}

export interface MatchResult {
  execPrice: bigint;
  fill: bigint;
  quoteFilled: bigint;
  buyerKey: Field;
  sellerKey: Field;
  /** Public settlement commitments (0n = absent), in the circuit's public-input order. */
  fillNoteBuyer: Field;
  fillNoteSeller: Field;
  residualOrderA: Field;
  residualOrderB: Field;
  refundNoteA: Field;
  refundNoteB: Field;
  /** Amounts backing the non-zero outputs (for memos + book updates). */
  residualAAmount: bigint;
  residualBAmount: bigint;
  refundAAmount: bigint;
  refundBAmount: bigint;
}

interface Settlement {
  residual: Field;
  residualAmount: bigint;
  refund: Field;
  refundAmount: bigint;
}

/** Residual + refund for ONE order, mapped to A/B exactly as the circuit's `settle_order`. */
function settleOrder(order: Order, fill: bigint, quoteFilled: bigint, residualNonce: Field, refundBlinding: Field): Settlement {
  const residualAmount = order.amount - fill;
  if (residualAmount !== 0n) {
    // Partially filled: re-commit the remaining order (same side & price). No refund (MVP).
    const residual = computeOrderCommitment({
      side: order.side,
      price: order.price,
      amount: residualAmount,
      assetBase: order.assetBase,
      assetQuote: order.assetQuote,
      ownerKey: order.ownerKey,
      nonce: residualNonce,
    });
    return { residual, residualAmount, refund: 0n, refundAmount: 0n };
  }
  // Fully filled: a BUY refunds its quote-asset price improvement; a SELL refunds nothing.
  if (order.side === OrderSide.Buy) {
    const refundAmount = mulDivPrice(order.amount, order.price) - quoteFilled; // >= 0
    if (refundAmount !== 0n) {
      return {
        residual: 0n,
        residualAmount: 0n,
        refund: computeCommitment(order.assetQuote, refundAmount, order.ownerKey, refundBlinding),
        refundAmount,
      };
    }
  }
  return { residual: 0n, residualAmount: 0n, refund: 0n, refundAmount: 0n };
}

/**
 * Compute the settlement for crossing orders A and B, mirroring the `match_orders` circuit.
 * Throws (with the circuit's assert message) if the orders don't cross — so a caller can use
 * it as the compatibility check too. `secrets` are the matcher-chosen blindings/nonces for the
 * new fill/refund notes and residual orders.
 */
export function computeMatch(a: Order, b: Order, secrets: MatchSecrets): MatchResult {
  if (a.side === b.side) throw new Error("orders must be opposite sides");
  if (a.assetBase !== b.assetBase) throw new Error("base asset mismatch");
  if (a.assetQuote !== b.assetQuote) throw new Error("quote asset mismatch");

  const aIsBuy = a.side === OrderSide.Buy;
  const buyPrice = aIsBuy ? a.price : b.price;
  const sellPrice = aIsBuy ? b.price : a.price;
  const buyAmount = aIsBuy ? a.amount : b.amount;
  const sellAmount = aIsBuy ? b.amount : a.amount;
  const buyerKey = aIsBuy ? a.ownerKey : b.ownerKey;
  const sellerKey = aIsBuy ? b.ownerKey : a.ownerKey;

  if (buyPrice < sellPrice) throw new Error("prices incompatible");

  const execPrice = midpoint(buyPrice, sellPrice);
  const fill = min64(buyAmount, sellAmount);
  const quoteFilled = mulDivPrice(fill, execPrice);

  const fillNoteBuyer = computeCommitment(a.assetBase, fill, buyerKey, secrets.buyerFillBlinding);
  const fillNoteSeller = computeCommitment(a.assetQuote, quoteFilled, sellerKey, secrets.sellerFillBlinding);

  const sa = settleOrder(a, fill, quoteFilled, secrets.residualANonce, secrets.refundABlinding);
  const sb = settleOrder(b, fill, quoteFilled, secrets.residualBNonce, secrets.refundBBlinding);

  return {
    execPrice,
    fill,
    quoteFilled,
    buyerKey,
    sellerKey,
    fillNoteBuyer,
    fillNoteSeller,
    residualOrderA: sa.residual,
    residualOrderB: sb.residual,
    refundNoteA: sa.refund,
    refundNoteB: sb.refund,
    residualAAmount: sa.residualAmount,
    residualBAmount: sb.residualAmount,
    refundAAmount: sa.refundAmount,
    refundBAmount: sb.refundAmount,
  };
}
