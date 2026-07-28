import { describe, expect, it } from "vitest";
import {
  BPS_SCALE,
  INDEX_SCALE,
  POSITION_DOMAIN,
  SUPPLY_DOMAIN,
  computePositionCommitment,
  computeSupplyCommitment,
  createPosition,
  createSupplyPosition,
  deadlineStatus,
  debtNow,
  fromScaled,
  healthFactor,
  isSolvent,
  maxBorrowable,
  toScaled,
  valueOf,
} from "../src/lending.js";
import { computeOrderCommitment } from "../src/order.js";
import { deriveOwnerKey } from "../src/note.js";
import { hash7 } from "../src/poseidon.js";

const ONE_PRICE = 10_000_000n;
const ONE_INDEX = 1_000_000_000n;

describe("lending invariants", () => {
  it("matches the constants the circuits and contract use", () => {
    expect(POSITION_DOMAIN).toBe(7001n);
    expect(SUPPLY_DOMAIN).toBe(7002n);
    expect(INDEX_SCALE).toBe(1_000_000_000n);
    expect(BPS_SCALE).toBe(10_000n);
  });

  it("domain-separates positions from orders", () => {
    // Both are hash7. Without a distinct leading tag a crafted order could be
    // replayed as a position.
    const ownerKey = deriveOwnerKey(1n);
    const position = computePositionCommitment({
      collateralAsset: 0n,
      collateralAmount: 100n,
      debtAsset: 1n,
      debtScaled: 0n,
      ownerKey,
      nonce: 9n,
    });
    const order = computeOrderCommitment({
      side: 0n,
      price: 100n,
      amount: 1n,
      assetBase: 0n,
      assetQuote: 1n,
      ownerKey,
      nonce: 9n,
    });
    expect(position).not.toBe(order);
  });

  it("positions and supply positions never collide", () => {
    const ownerKey = deriveOwnerKey(1n);
    const p = computePositionCommitment({
      collateralAsset: 1n,
      collateralAmount: 5n,
      debtAsset: 0n,
      debtScaled: 0n,
      ownerKey,
      nonce: 3n,
    });
    const s = computeSupplyCommitment({ asset: 1n, supplyScaled: 5n, ownerKey, nonce: 3n });
    expect(p).not.toBe(s);
  });

  it("commits fields in the exact order the circuit hashes them", () => {
    const ownerKey = deriveOwnerKey(7n);
    expect(
      computePositionCommitment({
        collateralAsset: 0n,
        collateralAmount: 1000n,
        debtAsset: 1n,
        debtScaled: 700n,
        ownerKey,
        nonce: 12n,
      }),
    ).toBe(hash7(POSITION_DOMAIN, 0n, 1000n, 1n, 700n, ownerKey, 12n));

    expect(computeSupplyCommitment({ asset: 1n, supplyScaled: 500n, ownerKey, nonce: 42n })).toBe(
      hash7(SUPPLY_DOMAIN, 1n, 500n, ownerKey, 42n, 0n, 0n),
    );
  });
});

describe("scaled balances", () => {
  it("round-trips at a unit index", () => {
    expect(toScaled(500n, ONE_INDEX)).toBe(500n);
    expect(fromScaled(500n, ONE_INDEX)).toBe(500n);
  });

  it("accrues interest without touching the note", () => {
    // Same scaled balance, index doubled -> debt doubled.
    expect(debtNow({ debtScaled: 500n }, 2n * ONE_INDEX)).toBe(1000n);
  });

  it("rejects a non-positive index", () => {
    expect(() => toScaled(1n, 0n)).toThrow(/positive/);
  });
});

describe("solvency", () => {
  const base = {
    collateralAmount: 1000n,
    collateralPrice: ONE_PRICE,
    debtPrice: ONE_PRICE,
    borrowIndex: ONE_INDEX,
  };

  it("passes at exactly the limit and fails one over", () => {
    // 1000 @1.0 * 75% = 750 allowed.
    expect(isSolvent({ ...base, debtScaled: 750n, bps: 7500 })).toBe(true);
    expect(isSolvent({ ...base, debtScaled: 751n, bps: 7500 })).toBe(false);
  });

  it("agrees with the circuit's boundary behaviour after a price crash", () => {
    // Collateral halves: 1000 @0.5 = 500, 80% -> 400 allowed.
    const crashed = { ...base, collateralPrice: ONE_PRICE / 2n };
    expect(isSolvent({ ...crashed, debtScaled: 400n, bps: 8000 })).toBe(true);
    expect(isSolvent({ ...crashed, debtScaled: 401n, bps: 8000 })).toBe(false);
  });

  it("becomes insolvent as interest accrues", () => {
    expect(isSolvent({ ...base, debtScaled: 750n, bps: 7500 })).toBe(true);
    expect(isSolvent({ ...base, borrowIndex: 2n * ONE_INDEX, debtScaled: 750n, bps: 7500 })).toBe(
      false,
    );
  });

  it("reports an infinite health factor for a debt-free position", () => {
    expect(healthFactor({ ...base, debtScaled: 0n, liqThresholdBps: 8000 })).toBe(Infinity);
  });

  it("puts the health factor at 1.0 exactly on the liquidation boundary", () => {
    expect(healthFactor({ ...base, debtScaled: 800n, liqThresholdBps: 8000 })).toBeCloseTo(1.0, 9);
  });

  it("computes borrowing headroom consistent with isSolvent", () => {
    const headroom = maxBorrowable({ ...base, debtScaled: 0n, maxLtvBps: 7500 });
    expect(headroom).toBe(750n);
    // Borrowing exactly the headroom stays solvent; one more does not.
    expect(isSolvent({ ...base, debtScaled: headroom, bps: 7500 })).toBe(true);
    expect(isSolvent({ ...base, debtScaled: headroom + 1n, bps: 7500 })).toBe(false);
  });

  it("reports zero headroom once at the ceiling", () => {
    expect(maxBorrowable({ ...base, debtScaled: 750n, maxLtvBps: 7500 })).toBe(0n);
    expect(maxBorrowable({ ...base, debtScaled: 900n, maxLtvBps: 7500 })).toBe(0n);
  });

  it("values amounts at the shared price scale", () => {
    expect(valueOf(1000n, ONE_PRICE)).toBe(1000n);
    expect(valueOf(1000n, ONE_PRICE / 2n)).toBe(500n);
  });
});

describe("position construction", () => {
  it("derives the owner key from a spending key", () => {
    const p = createPosition({
      collateralAsset: 0n,
      collateralAmount: 1000n,
      debtAsset: 1n,
      spendingKey: 7n,
      nonce: 11n,
    });
    expect(p.ownerKey).toBe(deriveOwnerKey(7n));
    expect(p.debtScaled).toBe(0n);
    expect(p.commitment).toBe(
      computePositionCommitment({
        collateralAsset: 0n,
        collateralAmount: 1000n,
        debtAsset: 1n,
        debtScaled: 0n,
        ownerKey: deriveOwnerKey(7n),
        nonce: 11n,
      }),
    );
  });

  it("requires a key", () => {
    expect(() =>
      createPosition({ collateralAsset: 0n, collateralAmount: 1n, debtAsset: 1n }),
    ).toThrow(/ownerKey or spendingKey/);
  });

  it("range-checks amounts to the circuit's 64-bit bound", () => {
    expect(() =>
      createPosition({
        collateralAsset: 0n,
        collateralAmount: 1n << 64n,
        debtAsset: 1n,
        spendingKey: 7n,
      }),
    ).toThrow(RangeError);
  });

  it("builds supply positions", () => {
    const s = createSupplyPosition({ asset: 1n, supplyScaled: 500n, spendingKey: 7n, nonce: 42n });
    expect(s.commitment).toBe(
      computeSupplyCommitment({
        asset: 1n,
        supplyScaled: 500n,
        ownerKey: deriveOwnerKey(7n),
        nonce: 42n,
      }),
    );
  });
});

describe("attestation deadlines", () => {
  it("classifies urgency by ledgers remaining", () => {
    expect(deadlineStatus(100_000, 10_000).urgency).toBe("ok");
    expect(deadlineStatus(100_000, 97_000).urgency).toBe("due-soon");
    expect(deadlineStatus(100_000, 99_500).urgency).toBe("critical");
    expect(deadlineStatus(100_000, 100_001).urgency).toBe("expired");
  });

  it("flags a position as seizable only once the deadline has passed", () => {
    // Exactly at the deadline the contract still accepts an attestation
    // (`sequence > deadline` is the seizure condition), so it is not yet seizable.
    expect(deadlineStatus(100_000, 100_000).seizable).toBe(false);
    expect(deadlineStatus(100_000, 100_001).seizable).toBe(true);
  });

  it("estimates remaining wall-clock time", () => {
    const s = deadlineStatus(100_000, 99_000);
    expect(s.ledgersRemaining).toBe(1000);
    expect(s.secondsRemaining).toBe(5000);
  });
});
