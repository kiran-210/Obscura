/**
 * Stellar encoding: public-input serialization and address->field mapping.
 * Operation building is covered structurally (no live RPC).
 */
import { describe, expect, it } from "vitest";
import {
  WraithContract,
  addressToField,
  assetIdFromAddress,
  decodePublicInputs,
  encodePublicInputs,
  PUBLIC_INPUT_ORDER,
  recipientHash,
} from "../src/stellar.js";
import { NATIVE_ASSET_ID } from "../src/constants.js";
import { hash2 } from "../src/poseidon.js";

// A valid testnet contract StrKey (all-zero contract id) for deterministic decoding.
const CONTRACT_ID = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";

describe("public_inputs encoding (SHARED sec 6-7)", () => {
  it("concatenates 32-byte big-endian field elements", () => {
    const fields = [hash2(1n, 2n), hash2(3n, 4n), 5n];
    const bytes = encodePublicInputs(fields);
    expect(bytes.length).toBe(fields.length * 32);
    expect(decodePublicInputs(bytes)).toEqual(fields);
  });

  it("rejects mis-sized inputs on decode", () => {
    expect(() => decodePublicInputs(new Uint8Array(33))).toThrow();
  });

  it("declares the authoritative per-circuit public-input order", () => {
    expect(PUBLIC_INPUT_ORDER.withdraw).toEqual([
      "merkle_root",
      "nullifier",
      "recipient_hash",
      "amount",
      "asset_id",
    ]);
    expect(PUBLIC_INPUT_ORDER.cancel_order.length).toBe(3);
    expect(PUBLIC_INPUT_ORDER.match_orders.length).toBe(8);
  });
});

describe("address mapping", () => {
  it("native XLM has asset_id 0", () => {
    expect(assetIdFromAddress(undefined)).toBe(NATIVE_ASSET_ID);
    expect(assetIdFromAddress("native")).toBe(NATIVE_ASSET_ID);
  });

  it("SAC asset_id = hash2(addressAsField, 0)", () => {
    const expected = hash2(addressToField(CONTRACT_ID), 0);
    expect(assetIdFromAddress(CONTRACT_ID)).toBe(expected);
  });

  it("recipient_hash = hash2(addressAsField, 0)", () => {
    expect(recipientHash(CONTRACT_ID)).toBe(hash2(addressToField(CONTRACT_ID), 0));
  });

  it("rejects malformed addresses", () => {
    expect(() => addressToField("not-an-address")).toThrow();
  });
});

describe("WraithContract operation building", () => {
  const c = new WraithContract({ contractId: CONTRACT_ID });

  it("builds a deposit operation", () => {
    const op = c.depositOp({ from: CONTRACT_ID, asset: CONTRACT_ID, amount: 1000n, commitment: 123n });
    expect(op).toBeDefined();
  });

  it("transfer op accepts a 14592-byte proof and rejects wrong sizes", () => {
    const proof = new Uint8Array(14_592);
    const publicInputs = encodePublicInputs([1n, 2n]);
    expect(c.transferOp({ proof, publicInputs })).toBeDefined();
    expect(() => c.transferOp({ proof: new Uint8Array(100), publicInputs })).toThrow(/14592/);
  });
});
