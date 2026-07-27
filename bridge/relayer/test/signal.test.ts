import { describe, expect, it } from "vitest";
import {
  SignalClientSubmitter,
  epochFromInputData,
  fetchLatestSignalProof,
  parseJournal,
} from "../src/signal.js";
import type { BeaconHeaderData, ExecutionPayloadHeaderData } from "../src/types.js";
import type { Hex } from "viem";

// Real Boundless `signal-on-stellar` journal vector (one finalized transition).
const JOURNAL =
  "0x00000000000000000000000000000000000000000000000000000000000675a0d87a8b0faf867d9521ddb155f3c58b9523367444ac5b8822169c06cd71233ee6000000000000000000000000000000000000000000000000000000000006759f7f3d03a51f303b1f1855592276e609c932cc0f91518ca4d959c38685e9f90a6900000000000000000000000000000000000000000000000000000000000675a130da8e4de5b3733b25e850b7dd457886862f7657e3ad0d54246b76ac9676396300000000000000000000000000000000000000000000000000000000000675a0d87a8b0faf867d9521ddb155f3c58b9523367444ac5b8822169c06cd71233ee60000000000000000000000000000000000000000000000000000000000ceb400" as Hex;

const zeros = (n: number): Hex => `0x${"00".repeat(n)}` as Hex;

describe("parseJournal", () => {
  it("decodes the real 288-byte journal by fixed offsets", () => {
    const v = parseJournal(JOURNAL);
    expect(v.finalizedSlot).toBe(0xceb400n); // 13546496
    expect(v.finalizedEpoch).toBe(0x675a0n); // 423328
    expect(v.finalizedSlot).toBe(v.finalizedEpoch * 32n); // slot = epoch * 32
    expect(v.finalizedRoot).toBe(
      "0xd87a8b0faf867d9521ddb155f3c58b9523367444ac5b8822169c06cd71233ee6",
    );
    expect(v.preState.length).toBe(2 + 128 * 2);
    expect(v.postState.length).toBe(2 + 128 * 2);
    // post.finalized.root is the tail of post_state.
    expect(v.postState.endsWith(v.finalizedRoot.slice(2))).toBe(true);
  });

  it("rejects a journal of the wrong length", () => {
    expect(() => parseJournal("0xdeadbeef" as Hex)).toThrow(/expected 288/);
  });
});

describe("epochFromInputData", () => {
  it("extracts the epoch from a hex-encoded artifacts URL", () => {
    const url = "https://signal-artifacts.beboundless.xyz/v3/consensus/mainnet/inputs/457084.bin";
    const hex = `0x${Buffer.from(url, "utf8").toString("hex")}`;
    expect(epochFromInputData(hex)).toBe(457084);
  });

  it("throws when no epoch is present", () => {
    expect(() => epochFromInputData("0x1234")).toThrow(/no epoch/);
  });
});

describe("SignalClientSubmitter op building (pure, no network)", () => {
  const sub = new SignalClientSubmitter({
    contractId: "CDSTMIXJVKI4ZVP4QV4POCVXGMUR2CG6IE2BT65ZOGRMZ445JX6NIKTA",
  });

  it("builds receive(seal, journal)", () => {
    const op = sub.receiveOp(zeros(260), JOURNAL);
    expect(op).toBeDefined();
  });

  it("builds prove_execution(...)", () => {
    const header: BeaconHeaderData = {
      slot: 13546496n,
      proposerIndex: 1n,
      parentRoot: zeros(32),
      stateRoot: zeros(32),
      bodyRoot: zeros(32),
    };
    const execution: ExecutionPayloadHeaderData = {
      parentHash: zeros(32),
      feeRecipient: zeros(20),
      stateRoot: zeros(32),
      receiptsRoot: zeros(32),
      logsBloom: zeros(256),
      prevRandao: zeros(32),
      blockNumber: 28_372_822n,
      gasLimit: 30_000_000n,
      gasUsed: 21_000n,
      timestamp: 1_700_000_000n,
      extraData: "0x" as Hex,
      baseFeePerGas: zeros(32),
      blockHash: zeros(32),
      transactionsRoot: zeros(32),
      withdrawalsRoot: zeros(32),
      blobGasUsed: 0n,
      excessBlobGas: 0n,
    };
    const op = sub.proveExecutionOp({
      finalizedSlot: 13546496n,
      finalizedHeader: header,
      execution,
      executionBranch: [zeros(32), zeros(32), zeros(32), zeros(32)],
    });
    expect(op).toBeDefined();
  });
});

// Live integration smoke test — hits the public Boundless feed. Opt-in:
//   SIGNAL_LIVE=1 pnpm --filter @wraith/relayer test
describe.skipIf(!process.env.SIGNAL_LIVE)("live Signal feed", () => {
  it("fetches a fulfilled (seal, journal) and the journal parses", async () => {
    const proof = await fetchLatestSignalProof();
    expect(proof.seal.startsWith("0x73c457ba")).toBe(true);
    const v = parseJournal(proof.journal);
    expect(v.finalizedSlot).toBe(v.finalizedEpoch * 32n);
    // The fetched journal corresponds to (epoch+1) finalized, give or take.
    expect(Number(v.finalizedEpoch)).toBeGreaterThan(450_000);
  }, 30_000);
});
