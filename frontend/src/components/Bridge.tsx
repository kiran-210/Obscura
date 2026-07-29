import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useObscura } from '../hooks/useObscura'
import { useWallet } from '../hooks/useWallet'
import { loadNotes, type StoredNote } from '../lib/note-store'
import { baseUnitsToNumber } from '../lib/real-sdk'
import { formatAmount, isPositiveAmount, isValidStellarAddress, truncateKey } from '../lib/format'
import { USE_MOCK } from '../lib/config'
import {
  assetMeta,
  CURATED_TOKENS,
  depositableTokens,
  resolveCustomToken,
  type TokenMeta,
} from '../lib/tokens'
import { cx } from '../lib/cx'
import { Button, Card, CheckIcon, PageIntro, Spinner, TextInput, XIcon } from './ui'
import { CoinBadge } from './BrandIcons'

// ---------------------------------------------------------------------------
// Endpoints & routing
//
// The Deposit surface moves value between Stellar and the Obscura shielded pool,
// in either direction:
//   • deposit  = Stellar → Obscura   (fund the pool)
//   • withdraw = Obscura → Stellar   (redeem back out)
// Both endpoints are fixed — Stellar is the only supported Layer 1.
// ---------------------------------------------------------------------------

type Endpoint = 'stellar' | 'obscura'
type Direction = 'deposit' | 'withdraw'

const ENDPOINT_META: Record<Endpoint, { label: string; sub: string; icon: string }> = {
  stellar: { label: 'Stellar', sub: 'Testnet', icon: 'stellar' },
  obscura: { label: 'Obscura', sub: 'Shielded pool', icon: 'obscura' },
}

const STEP_LABELS: Record<Direction, string[]> = {
  deposit: ['Submit deposit on Stellar', 'Shielded note minted'],
  withdraw: ['Prove ownership (ZK)', 'Released on Stellar'],
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const stellarTxUrl = (hash: string) => `https://stellar.expert/explorer/testnet/tx/${hash}`

/** A stored note's amount as a human string (base units -> decimal). */
function noteHuman(n: StoredNote): string {
  const decimals = n.decimals ?? assetMeta(n.assetCode).decimals
  return formatAmount(baseUnitsToNumber(BigInt(n.amount), decimals))
}

type FlowStatus = 'idle' | 'running' | 'done' | 'error'
type StepState = 'pending' | 'active' | 'done' | 'error'

/** Progress ping for a host surface to dramatize the crossing (Act 01's droplet). */
export interface BridgeProgress {
  step: number
  total: number
  status: FlowStatus
}

function StepRow({ label, state, detail }: { label: string; state: StepState; detail?: ReactNode }) {
  return (
    <li className="flex items-start gap-3">
      <span
        className={cx(
          'mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border',
          state === 'done' && 'border-patina-500/40 bg-patina-500/15 text-patina-300',
          state === 'active' && 'border-spectral/50 bg-spectral/15 text-spectral-soft',
          state === 'pending' && 'border-ink-600 bg-ink-800 text-zinc-600',
          state === 'error' && 'border-red-500/50 bg-red-500/15 text-red-300',
        )}
      >
        {state === 'done' && <CheckIcon className="h-3.5 w-3.5" />}
        {state === 'active' && <Spinner className="h-3.5 w-3.5" />}
        {state === 'error' && <XIcon className="h-3.5 w-3.5" />}
        {state === 'pending' && <span className="h-1.5 w-1.5 rounded-full bg-current" />}
      </span>
      <div className="min-w-0">
        <div
          className={cx(
            'text-sm',
            state === 'pending' ? 'text-zinc-600' : state === 'error' ? 'text-red-300' : 'text-zinc-200',
          )}
        >
          {label}
        </div>
        {detail && <div className="mt-0.5 text-xs text-zinc-500">{detail}</div>}
      </div>
    </li>
  )
}

function stepStateFor(index: number, step: number, status: FlowStatus): StepState {
  if (status === 'error' && index === step) return 'error'
  if (status === 'done') return 'done'
  if (index < step) return 'done'
  if (index === step && status === 'running') return 'active'
  return 'pending'
}

function TxLink({ href, label }: { href: string; label: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="font-mono text-spectral-soft underline-offset-2 hover:underline"
    >
      {label} ↗
    </a>
  )
}

/** Static chain identity — both endpoints are fixed (Stellar ↔ Obscura). */
function ChainIdentity({ endpoint }: { endpoint: Endpoint }) {
  const m = ENDPOINT_META[endpoint]
  return (
    <span className="flex items-center gap-2 px-2 py-1 text-sm font-medium text-zinc-200">
      <CoinBadge name={m.icon} size="sm" />
      {m.label}
      <span className="text-zinc-600">· {m.sub}</span>
    </span>
  )
}

/** A From / To endpoint panel (identity row + its asset/amount content). */
function EndpointPanel({
  role,
  identity,
  children,
}: {
  role: 'From' | 'To'
  identity: ReactNode
  children: ReactNode
}) {
  return (
    <div className="rounded-2xl border border-ink-700 bg-ink-900/50 p-4">
      <div className="mb-3 flex items-center justify-between">
        <span className="text-xs font-medium text-zinc-400">{role}</span>
        <div className="flex items-center gap-2">{identity}</div>
      </div>
      {children}
    </div>
  )
}

/** A read-only token chip (icon + code). */
function TokenChip({ code }: { code: string }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-2 rounded-xl border border-ink-700 bg-ink-850 px-3 py-2 text-sm font-semibold text-zinc-100">
      <CoinBadge name={code} size="sm" />
      {code}
    </span>
  )
}

// ---------------------------------------------------------------------------
// Deposit / withdraw widget
// ---------------------------------------------------------------------------

export function Bridge({ embedded, onProgress }: { embedded?: boolean; onProgress?: (p: BridgeProgress) => void } = {}) {
  const { sdk, refreshBalances, identityReady } = useObscura()
  const stellar = useWallet()

  const [direction, setDirection] = useState<Direction>('deposit')
  const from: Endpoint = direction === 'deposit' ? 'stellar' : 'obscura'
  const to: Endpoint = direction === 'deposit' ? 'obscura' : 'stellar'

  // Deposit token: any curated token (with a SAC here) or a custom SAC address.
  const [depositToken, setDepositToken] = useState<TokenMeta>(() => depositableTokens()[0] ?? CURATED_TOKENS[0]!)
  const [customMode, setCustomMode] = useState(false)
  const [customSac, setCustomSac] = useState('')
  const [customError, setCustomError] = useState<string | null>(null)
  const [resolvingCustom, setResolvingCustom] = useState(false)

  // Resolve a custom token from its SAC address (decimals + symbol) as it's typed.
  useEffect(() => {
    if (!customMode) return
    const sac = customSac.trim()
    if (!/^C[A-Z2-7]{55}$/.test(sac)) return
    let cancelled = false
    setResolvingCustom(true)
    setCustomError(null)
    resolveCustomToken(sac)
      .then((t) => {
        if (!cancelled) setDepositToken(t)
      })
      .catch((e) => {
        if (!cancelled) setCustomError(e instanceof Error ? e.message : 'Could not resolve token.')
      })
      .finally(() => {
        if (!cancelled) setResolvingCustom(false)
      })
    return () => {
      cancelled = true
    }
  }, [customMode, customSac])

  // Withdraw operates on individual notes (the circuit releases a full note, no change),
  // so the user picks a note rather than typing an amount.
  const [withdrawNote, setWithdrawNote] = useState('') // selected note commitment
  const withdrawableNotes =
    direction === 'withdraw'
      ? loadNotes().filter((n) => !n.spent && n.leafIndex !== undefined)
      : []
  const selectedNote = withdrawableNotes.find((n) => n.commitment === withdrawNote) ?? withdrawableNotes[0] ?? null
  const withdrawAmountHuman = selectedNote ? noteHuman(selectedNote) : ''

  const [amount, setAmount] = useState('')
  const [recipient, setRecipient] = useState('') // withdraw only: L1 destination

  const [status, setStatus] = useState<FlowStatus>('idle')
  const [step, setStep] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [stellarHash, setStellarHash] = useState<string | null>(null)
  const cancelledRef = useRef(false)
  useEffect(() => () => void (cancelledRef.current = true), [])

  const running = status === 'running'
  const amountValid = isPositiveAmount(amount)

  // Token codes shown in the From / To panels.
  const depositCode = depositToken.code
  const toCode = direction === 'deposit' ? depositCode : selectedNote?.assetCode ?? 'XLM'

  const steps = STEP_LABELS[direction]

  // Additive: let a host surface (Act 01) mirror the crossing. Default no-op — the
  // live deposit + withdraw paths are byte-for-byte unchanged.
  useEffect(() => {
    onProgress?.({ step, total: steps.length, status })
  }, [step, status, steps.length, onProgress])

  function reset() {
    setStatus('idle')
    setStep(0)
    setError(null)
    setStellarHash(null)
    setAmount('')
    setRecipient('')
  }

  // Withdraw defaults to the connected wallet's own Stellar account.
  function defaultRecipient(dir: Direction): string {
    return dir === 'withdraw' && stellar.address ? stellar.address : ''
  }

  function flip() {
    if (running) return
    const next: Direction = direction === 'deposit' ? 'withdraw' : 'deposit'
    setDirection(next)
    reset()
    setRecipient(defaultRecipient(next))
  }

  // --- deposit / withdraw flows --------------------------------------------

  /** Stellar → Obscura: a native single-tx deposit of the selected token (LIVE). */
  async function runStellarIn() {
    setStep(0)
    const { hash } = await sdk.deposit({
      asset: depositToken.code,
      amount,
      sac: depositToken.sac,
      decimals: depositToken.decimals,
      native: depositToken.native,
    })
    setStellarHash(hash)
    setStep(1)
    await refreshBalances()
  }

  /** Obscura → Stellar: an in-browser ZK withdraw of one note to a classic Stellar account. */
  async function runStellarOut() {
    if (!selectedNote) throw new Error('No shielded note to withdraw.')
    setStep(0)
    const { hash } = await sdk.withdraw({
      asset: selectedNote.assetCode,
      amount: noteHuman(selectedNote),
      recipient,
      commitment: selectedNote.commitment,
    })
    setStellarHash(hash)
    setStep(1)
    await refreshBalances()
  }

  async function run() {
    setError(null); setStellarHash(null); setStatus('running'); setStep(0)
    cancelledRef.current = false
    try {
      if (direction === 'deposit') await runStellarIn()
      else await runStellarOut()
      setStatus('done')
    } catch (err) {
      if (cancelledRef.current) return
      setError(err instanceof Error ? err.message : 'Transfer failed.')
      setStatus('error')
    }
  }

  // --- context-aware primary action ----------------------------------------

  const action: { label: string; onClick: () => void; disabled?: boolean; loading?: boolean } = (() => {
    if (running) return { label: 'Working…', onClick: () => {}, loading: true }
    // Every shielded note is owned by the wallet-derived identity, so a connected
    // Stellar wallet (and its derived key) is required for both directions.
    if (!USE_MOCK && stellar.status !== 'connected')
      return { label: 'Connect Stellar wallet', onClick: () => void stellar.connect() }
    if (!USE_MOCK && !identityReady)
      return { label: 'Preparing shielded identity…', onClick: () => {}, disabled: true }
    if (direction === 'deposit') {
      if (resolvingCustom) return { label: 'Resolving token…', onClick: () => {}, disabled: true }
      if (!depositToken.sac)
        return { label: `${depositToken.code} not available here`, onClick: () => {}, disabled: true }
      if (!amountValid) return { label: 'Enter an amount', onClick: () => {}, disabled: true }
      return { label: `Deposit ${depositToken.code}`, onClick: () => void run() }
    }
    // withdraw
    if (!selectedNote) return { label: 'No shielded note to withdraw', onClick: () => {}, disabled: true }
    if (!isValidStellarAddress(recipient))
      return { label: 'Enter recipient address', onClick: () => {}, disabled: true }
    return { label: 'Withdraw', onClick: () => void run() }
  })()

  const fromIdentity = <ChainIdentity endpoint={from} />
  const toIdentity = <ChainIdentity endpoint={to} />

  const showTracker = status !== 'idle'

  function stepDetail(i: number): ReactNode {
    if (stellarHash && !USE_MOCK) {
      const last = steps.length - 1
      if ((direction === 'deposit' && i === 0) || (direction === 'withdraw' && i === last)) {
        return <TxLink href={stellarTxUrl(stellarHash)} label={truncateKey(stellarHash, 8, 6)} />
      }
    }
    return undefined
  }

  return (
    <div className={embedded ? 'space-y-5' : 'mx-auto max-w-xl space-y-6'}>
      {!embedded && (
        <PageIntro
          title="Deposit"
          subtitle="Move assets between Stellar and the Obscura shielded pool — deposit in, or withdraw back out."
        />
      )}

      <Card className="p-5">
        {/* From */}
        <EndpointPanel role="From" identity={fromIdentity}>
          {direction === 'deposit' ? (
            <>
              <div className="flex items-center gap-3">
                <input
                  className="input input-mono flex-1 border-none bg-transparent px-0 text-2xl focus:ring-0"
                  inputMode="decimal"
                  placeholder="0.00"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  disabled={running}
                />
                <div className="inline-flex shrink-0 items-center gap-2 rounded-xl border border-ink-700 bg-ink-850 px-2.5 py-2">
                  <CoinBadge name={customMode ? depositToken.icon : depositCode} size="sm" />
                  <select
                    className="cursor-pointer appearance-none bg-transparent text-sm font-semibold text-zinc-100 focus:outline-none"
                    value={customMode ? '__custom__' : depositToken.code}
                    onChange={(e) => {
                      const v = e.target.value
                      if (v === '__custom__') {
                        setCustomMode(true)
                        setCustomError(null)
                      } else {
                        setCustomMode(false)
                        setCustomSac('')
                        setCustomError(null)
                        const t = CURATED_TOKENS.find((c) => c.code === v)
                        if (t) setDepositToken(t)
                      }
                    }}
                    disabled={running}
                  >
                    {CURATED_TOKENS.map((t) => (
                      <option key={t.code} value={t.code} className="bg-ink-850">
                        {t.code}
                        {t.sac ? '' : ' · n/a here'}
                      </option>
                    ))}
                    <option value="__custom__" className="bg-ink-850">
                      Custom…
                    </option>
                  </select>
                </div>
              </div>
              {customMode && (
                <div className="mt-2 space-y-1">
                  <TextInput
                    mono
                    placeholder="Token SAC address · C…"
                    value={customSac}
                    onChange={(e) => setCustomSac(e.target.value)}
                    disabled={running}
                  />
                  {resolvingCustom && <p className="text-xs text-zinc-500">Resolving token…</p>}
                  {customError && <p className="text-xs text-red-300">{customError}</p>}
                  {!resolvingCustom && !customError && depositToken.sac === customSac.trim() && (
                    <p className="text-xs text-patina-300">
                      Found {depositToken.code} · {depositToken.decimals} decimals
                    </p>
                  )}
                </div>
              )}
              {!customMode && depositToken.faucet && (
                <p className="mt-2 text-xs text-zinc-500">
                  Need test {depositToken.code}? Mint some from the{' '}
                  <a href="#/faucet" className="text-spectral-soft hover:underline">
                    faucet
                  </a>
                  .
                </p>
              )}
            </>
          ) : withdrawableNotes.length > 0 ? (
            <>
              <div className="flex items-center gap-3">
                <div className="input input-mono flex-1 border-none bg-transparent px-0 text-2xl text-zinc-100">
                  {withdrawAmountHuman || '0.00'}
                </div>
                <div className="inline-flex shrink-0 items-center gap-2 rounded-xl border border-ink-700 bg-ink-850 px-2.5 py-2">
                  <CoinBadge name={selectedNote?.assetCode ?? '—'} size="sm" />
                  <select
                    className="cursor-pointer appearance-none bg-transparent text-sm font-semibold text-zinc-100 focus:outline-none"
                    value={selectedNote?.commitment ?? ''}
                    onChange={(e) => setWithdrawNote(e.target.value)}
                    disabled={running}
                  >
                    {withdrawableNotes.map((n) => (
                      <option key={n.commitment} value={n.commitment} className="bg-ink-850">
                        {noteHuman(n)} {n.assetCode}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="mt-2 text-xs text-zinc-500">
                Withdraw sends one full shielded note · {withdrawableNotes.length} available
              </div>
            </>
          ) : (
            <div className="flex items-center gap-3">
              <div className="input input-mono flex-1 border-none bg-transparent px-0 text-2xl text-zinc-600">0.00</div>
              <TokenChip code="—" />
            </div>
          )}
        </EndpointPanel>

        {/* Flip direction */}
        <div className="relative flex h-2 justify-center">
          <button
            type="button"
            onClick={flip}
            disabled={running}
            aria-label="Switch direction"
            className="absolute -top-3 flex h-9 w-9 items-center justify-center rounded-xl border border-ink-700 bg-ink-850 text-zinc-300 transition hover:border-spectral/50 hover:text-spectral-soft disabled:opacity-50"
          >
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none">
              <path d="M7 4v16m0 0 3-3m-3 3-3-3M17 20V4m0 0 3 3m-3-3-3 3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>

        {/* To */}
        <EndpointPanel role="To" identity={toIdentity}>
          <div className="flex items-center gap-3">
            <div className="input input-mono flex-1 border-none bg-transparent px-0 text-2xl text-zinc-400">
              {direction === 'withdraw' ? withdrawAmountHuman || '0.00' : amountValid ? amount : '0.00'}
            </div>
            <TokenChip code={String(toCode)} />
          </div>
          {direction === 'withdraw' && (
            <TextInput
              mono
              className="mt-3"
              placeholder="Stellar recipient · G…"
              value={recipient}
              onChange={(e) => setRecipient(e.target.value)}
              disabled={running}
            />
          )}
        </EndpointPanel>

        <Button className="mt-5 w-full" onClick={action.onClick} disabled={action.disabled} loading={action.loading}>
          {action.label}
        </Button>

        <p className="mt-3 text-center text-xs text-zinc-500">
          {direction === 'deposit'
            ? 'Funds enter the shielded pool directly on Stellar Testnet.'
            : 'Redeems a shielded note back to a classic Stellar account.'}
        </p>
      </Card>

      {/* Progress */}
      {showTracker && (
        <Card className="p-5 animate-fade-in">
          <div className="mb-4 flex items-center justify-between">
            <span className="panel-title">{direction === 'deposit' ? 'Depositing' : 'Withdrawing'}</span>
            <span className="font-mono text-xs text-zinc-500">
              {ENDPOINT_META[from].label} → {ENDPOINT_META[to].label}
            </span>
          </div>
          <ol className="space-y-4">
            {steps.map((label, i) => (
              <StepRow key={label} label={label} state={stepStateFor(i, step, status)} detail={stepDetail(i)} />
            ))}
          </ol>
          {status === 'error' && error && <p className="mt-4 text-sm text-red-300">{error}</p>}
          {status === 'done' && (
            <p className="mt-4 flex items-center gap-2 text-sm text-emerald-300">
              <CheckIcon className="h-4 w-4" />
              {direction === 'deposit' ? (
                <>
                  Shielded {String(toCode)} now visible in{' '}
                  <Link to="/portfolio" className="underline underline-offset-2 transition hover:text-emerald-200">
                    Portfolio
                  </Link>
                  .
                </>
              ) : (
                <>Released to {truncateKey(recipient, 6, 6)} on Stellar.</>
              )}
            </p>
          )}
          {(status === 'done' || status === 'error') && (
            <Button variant="outline" className="mt-5 w-full" onClick={reset}>
              {direction === 'deposit' ? 'Deposit again' : 'Withdraw again'}
            </Button>
          )}
        </Card>
      )}
    </div>
  )
}
