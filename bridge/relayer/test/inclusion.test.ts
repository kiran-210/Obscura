/**
 * Inclusion-feed pure pieces: storage-slot derivation, lock-word decode, and RLP
 * proof packaging. Golden values cross-checked against bridge/l1/README.md §3.
 */
import { describe, expect, it } from "vitest";
import { keccak256, stringToBytes, toRlp, type Hex } from "viem";
import { decodeLockWord, deriveStorageSlot, packProofNodes, packageProof } from "../src/inclusion.js";

// From bridge/l1/README.md §3 (reproducible with `cast`):
const COMMITMENT =
  "0x0e86ed873f020b3df2996bcff4fb0b630e4cbbafb03858dde35121f86a754ecf" as Hex;
const SLOT =
  "0x8c6161de4d4b4289f5737ad9f0af76325499e5c87b1cd3246920f376fb114e58" as Hex;
const TOKEN = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";

describe("storage slot derivation", () => {
  it("matches keccak256(abi.encode(commitment, 0)) for the L1 README example", () => {
    expect(deriveStorageSlot(COMMITMENT)).toBe(SLOT);
  });

  it("cross-checks the example commitment is keccak256(\"obscura-note-1\")", () => {
    expect(keccak256(stringToBytes("obscura-note-1"))).toBe(COMMITMENT);
  });

  it("is sensitive to the declaration slot argument", () => {
    expect(deriveStorageSlot(COMMITMENT, 1n)).not.toBe(SLOT);
  });
});

describe("lock word decode (BRIDGE_SPEC §4 packing)", () => {
  it("decodes the ERC20 worked example (token low 20, amount high 12)", () => {
    // W = (1000000 << 160) | uint160(token); proven value is RLP-stripped.
    const value = (0x0f4240n << 160n) | BigInt(TOKEN);
    const { token, amount } = decodeLockWord(`0x${value.toString(16)}` as Hex);
    expect(token.toLowerCase()).toBe(TOKEN.toLowerCase());
    expect(amount).toBe(1_000_000n);
  });

  it("decodes native ETH (token == address(0), amount = 1 ether)", () => {
    const oneEther = 1_000_000_000_000_000_000n;
    const value = oneEther << 160n;
    const { token, amount } = decodeLockWord(value);
    expect(token).toBe("0x0000000000000000000000000000000000000000");
    expect(amount).toBe(oneEther);
  });
});

describe("RLP proof packaging into Bytes[]", () => {
  // A 17-item branch node and a 2-item leaf node — the shapes the MPT walk decodes.
  const branchNode = toRlp(
    Array.from({ length: 17 }, (_, i) => (i === 16 ? ("0x" as Hex) : (`0x${"ab".repeat(32)}` as Hex))),
  );
  const leafNode = toRlp([`0x20${"11".repeat(31)}` as Hex, `0x${"22".repeat(33)}` as Hex]);

  it("passes valid RLP trie nodes through unchanged", () => {
    const nodes = [branchNode, leafNode];
    expect(packProofNodes(nodes)).toEqual(nodes);
  });

  it("validates each node is a well-formed RLP list", () => {
    // A single RLP byte-string (not a list) is not a valid trie node.
    const notAList = toRlp("0xdeadbeef");
    expect(() => packProofNodes([notAList])).toThrow(/not an RLP list/);
  });

  it("packageProof extracts account + first storage proof and the proven value", () => {
    const packaged = packageProof({
      accountProof: [branchNode, leafNode],
      storageProof: [{ key: SLOT, value: "0xf4240", proof: [leafNode] }],
    });
    expect(packaged.accountProof).toEqual([branchNode, leafNode]);
    expect(packaged.storageProof).toEqual([leafNode]);
    expect(packaged.value).toBe("0xf4240");
  });

  it("throws if there is no storage proof entry", () => {
    expect(() => packageProof({ accountProof: [branchNode], storageProof: [] })).toThrow(/no storageProof/);
  });
});
