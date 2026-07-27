/** Out-feed pure pieces: L1 ABI shape, Locked log decode, bridge_out parsing. */
import { describe, expect, it } from "vitest";
import { hexToBytes, type Hex } from "viem";
import {
  LOCKED_EVENT,
  OBSCURA_BRIDGE_L1_ABI,
  parseBridgeOutEvent,
  parseLockedLog,
} from "../src/l1.js";

const COMMITMENT = `0x${"0e".repeat(32)}` as Hex;
const RECIPIENT = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";

describe("L1 ABI", () => {
  it("exposes unlock / locks / Locked / Unlocked", () => {
    const names = OBSCURA_BRIDGE_L1_ABI.map((x) => x.name);
    expect(names).toContain("unlock");
    expect(names).toContain("locks");
    expect(names).toContain("Locked");
    expect(names).toContain("Unlocked");
  });
  it("Locked event has the ObscuraBridgeL1 signature", () => {
    expect(LOCKED_EVENT.name).toBe("Locked");
    expect(LOCKED_EVENT.inputs.map((i) => i.type)).toEqual(["bytes32", "address", "uint256"]);
  });
});

describe("parseLockedLog", () => {
  it("extracts commitment/token/amount/block/tx", () => {
    const ev = parseLockedLog({
      args: { commitment: COMMITMENT, token: RECIPIENT as Hex, amount: 1_000_000n },
      blockNumber: 42n,
      transactionHash: `0x${"ff".repeat(32)}` as Hex,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    expect(ev.commitment).toBe(COMMITMENT);
    expect(ev.amount).toBe(1_000_000n);
    expect(ev.blockNumber).toBe(42n);
  });
});

describe("parseBridgeOutEvent", () => {
  it("parses a map with commitment + l1_recipient (byte arrays)", () => {
    const ev = parseBridgeOutEvent({
      commitment: hexToBytes(COMMITMENT),
      l1_recipient: hexToBytes(RECIPIENT as Hex),
    });
    expect(ev.commitment).toBe(COMMITMENT);
    expect(ev.l1Recipient).toBe("0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238");
  });

  it("parses a tuple/array of [32-byte, 20-byte]", () => {
    const ev = parseBridgeOutEvent([hexToBytes(COMMITMENT), hexToBytes(RECIPIENT as Hex)]);
    expect(ev.commitment).toBe(COMMITMENT);
    expect(ev.l1Recipient.toLowerCase()).toBe(RECIPIENT.toLowerCase());
  });

  it("accepts hex-string members too", () => {
    const ev = parseBridgeOutEvent({ commitment: COMMITMENT, l1_recipient: RECIPIENT });
    expect(ev.commitment).toBe(COMMITMENT);
  });

  it("throws when no 32-byte commitment is present", () => {
    expect(() => parseBridgeOutEvent([hexToBytes(RECIPIENT as Hex)])).toThrow(/commitment/);
  });

  it("throws when no 20-byte recipient is present", () => {
    expect(() => parseBridgeOutEvent([hexToBytes(COMMITMENT)])).toThrow(/l1_recipient/);
  });
});
