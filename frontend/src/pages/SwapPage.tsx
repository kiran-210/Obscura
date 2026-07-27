import { Act } from '../components/Act'
import { Swap } from '../components/Swap'
import { USE_MOCK } from '../lib/config'
import { matchingEnabled } from '../lib/matcher-client'

/** Act 03 honesty gate — an unobtrusive "i" next to the title that reveals the
 *  operator note on hover/focus. Shown live when no matcher operator is connected. */
function OperatorInfo() {
  return (
    <span className="group relative inline-flex">
      <button
        type="button"
        aria-label="About live matching"
        className="flex h-5 w-5 items-center justify-center rounded-full border border-spectral/40 font-mono text-[11px] leading-none text-spectral/70 transition hover:border-spectral hover:text-spectral"
      >
        i
      </button>
      <span
        role="tooltip"
        className="pointer-events-none absolute left-0 top-full z-30 mt-2 w-72 rounded-xl border border-[#efe9dc]/12 bg-[#1c1710]/95 px-4 py-3 text-xs leading-relaxed text-zinc-300 opacity-0 shadow-xl backdrop-blur-md transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100"
      >
        <span className="font-mono uppercase tracking-[0.14em] text-spectral/80">Operator</span> — orders place and cancel
        on-chain now; live matching connects when a matcher operator is running. Fills stay ZK-enforced at the midpoint,
        the operator only settles.
      </span>
    </span>
  )
}

export function SwapPage() {
  const showOperator = !USE_MOCK && !matchingEnabled()
  return (
    <Act
      no="Act 03"
      id="act-book"
      title="The sealed book"
      standfirst="A dark pool where orders stay sealed until they match at the midpoint — so there is nothing to front-run."
      coords={['Sealed orders', 'Midpoint match']}
      titleAside={showOperator ? <OperatorInfo /> : undefined}
      maxWidthClassName="max-w-6xl"
    >
      <Swap embedded />
    </Act>
  )
}

export default SwapPage
