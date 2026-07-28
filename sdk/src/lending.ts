/**
 * Private collateralised lending. See LENDING_SPEC.md.
 *
 * Mirrors `circuits/noir/lending_lib` exactly — the domain tags, scales and the
 * solvency inequality must agree byte-for-byte with the circuits and the Soroban
 * contract, or positions become unspendable and proofs unverifiable.
 *
 * Privacy model, restated so callers do not over-claim: collateral amounts are
 * PUBLIC (that is what makes a stale position seizable with no keeper), debt is
 * PRIVATE and never stored on-chain. Borrow/repay amounts are public deltas, so
 * an analyst who follows one position's operation chain can reconstruct its debt
 * by accumulation (LENDING_SPEC §1.1).
 */
import { hash7, randomField, toField, type Field, type FieldLike } from "./poseidon.js";
import { assertU64, deriveOwnerKey } from "./note.js";

// ---------------------------------------------------------------------------
// Invariants — must match lending_lib and lending.rs
// ---------------------------------------------------------------------------

/**
 * Domain tags occupy slot 0 of every lending commitment. Order commitments are
 * ALSO hash7, so without a distinct tag a crafted order could be replayed as a
 * position.
 */
export const POSITION_DOMAIN = 7001n;
export const SUPPLY_DOMAIN = 7002n;

/** Interest index fixed-point scale. */
export const INDEX_SCALE = 1_000_000_000n;
/** Basis-points denominator. */
export const BPS_SCALE = 10_000n;
/** Price fixed-point scale (same as the pool's PRICE_SCALE). */
export const LENDING_PRICE_SCALE = 10_000_000n;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A lending position. `debtScaled` is the private part; `collateralAmount` is
 * published on-chain and is committed here so the contract's public copy is
 * cryptographically bound to the position.
 */
export interface Position {
  collateralAsset: Field;
  collateralAmount: bigint;
  debtAsset: Field;
  /** Scaled debt — real debt is `debtScaled * borrowIndex / INDEX_SCALE`. */
  debtScaled: bigint;
  ownerKey: Field;
  nonce: Field;
  spendingKey?: Field;
  commitment: Field;
}

/** A supply-side position. Suppliers are never liquidated, so this stays private. */
export interface SupplyPosition {
  asset: Field;
  supplyScaled: bigint;
  ownerKey: Field;
  nonce: Field;
  spendingKey?: Field;
  commitment: Field;
}

/** Governance risk parameters. Mirrors the contract's `RiskParams`. */
export interface RiskParams {
  maxLtvBps: number;
  liqThresholdBps: number;
  attestationPeriod: number;
  maxPriceAge: number;
}

// ---------------------------------------------------------------------------
// Commitments
// ---------------------------------------------------------------------------

/**
 * position_commitment = hash7(POSITION_DOMAIN, collateral_asset,
 *   collateral_amount, debt_asset, debt_scaled, owner_key, nonce)
 */
export function computePositionCommitment(p: {
  collateralAsset: FieldLike;
  collateralAmount: FieldLike;
  debtAsset: FieldLike;
  debtScaled: FieldLike;
  ownerKey: FieldLike;
  nonce: FieldLike;
}): Field {
  return hash7(
    POSITION_DOMAIN,
    p.collateralAsset,
    p.collateralAmount,
    p.debtAsset,
    p.debtScaled,
    p.ownerKey,
    p.nonce,
  );
}

/** supply_commitment = hash7(SUPPLY_DOMAIN, asset, supply_scaled, owner_key, nonce, 0, 0) */
export function computeSupplyCommitment(p: {
  asset: FieldLike;
  supplyScaled: FieldLike;
  ownerKey: FieldLike;
  nonce: FieldLike;
}): Field {
  return hash7(SUPPLY_DOMAIN, p.asset, p.supplyScaled, p.ownerKey, p.nonce, 0, 0);
}

/** Build a {@link Position}, computing its commitment. */
export function createPosition(params: {
  collateralAsset: FieldLike;
  collateralAmount: bigint;
  debtAsset: FieldLike;
  debtScaled?: bigint;
  spendingKey?: FieldLike;
  ownerKey?: FieldLike;
  nonce?: FieldLike;
}): Position {
  assertU64(params.collateralAmount, "collateralAmount");
  const debtScaled = params.debtScaled ?? 0n;
  assertU64(debtScaled, "debtScaled");

  let ownerKey: Field;
  if (params.ownerKey !== undefined) {
    ownerKey = toField(params.ownerKey);
  } else if (params.spendingKey !== undefined) {
    ownerKey = deriveOwnerKey(params.spendingKey);
  } else {
    throw new Error("createPosition requires either ownerKey or spendingKey");
  }

  const nonce = params.nonce !== undefined ? toField(params.nonce) : randomField();
  const collateralAsset = toField(params.collateralAsset);
  const debtAsset = toField(params.debtAsset);
  const commitment = computePositionCommitment({
    collateralAsset,
    collateralAmount: params.collateralAmount,
    debtAsset,
    debtScaled,
    ownerKey,
    nonce,
  });

  const pos: Position = {
    collateralAsset,
    collateralAmount: params.collateralAmount,
    debtAsset,
    debtScaled,
    ownerKey,
    nonce,
    commitment,
  };
  if (params.spendingKey !== undefined) pos.spendingKey = toField(params.spendingKey);
  return pos;
}

/** Build a {@link SupplyPosition}, computing its commitment. */
export function createSupplyPosition(params: {
  asset: FieldLike;
  supplyScaled: bigint;
  spendingKey?: FieldLike;
  ownerKey?: FieldLike;
  nonce?: FieldLike;
}): SupplyPosition {
  assertU64(params.supplyScaled, "supplyScaled");

  let ownerKey: Field;
  if (params.ownerKey !== undefined) {
    ownerKey = toField(params.ownerKey);
  } else if (params.spendingKey !== undefined) {
    ownerKey = deriveOwnerKey(params.spendingKey);
  } else {
    throw new Error("createSupplyPosition requires either ownerKey or spendingKey");
  }

  const nonce = params.nonce !== undefined ? toField(params.nonce) : randomField();
  const asset = toField(params.asset);
  const commitment = computeSupplyCommitment({
    asset,
    supplyScaled: params.supplyScaled,
    ownerKey,
    nonce,
  });

  const sp: SupplyPosition = {
    asset,
    supplyScaled: params.supplyScaled,
    ownerKey,
    nonce,
    commitment,
  };
  if (params.spendingKey !== undefined) sp.spendingKey = toField(params.spendingKey);
  return sp;
}

// ---------------------------------------------------------------------------
// Scaled-balance maths (mirrors lending_lib)
// ---------------------------------------------------------------------------

/** `amount * INDEX_SCALE / index` — the scaled balance recorded in a note. */
export function toScaled(amount: bigint, index: bigint): bigint {
  if (index <= 0n) throw new Error("index must be positive");
  return (amount * INDEX_SCALE) / index;
}

/** `scaled * index / INDEX_SCALE` — the nominal value of a scaled balance now. */
export function fromScaled(scaled: bigint, index: bigint): bigint {
  return (scaled * index) / INDEX_SCALE;
}

/** Current debt of a position at `borrowIndex`. */
export function debtNow(position: Pick<Position, "debtScaled">, borrowIndex: bigint): bigint {
  return fromScaled(position.debtScaled, borrowIndex);
}

/** `amount * price / PRICE_SCALE`. */
export function valueOf(amount: bigint, price: bigint): bigint {
  return (amount * price) / LENDING_PRICE_SCALE;
}

/**
 * The solvency inequality the circuits enforce:
 *   collateral_value * bps / BPS_SCALE >= debt_value
 *
 * Pass `maxLtvBps` for borrow / withdraw-collateral, `liqThresholdBps` for an
 * attestation.
 */
export function isSolvent(p: {
  collateralAmount: bigint;
  collateralPrice: bigint;
  debtScaled: bigint;
  debtPrice: bigint;
  borrowIndex: bigint;
  bps: bigint | number;
}): boolean {
  const collateralValue = valueOf(p.collateralAmount, p.collateralPrice);
  const allowed = (collateralValue * BigInt(p.bps)) / BPS_SCALE;
  const debtValue = valueOf(fromScaled(p.debtScaled, p.borrowIndex), p.debtPrice);
  return allowed >= debtValue;
}

/**
 * Health factor as a float, for display only. 1.0 is the liquidation boundary.
 * Returns `Infinity` for a position with no debt. Never use this to decide
 * whether to submit a proof — the circuits use exact integer arithmetic, and a
 * float can disagree at the boundary.
 */
export function healthFactor(p: {
  collateralAmount: bigint;
  collateralPrice: bigint;
  debtScaled: bigint;
  debtPrice: bigint;
  borrowIndex: bigint;
  liqThresholdBps: bigint | number;
}): number {
  const debtValue = valueOf(fromScaled(p.debtScaled, p.borrowIndex), p.debtPrice);
  if (debtValue === 0n) return Number.POSITIVE_INFINITY;
  const weighted =
    (valueOf(p.collateralAmount, p.collateralPrice) * BigInt(p.liqThresholdBps)) / BPS_SCALE;
  return Number(weighted) / Number(debtValue);
}

/**
 * Largest additional amount of the debt asset that may be borrowed while staying
 * within `maxLtvBps`. Returns 0n if already at or past the ceiling.
 */
export function maxBorrowable(p: {
  collateralAmount: bigint;
  collateralPrice: bigint;
  debtScaled: bigint;
  debtPrice: bigint;
  borrowIndex: bigint;
  maxLtvBps: bigint | number;
}): bigint {
  if (p.debtPrice <= 0n) throw new Error("debtPrice must be positive");
  const allowed =
    (valueOf(p.collateralAmount, p.collateralPrice) * BigInt(p.maxLtvBps)) / BPS_SCALE;
  const debtValue = valueOf(fromScaled(p.debtScaled, p.borrowIndex), p.debtPrice);
  if (allowed <= debtValue) return 0n;
  // Invert valueOf: headroom_value -> amount of the debt asset.
  return ((allowed - debtValue) * LENDING_PRICE_SCALE) / p.debtPrice;
}

// ---------------------------------------------------------------------------
// Attestation deadline monitoring (client-side only — nothing on-chain)
// ---------------------------------------------------------------------------

export type DeadlineUrgency = "ok" | "due-soon" | "critical" | "expired";

export interface DeadlineStatus {
  /** Ledger the position becomes seizable at. */
  deadline: number;
  /** Ledgers remaining; negative once expired. */
  ledgersRemaining: number;
  /** Rough wall-clock estimate at ~5s per ledger. */
  secondsRemaining: number;
  urgency: DeadlineUrgency;
  /** True once anyone may call `liquidate_stale` on this position. */
  seizable: boolean;
}

/** Approximate seconds per Stellar ledger — for display estimates only. */
export const SECONDS_PER_LEDGER = 5;

/**
 * Classify how urgently a position needs a fresh solvency attestation.
 *
 * Missing the deadline means the whole collateral can be seized by anyone, and
 * the position freezes beforehand — it cannot be repaid or topped up out of
 * trouble once stale. So the thresholds are deliberately conservative.
 */
export function deadlineStatus(
  deadline: number,
  currentLedger: number,
  opts: { dueSoonLedgers?: number; criticalLedgers?: number } = {},
): DeadlineStatus {
  const dueSoon = opts.dueSoonLedgers ?? 4320; // ~6h
  const critical = opts.criticalLedgers ?? 720; // ~1h
  const ledgersRemaining = deadline - currentLedger;

  let urgency: DeadlineUrgency;
  if (ledgersRemaining < 0) urgency = "expired";
  else if (ledgersRemaining <= critical) urgency = "critical";
  else if (ledgersRemaining <= dueSoon) urgency = "due-soon";
  else urgency = "ok";

  return {
    deadline,
    ledgersRemaining,
    secondsRemaining: ledgersRemaining * SECONDS_PER_LEDGER,
    urgency,
    seizable: ledgersRemaining < 0,
  };
}

/**
 * Poll positions and fire a callback whenever one needs attention.
 *
 * Purely client-side: nothing here protects a position on its own — it only
 * reminds the user to attest. Returns a stop function.
 */
export function watchDeadlines(params: {
  /** Positions to watch, by commitment hex. */
  positions: () => Promise<Array<{ commitment: string; deadline: number }>>;
  currentLedger: () => Promise<number>;
  onStatus: (commitment: string, status: DeadlineStatus) => void;
  /** Poll interval in ms. Default 60s. */
  intervalMs?: number;
  /** Only fire for these urgencies. Default: everything except "ok". */
  notifyOn?: DeadlineUrgency[];
}): () => void {
  const intervalMs = params.intervalMs ?? 60_000;
  const notifyOn = params.notifyOn ?? ["due-soon", "critical", "expired"];
  let stopped = false;

  const tick = async () => {
    if (stopped) return;
    try {
      const [positions, ledger] = await Promise.all([
        params.positions(),
        params.currentLedger(),
      ]);
      for (const p of positions) {
        const status = deadlineStatus(p.deadline, ledger);
        if (notifyOn.includes(status.urgency)) params.onStatus(p.commitment, status);
      }
    } catch {
      // Polling is best-effort; a transient RPC failure must not kill the watcher.
    }
  };

  void tick();
  const handle = setInterval(() => void tick(), intervalMs);
  return () => {
    stopped = true;
    clearInterval(handle);
  };
}
