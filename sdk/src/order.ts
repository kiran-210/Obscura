/**
 * Dark-pool orders: creation and commitment. SHARED.md sec 4 / SPEC sec 7.
 *
 *   order_commitment = hash7(side, price, amount, asset_base, asset_quote, owner_key, nonce)
 *
 * Field order is fixed and must match the Noir circuits and the contract exactly.
 */
import { PRICE_SCALE } from "./constants.js";
import { hash7, randomField, toField, type Field, type FieldLike } from "./poseidon.js";
import { assertU64, deriveOwnerKey } from "./note.js";
import { OrderSide, type Order, type OrderParams } from "./types.js";

/** order_commitment = hash7(side, price, amount, asset_base, asset_quote, owner_key, nonce). */
export function computeOrderCommitment(o: {
  side: FieldLike;
  price: FieldLike;
  amount: FieldLike;
  assetBase: FieldLike;
  assetQuote: FieldLike;
  ownerKey: FieldLike;
  nonce: FieldLike;
}): Field {
  return hash7(o.side, o.price, o.amount, o.assetBase, o.assetQuote, o.ownerKey, o.nonce);
}

/**
 * Build an {@link Order}, computing its commitment. Supply either `ownerKey` directly
 * or a `spendingKey` to derive it. A random `nonce` is drawn unless supplied.
 */
export function createOrder(
  params: OrderParams & {
    ownerKey?: FieldLike;
    spendingKey?: FieldLike;
    nonce?: FieldLike;
  },
): Order {
  assertU64(params.price, "price");
  assertU64(params.amount, "amount");

  let ownerKey: Field;
  if (params.ownerKey !== undefined) {
    ownerKey = toField(params.ownerKey);
  } else if (params.spendingKey !== undefined) {
    ownerKey = deriveOwnerKey(params.spendingKey);
  } else {
    throw new Error("createOrder requires either ownerKey or spendingKey");
  }

  const nonce = params.nonce !== undefined ? toField(params.nonce) : randomField();
  const assetBase = toField(params.assetBase);
  const assetQuote = toField(params.assetQuote);
  const commitment = computeOrderCommitment({
    side: params.side,
    price: params.price,
    amount: params.amount,
    assetBase,
    assetQuote,
    ownerKey,
    nonce,
  });

  return {
    side: params.side,
    price: params.price,
    amount: params.amount,
    assetBase,
    assetQuote,
    ownerKey,
    nonce,
    commitment,
  };
}

/**
 * The asset and amount an order locks when placed (mirrors the place_order circuit's
 * balance check). Buy locks quote (`amount * price / PRICE_SCALE`); sell locks base
 * (`amount`). SPEC sec 8.3.
 */
export function orderLockedAmount(order: Pick<Order, "side" | "price" | "amount" | "assetBase" | "assetQuote">): {
  assetId: Field;
  amount: bigint;
} {
  if (order.side === OrderSide.Buy) {
    return { assetId: order.assetQuote, amount: (order.amount * order.price) / PRICE_SCALE };
  }
  return { assetId: order.assetBase, amount: order.amount };
}
