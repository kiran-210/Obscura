/**
 * In-memory wallet: stores owned balance notes and open orders, aggregates shielded
 * balances per asset, and selects notes to fund spends. SPEC sec 10.2.
 *
 * This is a client-side cache only; authority is always the on-chain Merkle tree and
 * nullifier set. Notes should be added when a Deposit/Transfer/settlement is observed
 * and marked spent when their nullifier is published.
 */
import { fieldToHex, type Field } from "./poseidon.js";
import { noteNullifier } from "./note.js";
import type { BalanceNote, Order } from "./types.js";

export class Wallet {
  /** Active (unspent) notes keyed by commitment hex. */
  private readonly notes = new Map<string, BalanceNote>();
  /** Nullifier hexes known to be spent. */
  private readonly spent = new Set<string>();
  /** Open orders keyed by order-commitment hex. */
  private readonly orders = new Map<string, Order>();

  /** Add (or replace) an owned note. */
  addNote(note: BalanceNote): void {
    this.notes.set(fieldToHex(note.commitment), note);
  }

  /** Add many notes. */
  addNotes(notes: Iterable<BalanceNote>): void {
    for (const n of notes) this.addNote(n);
  }

  /** Remove a note from the active set by commitment. */
  removeNote(commitment: Field): void {
    this.notes.delete(fieldToHex(commitment));
  }

  /** Mark a note spent (records its nullifier and drops it from the active set). */
  markNoteSpent(note: BalanceNote): void {
    this.spent.add(fieldToHex(noteNullifier(note)));
    this.removeNote(note.commitment);
  }

  /** Whether a nullifier has been recorded as spent in this wallet. */
  isSpent(nullifier: Field): boolean {
    return this.spent.has(fieldToHex(nullifier));
  }

  /** All active notes, optionally filtered by asset. */
  getNotes(assetId?: Field): BalanceNote[] {
    const all = [...this.notes.values()];
    return assetId === undefined ? all : all.filter((n) => n.assetId === assetId);
  }

  /** Total unspent balance for a single asset. */
  getBalance(assetId: Field): bigint {
    let sum = 0n;
    for (const n of this.notes.values()) {
      if (n.assetId === assetId) sum += n.amount;
    }
    return sum;
  }

  /** Aggregate shielded balances per asset id. SPEC sec 10.2 `getShieldedBalances`. */
  getShieldedBalances(): Map<Field, bigint> {
    const out = new Map<Field, bigint>();
    for (const n of this.notes.values()) {
      out.set(n.assetId, (out.get(n.assetId) ?? 0n) + n.amount);
    }
    return out;
  }

  /**
   * Select unspent notes of `assetId` whose amounts sum to at least `amount`.
   * Greedy largest-first to minimize the number of inputs. Throws if the balance is
   * insufficient. SPEC sec 10.2 `selectNotes`.
   */
  selectNotes(assetId: Field, amount: bigint): BalanceNote[] {
    if (amount <= 0n) return [];
    const candidates = this.getNotes(assetId).sort((a, b) =>
      a.amount < b.amount ? 1 : a.amount > b.amount ? -1 : 0,
    );
    const picked: BalanceNote[] = [];
    let total = 0n;
    for (const n of candidates) {
      picked.push(n);
      total += n.amount;
      if (total >= amount) return picked;
    }
    throw new Error(
      `insufficient balance for asset ${fieldToHex(assetId)}: have ${total}, need ${amount}`,
    );
  }

  // --- Orders ---

  /** Record an open order. */
  addOrder(order: Order): void {
    this.orders.set(fieldToHex(order.commitment), order);
  }

  /** Remove an order (on cancel or full fill). */
  removeOrder(commitment: Field): void {
    this.orders.delete(fieldToHex(commitment));
  }

  /** All open orders. SPEC sec 10 `getOpenOrders`. */
  getOpenOrders(): Order[] {
    return [...this.orders.values()];
  }

  /** Lookup an order by its commitment. */
  getOrder(commitment: Field): Order | undefined {
    return this.orders.get(fieldToHex(commitment));
  }
}
