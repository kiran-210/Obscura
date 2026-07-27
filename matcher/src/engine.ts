/**
 * Off-chain order book + price-time matching for the Obscura dark pool (SPEC sec 7.4 /
 * 11.2). The matching math here MUST mirror the `match_orders` Noir circuit
 * (`circuits/noir/match_orders/src/main.nr`) exactly, because the on-chain verifier will
 * reject any settlement whose notes don't reproduce the circuit's outputs.
 *
 * Circuit economics reproduced (all integer / floor, prices scaled by PRICE_SCALE = 10^7):
 *   - opposite sides, same (base, quote) pair, buy_price >= sell_price
 *   - exec_price   = floor((buy_price + sell_price) / 2)              (midpoint)
 *   - fill         = min(buy_amount, sell_amount)                     (residual on larger side)
 *   - quote_filled = floor(fill * exec_price / PRICE_SCALE)
 *   - buyer receives `fill` of BASE; seller receives `quote_filled` of QUOTE
 *   - per order: if amount > fill -> partial fill: residual order (same side & price,
 *     remaining amount), NO refund on the filled portion (documented MVP simplification);
 *     if amount == fill -> fully filled: a BUY gets a quote refund of its price
 *     improvement floor(amount*price/SCALE) - quote_filled (when positive); a SELL gets none.
 *
 * The engine computes amounts only; per-note commitments (which require fresh blindings/
 * nonces) are assembled in `prover.ts`.
 */
import { PRICE_SCALE } from "@obscura/sdk";
import type { Match, Side, SubmittedOrder } from "./types.js";

const TWO_POW_64 = 1n << 64n;

/** Trading-pair key for an order. */
export function pairKey(o: Pick<SubmittedOrder, "assetBase" | "assetQuote">): string {
  return `${o.assetBase}|${o.assetQuote}`;
}

/**
 * Per-order settlement, mirroring the circuit's `settle_order` (main.nr). Given the
 * agreed `fill` and `quoteFilled`, returns the residual base amount and the quote refund
 * amount for ONE order. Both are 0 when not applicable.
 */
export function settleOrder(
  order: Pick<SubmittedOrder, "side" | "price" | "amount">,
  fill: bigint,
  quoteFilled: bigint,
): { residualAmount: bigint; refundAmount: bigint } {
  // fill = min(buy, sell) <= order.amount, so residual is a non-negative 64-bit integer.
  const residualAmount = order.amount - fill;
  if (residualAmount !== 0n) {
    // Partially filled: funds stay locked in the residual order; no refund (MVP).
    return { residualAmount, refundAmount: 0n };
  }
  // Fully filled.
  if (order.side === "buy") {
    // Refund the BUY's quote-asset price improvement (exec_price <= buy_price).
    const locked = (order.amount * order.price) / PRICE_SCALE; // floor
    const refund = locked - quoteFilled; // >= 0
    return { residualAmount: 0n, refundAmount: refund > 0n ? refund : 0n };
  }
  // Fully-filled SELL: locked base fully delivered, no refund.
  return { residualAmount: 0n, refundAmount: 0n };
}

/**
 * Compute the deterministic {@link Match} for a buy/sell pair that is already known to be
 * compatible (opposite sides, same pair, buy.price >= sell.price). Order A is the buy,
 * order B is the sell.
 */
export function computeMatch(buy: SubmittedOrder, sell: SubmittedOrder): Match {
  const execPrice = (buy.price + sell.price) / 2n; // floor midpoint
  const fill = buy.amount < sell.amount ? buy.amount : sell.amount; // min
  const quoteFilled = (fill * execPrice) / PRICE_SCALE; // floor

  const a = settleOrder(buy, fill, quoteFilled);
  const b = settleOrder(sell, fill, quoteFilled);

  return {
    pair: pairKey(buy),
    a: buy,
    b: sell,
    buy,
    sell,
    execPrice,
    fill,
    quoteFilled,
    residualAmountA: a.residualAmount,
    residualAmountB: b.residualAmount,
    refundAmountA: a.refundAmount,
    refundAmountB: b.refundAmount,
  };
}

/** Validation error for a rejected order submission. */
export class OrderValidationError extends Error {
  override readonly name = "OrderValidationError";
}

function assertU64(value: bigint, label: string): void {
  if (typeof value !== "bigint" || value < 0n || value >= TWO_POW_64) {
    throw new OrderValidationError(`${label} must be a bigint in [0, 2^64): got ${String(value)}`);
  }
}

function assertNonEmpty(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new OrderValidationError(`${label} must be a non-empty string`);
  }
}

/**
 * In-memory order book with price-time priority matching. Buy and sell orders are kept in
 * separate maps keyed by trading pair (SPEC sec 11.1). The book is a pure data structure;
 * proving and on-chain submission live in `prover.ts` / `submitter.ts`.
 */
export class MatchingEngine {
  /** Open buy orders, keyed by `${assetBase}|${assetQuote}`. */
  private readonly buyOrders = new Map<string, SubmittedOrder[]>();
  /** Open sell orders, keyed by `${assetBase}|${assetQuote}`. */
  private readonly sellOrders = new Map<string, SubmittedOrder[]>();
  /** Monotonic submission counter for time priority. */
  private sequence = 0;

  /**
   * Add an order to the book. Validates shape/ranges, stamps a sequence number and
   * receipt time (for time priority), and returns the stored order. Throws
   * {@link OrderValidationError} on malformed input.
   */
  submit(order: SubmittedOrder): SubmittedOrder {
    if (order.side !== "buy" && order.side !== "sell") {
      throw new OrderValidationError(`side must be "buy" or "sell": got ${String(order.side)}`);
    }
    assertU64(order.price, "price");
    assertU64(order.amount, "amount");
    if (order.price === 0n) throw new OrderValidationError("price must be > 0");
    if (order.amount === 0n) throw new OrderValidationError("amount must be > 0");
    assertNonEmpty(order.commitment, "commitment");
    assertNonEmpty(order.assetBase, "assetBase");
    assertNonEmpty(order.assetQuote, "assetQuote");
    assertNonEmpty(order.ownerKey, "ownerKey");
    assertNonEmpty(order.nonce, "nonce");

    const stored: SubmittedOrder = {
      ...order,
      sequence: this.sequence++,
      receivedAt: Date.now(),
    };
    const book = stored.side === "buy" ? this.buyOrders : this.sellOrders;
    const key = pairKey(stored);
    const list = book.get(key);
    if (list) list.push(stored);
    else book.set(key, [stored]);
    return stored;
  }

  /** Remove an order from the book by commitment. Returns true if found and removed. */
  remove(commitment: string): boolean {
    for (const book of [this.buyOrders, this.sellOrders]) {
      for (const [key, list] of book) {
        const idx = list.findIndex((o) => o.commitment === commitment);
        if (idx !== -1) {
          list.splice(idx, 1);
          if (list.length === 0) book.delete(key);
          return true;
        }
      }
    }
    return false;
  }

  /** All open orders (buys then sells), in no particular order. */
  getOrders(): SubmittedOrder[] {
    const out: SubmittedOrder[] = [];
    for (const list of this.buyOrders.values()) out.push(...list);
    for (const list of this.sellOrders.values()) out.push(...list);
    return out;
  }

  /** Just the commitments of all open orders (what `GET /orders` exposes — no details). */
  getCommitments(): string[] {
    return this.getOrders().map((o) => o.commitment);
  }

  /** Number of open orders. */
  get size(): number {
    let n = 0;
    for (const list of this.buyOrders.values()) n += list.length;
    for (const list of this.sellOrders.values()) n += list.length;
    return n;
  }

  /**
   * Find crossable matches using price-time priority (SPEC sec 11.2):
   *   1. group orders by pair;
   *   2. sort buys by price DESC then time ASC, sells by price ASC then time ASC;
   *   3. while best buy >= best sell, cross them at the midpoint.
   *
   * Each order is matched at most once per pass. The residual of a partial fill is
   * reported on the resulting {@link Match} but the order is treated as consumed: its
   * residual carries a fresh nonce / commitment that only exists once the match settles
   * on-chain, so it re-enters the book on the next observation, not within this pass.
   */
  findMatches(): Match[] {
    const matches: Match[] = [];
    const pairs = new Set<string>([...this.buyOrders.keys(), ...this.sellOrders.keys()]);

    for (const key of pairs) {
      const buys = [...(this.buyOrders.get(key) ?? [])].sort(byBuyPriority);
      const sells = [...(this.sellOrders.get(key) ?? [])].sort(bySellPriority);

      let i = 0;
      let j = 0;
      while (i < buys.length && j < sells.length) {
        const buy = buys[i]!;
        const sell = sells[j]!;
        if (buy.price >= sell.price) {
          matches.push(computeMatch(buy, sell));
          i++;
          j++;
        } else {
          // Best remaining buy can't reach the cheapest remaining sell; since sells are
          // ascending and buys descending, nothing further crosses for this pair.
          break;
        }
      }
    }
    return matches;
  }
}

/** Buys: highest price first, earliest submission first on ties (price-time priority). */
function byBuyPriority(a: SubmittedOrder, b: SubmittedOrder): number {
  if (a.price !== b.price) return a.price > b.price ? -1 : 1;
  return (a.sequence ?? 0) - (b.sequence ?? 0);
}

/** Sells: lowest price first, earliest submission first on ties (price-time priority). */
function bySellPriority(a: SubmittedOrder, b: SubmittedOrder): number {
  if (a.price !== b.price) return a.price < b.price ? -1 : 1;
  return (a.sequence ?? 0) - (b.sequence ?? 0);
}

export type { Side };
