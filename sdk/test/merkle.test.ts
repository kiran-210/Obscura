/**
 * Merkle tree: ZEROS constants, incremental roots, and proof reconstruction must all
 * match the Noir-generated golden values (frontier algorithm, SHARED sec 5).
 */
import { describe, expect, it } from "vitest";
import goldenRoots from "./merkle.golden.json" assert { type: "json" };
import { MerkleTree } from "../src/merkle.js";
import { EMPTY_ROOT, TREE_DEPTH, ZEROS } from "../src/constants.js";
import { fieldToHex, hash2 } from "../src/poseidon.js";

describe("ZEROS constants", () => {
  it("recompute via hash2 (zeros[i+1] = hash2(zeros[i], zeros[i]))", () => {
    expect(ZEROS[0]).toBe(0n);
    for (let i = 0; i < TREE_DEPTH; i++) {
      expect(hash2(ZEROS[i]!, ZEROS[i]!)).toBe(ZEROS[i + 1]!);
    }
  });

  it("EMPTY_ROOT equals ZEROS[TREE_DEPTH] and the Noir empty root", () => {
    expect(EMPTY_ROOT).toBe(ZEROS[TREE_DEPTH]!);
    expect(fieldToHex(EMPTY_ROOT)).toBe(goldenRoots.rootEmpty);
  });
});

describe("incremental roots match Noir golden", () => {
  for (const { leaves, root } of goldenRoots.roots) {
    it(`root after inserting [${leaves.join(", ")}]`, () => {
      const tree = new MerkleTree(TREE_DEPTH);
      tree.insertMany(leaves.map((s) => BigInt(s)));
      expect(fieldToHex(tree.root)).toBe(root);
    });
  }

  it("empty tree root equals EMPTY_ROOT", () => {
    expect(new MerkleTree(TREE_DEPTH).root).toBe(EMPTY_ROOT);
  });
});

describe("proof generation and bit ordering", () => {
  it("every leaf's proof reconstructs the current root", () => {
    const tree = new MerkleTree(TREE_DEPTH);
    const leaves = [11n, 22n, 33n, 44n, 55n];
    tree.insertMany(leaves);
    for (let i = 0; i < leaves.length; i++) {
      const proof = tree.generateProof(i);
      expect(proof.leaf).toBe(leaves[i]!);
      expect(proof.pathElements.length).toBe(TREE_DEPTH);
      expect(proof.pathIndices.length).toBe(TREE_DEPTH);
      expect(MerkleTree.rootFromProof(proof)).toBe(tree.root);
      expect(proof.root).toBe(tree.root);
    }
  });

  it("path indices are the binary decomposition of the leaf index", () => {
    const tree = new MerkleTree(TREE_DEPTH);
    tree.insertMany([1n, 2n, 3n, 4n, 5n, 6n]);
    const idx = 5; // binary 101
    const proof = tree.generateProof(idx);
    const recovered = proof.pathIndices.reduce((acc, bit, i) => acc + bit * 2 ** i, 0);
    expect(recovered).toBe(idx);
  });

  it("a tampered sibling breaks root reconstruction", () => {
    const tree = new MerkleTree(TREE_DEPTH);
    tree.insertMany([7n, 8n, 9n]);
    const proof = tree.generateProof(1);
    proof.pathElements[0] = proof.pathElements[0]! + 1n;
    expect(MerkleTree.rootFromProof(proof)).not.toBe(tree.root);
  });
});
