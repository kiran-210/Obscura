/**
 * Balance notes: key derivation, commitments, nullifiers. SHARED.md sec 4 / SPEC sec 4.
 *
 *   owner_key   = hash2(spending_key, 0)
 *   viewing_key = hash2(spending_key, 1)
 *   commitment  = hash4(asset_id, amount, owner_key, blinding)   // field order is fixed
 *   nullifier   = hash2(commitment, spending_key)
 */
import { hash2, hash4, randomField, toField, type Field, type FieldLike } from "./poseidon.js";
import type { BalanceNote, KeyPair, OutputNote } from "./types.js";

const TWO_POW_64 = 1n << 64n;

/** Assert a value fits in the in-circuit 64-bit range check (amounts, prices). */
export function assertU64(value: bigint, label = "value"): void {
  if (value < 0n || value >= TWO_POW_64) {
    throw new RangeError(`${label} must be in [0, 2^64): got ${value}`);
  }
}

/** owner_key = hash2(spending_key, 0). Public identity. SHARED sec 4. */
export function deriveOwnerKey(spendingKey: FieldLike): Field {
  return hash2(spendingKey, 0);
}

/** viewing_key = hash2(spending_key, 1). Optional selective-disclosure key. */
export function deriveViewingKey(spendingKey: FieldLike): Field {
  return hash2(spendingKey, 1);
}

/** Derive the full {@link KeyPair} from a spending key. */
export function deriveKeys(spendingKey: FieldLike): KeyPair {
  const sk = toField(spendingKey);
  return { spendingKey: sk, ownerKey: deriveOwnerKey(sk), viewingKey: deriveViewingKey(sk) };
}

/** Generate a fresh random {@link KeyPair}. */
export function generateKeyPair(): KeyPair {
  return deriveKeys(randomField());
}

/**
 * Asset id for a SAC asset: `hash2(sacAddressAsField, 0)`. Native XLM uses `assetId = 0`.
 * SHARED sec 4 / SPEC sec 5.3. The caller is responsible for mapping a StrKey "C..."
 * address to a field via {@link addressToField} in stellar.ts.
 */
export function assetIdFromAddressField(addressAsField: FieldLike): Field {
  return hash2(addressAsField, 0);
}

/** commitment = hash4(asset_id, amount, owner_key, blinding). SHARED sec 4. */
export function computeCommitment(
  assetId: FieldLike,
  amount: FieldLike,
  ownerKey: FieldLike,
  blinding: FieldLike,
): Field {
  return hash4(assetId, amount, ownerKey, blinding);
}

/** nullifier = hash2(commitment, spending_key). SHARED sec 4. */
export function computeNullifier(commitment: FieldLike, spendingKey: FieldLike): Field {
  return hash2(commitment, spendingKey);
}

/**
 * Create a spendable balance note owned by `spendingKey`. A random `blinding` is drawn
 * unless one is supplied (useful for deterministic tests).
 */
export function createNote(params: {
  assetId: FieldLike;
  amount: bigint;
  spendingKey: FieldLike;
  blinding?: FieldLike;
  leafIndex?: number;
}): BalanceNote {
  assertU64(params.amount, "amount");
  const spendingKey = toField(params.spendingKey);
  const ownerKey = deriveOwnerKey(spendingKey);
  const blinding = params.blinding !== undefined ? toField(params.blinding) : randomField();
  const assetId = toField(params.assetId);
  const commitment = computeCommitment(assetId, params.amount, ownerKey, blinding);
  const note: BalanceNote = {
    assetId,
    amount: params.amount,
    ownerKey,
    blinding,
    spendingKey,
    commitment,
  };
  if (params.leafIndex !== undefined) {
    note.leafIndex = params.leafIndex;
  }
  return note;
}

/**
 * Create an output note destined for a recipient identified only by their public
 * `ownerKey` (no spending key). Used by transfers and settlements.
 */
export function createOutputNote(params: {
  assetId: FieldLike;
  amount: bigint;
  ownerKey: FieldLike;
  blinding?: FieldLike;
}): OutputNote {
  assertU64(params.amount, "amount");
  const assetId = toField(params.assetId);
  const ownerKey = toField(params.ownerKey);
  const blinding = params.blinding !== undefined ? toField(params.blinding) : randomField();
  const commitment = computeCommitment(assetId, params.amount, ownerKey, blinding);
  return { assetId, amount: params.amount, ownerKey, blinding, commitment };
}

/** Nullifier for an owned note. */
export function noteNullifier(note: BalanceNote): Field {
  return computeNullifier(note.commitment, note.spendingKey);
}
