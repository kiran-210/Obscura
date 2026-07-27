/**
 * Live USD price feed for the curated tokens.
 *
 * The dark-pool testnet has no on-chain price oracle, so the "market" reference price used to
 * prefill the order form and anchor the preview chart comes from CoinGecko's public simple-price
 * endpoint. Any code without a mapping — or when the request fails (offline, rate-limited, CORS) —
 * falls back to the static `priceUsd` in the token registry, so the UI keeps working fully offline,
 * just without live movement.
 */
import { assetMeta } from './tokens'

const COINGECKO_IDS: Record<string, string> = {
  XLM: 'stellar',
  USDC: 'usd-coin',
  ETH: 'ethereum',
  BTC: 'bitcoin',
  XRP: 'ripple',
}

const ENDPOINT = 'https://api.coingecko.com/api/v3/simple/price'

/** Live USD prices for the codes CoinGecko knows about. Returns `{}` on any failure. */
export async function fetchLiveUsd(codes: string[]): Promise<Record<string, number>> {
  const wanted = codes.filter((c) => c in COINGECKO_IDS)
  if (wanted.length === 0) return {}
  const ids = [...new Set(wanted.map((c) => COINGECKO_IDS[c]))].join(',')
  try {
    const res = await fetch(`${ENDPOINT}?ids=${ids}&vs_currencies=usd`)
    if (!res.ok) return {}
    const data = (await res.json()) as Record<string, { usd?: number }>
    const out: Record<string, number> = {}
    for (const code of wanted) {
      const usd = data[COINGECKO_IDS[code]]?.usd
      if (typeof usd === 'number' && usd > 0) out[code] = usd
    }
    return out
  } catch {
    return {}
  }
}

/** USD price for a code: live if present, else the registry estimate (0 if unknown). */
export function usdOf(code: string, live: Record<string, number>): number {
  return live[code] ?? assetMeta(code).priceUsd
}

/** Reference price of `base` denominated in `quote` (quote per base), or null if unpriceable. */
export function quotePrice(base: string, quote: string, live: Record<string, number>): number | null {
  const b = usdOf(base, live)
  const q = usdOf(quote, live)
  if (!(b > 0) || !(q > 0)) return null
  return b / q
}
