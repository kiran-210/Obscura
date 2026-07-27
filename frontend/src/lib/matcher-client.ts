/**
 * Client for the off-chain dark-pool matcher.
 *
 * Placing an order on-chain only posts a sealed commitment — the matcher can't see it. To
 * opt into matching, the trader hands the matcher the order's preimage (price/amount/side/
 * assets/owner/nonce) plus their receive code, so it can find a cross, build the settlement
 * proof, and seal the fill back to them (see services/matcher). This is the *only* place the
 * order details leave the browser, and only to the matcher the user configured.
 *
 * Best-effort: if no matcher is configured or it's unreachable, the order still lives on-chain
 * (placeable + cancellable) — it just won't fill until a matcher sees it.
 */
import { MATCHER_URL } from './config'

export interface MatcherOrderSubmission {
  commitment: string
  side: 'buy' | 'sell'
  price: string // scaled u64 (× PRICE_SCALE)
  amount: string // base-asset base units (u64)
  assetBase: string // hex field
  assetQuote: string // hex field
  ownerKey: string // hex field
  nonce: string // hex field
  receiveCode: string // wr1… — for sealing the settlement memos
  baseCode?: string
  quoteCode?: string
}

/** True when a matcher endpoint is configured. */
export function matchingEnabled(): boolean {
  return MATCHER_URL.length > 0
}

/**
 * Submit an order to the matcher. Returns true on acceptance, false if matching is disabled or
 * the matcher rejected/was unreachable (non-fatal — the order is already on-chain).
 */
export async function submitOrderToMatcher(order: MatcherOrderSubmission): Promise<boolean> {
  if (!matchingEnabled()) return false
  try {
    const res = await fetch(`${MATCHER_URL.replace(/\/$/, '')}/orders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(order),
    })
    if (!res.ok) {
      console.warn('[matcher] order rejected:', res.status, await res.text().catch(() => ''))
      return false
    }
    return true
  } catch (err) {
    console.warn('[matcher] unreachable; order is on-chain but unmatched until a matcher sees it.', err)
    return false
  }
}
