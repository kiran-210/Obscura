/**
 * Wallet: balance aggregation and greedy note selection.
 */
import { describe, expect, it } from "vitest";
import { Wallet } from "../src/wallet.js";
import { createNote, noteNullifier } from "../src/note.js";

const note = (assetId: bigint, amount: bigint, blinding: bigint) =>
  createNote({ assetId, amount, spendingKey: 42n, blinding });

describe("Wallet balances", () => {
  it("aggregates per-asset balances over unspent notes", () => {
    const w = new Wallet();
    w.addNote(note(5n, 100n, 1n));
    w.addNote(note(5n, 250n, 2n));
    w.addNote(note(9n, 70n, 3n));
    expect(w.getBalance(5n)).toBe(350n);
    expect(w.getBalance(9n)).toBe(70n);
    const balances = w.getShieldedBalances();
    expect(balances.get(5n)).toBe(350n);
    expect(balances.get(9n)).toBe(70n);
  });

  it("excludes spent notes from balances", () => {
    const w = new Wallet();
    const n = note(5n, 100n, 1n);
    w.addNote(n);
    expect(w.getBalance(5n)).toBe(100n);
    w.markNoteSpent(n);
    expect(w.getBalance(5n)).toBe(0n);
    expect(w.isSpent(noteNullifier(n))).toBe(true);
  });
});

describe("note selection", () => {
  it("selects greedily largest-first to cover the amount", () => {
    const w = new Wallet();
    w.addNote(note(5n, 100n, 1n));
    w.addNote(note(5n, 250n, 2n));
    w.addNote(note(5n, 30n, 3n));
    const picked = w.selectNotes(5n, 300n);
    expect(picked.reduce((s, n) => s + n.amount, 0n) >= 300n).toBe(true);
    // Largest-first: 250 + 100 covers 300 with 2 notes.
    expect(picked.length).toBe(2);
    expect(picked[0]!.amount).toBe(250n);
  });

  it("throws when balance is insufficient", () => {
    const w = new Wallet();
    w.addNote(note(5n, 100n, 1n));
    expect(() => w.selectNotes(5n, 1000n)).toThrow(/insufficient/);
  });

  it("returns empty for non-positive amount", () => {
    expect(new Wallet().selectNotes(5n, 0n)).toEqual([]);
  });
});
