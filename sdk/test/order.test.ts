/**
 * Order commitments (hash7) — anchored to a Noir golden vector — plus locked-amount math.
 */
import { describe, expect, it } from "vitest";
import golden from "./commitments.golden.json" assert { type: "json" };
import { computeOrderCommitment, createOrder, orderLockedAmount } from "../src/order.js";
import { OrderSide } from "../src/types.js";
import { fieldToHex } from "../src/poseidon.js";
import { PRICE_SCALE } from "../src/constants.js";

const g = golden.order;

describe("order commitment vector (SHARED sec 4)", () => {
  it("order_commitment = hash7(side, price, amount, base, quote, owner_key, nonce)", () => {
    const c = computeOrderCommitment({
      side: BigInt(g.side),
      price: BigInt(g.price),
      amount: BigInt(g.amount),
      assetBase: BigInt(g.assetBase),
      assetQuote: BigInt(g.assetQuote),
      ownerKey: BigInt(g.ownerKey),
      nonce: BigInt(g.nonce),
    });
    expect(fieldToHex(c)).toBe(g.commitment);
  });

  it("createOrder reproduces the golden commitment", () => {
    const order = createOrder({
      side: OrderSide.Sell,
      price: BigInt(g.price),
      amount: BigInt(g.amount),
      assetBase: BigInt(g.assetBase),
      assetQuote: BigInt(g.assetQuote),
      spendingKey: BigInt(g.spendingKey),
      nonce: BigInt(g.nonce),
    });
    expect(fieldToHex(order.ownerKey)).toBe(g.ownerKey);
    expect(fieldToHex(order.commitment)).toBe(g.commitment);
  });
});

describe("orderLockedAmount (SPEC sec 8.3)", () => {
  it("sell locks the base asset, amount = order amount", () => {
    const locked = orderLockedAmount({
      side: OrderSide.Sell,
      price: 25_000_000n,
      amount: 1000n,
      assetBase: 5n,
      assetQuote: 9n,
    });
    expect(locked.assetId).toBe(5n);
    expect(locked.amount).toBe(1000n);
  });

  it("buy locks the quote asset, amount = amount * price / PRICE_SCALE", () => {
    const locked = orderLockedAmount({
      side: OrderSide.Buy,
      price: 25_000_000n, // 2.5 in PRICE_SCALE units
      amount: 1000n,
      assetBase: 5n,
      assetQuote: 9n,
    });
    expect(locked.assetId).toBe(9n);
    expect(locked.amount).toBe((1000n * 25_000_000n) / PRICE_SCALE);
  });
});

describe("createOrder validation", () => {
  it("requires ownerKey or spendingKey", () => {
    expect(() =>
      createOrder({ side: OrderSide.Buy, price: 1n, amount: 1n, assetBase: 1n, assetQuote: 2n }),
    ).toThrow();
  });
  it("rejects price/amount >= 2^64", () => {
    expect(() =>
      createOrder({ side: OrderSide.Buy, price: 1n << 64n, amount: 1n, assetBase: 1n, assetQuote: 2n, spendingKey: 1n }),
    ).toThrow();
  });
});
