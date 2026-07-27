import { useEffect, useRef } from 'react'

/**
 * ScrambleNumber — the shielded total, private by default. Masked it reads as a
 * grain-filled cipher (#@%&…) that quietly reshuffles; on reveal it scrambles and
 * resolves to the real figure, the way the landing headline settles its last word.
 * Toggling back re-encrypts it. One span, per-character child spans mutated in place.
 */

const GLYPHS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789#%&*+=/<>[]{}?'
const NBSP = ' '
const glyph = () => GLYPHS[Math.floor(Math.random() * GLYPHS.length)]

export function ScrambleNumber({
  value,
  revealed,
  className = '',
  duration = 780,
}: {
  value: string
  revealed: boolean
  className?: string
  duration?: number
}) {
  const hostRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const chars = [...value]
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

    // Rebuild the child spans to match the value length.
    host.replaceChildren()
    const spans = chars.map((ch) => {
      const s = document.createElement('span')
      if (ch === ' ') s.textContent = NBSP
      host.appendChild(s)
      return s
    })

    const paint = (i: number, text: string, cipher: boolean) => {
      if (chars[i] === ' ') return
      const s = spans[i]
      s.textContent = text
      s.className = cipher ? 'wr-scramble-glyph wr-scramble-char' : ''
    }

    if (reduced) {
      chars.forEach((ch, i) => paint(i, revealed ? ch : glyph(), !revealed))
      return
    }

    const totalFrames = Math.max(1, Math.round(duration / 16))
    const ends = chars.map((_, i) => Math.floor((i / chars.length) * totalFrames * 0.5) + 8 + Math.floor(Math.random() * totalFrames * 0.5))

    let raf = 0
    let frame = 0
    let reshuffle = 0

    const settle = () => {
      // Masked: keep it alive with a slow cipher reshuffle. Revealed: hold steady.
      if (revealed) return
      reshuffle = window.setInterval(() => {
        chars.forEach((ch, i) => ch !== ' ' && paint(i, glyph(), true))
      }, 120)
    }

    const tick = () => {
      let settled = 0
      chars.forEach((ch, i) => {
        if (ch === ' ') { settled++; return }
        if (frame >= ends[i]) {
          paint(i, revealed ? ch : glyph(), !revealed)
          settled++
        } else {
          paint(i, glyph(), true)
        }
      })
      frame++
      if (settled < chars.length) raf = requestAnimationFrame(tick)
      else settle()
    }
    raf = requestAnimationFrame(tick)

    return () => {
      cancelAnimationFrame(raf)
      clearInterval(reshuffle)
    }
  }, [value, revealed, duration])

  return (
    <span
      ref={hostRef}
      className={className}
      aria-label={revealed ? value : 'hidden'}
      style={{ fontVariantNumeric: 'tabular-nums' }}
    />
  )
}

export default ScrambleNumber
