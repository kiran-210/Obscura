import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useObscura } from '../hooks/useObscura'
import { useReveal } from '../hooks/useReveal'
import { loadNotes, type StoredNote } from '../lib/note-store'
import { assetMeta } from '../lib/tokens'
import { formatAmount, formatUsd } from '../lib/format'
import { cx } from '../lib/cx'
import { AssetAvatar, ChevronDownIcon, EyeGlyph } from '../components/ui'
import { ScrambleNumber } from '../components/ScrambleNumber'
import type { AssetCode } from '../lib/obscura-sdk'

const MASK = '••••••'

const SOURCE_LABEL: Record<NonNullable<StoredNote['source']>, string> = {
  deposit: 'Deposit',
  received: 'Received',
  change: 'Change',
}

/** A stored note's amount as a human number, using its own decimals (falls back to the token's). */
function noteHuman(note: StoredNote): number {
  const decimals = note.decimals ?? assetMeta(note.assetCode).decimals
  return Number(BigInt(note.amount)) / 10 ** decimals
}

/** The wallet's unspent notes grouped by asset, largest first — the per-asset breakdown. */
function groupUnspentNotes(): Map<AssetCode, StoredNote[]> {
  const map = new Map<AssetCode, StoredNote[]>()
  for (const n of loadNotes()) {
    if (n.spent) continue
    const arr = map.get(n.assetCode) ?? []
    arr.push(n)
    map.set(n.assetCode, arr)
  }
  for (const arr of map.values()) arr.sort((a, b) => noteHuman(b) - noteHuman(a))
  return map
}

export function PortfolioPage() {
  const { balances, loadingBalances } = useObscura()
  const { revealed, toggle } = useReveal()
  const [open, setOpen] = useState<AssetCode | null>(null)

  const total = balances.reduce((sum, b) => sum + b.usdEstimate, 0)
  // Recomputed each render; the page re-renders whenever balances refresh (which is when the
  // spent flags used below are reconciled), so the breakdown stays in sync with the totals.
  const notesByAsset = groupUnspentNotes()

  return (
    <div className="mx-auto w-full max-w-3xl px-5 pb-20 pt-12">
      {/* Total */}
      <header className="mb-8">
        <div className="coord-label">portfolio · shielded</div>
        <div className="mt-2 flex items-center gap-3">
          {loadingBalances ? (
            <span className="display-hd text-4xl text-spectral/25">{MASK}</span>
          ) : (
            <ScrambleNumber
              value={formatUsd(total)}
              revealed={revealed}
              className="display-hd text-[clamp(2rem,6vw,3.4rem)]"
            />
          )}
          <button
            type="button"
            onClick={toggle}
            aria-label={revealed ? 'Hide balances' : 'Show balances'}
            className="text-spectral/50 transition hover:text-spectral"
          >
            <EyeGlyph off={!revealed} className="h-5 w-5" />
          </button>
        </div>
        <div className="coord-label mt-1">{revealed ? 'total shielded value · usd' : 'private by default'}</div>
      </header>

      {/* Holdings */}
      {loadingBalances ? (
        <div className="space-y-2">
          {[0, 1].map((i) => (
            <div key={i} className="h-[68px] animate-pulse rounded-2xl border border-[#00CDCD]/10 bg-[#FFFFFF]/40" />
          ))}
        </div>
      ) : balances.length === 0 ? (
        <div className="rounded-2xl border border-[#00CDCD]/10 bg-[#FFFFFF]/40 px-6 py-14 text-center">
          <p className="text-sm text-zinc-400">Nothing shielded yet.</p>
          <Link to="/deposit" className="coord-label mt-3 inline-block text-spectral/70 transition hover:text-spectral">
            deposit assets →
          </Link>
        </div>
      ) : (
        <div className="space-y-2">
          {balances.map((b) => {
            const notes = notesByAsset.get(b.asset) ?? []
            const isOpen = open === b.asset
            const meta = assetMeta(b.asset)
            return (
              <div key={b.asset} className="overflow-hidden rounded-2xl border border-[#00CDCD]/10 bg-[#FFFFFF]/40">
                <button
                  type="button"
                  onClick={() => setOpen(isOpen ? null : b.asset)}
                  aria-expanded={isOpen}
                  className="flex w-full items-center gap-3 p-4 text-left transition hover:bg-[#00CDCD]/[0.03]"
                >
                  <AssetAvatar code={b.asset} className="h-10 w-10" />
                  <div className="min-w-0">
                    <div className="font-display text-sm font-semibold text-[#000000]">{b.asset}</div>
                    <div className="truncate text-xs text-zinc-500">
                      {meta.name} · {notes.length} note{notes.length === 1 ? '' : 's'}
                    </div>
                  </div>
                  <div className="ml-auto text-right">
                    <div className="font-mono text-sm tabular-nums text-[#000000]">{revealed ? b.amount : MASK}</div>
                    <div className="text-xs text-zinc-500">{revealed ? `≈ ${formatUsd(b.usdEstimate)}` : ''}</div>
                  </div>
                  <ChevronDownIcon
                    className={cx('h-4 w-4 shrink-0 text-zinc-500 transition-transform', isOpen && 'rotate-180')}
                  />
                </button>

                {isOpen && (
                  <div className="border-t border-[#00CDCD]/8 px-4 py-3">
                    <div className="coord-label mb-2">notes</div>
                    {notes.length === 0 ? (
                      <p className="text-xs text-zinc-500">No spendable notes.</p>
                    ) : (
                      <ul className="space-y-1.5">
                        {notes.map((n) => (
                          <li key={n.commitment} className="flex items-center gap-3 text-xs">
                            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-spectral/50" />
                            <span className="text-zinc-400">{SOURCE_LABEL[n.source ?? 'received']}</span>
                            {n.leafIndex !== undefined && (
                              <span className="font-mono text-[11px] text-zinc-600">#{n.leafIndex}</span>
                            )}
                            <span className="ml-auto font-mono tabular-nums text-zinc-200">
                              {revealed ? `${formatAmount(noteHuman(n))} ${n.assetCode}` : MASK}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

export default PortfolioPage
