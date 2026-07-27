/**
 * BLOCKING golden-vector gate (SHARED.md sec 9). The SDK's Poseidon2 must reproduce the
 * on-chain/Noir hash for arities 2, 4, and 7. Vectors in poseidon.golden.json were
 * generated from the pinned Noir `poseidon` v0.2.0 lib (test/golden-gen).
 *
 * Do not weaken these assertions: a silent mismatch makes every Wraith note unspendable.
 */
import { describe, expect, it } from "vitest";
import golden from "./poseidon.golden.json" assert { type: "json" };
import {
  bytesToField,
  fieldToBytes,
  fieldToHex,
  hash,
  hash2,
  hash4,
  hash7,
  hexToField,
  toField,
} from "../src/poseidon.js";
import { BN254_FIELD_MODULUS } from "../src/constants.js";

const callByArity = (inputs: bigint[]): bigint => {
  switch (inputs.length) {
    case 2:
      return hash2(inputs[0]!, inputs[1]!);
    case 4:
      return hash4(inputs[0]!, inputs[1]!, inputs[2]!, inputs[3]!);
    case 7:
      return hash7(inputs[0]!, inputs[1]!, inputs[2]!, inputs[3]!, inputs[4]!, inputs[5]!, inputs[6]!);
    default:
      return hash(inputs);
  }
};

describe("Poseidon2 golden-vector gate (SHARED sec 9)", () => {
  for (const v of golden.vectors) {
    it(`${v.name} [arity ${v.arity}] reproduces the Noir/on-chain hash`, () => {
      const inputs = v.inputs.map((s) => BigInt(s));
      const got = callByArity(inputs);
      expect(fieldToHex(got)).toBe(v.expected);
    });
  }

  it("covers arities 2, 4 and 7", () => {
    const arities = new Set(golden.vectors.map((v) => v.arity));
    expect(arities).toEqual(new Set([2, 4, 7]));
  });

  it("variable-arity hash() agrees with the fixed-arity helpers", () => {
    expect(hash([1n, 2n])).toBe(hash2(1n, 2n));
    expect(hash([1n, 2n, 3n, 4n])).toBe(hash4(1n, 2n, 3n, 4n));
    expect(hash([1n, 2n, 3n, 4n, 5n, 6n, 7n])).toBe(hash7(1n, 2n, 3n, 4n, 5n, 6n, 7n));
  });
});

describe("field helpers", () => {
  it("reduces inputs mod r (matches on-chain rem_euclid)", () => {
    expect(toField(BN254_FIELD_MODULUS)).toBe(0n);
    expect(toField(BN254_FIELD_MODULUS + 5n)).toBe(5n);
    expect(toField(-1n)).toBe(BN254_FIELD_MODULUS - 1n);
  });

  it("fieldToBytes is 32-byte big-endian and round-trips", () => {
    const x = hash2(123n, 456n);
    const bytes = fieldToBytes(x);
    expect(bytes.length).toBe(32);
    expect(bytesToField(bytes)).toBe(x);
  });

  it("fieldToHex / hexToField round-trip", () => {
    const x = hash7(1n, 2n, 3n, 4n, 5n, 6n, 7n);
    const hex = fieldToHex(x);
    expect(hex).toMatch(/^0x[0-9a-f]{64}$/);
    expect(hexToField(hex)).toBe(x);
  });

  it("hashing reduced and unreduced inputs agree", () => {
    expect(hash2(0n, 0n)).toBe(hash2(BN254_FIELD_MODULUS, BN254_FIELD_MODULUS));
  });
});
