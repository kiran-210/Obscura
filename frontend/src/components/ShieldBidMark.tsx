import type { SVGProps } from 'react'

/**
 * ShieldBid mark: a ring, an inner ring, and a dollar sign at the centre.
 *
 * Drawn as an SVG rather than a bitmap so it inherits `currentColor` and scales
 * cleanly — the old mark was a fixed-colour PNG that needed a CSS filter hack to
 * be legible on a light surface.
 */
export function ShieldBidMark({ title = 'ShieldBid', ...props }: SVGProps<SVGSVGElement> & { title?: string }) {
  return (
    <svg viewBox="0 0 48 48" fill="none" role="img" aria-label={title} {...props}>
      <circle cx="24" cy="24" r="22" stroke="currentColor" strokeWidth="2.5" />
      <circle cx="24" cy="24" r="15" stroke="currentColor" strokeWidth="1.75" opacity="0.55" />
      {/* Dollar sign: the stroke of the S plus the vertical bar through it. */}
      <path
        d="M28.6 18.4c-.9-1.5-2.6-2.4-4.6-2.4-2.7 0-4.6 1.5-4.6 3.7 0 2.1 1.6 3.1 4.6 3.8 3.3.8 5.2 1.9 5.2 4.4 0 2.4-2.1 4.1-5.2 4.1-2.4 0-4.3-1-5.2-2.7"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
      <path d="M24 12.5v23" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  )
}

export default ShieldBidMark
