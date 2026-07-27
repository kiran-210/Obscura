import type { FC, SVGProps } from 'react'
import { cx } from '../lib/cx'

/**
 * Monochrome brand marks for chains and tokens.
 *
 * Rendered as single-color glyphs (they inherit `currentColor`) so they sit cleanly
 * in the black-and-white UI — no external image fetches, so nothing can 404. The
 * Stellar and Ethereum paths are the canonical simple-icons marks; USDC and the
 * Obscura mark are drawn to match the same weight.
 */

export function StellarGlyph(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden {...props}>
      <path d="M12.003 1.716c-1.37 0-2.7.27-3.948.78A10.18 10.18 0 0 0 2.66 7.901a10.136 10.136 0 0 0-.797 3.954c0 .258.01.516.027.775a1.942 1.942 0 0 1-1.055 1.88L0 14.934v1.902l2.463-1.26.072-.032v.005l.77-.39.758-.385.066-.039 14.807-7.56 1.666-.847 3.392-1.732V2.694L17.792 5.86 3.744 13.025l-.104.055-.017-.115a8.286 8.286 0 0 1-.071-1.105c0-2.255.88-4.377 2.474-5.977a8.462 8.462 0 0 1 2.71-1.82 8.513 8.513 0 0 1 3.2-.654h.067a8.41 8.41 0 0 1 4.09 1.055l1.628-.83.126-.066a10.11 10.11 0 0 0-5.845-1.853zM24 7.143 5.047 16.808l-1.666.847L0 19.382v1.902l3.282-1.671 2.91-1.485 14.058-7.153.105-.055.016.115c.05.369.072.743.072 1.11 0 2.255-.88 4.383-2.475 5.978a8.461 8.461 0 0 1-2.71 1.82 8.305 8.305 0 0 1-3.2.654h-.06c-1.441 0-2.86-.369-4.102-1.061l-.066.033-1.683.857c.594.418 1.232.776 1.903 1.062a10.11 10.11 0 0 0 3.947.797 10.09 10.09 0 0 0 7.17-2.975 10.136 10.136 0 0 0 2.969-7.18c0-.259-.005-.523-.027-.781a1.942 1.942 0 0 1 1.055-1.88L24 9.044z" />
    </svg>
  )
}

export function EthereumGlyph(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden {...props}>
      <path d="M11.944 17.97L4.58 13.62 11.943 24l7.37-10.38-7.372 4.35h.003zM12.056 0L4.69 12.223l7.365 4.354 7.365-4.35L12.056 0z" />
    </svg>
  )
}

export function UsdcGlyph(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden {...props}>
      <circle cx="12" cy="12" r="9.25" />
      <path d="M12 6.3v11.4" strokeLinecap="round" />
      <path
        d="M14.8 9c-.52-.92-1.57-1.45-2.8-1.45-1.65 0-2.85.83-2.85 2.15 0 1.3 1.05 1.83 2.85 2.25 1.8.42 3 .95 3 2.35 0 1.35-1.2 2.2-2.95 2.2-1.35 0-2.5-.53-3.02-1.55"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function BitcoinGlyph(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden {...props}>
      <path d="M23.638 14.904c-1.602 6.43-8.113 10.34-14.542 8.736C2.67 22.05-1.244 15.525.362 9.105 1.962 2.67 8.475-1.243 14.9.358c6.43 1.605 10.342 8.115 8.738 14.548v-.002zm-6.35-4.613c.24-1.59-.974-2.45-2.64-3.03l.54-2.153-1.315-.33-.525 2.107c-.345-.087-.705-.167-1.064-.25l.526-2.127-1.32-.33-.54 2.165c-.285-.067-.565-.132-.84-.2l-1.815-.45-.35 1.407s.975.225.955.236c.535.136.63.486.615.766l-1.477 5.92c-.075.166-.24.406-.614.314.015.02-.96-.24-.96-.24l-.66 1.51 1.71.426.93.242-.54 2.19 1.32.327.54-2.17c.36.1.705.19 1.05.273l-.51 2.154 1.32.33.545-2.19c2.24.427 3.93.257 4.64-1.774.57-1.637-.03-2.58-1.217-3.196.854-.193 1.5-.76 1.68-1.93h.01zm-3.01 4.22c-.404 1.64-3.157.75-4.05.53l.72-2.9c.896.23 3.757.67 3.33 2.37zm.41-4.24c-.37 1.49-2.662.735-3.405.55l.654-2.64c.744.18 3.137.524 2.75 2.084v.006z" />
    </svg>
  )
}

export function XrpGlyph(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden {...props}>
      <path d="M5.52 2.955A3.521 3.521 0 001.996 6.48v2.558A2.12 2.12 0 010 11.157l.03.562-.03.561a2.12 2.12 0 011.996 2.121v2.948a3.69 3.69 0 003.68 3.696v-1.123a2.56 2.56 0 01-2.557-2.558v-2.963a3.239 3.239 0 00-1.42-2.682 3.26 3.26 0 001.42-2.682V6.48A2.412 2.412 0 015.52 4.078h.437V2.955zm12.538 0v1.123h.437a2.39 2.39 0 012.386 2.401v2.558a3.26 3.26 0 001.42 2.682 3.239 3.239 0 00-1.42 2.682v2.963a2.56 2.56 0 01-2.557 2.558v1.123a3.69 3.69 0 003.68-3.696V14.4A2.12 2.12 0 0124 12.281l-.03-.562.03-.561a2.12 2.12 0 01-1.996-2.12V6.478a3.518 3.518 0 00-3.509-3.524zM6.253 7.478l3.478 3.259a3.393 3.393 0 004.553 0l3.478-3.26h-1.669l-2.65 2.464a2.133 2.133 0 01-2.886 0L7.922 7.478zm5.606 4.884a3.36 3.36 0 00-2.128.886l-3.493 3.274h1.668l2.667-2.495a2.133 2.133 0 012.885 0l2.65 2.495h1.67l-3.494-3.274a3.36 3.36 0 00-2.425-.886z" />
    </svg>
  )
}

export function ObscuraMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden {...props}>
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M1 3.19 1 4.34 1.33 6.2 2.31 8.88 2.99 9.94 4.03 11.01 4.98 11.6 5.89 11.93 4.19 12.73 3.19 13.7 2.44 14.77 1.77 16.21 1.35 17.58 1 19.59 1 20.68 22.89 20.63 22.54 17.58 22 15.85 21.45 14.75 19.95 12.93 19 12.31 18.06 11.95 19.19 11.47 20.06 10.85 21.54 8.95 22.53 6.38 22.87 3.19ZM11.98 4.21 12.49 7.02 13.04 8.46 13.61 9.46 14.37 10.45 15.17 11.16 16.8 11.95 15.87 12.29 14.97 12.86 13.51 14.55 12.49 16.85 12 19.66 11.36 16.72 10.27 14.37 9.01 12.93 7.99 12.27 7.06 11.96 8.86 11.05 9.52 10.47 10.29 9.46 11.36 7.15Z"
      />
    </svg>
  )
}

// --- Coin badge -------------------------------------------------------------

type GlyphComponent = FC<SVGProps<SVGSVGElement>>

/** Registry keyed by both chain ids and token codes. */
const GLYPHS: Record<string, GlyphComponent> = {
  stellar: StellarGlyph,
  ethereum: EthereumGlyph,
  obscura: ObscuraMark,
  XLM: StellarGlyph,
  ETH: EthereumGlyph,
  bETH: EthereumGlyph,
  USDC: UsdcGlyph,
  bUSDC: UsdcGlyph,
  BTC: BitcoinGlyph,
  XRP: XrpGlyph,
}

const SIZES = {
  sm: { chip: 'h-5 w-5', glyph: 'h-3 w-3' },
  md: { chip: 'h-7 w-7', glyph: 'h-4 w-4' },
  lg: { chip: 'h-9 w-9', glyph: 'h-[18px] w-[18px]' },
} as const

/**
 * A chain or token logo inside a round monochrome chip. `name` is a chain id
 * (`stellar`/`ethereum`/`obscura`) or a token code (`XLM`, `ETH`, `bETH`, …).
 * Unknown names fall back to a short mono label so nothing renders empty.
 */
export function CoinBadge({
  name,
  size = 'md',
  className,
}: {
  name: string
  size?: keyof typeof SIZES
  className?: string
}) {
  const Glyph = GLYPHS[name]
  const s = SIZES[size]
  return (
    <span
      className={cx(
        'inline-flex shrink-0 items-center justify-center rounded-full border border-ink-700 bg-ink-800 text-zinc-100',
        s.chip,
        className,
      )}
    >
      {Glyph ? (
        <Glyph className={s.glyph} />
      ) : (
        <span className="font-mono text-[8px] font-bold leading-none">{name.replace(/^b/, '').slice(0, 3)}</span>
      )}
    </span>
  )
}
