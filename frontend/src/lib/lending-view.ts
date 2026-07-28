/**
 * View-model helpers for the lending UI.
 *
 * Everything shown about a position is derived CLIENT-SIDE from the locally
 * persisted secrets — never rendered from on-chain data, because the chain does
 * not hold the debt at all. The contract publishes only collateral and deadline.
 */
import {
  BPS_SCALE,
  deadlineStatus,
  fromScaled,
  healthFactor,
  maxBorrowable,
  type DeadlineStatus,
} from '@obscura/sdk'
import type { StoredPosition } from './note-store'
import { baseUnitsToNumber } from './real-sdk'
import { assetMeta } from './tokens'

/** Risk parameters as the contract reports them. Placeholders until Verdex lands. */
export interface RiskView {
  maxLtvBps: number
  liqThresholdBps: number
  attestationPeriod: number
}

export const DEFAULT_RISK: RiskView = {
  maxLtvBps: 7500,
  liqThresholdBps: 8000,
  attestationPeriod: 17280,
}

export interface PositionView {
  stored: StoredPosition
  collateralCode: string
  debtCode: string
  /** Public — the contract holds this too. */
  collateralAmount: number
  /** PRIVATE — decrypted locally; the chain never sees it. */
  debtAmount: number
  collateralValueUsd: number
  debtValueUsd: number
  /** 1.0 is the liquidation boundary. Infinity when there is no debt. */
  health: number
  /** Current loan-to-value in percent. */
  ltvPercent: number
  /** Additional debt-asset units still borrowable. */
  borrowable: number
  deadline: DeadlineStatus | null
  /** True when health has fallen to or below the liquidation boundary. */
  underwater: boolean
}

/**
 * Build the display model for one position.
 *
 * `health` and `ltvPercent` are floats for rendering only — the circuits use exact
 * integer arithmetic, so never gate a submit on these. The SDK's `isSolvent` is
 * the authority, and the client methods already pre-check with it.
 */
export function buildPositionView(params: {
  stored: StoredPosition
  collateralPrice: bigint
  debtPrice: bigint
  borrowIndex: bigint
  risk: RiskView
  currentLedger: number | null
}): PositionView {
  const { stored, collateralPrice, debtPrice, borrowIndex, risk } = params
  const collateralAmount = BigInt(stored.collateralAmount)
  const debtScaled = BigInt(stored.debtScaled)
  const debtNominal = fromScaled(debtScaled, borrowIndex)

  const cMeta = assetMeta(stored.collateralAssetCode)
  const dMeta = assetMeta(stored.debtAssetCode)

  const health = healthFactor({
    collateralAmount,
    collateralPrice,
    debtScaled,
    debtPrice,
    borrowIndex,
    liqThresholdBps: risk.liqThresholdBps,
  })

  const borrowableBase = maxBorrowable({
    collateralAmount,
    collateralPrice,
    debtScaled,
    debtPrice,
    borrowIndex,
    maxLtvBps: risk.maxLtvBps,
  })

  const collateralValue = Number(collateralAmount * collateralPrice) / 1e7 / 10 ** cMeta.decimals
  const debtValue = Number(debtNominal * debtPrice) / 1e7 / 10 ** dMeta.decimals
  const ltvPercent = collateralValue > 0 ? (debtValue / collateralValue) * 100 : 0

  return {
    stored,
    collateralCode: stored.collateralAssetCode,
    debtCode: stored.debtAssetCode,
    collateralAmount: baseUnitsToNumber(collateralAmount, cMeta.decimals),
    debtAmount: baseUnitsToNumber(debtNominal, dMeta.decimals),
    collateralValueUsd: collateralValue,
    debtValueUsd: debtValue,
    health,
    ltvPercent,
    borrowable: baseUnitsToNumber(borrowableBase, dMeta.decimals),
    deadline:
      stored.deadline !== undefined && params.currentLedger !== null
        ? deadlineStatus(stored.deadline, params.currentLedger)
        : null,
    underwater: health <= 1,
  }
}

/** Colour band for a health factor. */
export function healthTone(health: number): 'good' | 'warn' | 'danger' {
  if (!Number.isFinite(health) || health >= 1.5) return 'good'
  if (health >= 1.15) return 'warn'
  return 'danger'
}

/** Human label for an attestation deadline. */
export function deadlineLabel(status: DeadlineStatus | null): string {
  if (!status) return 'unknown'
  if (status.seizable) return 'EXPIRED — seizable'
  const s = status.secondsRemaining
  if (s < 3600) return `${Math.max(0, Math.floor(s / 60))}m left`
  if (s < 86400) return `${Math.floor(s / 3600)}h left`
  return `${Math.floor(s / 86400)}d left`
}

/** Percentage of the borrow ceiling currently used. */
export function ltvUtilisation(view: PositionView, risk: RiskView): number {
  const ceiling = Number(BigInt(risk.maxLtvBps)) / Number(BPS_SCALE) * 100
  return ceiling > 0 ? Math.min(100, (view.ltvPercent / ceiling) * 100) : 0
}
