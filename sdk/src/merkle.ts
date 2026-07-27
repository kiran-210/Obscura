/**
 * Client-side incremental, append-only Merkle tree — an exact mirror of the on-chain
 * tree (SHARED.md sec 5 / SPEC sec 4.5-4.6).
 *
 *  - Depth 20, leaves are note commitments, node hash = `hash2`.
 *  - Empty subtrees use the precomputed `ZEROS` constants.
 *  - Insertion uses the frontier / `filledSubtrees` algorithm, byte-for-byte matching
 *    the Soroban contract, so locally-computed roots equal on-chain roots.
 *  - Proof bit ordering matches the in-circuit `check_merkle_proof`:
 *      pathIndices[i] == 0  => current node is LEFT  => hash2(current, sibling)
 *      pathIndices[i] == 1  => current node is RIGHT => hash2(sibling, current)
 */
import { TREE_DEPTH, ZEROS } from "./constants.js";
import { hash2, type Field } from "./poseidon.js";
import type { MerkleProof } from "./types.js";

const MAX_ROOT_HISTORY = 100;

export class MerkleTree {
  readonly depth: number;
  private readonly leaves: Field[] = [];
  private readonly filledSubtrees: Field[];
  private readonly roots: Field[] = [];
  private _root: Field;

  constructor(depth: number = TREE_DEPTH) {
    if (depth < 1 || depth >= ZEROS.length) {
      throw new RangeError(`MerkleTree depth must be in [1, ${ZEROS.length - 1}]`);
    }
    this.depth = depth;
    this.filledSubtrees = ZEROS.slice(0, depth);
    this._root = ZEROS[depth]!;
    this.roots.push(this._root);
  }

  /** Current root. */
  get root(): Field {
    return this._root;
  }

  /** Number of inserted leaves (= index of the next insertion). */
  get size(): number {
    return this.leaves.length;
  }

  /** Last `MAX_ROOT_HISTORY` roots (oldest first), mirroring the contract ring buffer. */
  get rootHistory(): readonly Field[] {
    return this.roots;
  }

  /** Whether `root` is in the retained history (matches `is_known_root`). */
  isKnownRoot(root: Field): boolean {
    return this.roots.includes(root);
  }

  /**
   * Append a leaf using the frontier algorithm. Returns its leaf index.
   * Mirrors SHARED sec 5 / SPEC sec 4.5 exactly.
   */
  insert(leaf: Field): number {
    const index = this.leaves.length;
    if (index >= 2 ** this.depth) {
      throw new RangeError("MerkleTree is full");
    }
    let current = leaf;
    let idx = index;
    for (let level = 0; level < this.depth; level++) {
      if (idx % 2 === 0) {
        this.filledSubtrees[level] = current;
        current = hash2(current, ZEROS[level]!);
      } else {
        current = hash2(this.filledSubtrees[level]!, current);
      }
      idx = Math.floor(idx / 2);
    }
    this._root = current;
    this.leaves.push(leaf);
    this.roots.push(current);
    if (this.roots.length > MAX_ROOT_HISTORY) {
      this.roots.shift();
    }
    return index;
  }

  /** Insert many leaves; returns the index of the first one. */
  insertMany(leaves: Iterable<Field>): number {
    const start = this.leaves.length;
    for (const leaf of leaves) {
      this.insert(leaf);
    }
    return start;
  }

  /** Find the index of a leaf by its commitment value, or -1 if absent. */
  indexOf(leaf: Field): number {
    return this.leaves.indexOf(leaf);
  }

  /** Read a leaf by index. */
  leafAt(index: number): Field | undefined {
    return this.leaves[index];
  }

  /**
   * Build a membership proof for the leaf at `leafIndex` from the locally stored
   * leaves. The reconstructed root equals {@link root}.
   */
  generateProof(leafIndex: number): MerkleProof {
    if (leafIndex < 0 || leafIndex >= this.leaves.length) {
      throw new RangeError(`leafIndex ${leafIndex} out of range [0, ${this.leaves.length})`);
    }
    const pathElements: Field[] = [];
    const pathIndices: number[] = [];
    let layer: Field[] = this.leaves.slice();
    let index = leafIndex;
    for (let level = 0; level < this.depth; level++) {
      const isRight = index % 2; // 0 => left child, 1 => right child
      const siblingIndex = isRight ? index - 1 : index + 1;
      const sibling = siblingIndex < layer.length ? layer[siblingIndex]! : ZEROS[level]!;
      pathElements.push(sibling);
      pathIndices.push(isRight);

      const next: Field[] = [];
      for (let i = 0; i < layer.length; i += 2) {
        const left = layer[i]!;
        const right = i + 1 < layer.length ? layer[i + 1]! : ZEROS[level]!;
        next.push(hash2(left, right));
      }
      layer = next;
      index = index >> 1;
    }
    return {
      leaf: this.leaves[leafIndex]!,
      leafIndex,
      pathElements,
      pathIndices,
      root: this._root,
    };
  }

  /**
   * Recompute the root implied by a proof. Used to validate a proof off-chain and to
   * mirror the in-circuit `check_merkle_proof`. SHARED sec 5.
   */
  static rootFromProof(proof: Pick<MerkleProof, "leaf" | "pathElements" | "pathIndices">): Field {
    let current = proof.leaf;
    for (let i = 0; i < proof.pathElements.length; i++) {
      const sibling = proof.pathElements[i]!;
      current = proof.pathIndices[i] === 0 ? hash2(current, sibling) : hash2(sibling, current);
    }
    return current;
  }
}
