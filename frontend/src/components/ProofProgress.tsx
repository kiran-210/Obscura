import type { ProofFlow } from '../hooks/useProofFlow'
import { cx } from '../lib/cx'
import { Button, CheckIcon, XIcon } from './ui'
import { ScrambleNumber } from './ScrambleNumber'

/**
 * Proof-as-theatre. The real in-browser UltraHonk proving dominates the wall-clock,
 * so instead of hiding it in a spinner we take over the whole canvas: the `subject`
 * (the amount in flight) dissolves through encrypted glyphs for exactly as long as
 * proving runs, then resolves once the transaction confirms. The step list stays as
 * the reduced-motion / screen-share fallback. The {flow, onClose} contract is
 * unchanged, so Pay / Swap callers are untouched; `subject` is optional.
 */
export function ProofProgress({
  flow,
  title = 'Generating proof',
  subject,
  onClose,
}: {
  flow: ProofFlow
  title?: string
  subject?: string
  onClose: () => void
}) {
  if (flow.status === 'idle') return null

  const done = flow.status === 'done'
  const errored = flow.status === 'error'
  const running = flow.status === 'running'
  const current = flow.steps[Math.min(flow.step, flow.steps.length - 1)]

  return (
    <div className="fixed inset-0 z-[60] flex flex-col items-center justify-center overflow-hidden bg-[#FFFFFF]/88 p-6 backdrop-blur-sm animate-fade-in">
      {/* the field intensifying — a slow warm pulse while proving */}
      {running && (
        <div
          className="pointer-events-none absolute left-1/2 top-1/2 h-[42rem] w-[42rem] -translate-x-1/2 -translate-y-1/2 animate-pulse rounded-full"
          style={{ background: 'radial-gradient(circle, rgba(79,62,34,0.55), transparent 62%)' }}
          aria-hidden
        />
      )}

      <div className="relative flex w-full max-w-lg flex-col items-center text-center">
        <div className="coord-label mb-8">zero-knowledge proof · stellar testnet</div>

        {subject ? (
          <ScrambleNumber
            value={subject}
            revealed={done}
            className={cx('display-hd text-4xl sm:text-5xl', errored && 'opacity-60')}
          />
        ) : (
          <div className="display-hd text-3xl sm:text-4xl">{done ? 'Confirmed' : errored ? 'Failed' : title}</div>
        )}

        <div className="mt-8 flex items-center gap-2.5">
          {done ? (
            <span className="flex items-center gap-2 text-sm font-medium text-emerald-300">
              <CheckIcon className="h-4 w-4" /> Confirmed on Stellar
            </span>
          ) : errored ? (
            <span className="flex items-center gap-2 text-sm font-medium text-red-300">
              <XIcon className="h-4 w-4" /> {flow.error ?? 'Proof failed'}
            </span>
          ) : (
            <span className="text-sm text-zinc-300">{current}</span>
          )}
        </div>

        {/* step ticks — the honest fallback */}
        <ol className="mt-6 flex items-center gap-2" aria-label="proof progress">
          {flow.steps.map((label, i) => {
            const state = errored && i === flow.step ? 'error' : done || i < flow.step ? 'done' : i === flow.step ? 'active' : 'pending'
            return (
              <li
                key={label}
                title={label}
                className={cx(
                  'h-1.5 rounded-full transition-all duration-300',
                  state === 'active' ? 'w-8 bg-spectral' : 'w-4',
                  state === 'done' && 'bg-patina-400/80',
                  state === 'pending' && 'bg-[#00CDCD]/15',
                  state === 'error' && 'w-8 bg-red-400',
                )}
              />
            )
          })}
        </ol>

        {(done || errored) && (
          <Button className="mt-9" variant={errored ? 'outline' : 'primary'} onClick={onClose}>
            {errored ? 'Close' : 'Done'}
          </Button>
        )}
      </div>
    </div>
  )
}
