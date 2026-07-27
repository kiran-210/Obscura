/**
 * Note commitments, nullifiers, and key derivation — anchored to Noir golden vectors
 * (commitments.golden.json) and SHARED sec 4 field ordering.
 */
import { describe, expect, it } from "vitest";
import golden from "./commitments.golden.json" assert { type: "json" };
import {
  computeCommitment,
  computeNullifier,
  createNote,
  deriveKeys,
  deriveOwnerKey,
  deriveViewingKey,
  noteNullifier,
} from "../src/note.js";
import { fieldToHex } from "../src/poseidon.js";

const g = golden.note;

describe("key derivation (SHARED sec 4)", () => {
  it("owner_key = hash2(spending_key, 0)", () => {
    expect(fieldToHex(deriveOwnerKey(BigInt(g.spendingKey)))).toBe(g.ownerKey);
  });
  it("viewing_key = hash2(spending_key, 1)", () => {
    expect(fieldToHex(deriveViewingKey(BigInt(g.spendingKey)))).toBe(g.viewingKey);
  });
  it("deriveKeys returns matching owner/viewing keys", () => {
    const keys = deriveKeys(BigInt(g.spendingKey));
    expect(fieldToHex(keys.ownerKey)).toBe(g.ownerKey);
    expect(fieldToHex(keys.viewingKey)).toBe(g.viewingKey);
  });
});

describe("commitment & nullifier vectors (SHARED sec 4)", () => {
  it("commitment = hash4(asset_id, amount, owner_key, blinding)", () => {
    const c = computeCommitment(BigInt(g.assetId), BigInt(g.amount), BigInt(g.ownerKey), BigInt(g.blinding));
    expect(fieldToHex(c)).toBe(g.commitment);
  });

  it("nullifier = hash2(commitment, spending_key)", () => {
    const n = computeNullifier(BigInt(g.commitment), BigInt(g.spendingKey));
    expect(fieldToHex(n)).toBe(g.nullifier);
  });

  it("createNote reproduces the golden commitment and nullifier", () => {
    const note = createNote({
      assetId: BigInt(g.assetId),
      amount: BigInt(g.amount),
      spendingKey: BigInt(g.spendingKey),
      blinding: BigInt(g.blinding),
    });
    expect(fieldToHex(note.ownerKey)).toBe(g.ownerKey);
    expect(fieldToHex(note.commitment)).toBe(g.commitment);
    expect(fieldToHex(noteNullifier(note))).toBe(g.nullifier);
  });
});

describe("createNote behavior", () => {
  it("draws a random blinding when none is supplied (commitments differ)", () => {
    const a = createNote({ assetId: 5n, amount: 1000n, spendingKey: 42n });
    const b = createNote({ assetId: 5n, amount: 1000n, spendingKey: 42n });
    expect(a.blinding).not.toBe(b.blinding);
    expect(a.commitment).not.toBe(b.commitment);
  });

  it("rejects amounts >= 2^64", () => {
    expect(() => createNote({ assetId: 5n, amount: 1n << 64n, spendingKey: 42n })).toThrow();
  });
});
