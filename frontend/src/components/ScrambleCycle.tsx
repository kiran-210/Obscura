import { useEffect, useRef } from 'react'

/**
 * ScrambleCycle — cycles a list of words in place, scrambling from one to the next
 * through "encrypted" glyphs (#@%&…), like the rotating final line of the
 * monopo.nyc headline. A hidden spacer reserves the current word's width while the
 * centered letters overlay animates. No innerHTML; DOM spans mutated per frame.
 */

const GLYPHS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789#%&*+=/<>[]{}?'

interface Slot {
  from: string
  to: string
  start: number
  end: number
  glyph: string
  span: HTMLSpanElement
  state: '' | 'scr' | 'done'
}

export interface ScrambleCycleProps {
  words: string[]
  className?: string
  /** ms for a single word→word transition. */
  duration?: number
  /** ms to hold a resolved word before moving on. */
  hold?: number
  /** RGB chromatic-aberration glitch on scrambling glyphs. */
  glitch?: boolean
}

export function ScrambleCycle({ words, className = '', duration = 900, hold = 2000, glitch = true }: ScrambleCycleProps) {
  const spacerRef = useRef<HTMLSpanElement>(null)
  const lettersRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    const spacer = spacerRef.current
    const letters = lettersRef.current
    if (!spacer || !letters || words.length === 0) return

    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      spacer.textContent = words[0]
      letters.textContent = words[0]
      return
    }

    const glyphClass = glitch ? 'wr-scramble-glyph wr-scramble-char' : 'wr-scramble-glyph'
    const totalFrames = Math.max(1, Math.round(duration / 16))
    let raf = 0
    let timer = 0
    let idx = 0
    let current = ''
    let frame = 0
    let slots: Slot[] = []

    const build = (target: string) => {
      const len = Math.max(current.length, target.length)
      letters.replaceChildren()
      slots = []
      for (let i = 0; i < len; i++) {
        const span = document.createElement('span')
        span.setAttribute('aria-hidden', 'true')
        letters.appendChild(span)
        const start = Math.floor((i / len) * totalFrames * 0.5) + Math.floor(Math.random() * 6)
        const end = start + 8 + Math.floor(Math.random() * totalFrames * 0.5)
        slots.push({ from: current[i] || '', to: target[i] || '', start, end, glyph: '', span, state: '' })
      }
    }

    const tick = () => {
      let done = 0
      for (const s of slots) {
        if (frame >= s.end) {
          if (s.state !== 'done') {
            s.span.textContent = s.to
            s.span.className = ''
            s.state = 'done'
          }
          done++
        } else if (frame >= s.start) {
          if (!s.glyph || Math.random() < 0.28) s.glyph = GLYPHS[Math.floor(Math.random() * GLYPHS.length)]
          s.span.textContent = s.glyph
          if (s.state !== 'scr') {
            s.span.className = glyphClass
            s.state = 'scr'
          }
        } else {
          s.span.textContent = s.from
        }
      }
      frame++
      if (done < slots.length) {
        raf = requestAnimationFrame(tick)
      } else {
        current = words[idx]
        timer = window.setTimeout(advance, hold)
      }
    }

    const advance = () => {
      idx = (idx + 1) % words.length
      const target = words[idx]
      spacer.textContent = target
      build(target)
      frame = 0
      raf = requestAnimationFrame(tick)
    }

    spacer.textContent = words[0]
    build(words[0])
    frame = 0
    raf = requestAnimationFrame(tick)

    return () => {
      cancelAnimationFrame(raf)
      clearTimeout(timer)
    }
  }, [words, duration, hold, glitch])

  return (
    <span className={`relative inline-block ${className}`} aria-label={words[0]}>
      <span ref={spacerRef} className="invisible" aria-hidden />
      <span ref={lettersRef} className="absolute left-1/2 top-0 -translate-x-1/2 whitespace-nowrap" aria-hidden />
    </span>
  )
}

export default ScrambleCycle
