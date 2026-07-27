import { useEffect, useMemo, useState } from 'react'
import { fetchLiveUsd, quotePrice } from '../lib/prices'
import { TOKEN_CODES } from '../lib/tokens'

const REFRESH_MS = 60_000

/**
 * Market reference price for a pair (quote per base), from the live CoinGecko feed with a static
 * fallback. Polls once a minute. `live` is true only when both legs came from the live feed.
 */
export function usePriceQuote(base: string, quote: string) {
  const [usd, setUsd] = useState<Record<string, number>>({})
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let active = true
    const load = async () => {
      const live = await fetchLiveUsd(TOKEN_CODES)
      if (!active) return
      setUsd(live)
      setLoaded(true)
    }
    void load()
    const id = setInterval(() => void load(), REFRESH_MS)
    return () => {
      active = false
      clearInterval(id)
    }
  }, [])

  const price = useMemo(() => quotePrice(base, quote, usd), [base, quote, usd])
  const live = base in usd && quote in usd

  return { price, live, loading: !loaded }
}
