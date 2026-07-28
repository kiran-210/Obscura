import { NavLink, Outlet } from 'react-router-dom'
import { useObscura } from '../hooks/useObscura'
import { useReveal } from '../hooks/useReveal'
import { clearAllNotes } from '../lib/note-store'
import { formatUsd } from '../lib/format'
import { cx } from '../lib/cx'
import { BrandCanvas } from './BrandCanvas'
import { ConnectWallet } from './ConnectWallet'
import { EyeGlyph, ObscuraMark } from './ui'
import { ScrambleNumber } from './ScrambleNumber'

const NAV = [
  ['Portfolio', '/portfolio'],
  ['Deposit / Withdraw', '/deposit'],
  ['Pay', '/pay'],
  ['Swap', '/swap'],
  ['Lend', '/lend'],
  ['Receive', '/receive'],
] as const

function ShieldedChip() {
  const { balances, loadingBalances } = useObscura()
  const { revealed, toggle } = useReveal()
  if (loadingBalances || balances.length === 0) return null
  const total = balances.reduce((sum, b) => sum + b.usdEstimate, 0)
  return (
    <div className="hidden items-center gap-2 md:flex">
      <span className="coord-label">shielded</span>
      <ScrambleNumber value={formatUsd(total)} revealed={revealed} className="font-mono text-sm text-[#062626]" />
      <button
        type="button"
        onClick={toggle}
        aria-label={revealed ? 'Hide balance' : 'Reveal balance'}
        className="text-spectral/50 transition hover:text-spectral"
      >
        <EyeGlyph off={!revealed} className="h-4 w-4" />
      </button>
    </div>
  )
}

function AppNav() {
  return (
    <header className="sticky top-0 z-40 border-b border-[#00CDCD]/8 bg-[#FFFFFF]/40 backdrop-blur-md">
      <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-4 px-5 py-3">
        <NavLink to="/app" className="flex items-center gap-2">
          <ObscuraMark className="h-5 w-5 text-spectral" />
          <span className="font-display text-sm font-semibold tracking-tight text-[#062626]">
            obscura <sup className="align-super font-mono text-[9px] tracking-[0.2em] text-spectral/60">ZK</sup>
          </span>
        </NavLink>
        <nav className="hidden items-center gap-5 font-mono text-[10px] uppercase tracking-[0.16em] md:flex">
          {NAV.map(([label, to]) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                cx('transition hover:text-[#062626]', isActive ? 'text-[#062626]' : 'text-spectral/70')
              }
            >
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="flex items-center gap-4">
          <ShieldedChip />
          <ConnectWallet />
        </div>
      </div>
    </header>
  )
}

function AppFooter() {
  const { refreshBalances } = useObscura()
  async function clearLocalData() {
    const ok = window.confirm(
      'Clear locally-cached shielded notes on this device?\n\nYour wallet stays connected — this only removes the notes/balance stored in this browser. Any on-chain funds tied to older notes stay on-chain.',
    )
    if (!ok) return
    clearAllNotes()
    await refreshBalances()
  }
  return (
    <footer className="cream-panel relative mt-auto">
      {/* Grain eases in over the top edge so it settles into the wash above
          instead of popping at the boundary. */}
      <div
        aria-hidden
        className="wr-grain absolute inset-0 opacity-40"
        style={{
          WebkitMaskImage: 'linear-gradient(to bottom, transparent, #000 4rem)',
          maskImage: 'linear-gradient(to bottom, transparent, #000 4rem)',
        }}
      />
      <div className="relative mx-auto flex w-full max-w-6xl flex-col gap-5 px-8 py-8 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <ObscuraMark className="h-7 w-7 shrink-0" style={{ filter: 'brightness(0)', opacity: 0.85 }} />
          <p className="max-w-[18rem] text-[12.5px] font-normal leading-relaxed text-[#00B8B8]/70">
            Private money on Stellar. Bridge in, hold, pay and trade — proven on-chain, never revealed.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 font-mono text-[11px] uppercase tracking-[0.16em] text-[#00B8B8]/55">
          <NavLink to="/faucet" className="transition hover:text-[#00B8B8]">
            Faucet
          </NavLink>
          <button type="button" onClick={() => void clearLocalData()} className="uppercase transition hover:text-[#00B8B8]">
            Clear data
          </button>
          <span className="text-[#00B8B8]/45">© Obscura 2026</span>
        </div>
      </div>
    </footer>
  )
}

/** Persistent app shell: the BrandCanvas world, router nav and cream footer wrap
 *  every routed surface (hub, bridge, pay, swap, receive, faucet). */
export function AppLayout() {
  return (
    <div className="relative flex min-h-screen flex-col">
      <BrandCanvas />
      <AppNav />
      <main className="relative flex-1">
        <Outlet />
      </main>
      {/* Long, eased cream wash so the fixed dark canvas dissolves into the footer
          over a tall multi-stop ramp — the section change reads as one surface.
          No grain of its own: the fixed canvas grain shows through the transparent
          top and is naturally covered as the wash turns opaque. */}
      <div
        aria-hidden
        className="pointer-events-none relative h-[30rem]"
        style={{
          background:
            'linear-gradient(to bottom, rgba(244,239,228,0) 0%, rgba(244,239,228,0) 20%, rgba(244,239,228,0.14) 42%, rgba(244,239,228,0.42) 62%, rgba(244,239,228,0.74) 78%, rgba(244,239,228,0.93) 91%, #f4efe4 100%)',
        }}
      />
      <AppFooter />
    </div>
  )
}

export default AppLayout
