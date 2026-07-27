/**
 * Match settlement delivery: the matcher seals each fill/refund note + residual order to its
 * owner (in the contract's exact insertion order), and the owner recovers them with their
 * viewing key. Uses the shared @wraith/sdk sealing, so this is the same path the wallet's
 * indexer runs on-chain.
 */
import { describe, expect, it } from "vitest";
import {
  createOrder,
  decryptNote,
  decryptOrder,
  deriveEncKeypair,
  deriveOwnerKey,
  deriveViewingKey,
  encodeReceiveCode,
  fieldToHex,
  OrderSide,
  randomField,
  type Order,
} from "@wraith/sdk";
import { computeMatch } from "../src/engine.js";
import { assembleMatchInputs, type MatchBlindings } from "../src/prover.js";
import { buildMatchMemos } from "../src/memo.js";
import type { SubmittedOrder } from "../src/types.js";

function trader() {
  const sk = randomField();
  const enc = deriveEncKeypair(deriveViewingKey(sk));
  return { enc, ownerKey: deriveOwnerKey(sk), code: encodeReceiveCode(deriveOwnerKey(sk), enc.pub) };
}

function submitted(o: Order, side: "buy" | "sell", code: string): SubmittedOrder {
  return {
    commitment: fieldToHex(o.commitment),
    side,
    price: o.price,
    amount: o.amount,
    assetBase: fieldToHex(o.assetBase),
    assetQuote: fieldToHex(o.assetQuote),
    ownerKey: fieldToHex(o.ownerKey),
    nonce: fieldToHex(o.nonce),
    receiveCode: code,
    baseCode: "XLM",
    quoteCode: "USDC",
  };
}

const blindings: MatchBlindings = {
  buyerFillBlinding: 701n,
  sellerFillBlinding: 702n,
  residualANonce: 801n,
  residualBNonce: 802n,
  refundABlinding: 703n,
  refundBBlinding: 804n,
};
const pair = { assetBase: 0n, assetQuote: 1n };

describe("buildMatchMemos → owner recovery", () => {
  it("full fill with buyer refund: 3 leaf memos (fill_buyer, fill_seller, refund_a), 0 residual", () => {
    const buyer = trader();
    const seller = trader();
    const buy = submitted(createOrder({ side: OrderSide.Buy, price: 20000000n, amount: 10n, ...pair, ownerKey: buyer.ownerKey, nonce: 42n }), "buy", buyer.code);
    const sell = submitted(createOrder({ side: OrderSide.Sell, price: 10000000n, amount: 10n, ...pair, ownerKey: seller.ownerKey, nonce: 43n }), "sell", seller.code);

    const match = computeMatch(buy, sell);
    const assembled = assembleMatchInputs(match, blindings);
    const { leafMemos, residualMemos } = buildMatchMemos(match, assembled);

    expect(leafMemos).toHaveLength(3);
    expect(residualMemos).toHaveLength(0);

    // Buyer decrypts leaf 0 (fill: 10 base) and leaf 2 (refund: 5 quote); NOT the seller's.
    const fillBuyer = decryptNote(buyer.enc, leafMemos[0]!);
    expect(fillBuyer?.amount).toBe("10");
    expect(fillBuyer?.commitment).toBe(fieldToHex(assembled.publicInputs[2]!));
    expect(fillBuyer?.ownerKey).toBe(fieldToHex(buyer.ownerKey));
    expect(decryptNote(seller.enc, leafMemos[0]!)).toBeNull();

    const refundA = decryptNote(buyer.enc, leafMemos[2]!);
    expect(refundA?.amount).toBe("5");
    expect(refundA?.commitment).toBe(fieldToHex(assembled.publicInputs[6]!));

    // Seller decrypts leaf 1 (fill: 15 quote).
    const fillSeller = decryptNote(seller.enc, leafMemos[1]!);
    expect(fillSeller?.amount).toBe("15");
    expect(fillSeller?.commitment).toBe(fieldToHex(assembled.publicInputs[3]!));
    expect(fillSeller?.code).toBe("USDC");
  });

  it("partial fill: 2 leaf memos + 1 residual-order memo the buyer can reopen + cancel", () => {
    const buyer = trader();
    const seller = trader();
    const buy = submitted(createOrder({ side: OrderSide.Buy, price: 20000000n, amount: 10n, ...pair, ownerKey: buyer.ownerKey, nonce: 42n }), "buy", buyer.code);
    const sell = submitted(createOrder({ side: OrderSide.Sell, price: 10000000n, amount: 4n, ...pair, ownerKey: seller.ownerKey, nonce: 43n }), "sell", seller.code);

    const match = computeMatch(buy, sell);
    const assembled = assembleMatchInputs(match, blindings);
    const { leafMemos, residualMemos } = buildMatchMemos(match, assembled);

    expect(leafMemos).toHaveLength(2); // fills only, no refunds
    expect(residualMemos).toHaveLength(1); // residual A (buyer's remaining 6)

    const residualA = decryptOrder(buyer.enc, residualMemos[0]!);
    expect(residualA?.kind).toBe("order");
    expect(residualA?.amount).toBe("6");
    expect(residualA?.side).toBe(0); // buy
    expect(residualA?.commitment).toBe(fieldToHex(assembled.publicInputs[4]!));
    expect(decryptOrder(seller.enc, residualMemos[0]!)).toBeNull();
  });
});
