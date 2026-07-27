import { describe, expect, it } from "vitest";
import { PRICE_SCALE } from "@wraith/sdk";
import {
  MatchingEngine,
  OrderValidationError,
  computeMatch,
  pairKey,
  settleOrder,
} from "../src/engine.js";
import type { Side, SubmittedOrder } from "../src/types.js";

// ---- helpers --------------------------------------------------------------

let counter = 0;
function order(p: {
  side: Side;
  price: bigint;
  amount: bigint;
  assetBase?: string;
  assetQuote?: string;
  commitment?: string;
  ownerKey?: string;
  nonce?: string;
}): SubmittedOrder {
  counter += 1;
  return {
    commitment: p.commitment ?? `c${counter}`,
    side: p.side,
    price: p.price,
    amount: p.amount,
    assetBase: p.assetBase ?? "BASE",
    assetQuote: p.assetQuote ?? "QUOTE",
    ownerKey: p.ownerKey ?? `ok${counter}`,
    nonce: p.nonce ?? `n${counter}`,
  };
}

// ---- submit / validation --------------------------------------------------

describe("MatchingEngine.submit", () => {
  it("stamps a monotonic sequence and stores by pair", () => {
    const e = new MatchingEngine();
    const a = e.submit(order({ side: "buy", price: 100n, amount: 5n }));
    const b = e.submit(order({ side: "sell", price: 90n, amount: 5n }));
    expect(a.sequence).toBe(0);
    expect(b.sequence).toBe(1);
    expect(e.size).toBe(2);
    expect(e.getCommitments().sort()).toEqual([a.commitment, b.commitment].sort());
  });

  it("rejects bad side, zero/negative/oversized price & amount, and missing fields", () => {
    const e = new MatchingEngine();
    expect(() => e.submit(order({ side: "bid" as unknown as Side, price: 1n, amount: 1n }))).toThrow(
      OrderValidationError,
    );
    expect(() => e.submit(order({ side: "buy", price: 0n, amount: 1n }))).toThrow(/price must be > 0/);
    expect(() => e.submit(order({ side: "buy", price: 1n, amount: 0n }))).toThrow(/amount must be > 0/);
    expect(() => e.submit(order({ side: "buy", price: -1n, amount: 1n }))).toThrow(OrderValidationError);
    expect(() => e.submit(order({ side: "buy", price: 1n << 64n, amount: 1n }))).toThrow(/2\^64/);
    expect(() => e.submit(order({ side: "buy", price: 1n, amount: 1n, commitment: "" }))).toThrow(
      /commitment/,
    );
  });

  it("remove() drops an order by commitment", () => {
    const e = new MatchingEngine();
    const a = e.submit(order({ side: "buy", price: 100n, amount: 5n }));
    expect(e.remove(a.commitment)).toBe(true);
    expect(e.remove(a.commitment)).toBe(false);
    expect(e.size).toBe(0);
  });
});

// ---- crossing rules -------------------------------------------------------

describe("MatchingEngine.findMatches — crossing", () => {
  it("matches when prices overlap (buy >= sell)", () => {
    const e = new MatchingEngine();
    const buy = e.submit(order({ side: "buy", price: 100n, amount: 5n }));
    const sell = e.submit(order({ side: "sell", price: 90n, amount: 5n }));
    const matches = e.findMatches();
    expect(matches).toHaveLength(1);
    expect(matches[0]!.buy.commitment).toBe(buy.commitment);
    expect(matches[0]!.sell.commitment).toBe(sell.commitment);
  });

  it("matches at exactly equal prices (buy == sell)", () => {
    const e = new MatchingEngine();
    e.submit(order({ side: "buy", price: 100n, amount: 5n }));
    e.submit(order({ side: "sell", price: 100n, amount: 5n }));
    const matches = e.findMatches();
    expect(matches).toHaveLength(1);
    expect(matches[0]!.execPrice).toBe(100n);
  });

  it("does NOT match with no price overlap (buy < sell)", () => {
    const e = new MatchingEngine();
    e.submit(order({ side: "buy", price: 80n, amount: 5n }));
    e.submit(order({ side: "sell", price: 90n, amount: 5n }));
    expect(e.findMatches()).toHaveLength(0);
  });

  it("does NOT match same-side orders only", () => {
    const e = new MatchingEngine();
    e.submit(order({ side: "buy", price: 100n, amount: 5n }));
    e.submit(order({ side: "buy", price: 99n, amount: 5n }));
    expect(e.findMatches()).toHaveLength(0);

    const e2 = new MatchingEngine();
    e2.submit(order({ side: "sell", price: 50n, amount: 5n }));
    e2.submit(order({ side: "sell", price: 51n, amount: 5n }));
    expect(e2.findMatches()).toHaveLength(0);
  });

  it("does NOT match across different pairs", () => {
    const e = new MatchingEngine();
    e.submit(order({ side: "buy", price: 100n, amount: 5n, assetBase: "AAA", assetQuote: "BBB" }));
    e.submit(order({ side: "sell", price: 90n, amount: 5n, assetBase: "CCC", assetQuote: "DDD" }));
    expect(e.findMatches()).toHaveLength(0);

    // Swapped base/quote is a *different* pair, too.
    const e2 = new MatchingEngine();
    e2.submit(order({ side: "buy", price: 100n, amount: 5n, assetBase: "AAA", assetQuote: "BBB" }));
    e2.submit(order({ side: "sell", price: 90n, amount: 5n, assetBase: "BBB", assetQuote: "AAA" }));
    expect(e2.findMatches()).toHaveLength(0);
  });
});

// ---- economics (mirror the circuit) ---------------------------------------

describe("computeMatch — economics mirror the match_orders circuit", () => {
  it("execution price is the FLOOR of the midpoint", () => {
    const buy = order({ side: "buy", price: 7n, amount: 10n });
    const sell = order({ side: "sell", price: 4n, amount: 10n });
    // floor((7 + 4) / 2) = 5
    expect(computeMatch(buy, sell).execPrice).toBe(5n);
  });

  it("fill = min(amounts); quote_filled = floor(fill * exec / PRICE_SCALE)", () => {
    // buy 3 @ 2.0, sell 10 @ 1.0  -> exec 1.5, fill 3, quote floor(3*1.5)=4
    const buy = order({ side: "buy", price: 20_000_000n, amount: 3n });
    const sell = order({ side: "sell", price: 10_000_000n, amount: 10n });
    const m = computeMatch(buy, sell);
    expect(m.execPrice).toBe(15_000_000n);
    expect(m.fill).toBe(3n);
    expect(m.quoteFilled).toBe(4n); // floor(45_000_000 / 10_000_000)
    expect(PRICE_SCALE).toBe(10_000_000n);
  });

  it("exact fill: both fully filled, no residual; buy gets price-improvement refund", () => {
    // buy 10 @ 2.0, sell 10 @ 1.0 -> exec 1.5, fill 10, quote 15, buyer refund 20-15=5
    const buy = order({ side: "buy", price: 20_000_000n, amount: 10n });
    const sell = order({ side: "sell", price: 10_000_000n, amount: 10n });
    const m = computeMatch(buy, sell);
    expect(m.fill).toBe(10n);
    expect(m.quoteFilled).toBe(15n);
    expect(m.residualAmountA).toBe(0n);
    expect(m.residualAmountB).toBe(0n);
    expect(m.refundAmountA).toBe(5n); // fully-filled BUY price improvement
    expect(m.refundAmountB).toBe(0n); // SELL never refunds
  });

  it("partial fill: residual on the LARGER (buy) side, no refund on the filled portion", () => {
    // buy 10 @ 2.0, sell 4 @ 1.0 -> fill 4, residual buy 6, no refund (MVP)
    const buy = order({ side: "buy", price: 20_000_000n, amount: 10n });
    const sell = order({ side: "sell", price: 10_000_000n, amount: 4n });
    const m = computeMatch(buy, sell);
    expect(m.fill).toBe(4n);
    expect(m.residualAmountA).toBe(6n); // buy is larger -> residual on A
    expect(m.residualAmountB).toBe(0n);
    expect(m.refundAmountA).toBe(0n); // partially-filled buy: NO refund
    expect(m.refundAmountB).toBe(0n);
  });

  it("partial fill: residual on the LARGER (sell) side; the fully-filled buy still refunds", () => {
    // buy 4 @ 2.0, sell 10 @ 1.0 -> fill 4, residual sell 6, buy fully filled -> refund 8-6=2
    const buy = order({ side: "buy", price: 20_000_000n, amount: 4n });
    const sell = order({ side: "sell", price: 10_000_000n, amount: 10n });
    const m = computeMatch(buy, sell);
    expect(m.fill).toBe(4n);
    expect(m.quoteFilled).toBe(6n); // floor(4 * 1.5)
    expect(m.residualAmountA).toBe(0n);
    expect(m.residualAmountB).toBe(6n); // sell is larger -> residual on B
    expect(m.refundAmountA).toBe(2n); // floor(4*2.0)=8 locked, minus 6 filled
    expect(m.refundAmountB).toBe(0n);
  });

  it("settleOrder mirrors the circuit branches directly", () => {
    // partially-filled buy: residual, no refund
    expect(settleOrder({ side: "buy", price: 20_000_000n, amount: 10n }, 4n, 6n)).toEqual({
      residualAmount: 6n,
      refundAmount: 0n,
    });
    // fully-filled buy: refund = floor(amount*price/SCALE) - quoteFilled
    expect(settleOrder({ side: "buy", price: 20_000_000n, amount: 10n }, 10n, 15n)).toEqual({
      residualAmount: 0n,
      refundAmount: 5n,
    });
    // fully-filled sell: never refunds
    expect(settleOrder({ side: "sell", price: 10_000_000n, amount: 10n }, 10n, 15n)).toEqual({
      residualAmount: 0n,
      refundAmount: 0n,
    });
    // partially-filled sell: residual, no refund
    expect(settleOrder({ side: "sell", price: 10_000_000n, amount: 10n }, 4n, 6n)).toEqual({
      residualAmount: 6n,
      refundAmount: 0n,
    });
  });
});

// ---- price-time priority --------------------------------------------------

describe("MatchingEngine.findMatches — price-time priority", () => {
  it("crosses best-priced first, breaking ties by earliest submission", () => {
    const e = new MatchingEngine();
    // buys (submitted in this order -> sequence 0..)
    const b100 = e.submit(order({ side: "buy", price: 100n, amount: 5n, commitment: "b100" }));
    const b120early = e.submit(order({ side: "buy", price: 120n, amount: 5n, commitment: "b120e" }));
    const b120late = e.submit(order({ side: "buy", price: 120n, amount: 5n, commitment: "b120l" }));
    // sells
    const s90 = e.submit(order({ side: "sell", price: 90n, amount: 5n, commitment: "s90" }));
    const s80 = e.submit(order({ side: "sell", price: 80n, amount: 5n, commitment: "s80" }));
    const s95 = e.submit(order({ side: "sell", price: 95n, amount: 5n, commitment: "s95" }));

    const matches = e.findMatches();
    expect(matches).toHaveLength(3);

    // 1) best buy (120, earliest) x cheapest sell (80)
    expect([matches[0]!.buy.commitment, matches[0]!.sell.commitment]).toEqual([b120early.commitment, s80.commitment]);
    // 2) next buy (the later 120 — time priority among equal prices) x next sell (90)
    expect([matches[1]!.buy.commitment, matches[1]!.sell.commitment]).toEqual([b120late.commitment, s90.commitment]);
    // 3) remaining buy (100) x remaining sell (95)
    expect([matches[2]!.buy.commitment, matches[2]!.sell.commitment]).toEqual([b100.commitment, s95.commitment]);
  });

  it("stops crossing once the best remaining buy can't reach the cheapest sell", () => {
    const e = new MatchingEngine();
    e.submit(order({ side: "buy", price: 100n, amount: 5n, commitment: "b100" }));
    e.submit(order({ side: "buy", price: 70n, amount: 5n, commitment: "b70" }));
    e.submit(order({ side: "sell", price: 90n, amount: 5n, commitment: "s90" }));
    e.submit(order({ side: "sell", price: 95n, amount: 5n, commitment: "s95" }));
    // only b100 crosses s90; b70 < s95 -> stop. 1 match.
    const matches = e.findMatches();
    expect(matches).toHaveLength(1);
    expect([matches[0]!.buy.commitment, matches[0]!.sell.commitment]).toEqual(["b100", "s90"]);
  });

  it("keys orders by pair", () => {
    expect(pairKey({ assetBase: "A", assetQuote: "B" })).toBe("A|B");
    expect(pairKey({ assetBase: "A", assetQuote: "B" })).not.toBe(pairKey({ assetBase: "B", assetQuote: "A" }));
  });
});
