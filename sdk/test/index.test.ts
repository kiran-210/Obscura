/**
 * Wraith orchestrator: the deterministic (non-proof) paths — deposit, local-tree sync,
 * balance/ order views, and the precise "no prover configured" errors for proof flows.
 */
import { describe, expect, it } from "vitest";
import { Wraith, nativeAsset } from "../src/index.js";
import { fieldToHex } from "../src/poseidon.js";

const CONTRACT_ID = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";
const ACCOUNT = "GBGLR42JSE24SYA2H5XHHMQR6MTGOA5AUIPHQHL5JX5UH7N7CKUXKSPP";
const XLM = nativeAsset();

const newSdk = () => new Wraith({ contractId: CONTRACT_ID, spendingKey: 42n });

describe("deposit + local tree sync", () => {
  it("creates a note, builds an op, and tracks the shielded balance", () => {
    const sdk = newSdk();
    const { note, operation, commitment } = sdk.deposit({ asset: XLM, amount: 1000n, from: ACCOUNT });
    expect(operation).toBeDefined();
    expect(note.amount).toBe(1000n);
    expect(note.assetId).toBe(0n); // native XLM
    expect(commitment).toBe(note.commitment);
    expect(sdk.getShieldedBalances().get(0n)).toBe(1000n);
  });

  it("observeCommitment binds the leafIndex of an owned note", () => {
    const sdk = newSdk();
    const { note } = sdk.deposit({ asset: XLM, amount: 500n, from: ACCOUNT });
    expect(note.leafIndex).toBeUndefined();
    const index = sdk.observeCommitment(note.commitment);
    expect(index).toBe(0);
    expect(note.leafIndex).toBe(0);
    // The note now has a valid Merkle proof in the local mirror.
    const proof = sdk.tree.generateProof(note.leafIndex!);
    expect(fieldToHex(proof.root)).toBe(fieldToHex(sdk.tree.root));
  });
});

describe("proof flows require a configured prover", () => {
  it("withdraw without a prover throws a precise error", async () => {
    const sdk = newSdk();
    const { note } = sdk.deposit({ asset: XLM, amount: 1000n, from: ACCOUNT });
    sdk.observeCommitment(note.commitment);
    await expect(sdk.withdraw({ note, recipient: ACCOUNT })).rejects.toThrow(/no prover configured/);
  });

  it("proving before syncing the tree throws about the missing leafIndex", async () => {
    const sdk = newSdk();
    const { note } = sdk.deposit({ asset: XLM, amount: 1000n, from: ACCOUNT });
    await expect(sdk.withdraw({ note, recipient: ACCOUNT })).rejects.toThrow(/leafIndex/);
  });

  it("transfer assembles full padded inputs (then needs a prover)", async () => {
    const sdk = newSdk();
    const { note } = sdk.deposit({ asset: XLM, amount: 1000n, from: ACCOUNT });
    sdk.observeCommitment(note.commitment);
    // Input assembly (Merkle proof + 2-input padding + output notes) must succeed; only
    // the proving step is missing. A throw about leafIndex/asset here would be a bug.
    await expect(
      sdk.transfer({ fromNotes: [note], recipientOwnerKey: 0x1234n, amount: 600n }),
    ).rejects.toThrow(/no prover configured/);
  });
});

describe("views", () => {
  it("getOpenOrders is empty initially", () => {
    expect(newSdk().getOpenOrders()).toEqual([]);
  });
});
