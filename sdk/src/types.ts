/**
 * Obscura data model — notes, orders, Merkle proofs, keys, assets.
 * Field ordering and semantics follow SHARED.md sec 4-7 exactly.
 */
import type { Field } from "./poseidon.js";

export type { Field };

/** Order side relative to the base asset. SHARED sec 4 / SPEC sec 7.1. */
export const OrderSide = { Buy: 0, Sell: 1 } as const;
export type OrderSide = (typeof OrderSide)[keyof typeof OrderSide];

/**
 * A Obscura asset. `assetId` is the in-circuit field identifier:
 * `hash2(sacAddressAsField, 0)` for a SAC asset, or `0` for native XLM.
 * SHARED sec 4 / SPEC sec 5.3.
 */
export interface Asset {
  /** Field identifier used in notes/orders. */
  assetId: Field;
  /** SAC contract address (StrKey "C..."), undefined for native XLM. */
  address?: string;
  /** Human-readable label, e.g. "XLM", "USDC". */
  code?: string;
}

/** Deterministic keys derived from a single secret spending key. SHARED sec 4. */
export interface KeyPair {
  /** Secret 254-bit scalar — never leaves the wallet. */
  spendingKey: Field;
  /** Public identity: `hash2(spendingKey, 0)`. */
  ownerKey: Field;
  /** Optional selective-disclosure key: `hash2(spendingKey, 1)`. */
  viewingKey: Field;
}

/**
 * A spendable shielded balance note owned by this wallet. Carries the secret
 * material required to nullify it. `commitment = hash4(assetId, amount, ownerKey, blinding)`,
 * `nullifier = hash2(commitment, spendingKey)`. SHARED sec 4.
 */
export interface BalanceNote {
  assetId: Field;
  /** Token quantity; constrained to < 2^64 in-circuit. */
  amount: bigint;
  ownerKey: Field;
  blinding: Field;
  /** Secret spending key whose ownerKey == this note's ownerKey. */
  spendingKey: Field;
  /** Poseidon2_4 commitment (the Merkle leaf). */
  commitment: Field;
  /** Position in the on-chain Merkle tree, set once the deposit is observed. */
  leafIndex?: number;
  /** SAC contract address (StrKey "C...") this note's asset lives at; needed to drive
   *  the on-chain SAC transfer on withdraw. Set at deposit time. */
  assetAddress?: string;
}

/**
 * An output note created for a recipient (possibly not this wallet). Has no secret
 * spending key — only the public `ownerKey` of the recipient.
 */
export interface OutputNote {
  assetId: Field;
  amount: bigint;
  ownerKey: Field;
  blinding: Field;
  commitment: Field;
}

/**
 * A hidden dark-pool order. `commitment = hash7(side, price, amount, assetBase,
 * assetQuote, ownerKey, nonce)`. SHARED sec 4 / SPEC sec 7.
 */
export interface Order {
  side: OrderSide;
  /** Limit price scaled by PRICE_SCALE; < 2^64. */
  price: bigint;
  /** Base-asset quantity; < 2^64. */
  amount: bigint;
  assetBase: Field;
  assetQuote: Field;
  ownerKey: Field;
  nonce: Field;
  commitment: Field;
}

/** Parameters for creating an order (pre-commitment). */
export interface OrderParams {
  side: OrderSide;
  price: bigint;
  amount: bigint;
  assetBase: Field;
  assetQuote: Field;
}

/**
 * A Merkle membership proof for a leaf. `pathIndices[i] == 0` => current node is the
 * LEFT child at level i; `== 1` => RIGHT child. SHARED sec 5 / SPEC sec 4.6.
 */
export interface MerkleProof {
  leaf: Field;
  leafIndex: number;
  /** Sibling hashes, bottom-up; length == TREE_DEPTH. */
  pathElements: Field[];
  /** Direction bits (0=left, 1=right), bottom-up; length == TREE_DEPTH. */
  pathIndices: number[];
  /** Root this proof reconstructs. */
  root: Field;
}

/** A generated zero-knowledge proof ready for on-chain submission. SHARED sec 6. */
export interface ProofData {
  /** Raw UltraHonk proof bytes (expected length PROOF_BYTES = 14592). */
  proof: Uint8Array;
  /** Public inputs as field elements, in the circuit's declared `pub` order. */
  publicInputs: Field[];
}
