/** Formatting and validation helpers for the Obscura UI. */

/** Shorten a long key/hash to `ABCDE…WXYZ`. */
export function truncateKey(key: string, lead = 5, tail = 4): string {
  if (key.length <= lead + tail + 1) return key
  return `${key.slice(0, lead)}…${key.slice(-tail)}`
}

const amountFmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 7 })

/** Format a token amount with thousands separators, trimming trailing zeros. */
export function formatAmount(value: number): string {
  if (!Number.isFinite(value)) return '0'
  return amountFmt.format(value)
}

/** Format a price (quote per base) as a clean, editable decimal string with
 *  magnitude-aware precision. Empty string for non-positive/invalid values. */
export function formatPrice(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return ''
  const abs = Math.abs(value)
  const decimals = abs >= 1000 ? 2 : abs >= 1 ? 4 : abs >= 0.01 ? 6 : 8
  return value.toFixed(decimals).replace(/\.?0+$/, '')
}

const usdFmt = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 2,
})

export function formatUsd(value: number): string {
  return usdFmt.format(Number.isFinite(value) ? value : 0)
}

/** Parse a user-entered decimal string into a number (NaN if invalid). */
export function parseAmount(input: string): number {
  if (!input.trim()) return NaN
  const n = Number(input.replace(/,/g, '').trim())
  return Number.isFinite(n) ? n : NaN
}

export function isPositiveAmount(input: string): boolean {
  const n = parseAmount(input)
  return Number.isFinite(n) && n > 0
}

const STELLAR_ADDRESS = /^G[A-Z2-7]{55}$/

/** Lightweight check for a classic Stellar public key (G… base32, 56 chars). */
export function isValidStellarAddress(addr: string): boolean {
  return STELLAR_ADDRESS.test(addr.trim())
}
