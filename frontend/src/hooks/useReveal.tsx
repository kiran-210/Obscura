import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'

const STORAGE_KEY = 'obscura.revealBalance.v1'

/**
 * Whether shielded balances are shown. Persisted so the choice survives a hard refresh, and
 * defaulting to HIDDEN — a privacy wallet should never flash the balance before the user opts in.
 */
function loadRevealed(): boolean {
  try {
    return globalThis.localStorage?.getItem(STORAGE_KEY) === 'true'
  } catch {
    return false
  }
}

interface RevealValue {
  revealed: boolean
  toggle: () => void
  setRevealed: (value: boolean) => void
}

const RevealContext = createContext<RevealValue | null>(null)

/**
 * App-wide "show / hide shielded balance" state, shared across the header chip, the hub and the
 * portfolio so toggling the eye anywhere flips them all at once. Persisted to localStorage
 * (default hidden) so it holds across reloads.
 */
export function RevealProvider({ children }: { children: ReactNode }) {
  const [revealed, setRevealedState] = useState<boolean>(loadRevealed)

  useEffect(() => {
    try {
      globalThis.localStorage?.setItem(STORAGE_KEY, String(revealed))
    } catch {
      /* storage unavailable — non-fatal, the choice just won't persist */
    }
  }, [revealed])

  const setRevealed = useCallback((value: boolean) => setRevealedState(value), [])
  const toggle = useCallback(() => setRevealedState((v) => !v), [])
  const value = useMemo(() => ({ revealed, toggle, setRevealed }), [revealed, toggle, setRevealed])

  return <RevealContext.Provider value={value}>{children}</RevealContext.Provider>
}

export function useReveal(): RevealValue {
  const ctx = useContext(RevealContext)
  if (!ctx) throw new Error('useReveal must be used within a RevealProvider')
  return ctx
}
