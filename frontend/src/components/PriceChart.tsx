import { useEffect, useMemo, useRef } from 'react'
import {
  createChart,
  CandlestickSeries,
  ColorType,
  type CandlestickData,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from 'lightweight-charts'

// Adapted from Lotusfi/Lotus_main's AssetChart (lightweight-charts v5), recoloured
// to the Obscura sepia/spectral DA. The shape is deterministic per market so the
// preview is stable; when a live reference price is known the whole series is
// rescaled so its last close sits on that price — the dark-pool testnet has no
// historical feed of its own.
const UP = '#7FEFEF'
const DOWN = '#00FFFF'

function mockCandles(seed: string, anchor?: number, n = 90): CandlestickData[] {
  let s = 0
  for (let i = 0; i < seed.length; i++) s = (s * 31 + seed.charCodeAt(i)) >>> 0
  const rand = () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 0xffffffff
  }
  const out: CandlestickData[] = []
  let price = 0.1 + rand() * 0.6
  const now = Math.floor(Date.now() / 1000)
  const step = 3600
  for (let i = n - 1; i >= 0; i--) {
    const open = price
    const close = Math.max(0.0001, price + (rand() - 0.5) * price * 0.07)
    const high = Math.max(open, close) * (1 + rand() * 0.02)
    const low = Math.min(open, close) * (1 - rand() * 0.02)
    out.push({ time: (now - i * step) as UTCTimestamp, open, high, low, close })
    price = close
  }
  if (anchor && anchor > 0 && out.length) {
    const scale = anchor / out[out.length - 1].close
    for (const c of out) {
      c.open *= scale
      c.high *= scale
      c.low *= scale
      c.close *= scale
    }
  }
  return out
}

export function PriceChart({ pair, price }: { pair: string; price?: number | null }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const candles = useMemo(() => mockCandles(pair, price ?? undefined), [pair, price])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const chart = createChart(el, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: '#B3F5F5',
        fontFamily: "'JetBrains Mono', ui-monospace, SFMono-Regular, monospace",
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: 'rgba(0,205,205,0.04)' },
        horzLines: { color: 'rgba(0,205,205,0.04)' },
      },
      rightPriceScale: { borderColor: 'rgba(0,205,205,0.08)' },
      timeScale: { borderColor: 'rgba(0,205,205,0.08)', timeVisible: true, secondsVisible: false },
      crosshair: { mode: 0 },
    })
    chartRef.current = chart
    seriesRef.current = chart.addSeries(CandlestickSeries, {
      upColor: UP,
      downColor: DOWN,
      borderVisible: false,
      wickUpColor: UP,
      wickDownColor: DOWN,
    })
    return () => {
      chart.remove()
      chartRef.current = null
      seriesRef.current = null
    }
  }, [])

  useEffect(() => {
    const chart = chartRef.current
    const series = seriesRef.current
    if (!chart || !series) return
    series.setData(candles)
    chart.timeScale().fitContent()
  }, [candles])

  return <div ref={containerRef} className="h-full min-h-[260px] w-full" />
}

export default PriceChart
