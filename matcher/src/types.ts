/**
 * Obscura matcher data model.
 *
 * A {@link SubmittedOrder} is what a trader hands the off-chain matching service: the
 * on-chain order commitment plus the full order preimage (side/price/amount/assets/
 * owner_key/nonce). Those preimage fields are exactly the `match_orders` circuit's
 * private inputs for one order (SPEC sec 8.4 / SHARED sec 7), so the matcher needs them
 * to build a settlement proof — it cannot, however, steal funds: settlement is
 * ZK-enforced (see README "Trust model").
 *
 * A {@link Match} is the pure, deterministic economic result of crossing two orders,
 * mirroring the circuit's math byte-for-byte (midpoint exec price, floor rounding,
 * fill = min(amounts), residual on the larger side, buyer price-improvement refund only
 * when fully filled). It carries amounts only; the per-note commitments (which need
 * fresh blindings/nonces) are assembled later in `prover.ts`.
 */

/** Order side relative to the base asset. SHARED sec 4 / SPEC sec 7.1 (`buy` => 0, `sell` => 1). */
export type Side = "buy" | "sell";

/**
 * An order submitted to the matching service. `price`/`amount` are the in-circuit
 * 64-bit integers (price scaled by `PRICE_SCALE = 10^7`). The `Field`-valued members
 * (`assetBase`, `assetQuote`, `ownerKey`, `nonce`, `commitment`) are carried as strings
 * (decimal or `0x`-hex) and coerced with the SDK's `toField` when hashing.
 */
export interface SubmittedOrder {
  /** On-chain order commitment = hash7(side, price, amount, assetBase, assetQuote, ownerKey, nonce). */
  commitment: string;
  side: Side;
  /** Limit price, scaled by PRICE_SCALE; in [0, 2^64). */
  price: bigint;
  /** Base-asset quantity; in [0, 2^64). */
  amount: bigint;
  /** Base-asset identifier (Field). */
  assetBase: string;
  /** Quote-asset identifier (Field). */
  assetQuote: string;
  /** Trader's public owner key (Field) — settlement notes are minted to this key. */
  ownerKey: string;
  /** Order nonce (Field) — part of the commitment preimage, supplied so the proof can reopen it. */
  nonce: string;

  /** The trader's Obscura receive code (`wr1…` = ownerKey ‖ encPub). Required by the live intake
   *  so the matcher can seal the settlement notes/residual to the owner's viewing key (on-chain
   *  memo delivery). Optional in the type so tests can build orders without one. */
  receiveCode?: string;
  /** Optional display codes for the pair, echoed into the settlement memos so the recipient's
   *  wallet labels the fill correctly (the amount/asset are authoritative regardless). */
  baseCode?: string;
  quoteCode?: string;

  // ---- engine bookkeeping (assigned by MatchingEngine.submit) ----
  /** Monotonic submission index, used as the time-priority tie-breaker. */
  sequence?: number;
  /** Wall-clock receipt time (ms since epoch). */
  receivedAt?: number;
}

/**
 * The deterministic outcome of crossing two compatible orders. Mirrors the
 * `match_orders` circuit (SPEC sec 8.4). By convention `a` is the BUY order and `b` is
 * the SELL order, but every economic quantity is computed per-order so the A/B labelling
 * is purely positional (matching the circuit, which maps residual/refund to A and B, not
 * to buyer/seller).
 */
export interface Match {
  /** `${assetBase}|${assetQuote}` trading-pair key. */
  pair: string;
  /** Order A (by convention the buy). */
  a: SubmittedOrder;
  /** Order B (by convention the sell). */
  b: SubmittedOrder;
  /** Alias of {@link a} — the buy side. */
  buy: SubmittedOrder;
  /** Alias of {@link b} — the sell side. */
  sell: SubmittedOrder;

  /** Execution price = floor((buy_price + sell_price) / 2). */
  execPrice: bigint;
  /** Base filled = min(buy.amount, sell.amount). */
  fill: bigint;
  /** Quote delivered to the seller = floor(fill * execPrice / PRICE_SCALE). */
  quoteFilled: bigint;

  /** Remaining base on order A (`a.amount - fill`); 0 => A fully filled. */
  residualAmountA: bigint;
  /** Remaining base on order B (`b.amount - fill`); 0 => B fully filled. */
  residualAmountB: bigint;
  /** Quote refund to A (price improvement) — non-zero only if A is a fully-filled BUY. */
  refundAmountA: bigint;
  /** Quote refund to B (price improvement) — non-zero only if B is a fully-filled BUY. */
  refundAmountB: bigint;
}
