/**
 * Prover: input-builder shape and proof-length guard. The full proof pipeline is wired
 * against the noir_js / bb.js interface but is SKIPPED here because the compiled circuit
 * JSONs live on the feat/circuits branch (not present in this worktree) and bb.js proof
 * generation needs the Barretenberg CRS. See README "What's pending integration".
 */
import { describe, expect, it } from "vitest";
import {
  NoirProver,
  buildCancelOrderInputs,
  buildPlaceOrderInputs,
  buildWithdrawInputs,
  isValidProofLength,
} from "../src/prover.js";
import { PROOF_BYTES } from "../src/constants.js";

describe("proof-length guard (SHARED sec 6)", () => {
  it("accepts exactly 14592 bytes", () => {
    expect(isValidProofLength(new Uint8Array(PROOF_BYTES))).toBe(true);
    expect(isValidProofLength(new Uint8Array(PROOF_BYTES - 1))).toBe(false);
  });
});

describe("circuit input builders (SPEC sec 8 field names)", () => {
  it("withdraw inputs include all public + private fields with hex/decimal encoding", () => {
    const inputs = buildWithdrawInputs({
      merkleRoot: 0x10n,
      nullifier: 0x11n,
      recipientHash: 0x12n,
      amount: 1000n,
      assetId: 5n,
      noteOwnerKey: 0x13n,
      noteBlinding: 7n,
      spendingKey: 42n,
      merklePath: [1n, 2n, 3n],
      merkleIndices: [0, 1, 0],
    });
    expect(Object.keys(inputs)).toEqual([
      "merkle_root",
      "nullifier",
      "recipient_hash",
      "amount",
      "asset_id",
      "note_amount",
      "note_asset_id",
      "note_owner_key",
      "note_blinding",
      "spending_key",
      "merkle_path",
      "merkle_indices",
    ]);
    expect(inputs.amount).toBe("1000"); // u64 as decimal
    expect(inputs.merkle_root).toMatch(/^0x[0-9a-f]{64}$/); // field as hex
    expect(inputs.merkle_path).toEqual([
      "0x0000000000000000000000000000000000000000000000000000000000000001",
      "0x0000000000000000000000000000000000000000000000000000000000000002",
      "0x0000000000000000000000000000000000000000000000000000000000000003",
    ]);
    expect(inputs.merkle_indices).toEqual(["0", "1", "0"]);
  });

  it("place_order and cancel_order builders are keyed correctly", () => {
    const po = buildPlaceOrderInputs({
      merkleRoot: 1n,
      nullifier: 2n,
      orderCommitment: 3n,
      changeCommitment: 0n,
      lockedAssetId: 5n,
      noteAmount: 1000n,
      noteAssetId: 5n,
      noteBlinding: 7n,
      spendingKey: 42n,
      merklePath: [1n],
      merkleIndices: [0],
      orderSide: 1,
      orderPrice: 25_000_000n,
      orderAmount: 1000n,
      orderAssetBase: 5n,
      orderAssetQuote: 9n,
      orderNonce: 123n,
      changeAmount: 0n,
      changeBlinding: 0n,
    });
    expect(po.order_side).toBe("1");
    expect(po.order_price).toBe("25000000");

    const co = buildCancelOrderInputs({
      orderCommitment: 3n,
      refundCommitment: 4n,
      refundAssetId: 5n,
      side: 1,
      price: 25_000_000n,
      amount: 1000n,
      assetBase: 5n,
      assetQuote: 9n,
      nonce: 123n,
      spendingKey: 42n,
      refundBlinding: 7n,
    });
    expect(Object.keys(co)).toContain("refund_commitment");
    expect(co.nonce).toBe("0x000000000000000000000000000000000000000000000000000000000000007b");
  });
});

describe("NoirProver", () => {
  it("constructs lazily without loading bb.js", () => {
    const prover = new NoirProver({ bytecode: "deadbeef", abi: {} }, { keccak: true });
    expect(prover).toBeInstanceOf(NoirProver);
  });

  // Full end-to-end proof generation (witness -> UltraHonk proof with keccak transcript).
  // Requires a compiled circuit JSON (feat/circuits) + Barretenberg CRS download.
  it.skip("generates a 14592-byte UltraHonk (keccak) proof from a compiled circuit", async () => {
    // const circuit = JSON.parse(fs.readFileSync("target/withdraw.json", "utf8"));
    // const prover = new NoirProver(circuit, { keccak: true });
    // const { proof, publicInputs } = await prover.prove(buildWithdrawInputs({ ... }));
    // expect(isValidProofLength(proof)).toBe(true);
    // expect(await prover.verify({ proof, publicInputs })).toBe(true);
  });
});
