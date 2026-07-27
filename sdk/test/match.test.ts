/**
 * Golden test: `computeMatch` reproduces the `match_orders` circuit's own `#[test]` vectors
 * (circuits/noir/match_orders/src/main.nr). Same hashes + same fill math ⇒ the matcher builds
 * settlement commitments the deployed verifier accepts, with no chain or prover.
 */
import { describe, expect, it } from "vitest";
import { computeMatch, type MatchSecrets } from "../src/match.js";
import { createOrder } from "../src/order.js";
import { computeCommitment, computeOrderCommitment, deriveOwnerKey } from "../src/index.js";
import { OrderSide } from "../src/types.js";

const ok_a = deriveOwnerKey(7n); // w::owner_key(7)
const ok_b = deriveOwnerKey(9n); // w::owner_key(9)
const secrets: MatchSecrets = {
  buyerFillBlinding: 701n,
  sellerFillBlinding: 702n,
  residualANonce: 801n,
  residualBNonce: 802n,
  refundABlinding: 703n,
  refundBBlinding: 804n,
};
const pair = { assetBase: 0n, assetQuote: 1n };
const buy = (price: bigint, amount: bigint, ownerKey: bigint, nonce: bigint) =>
  createOrder({ side: OrderSide.Buy, price, amount, ...pair, ownerKey, nonce });
const sell = (price: bigint, amount: bigint, ownerKey: bigint, nonce: bigint) =>
  createOrder({ side: OrderSide.Sell, price, amount, ...pair, ownerKey, nonce });

describe("computeMatch mirrors the match_orders circuit", () => {
  it("full fill with buyer refund (A BUY 10@2.0, B SELL 10@1.0)", () => {
    const m = computeMatch(buy(20000000n, 10n, ok_a, 42n), sell(10000000n, 10n, ok_b, 43n), secrets);
    expect([m.execPrice, m.fill, m.quoteFilled]).toEqual([15000000n, 10n, 15n]);
    expect(m.fillNoteBuyer).toBe(computeCommitment(0n, 10n, ok_a, 701n)); // 10 base to buyer
    expect(m.fillNoteSeller).toBe(computeCommitment(1n, 15n, ok_b, 702n)); // 15 quote to seller
    expect(m.residualOrderA).toBe(0n);
    expect(m.residualOrderB).toBe(0n);
    expect(m.refundNoteA).toBe(computeCommitment(1n, 5n, ok_a, 703n)); // buyer refund 5 quote (20-15)
    expect(m.refundAAmount).toBe(5n);
    expect(m.refundNoteB).toBe(0n);
  });

  it("partial fill residual (A BUY 10@2.0, B SELL 4@1.0)", () => {
    const m = computeMatch(buy(20000000n, 10n, ok_a, 42n), sell(10000000n, 4n, ok_b, 43n), secrets);
    expect([m.execPrice, m.fill, m.quoteFilled]).toEqual([15000000n, 4n, 6n]);
    expect(m.fillNoteBuyer).toBe(computeCommitment(0n, 4n, ok_a, 701n));
    expect(m.fillNoteSeller).toBe(computeCommitment(1n, 6n, ok_b, 702n));
    // A partially filled: residual BUY 6 @ 2.0, new nonce 801, no refund.
    expect(m.residualOrderA).toBe(
      computeOrderCommitment({ side: OrderSide.Buy, price: 20000000n, amount: 6n, ...pair, ownerKey: ok_a, nonce: 801n }),
    );
    expect(m.residualAAmount).toBe(6n);
    expect(m.refundNoteA).toBe(0n);
    expect(m.residualOrderB).toBe(0n);
    expect(m.refundNoteB).toBe(0n);
  });

  it("rejects incompatible crosses like the circuit asserts", () => {
    expect(() => computeMatch(buy(20000000n, 10n, ok_a, 42n), buy(10000000n, 10n, ok_b, 43n), secrets)).toThrow(
      "opposite sides",
    );
    expect(() => computeMatch(buy(10000000n, 10n, ok_a, 42n), sell(20000000n, 10n, ok_b, 43n), secrets)).toThrow(
      "prices incompatible",
    );
  });
});
