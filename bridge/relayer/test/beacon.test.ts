/** Beacon JSON -> LightClientUpdateData assembly (pure, network-free). */
import { describe, expect, it } from "vitest";
import { assembleLightClientUpdate, periodOfSlot, u256ToLe32 } from "../src/beacon.js";
import { G2_UNCOMPRESSED, rawFinalityUpdate } from "./fixtures.js";

describe("u256ToLe32 (SSZ uint256 little-endian)", () => {
  it("encodes a value little-endian, zero-padded to 32 bytes", () => {
    // 1000000007 = 0x3b9aca07 -> LE first bytes 07 ca 9a 3b, rest zero.
    expect(u256ToLe32(1_000_000_007n)).toBe(
      "0x07ca9a3b00000000000000000000000000000000000000000000000000000000",
    );
  });
  it("accepts a decimal string", () => {
    expect(u256ToLe32("0")).toBe(`0x${"00".repeat(32)}`);
  });
  it("rejects values exceeding uint256", () => {
    expect(() => u256ToLe32(1n << 256n)).toThrow(/exceeds uint256/);
  });
});

describe("periodOfSlot", () => {
  it("divides by SLOTS_PER_PERIOD (8192)", () => {
    expect(periodOfSlot(8192n)).toBe(1n);
    expect(periodOfSlot(8191n)).toBe(0n);
    expect(periodOfSlot(10_584_064n)).toBe(1292n); // the on-chain test-vector period
  });
});

describe("assembleLightClientUpdate", () => {
  const update = assembleLightClientUpdate(rawFinalityUpdate());

  it("maps headers and slots", () => {
    expect(update.attestedHeader.slot).toBe(100n);
    expect(update.finalizedHeader.slot).toBe(96n);
    expect(update.signatureSlot).toBe(101n);
    expect(update.finalizedExecution.blockNumber).toBe(11_173_338n);
  });

  it("decompresses the G2 signature to 192 uncompressed bytes", () => {
    expect(update.syncCommitteeSignature).toBe(G2_UNCOMPRESSED);
    expect((update.syncCommitteeSignature.length - 2) / 2).toBe(192);
  });

  it("converts base_fee_per_gas to 32-byte little-endian", () => {
    expect(update.finalizedExecution.baseFeePerGas).toBe(u256ToLe32(1_000_000_007n));
  });

  it("passes the finality and execution branches through", () => {
    expect(update.finalityBranch).toHaveLength(6);
    expect(update.executionBranch).toHaveLength(4);
  });

  it("keeps the 64-byte participation bits", () => {
    expect((update.syncCommitteeBits.length - 2) / 2).toBe(64);
  });

  it("rejects a malformed logs_bloom length", () => {
    const bad = rawFinalityUpdate();
    bad.finalized_header.execution.logs_bloom = "0x00";
    expect(() => assembleLightClientUpdate(bad)).toThrow(/logs_bloom/);
  });
});
