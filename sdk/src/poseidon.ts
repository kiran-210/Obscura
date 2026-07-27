/**
 * Poseidon2 over BN254 — the critical cross-component invariant (SHARED.md sec 3).
 *
 * Parametrization: BN254, state width t = 4, RATE 3, HADES, S-box x^5, variable-length
 * sponge with domain/IV `iv = num_inputs * 2^64`, output = `state[0]`.
 *
 * Backed by `@zkpassport/poseidon2` (`poseidon2Hash`), which is a pure-TS port of the
 * Barretenberg / Noir Poseidon2 sponge. It is validated against golden vectors generated
 * from the pinned Noir `poseidon` v0.2.0 lib in test/poseidon.test.ts. Golden-vector
 * status (regenerate via `pnpm golden`):
 *
 *   arity 2  ->  PASS
 *   arity 4  ->  PASS
 *   arity 7  ->  PASS
 *
 * Inputs are reduced mod r before hashing, matching the on-chain Soroban path
 * (`U256::from_be_bytes(..).rem_euclid(&modulus)`), so out-of-range inputs cannot
 * produce an SDK/contract divergence.
 */
import { poseidon2Hash } from "@zkpassport/poseidon2";
import { BN254_FIELD_MODULUS, FIELD_BYTES } from "./constants.js";

/** A BN254 scalar-field element, canonically reduced to `[0, r)`. */
export type Field = bigint;

/** Accepted loose inputs that can be coerced into a {@link Field}. */
export type FieldLike = bigint | number | string | Uint8Array;

/**
 * Coerce any {@link FieldLike} into a canonical {@link Field} in `[0, r)`.
 * - `bigint`/`number`: reduced mod r (negatives wrap).
 * - `string`: `0x`-prefixed hex or decimal.
 * - `Uint8Array`: interpreted as big-endian bytes.
 */
export function toField(x: FieldLike): Field {
  let v: bigint;
  if (typeof x === "bigint") {
    v = x;
  } else if (typeof x === "number") {
    if (!Number.isInteger(x)) {
      throw new TypeError(`toField: non-integer number ${x}`);
    }
    v = BigInt(x);
  } else if (typeof x === "string") {
    // BigInt() handles both "0x"-prefixed hex and decimal strings.
    v = BigInt(x.trim());
  } else {
    v = bytesToField(x);
  }
  v %= BN254_FIELD_MODULUS;
  if (v < 0n) v += BN254_FIELD_MODULUS;
  return v;
}

/** Variable-arity Poseidon2 hash. Inputs are canonicalized via {@link toField}. */
export function hash(inputs: readonly FieldLike[]): Field {
  return poseidon2Hash(inputs.map(toField));
}

/** 2-to-1 Poseidon2 (Merkle nodes, nullifiers, key derivation). SHARED sec 3. */
export function hash2(a: FieldLike, b: FieldLike): Field {
  return poseidon2Hash([toField(a), toField(b)]);
}

/** 4-to-1 Poseidon2 (balance-note commitments). SHARED sec 4. */
export function hash4(a: FieldLike, b: FieldLike, c: FieldLike, d: FieldLike): Field {
  return poseidon2Hash([toField(a), toField(b), toField(c), toField(d)]);
}

/** 7-to-1 Poseidon2 (order commitments). SHARED sec 4. */
export function hash7(
  a: FieldLike,
  b: FieldLike,
  c: FieldLike,
  d: FieldLike,
  e: FieldLike,
  f: FieldLike,
  g: FieldLike,
): Field {
  return poseidon2Hash([
    toField(a),
    toField(b),
    toField(c),
    toField(d),
    toField(e),
    toField(f),
    toField(g),
  ]);
}

/** Serialize a field element to 32-byte big-endian (the on-wire form). SHARED sec 2. */
export function fieldToBytes(x: Field): Uint8Array {
  const v = ((x % BN254_FIELD_MODULUS) + BN254_FIELD_MODULUS) % BN254_FIELD_MODULUS;
  const out = new Uint8Array(FIELD_BYTES);
  let t = v;
  for (let i = FIELD_BYTES - 1; i >= 0; i--) {
    out[i] = Number(t & 0xffn);
    t >>= 8n;
  }
  return out;
}

/** Parse a big-endian byte array into a field element. */
export function bytesToField(b: Uint8Array): Field {
  let v = 0n;
  for (const byte of b) {
    v = (v << 8n) | BigInt(byte);
  }
  return v;
}

/** Format a field element as a `0x`-prefixed 64-hex-char (32-byte) string. */
export function fieldToHex(x: Field): string {
  const v = ((x % BN254_FIELD_MODULUS) + BN254_FIELD_MODULUS) % BN254_FIELD_MODULUS;
  return "0x" + v.toString(16).padStart(FIELD_BYTES * 2, "0");
}

/** Parse a `0x`-prefixed (or decimal) string into a canonical field element. */
export function hexToField(h: string): Field {
  return toField(h);
}

/**
 * Generate a uniformly-random canonical field element via the platform CSPRNG.
 * Used for `spending_key`, `blinding`, and order `nonce`. Rejection-samples to avoid
 * modulo bias.
 */
export function randomField(): Field {
  const buf = new Uint8Array(FIELD_BYTES);
  // 2^256 / r ~ 6.04, so the rejection region is < r/2^256; loop iterations are tiny.
  for (;;) {
    globalThis.crypto.getRandomValues(buf);
    const v = bytesToField(buf);
    if (v < BN254_FIELD_MODULUS) {
      return v;
    }
  }
}
