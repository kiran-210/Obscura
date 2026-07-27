/** ScVal encoding: Soroban symbol ordering + struct/update map construction. */
import { describe, expect, it } from "vitest";
import { scValToNative, xdr } from "@stellar/stellar-sdk";
import {
  compareSymbol,
  encodeBeaconHeader,
  encodeLightClientUpdate,
  scvU64,
  structToScVal,
} from "../src/scval.js";
import { minimalUpdate } from "./fixtures.js";

/** Read an ScMap's entry keys in stored order. */
function mapKeys(scv: xdr.ScVal): string[] {
  return scv
    .map()!
    .map((e) => e.key().sym().toString());
}

describe("Soroban symbol comparator", () => {
  it("sorts BeaconHeader field names in host order", () => {
    const keys = ["slot", "state_root", "body_root", "parent_root", "proposer_index"];
    expect([...keys].sort(compareSymbol)).toEqual([
      "body_root",
      "parent_root",
      "proposer_index",
      "slot",
      "state_root",
    ]);
  });

  it("orders '_' before letters and is prefix-aware", () => {
    expect(compareSymbol("finality_branch", "finalized_execution")).toBe(-1);
    expect(compareSymbol("gas_limit", "gas_used") < 0).toBe(true);
    expect(compareSymbol("a", "ab")).toBe(-1);
  });

  it("rejects characters outside the symbol alphabet", () => {
    // Shared prefix so the invalid '-' is actually reached during comparison.
    expect(() => compareSymbol("ab-cd", "ab-ef")).toThrow(/invalid Soroban symbol/);
  });
});

describe("structToScVal", () => {
  it("emits an ScMap with keys in ascending symbol order", () => {
    const scv = structToScVal({
      state_root: scvU64(1),
      body_root: scvU64(2),
      slot: scvU64(3),
    });
    expect(mapKeys(scv)).toEqual(["body_root", "slot", "state_root"]);
  });
});

describe("encodeBeaconHeader", () => {
  it("produces a 5-field sorted map that decodes back", () => {
    const scv = encodeBeaconHeader(minimalUpdate().attestedHeader);
    expect(mapKeys(scv)).toEqual(["body_root", "parent_root", "proposer_index", "slot", "state_root"]);
    const native = scValToNative(scv) as Record<string, unknown>;
    expect(native.slot).toBe(100n);
    expect(native.proposer_index).toBe(7n);
  });
});

describe("encodeLightClientUpdate", () => {
  const scv = encodeLightClientUpdate(minimalUpdate());

  it("has all 8 top-level fields in symbol order", () => {
    expect(mapKeys(scv)).toEqual([
      "attested_header",
      "execution_branch",
      "finality_branch",
      "finalized_execution",
      "finalized_header",
      "signature_slot",
      "sync_committee_bits",
      "sync_committee_signature",
    ]);
  });

  it("decodes nested values (bits 64B, signature 192B, branch lengths)", () => {
    const native = scValToNative(scv) as Record<string, unknown>;
    expect(native.signature_slot).toBe(101n);
    expect((native.sync_committee_bits as Uint8Array).length).toBe(64);
    expect((native.sync_committee_signature as Uint8Array).length).toBe(192);
    expect((native.finality_branch as unknown[]).length).toBe(6);
    expect((native.execution_branch as unknown[]).length).toBe(4);
  });

  it("encodes the 17-field execution payload header", () => {
    const exec = scv.map()!.find((e) => e.key().sym().toString() === "finalized_execution")!.val();
    expect(exec.map()!.length).toBe(17);
  });
});
