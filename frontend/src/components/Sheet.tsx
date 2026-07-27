import { useEffect } from 'react'
import type { ReactNode } from 'react'
import { XIcon } from './ui'

/**
 * A slide-up sheet, sized to the wallet column. Actions (Bridge / Send / Swap /
 * Receive) open inside it over the wallet home, so the whole app stays one surface.
 * Bottom-sheet on mobile, centered modal on wider screens.
 */
export function Sheet({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean
  title: string
  onClose: () => void
  children: ReactNode
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
    }
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-ink-950/80 animate-fade-in" onClick={onClose} />
      <div className="animate-fade-in relative z-10 flex max-h-[92vh] w-full max-w-[460px] flex-col rounded-t-2xl border border-ink-700 bg-ink-900 shadow-panel sm:rounded-2xl">
        <div className="flex items-center justify-between border-b border-ink-800 px-5 py-4">
          <h2 className="text-base font-semibold tracking-tight text-zinc-100">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-8 w-8 items-center justify-center rounded-lg text-zinc-500 transition hover:bg-ink-800 hover:text-zinc-200"
          >
            <XIcon className="h-4 w-4" />
          </button>
        </div>
        <div className="overflow-y-auto px-5 py-5">{children}</div>
      </div>
    </div>
  )
}
