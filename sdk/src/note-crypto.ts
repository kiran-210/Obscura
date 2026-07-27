/**
 * Encrypted note/order delivery — the sealed-box transport shared by the wallet and the
 * matcher, so both encrypt/decrypt identically (single source of truth).
 *
 * A private action (transfer, or a dark-pool match) creates outputs the recipient can't
 * otherwise see — their secret contents (amount, blinding, …) only ever existed in the
 * sender's/matcher's process. To deliver them we seal an encrypted payload to the recipient's
 * **viewing key** and publish it in the on-chain event. The recipient scans those events and
 * trial-decrypts; only a payload whose commitment matches a real on-chain output is accepted,
 * so the untrusted transport can never forge balance.
 *
 * Scheme: a libsodium-style sealed box — ephemeral X25519 → ECDH → HKDF-SHA256 →
 * XChaCha20-Poly1305. The recipient's X25519 keypair is derived deterministically from the
 * `viewingKey` the SDK already exposes, so it needs no extra secret.
 */
import { x25519 } from "@noble/curves/ed25519.js";
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { randomBytes } from "@noble/hashes/utils.js";
import { bytesToField, fieldToHex, hexToField, type Field } from "./poseidon.js";

const EPH_LEN = 32;
const NONCE_LEN = 24;
const RECEIVE_PREFIX = "wr1";

/** The plaintext sealed into a memo: a note's secret contents (+ an optional witness snapshot,
 *  now superseded by the recipient's indexer, so the witness fields are optional). */
export interface NotePayload {
  v: 1;
  /** Asset display code (free-form; the wallet maps it to its token registry). */
  code: string;
  decimals?: number;
  assetId: string; // hex field
  amount: string; // decimal base units
  ownerKey: string; // hex field
  blinding: string; // hex field
  commitment: string; // hex field — cross-checked against the on-chain outputs
  leafIndex?: number;
  root?: string; // hex field the witness folds to
  path?: string[]; // hex fields
  indices?: number[];
}

/** The plaintext sealed to deliver a residual order's secret to its owner (so it stays
 *  cancellable/manageable after a partial fill). */
export interface OrderPayload {
  v: 1;
  kind: "order";
  side: number; // 0 buy / 1 sell
  price: string; // decimal (scaled by PRICE_SCALE)
  amount: string; // decimal base units
  assetBase: string; // hex field
  assetQuote: string; // hex field
  ownerKey: string; // hex field
  nonce: string; // hex field
  commitment: string; // hex field — cross-checked against the on-chain residual commitments
  baseCode?: string;
  quoteCode?: string;
  lockedAssetCode?: string;
  lockedDecimals?: number;
}

export interface EncKeypair {
  priv: Uint8Array;
  pub: Uint8Array;
}

// --- bytes helpers ----------------------------------------------------------

function fieldTo32(f: Field): Uint8Array {
  const hex = fieldToHex(f).slice(2).padStart(64, "0");
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function b64uEncode(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64uDecode(s: string): Uint8Array {
  const pad = s.length % 4 ? "=".repeat(4 - (s.length % 4)) : "";
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

// --- keys -------------------------------------------------------------------

/** Deterministic X25519 keypair for a wallet, derived from its `viewingKey`. */
export function deriveEncKeypair(viewingKey: Field): EncKeypair {
  const priv = fieldTo32(viewingKey);
  return { priv, pub: x25519.getPublicKey(priv) };
}

// --- sealed box -------------------------------------------------------------

function kdf(shared: Uint8Array, ephPub: Uint8Array, recipientPub: Uint8Array): Uint8Array {
  return hkdf(sha256, shared, undefined, concat(ephPub, recipientPub), 32);
}

/** Seal `plaintext` to `recipientPub` (anonymous sender). */
export function seal(recipientPub: Uint8Array, plaintext: Uint8Array): Uint8Array {
  const ephPriv = randomBytes(32);
  const ephPub = x25519.getPublicKey(ephPriv);
  const shared = x25519.getSharedSecret(ephPriv, recipientPub);
  const key = kdf(shared, ephPub, recipientPub);
  const nonce = randomBytes(NONCE_LEN);
  const ct = xchacha20poly1305(key, nonce).encrypt(plaintext);
  return concat(ephPub, nonce, ct);
}

/** Try to open a sealed box with `recipient`'s key. Returns null if it isn't ours. */
export function open(recipient: EncKeypair, blob: Uint8Array): Uint8Array | null {
  if (blob.length < EPH_LEN + NONCE_LEN + 16) return null;
  try {
    const ephPub = blob.slice(0, EPH_LEN);
    const nonce = blob.slice(EPH_LEN, EPH_LEN + NONCE_LEN);
    const ct = blob.slice(EPH_LEN + NONCE_LEN);
    const shared = x25519.getSharedSecret(recipient.priv, ephPub);
    const key = kdf(shared, ephPub, recipient.pub);
    return xchacha20poly1305(key, nonce).decrypt(ct);
  } catch {
    return null; // not addressed to us (or corrupt) — the AEAD tag failed
  }
}

// --- typed payloads <-> memo bytes ------------------------------------------

export function encryptNote(recipientPub: Uint8Array, payload: NotePayload): Uint8Array {
  return seal(recipientPub, new TextEncoder().encode(JSON.stringify(payload)));
}

export function decryptNote(recipient: EncKeypair, blob: Uint8Array): NotePayload | null {
  const plain = open(recipient, blob);
  if (!plain) return null;
  try {
    const obj = JSON.parse(new TextDecoder().decode(plain)) as NotePayload;
    return obj && obj.v === 1 && (obj as { kind?: string }).kind !== "order" ? obj : null;
  } catch {
    return null;
  }
}

export function encryptOrder(recipientPub: Uint8Array, payload: OrderPayload): Uint8Array {
  return seal(recipientPub, new TextEncoder().encode(JSON.stringify(payload)));
}

export function decryptOrder(recipient: EncKeypair, blob: Uint8Array): OrderPayload | null {
  const plain = open(recipient, blob);
  if (!plain) return null;
  try {
    const obj = JSON.parse(new TextDecoder().decode(plain)) as OrderPayload;
    return obj && obj.v === 1 && obj.kind === "order" ? obj : null;
  } catch {
    return null;
  }
}

// --- Receive code {ownerKey, encPub} ----------------------------------------

/** Encode a shareable Receive code carrying both the owner key and the encryption key. */
export function encodeReceiveCode(ownerKey: Field, encPub: Uint8Array): string {
  return RECEIVE_PREFIX + b64uEncode(concat(fieldTo32(ownerKey), encPub));
}

export interface ReceiveCode {
  ownerKey: Field;
  encPub: Uint8Array;
}

/** Parse a Receive code. Throws on anything that isn't a valid `wr1…` code. */
export function decodeReceiveCode(code: string): ReceiveCode {
  const c = code.trim();
  if (!c.startsWith(RECEIVE_PREFIX)) {
    throw new Error("Not a Wraith receive code. Ask the recipient for their code from the Receive screen.");
  }
  const raw = b64uDecode(c.slice(RECEIVE_PREFIX.length));
  if (raw.length !== 64) throw new Error("Malformed receive code.");
  return { ownerKey: bytesToField(raw.slice(0, 32)), encPub: raw.slice(32, 64) };
}

/** Hex-encode a memo blob for the on-chain `Bytes` arg (and back). */
export const memoToHex = (b: Uint8Array): string => `0x${[...b].map((x) => x.toString(16).padStart(2, "0")).join("")}`;
export const hexToBytes = (hex: string): Uint8Array => {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
};
