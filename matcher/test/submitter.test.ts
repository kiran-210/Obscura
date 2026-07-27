import { describe, expect, it } from "vitest";
import { PROOF_BYTES, decodePublicInputs, type Field, type ProofData } from "@obscura/sdk";
import { xdr } from "@stellar/stellar-sdk";
import { MatchSubmitter, resolveContractId } from "../src/submitter.js";

// A deployed pool address from deployments.json (testnet).
const POOL = "CA7G45QPOS5RFTK7R5LWJSTPEGTPXDDD7FIQ3XFUN4U7FLG5WUSGXYSK";

function mockProof(publicInputs: Field[], proofLen = PROOF_BYTES): ProofData {
  return { proof: new Uint8Array(proofLen), publicInputs };
}

const EIGHT: Field[] = [1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n];

describe("resolveContractId — precedence", () => {
  it("explicit > env > deployments", () => {
    expect(
      resolveContractId({
        contractId: "C_EXPLICIT",
        env: { OBSCURA_POOL_CONTRACT: "C_ENV" },
        deployments: { contracts: { obscuraPool: "C_DEP" } },
      }),
    ).toBe("C_EXPLICIT");

    expect(
      resolveContractId({
        env: { OBSCURA_POOL_CONTRACT: "C_ENV" },
        deployments: { contracts: { obscuraPool: "C_DEP" } },
      }),
    ).toBe("C_ENV");

    expect(resolveContractId({ env: {}, deployments: { contracts: { obscuraPool: "C_DEP" } } })).toBe("C_DEP");
  });

  it("throws when nothing is configured", () => {
    expect(() => resolveContractId({ env: {} })).toThrow(/contract id/);
  });
});

describe("MatchSubmitter.encode", () => {
  it("encodes 8 public inputs into 256 bytes (8 x 32) that round-trip", () => {
    const sub = new MatchSubmitter({ contractId: POOL });
    const { proof, publicInputs } = sub.encode(mockProof(EIGHT));
    expect(proof).toHaveLength(PROOF_BYTES);
    expect(publicInputs).toHaveLength(8 * 32);
    expect(decodePublicInputs(publicInputs)).toEqual(EIGHT);
  });

  it("rejects a wrong number of public inputs", () => {
    const sub = new MatchSubmitter({ contractId: POOL });
    expect(() => sub.encode(mockProof([1n, 2n, 3n]))).toThrow(/8 public inputs/);
  });
});

describe("MatchSubmitter.buildOperation", () => {
  it("builds a match_orders invoke op carrying the encoded public_inputs", () => {
    const sub = new MatchSubmitter({ contractId: POOL });
    const op = sub.buildOperation(mockProof(EIGHT));

    // It is an InvokeHostFunction op calling "match_orders".
    const invoke = op.body().invokeHostFunctionOp();
    const args = invoke.hostFunction().invokeContract();
    expect(args.functionName().toString()).toBe("match_orders");

    // Four scval args: proof, public_inputs (256), leaf_memos vec, residual_memos vec.
    const params = args.args();
    expect(params).toHaveLength(4);
    expect(params[0]!.switch()).toBe(xdr.ScValType.scvBytes());
    expect(params[1]!.switch()).toBe(xdr.ScValType.scvBytes());
    expect(params[2]!.switch()).toBe(xdr.ScValType.scvVec());
    expect(params[3]!.switch()).toBe(xdr.ScValType.scvVec());
    expect(params[0]!.bytes()).toHaveLength(PROOF_BYTES);
    expect(params[1]!.bytes()).toHaveLength(8 * 32);
    expect(decodePublicInputs(new Uint8Array(params[1]!.bytes()))).toEqual(EIGHT);
    // No memos passed → empty vecs.
    expect(params[2]!.vec()).toHaveLength(0);
    expect(params[3]!.vec()).toHaveLength(0);
  });

  it("rejects a proof whose length is neither 0 nor PROOF_BYTES", () => {
    const sub = new MatchSubmitter({ contractId: POOL });
    expect(() => sub.buildOperation(mockProof(EIGHT, 10))).toThrow(/14592/);
  });
});

describe("MatchSubmitter.fromSources", () => {
  it("resolves the contract + passphrase from a deployments object", () => {
    const sub = MatchSubmitter.fromSources({
      deployments: {
        networkPassphrase: "Test SDF Network ; September 2015",
        contracts: { obscuraPool: POOL },
      },
    });
    expect(sub.contractId).toBe(POOL);
    expect(sub.networkPassphrase).toBe("Test SDF Network ; September 2015");
  });
});
