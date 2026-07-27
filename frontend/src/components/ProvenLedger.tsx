import { loadNotes, type StoredNote } from '../lib/note-store'
import { truncateKey } from '../lib/format'

// A slim audit trail under the masthead: the shielded actions this device has
// proven, reconstructed read-only from the local note store. No terminal shell —
// just receipts, so the film leaves a verifiable paper trail.

const VERB: Record<NonNullable<StoredNote['source']>, string> = {
  deposit: 'DEPOSIT',
  received: 'RECEIVED',
  change: 'SENT',
}

function clock(ts: number): string {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function ProvenLedger() {
  const entries = loadNotes()
    .slice()
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 4)

  if (entries.length === 0) return null

  return (
    <ul className="mx-auto flex max-w-xl flex-wrap items-center justify-center gap-x-5 gap-y-2">
      {entries.map((n) => {
        const proven = Boolean(n.txHash)
        return (
          <li key={n.commitment} className="coord-label flex items-center gap-2 normal-case tracking-normal">
            <span className="tabular-nums text-spectral/45">{clock(n.createdAt)}</span>
            <span className="uppercase tracking-[0.14em] text-zinc-400">{VERB[n.source ?? 'received']}</span>
            <span className={proven ? 'text-emerald-400/80' : 'text-emerald-400/45'}>
              {proven ? '✓ proven' : '· sealed'}
            </span>
            {proven && <span className="tabular-nums text-spectral/40">{truncateKey(n.txHash!, 4, 4)}</span>}
          </li>
        )
      })}
    </ul>
  )
}

export default ProvenLedger
