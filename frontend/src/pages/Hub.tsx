import { Link } from 'react-router-dom'
import { useObscura } from '../hooks/useObscura'
import { useReveal } from '../hooks/useReveal'
import { formatUsd } from '../lib/format'
import { cx } from '../lib/cx'
import { ScrambleNumber } from '../components/ScrambleNumber'
import { ProvenLedger } from '../components/ProvenLedger'
import { CoinBadge } from '../components/BrandIcons'
import { EyeGlyph } from '../components/ui'

const MASK = '######'

const MODULES = [
  ['Deposit / Withdraw', '/deposit', 'Cross the veil', 'Move value in and out of the shielded pool — proven, not trusted.'],
  ['Pay', '/pay', 'Send into the dark', 'A 2-in / 2-out shielded transfer. Amounts and parties stay hidden.'],
  ['Swap', '/swap', 'The sealed book', 'A dark pool where orders match at the midpoint — nothing to front-run.'],
  ['Receive', '/receive', 'Your cipher', 'Share your receive code to be paid privately.'],
] as const

export function Hub() {
  const { balances, loadingBalances } = useObscura()
  const { revealed, toggle } = useReveal()
  const total = balances.reduce((sum, b) => sum + b.usdEstimate, 0)

  return (
    <div className="mx-auto w-full max-w-6xl px-5 pb-16 pt-12">
      <section className="flex flex-col items-center pb-12 text-center">
        <div className="flex items-center gap-3">
          <span className="coord-label">shielded · [ poseidon · merkle ]</span>
          <button
            type="button"
            onClick={toggle}
            aria-label={revealed ? 'Hide balance' : 'Reveal balance'}
            className="text-spectral/50 transition hover:text-spectral"
          >
            <EyeGlyph off={!revealed} className="h-4 w-4" />
          </button>
        </div>

        <div className="mt-6 flex min-h-[4.5rem] items-center" style={{ textShadow: '0 2px 34px rgba(20,16,9,0.55)' }}>
          {loadingBalances ? (
            <span className="display-hd text-5xl text-spectral/25">••••••</span>
          ) : (
            <ScrambleNumber value={formatUsd(total)} revealed={revealed} className="display-hd text-[clamp(2.6rem,9vw,5rem)]" />
          )}
        </div>
        <div className="coord-label mt-3">{revealed ? 'your shielded total · usd' : 'private by default'}</div>

        {!loadingBalances && balances.length > 0 && (
          <div className="mt-8 flex flex-wrap items-center justify-center gap-x-6 gap-y-3">
            {balances.map((b) => (
              <span key={b.asset} className="flex items-center gap-2">
                <CoinBadge name={b.asset} size="sm" />
                <span className="font-mono text-sm text-zinc-200">{b.asset}</span>
                <span
                  className={cx(
                    'font-mono text-sm tabular-nums',
                    revealed ? 'text-zinc-100' : 'wr-scramble-glyph wr-scramble-char',
                  )}
                >
                  {revealed ? b.amount : MASK}
                </span>
              </span>
            ))}
          </div>
        )}

        {!loadingBalances && balances.length === 0 && (
          <Link to="/deposit" className="coord-label mt-8 text-spectral/70 transition hover:text-spectral">
            nothing shielded yet — cross the veil →
          </Link>
        )}

        <div className="mt-10 w-full">
          <ProvenLedger />
        </div>
      </section>

      <div className="grid gap-4 sm:grid-cols-2">
        {MODULES.map(([label, to, title, desc]) => (
          <Link
            key={to}
            to={to}
            className="group rounded-2xl border border-[#efe9dc]/10 bg-[#1c1710]/40 p-6 backdrop-blur-sm transition hover:border-spectral/40"
          >
            <div className="coord-label mb-2">{label}</div>
            <h3 className="display-hd text-xl text-[#f6f1e6]">{title}</h3>
            <p className="mt-2 text-sm leading-relaxed text-zinc-400">{desc}</p>
            <span className="coord-label mt-4 inline-block text-spectral/70 transition group-hover:text-spectral">enter →</span>
          </Link>
        ))}
      </div>
    </div>
  )
}

export default Hub
