/**
 * Lending: position dashboard, attestation countdown, and borrow/repay/withdraw forms.
 *
 * Every figure here is derived client-side from locally persisted secrets. The
 * chain publishes a position's collateral and deadline but NOT its debt, so debt,
 * health and LTV cannot be rendered from on-chain data even in principle — see
 * LENDING_SPEC §1.
 */
import { useEffect, useMemo, useState } from 'react'
import { useReveal } from '../hooks/useReveal'
import { cx } from '../lib/cx'
import {
  DEFAULT_RISK,
  buildPositionView,
  deadlineLabel,
  healthTone,
  ltvUtilisation,
  type PositionView,
  type RiskView,
} from '../lib/lending-view'
import { SOROBAN_RPC_URL } from '../lib/config'
import { loadPositions, type StoredPosition } from '../lib/note-store'
import { assetMeta } from '../lib/tokens'
import { AssetAvatar, Badge, Button, Card, Field, SectionHeading, TextInput } from './ui'

type Action = 'borrow' | 'repay' | 'withdraw'

const ONE_PRICE = 10_000_000n
const ONE_INDEX = 1_000_000_000n

/** Health bar: 1.0 is the liquidation boundary, so the scale is anchored there. */
function HealthBar({ health }: { health: number }) {
  const tone = healthTone(health)
  // Map [1.0, 2.5] onto the bar; anything above is simply full.
  const pct = Number.isFinite(health) ? Math.min(100, Math.max(0, ((health - 1) / 1.5) * 100)) : 100
  return (
    <div className="space-y-1">
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-[#efe9dc]/10">
        <div
          className={cx(
            'h-full rounded-full transition-[width] duration-500',
            tone === 'good' && 'bg-emerald-400/80',
            tone === 'warn' && 'bg-amber-400/80',
            tone === 'danger' && 'bg-rose-500/90',
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="flex justify-between font-mono text-[10px] uppercase tracking-[0.14em] text-zinc-500">
        <span>liquidation</span>
        <span>safe</span>
      </div>
    </div>
  )
}

/**
 * The attestation countdown. This is the mechanism that keeps a position alive:
 * miss it and the whole collateral is seizable by anyone, and the position freezes
 * first — it cannot be repaid out of trouble afterwards.
 */
function DeadlineChip({ view }: { view: PositionView }) {
  const d = view.deadline
  if (!d) {
    return <Badge tone="neutral">deadline unknown</Badge>
  }
  const tone =
    d.urgency === 'expired' || d.urgency === 'critical'
      ? 'danger'
      : d.urgency === 'due-soon'
        ? 'warn'
        : 'neutral'
  return <Badge tone={tone}>attest · {deadlineLabel(d)}</Badge>
}

function PositionCard({
  view,
  risk,
  busy,
  onAttest,
  onAct,
}: {
  view: PositionView
  risk: RiskView
  busy: string | null
  onAttest: (v: PositionView) => void
  onAct: (v: PositionView, action: Action) => void
}) {
  const { revealed } = useReveal()
  const hide = (n: number, dp = 4) => (revealed ? n.toFixed(dp) : '••••')
  const seizable = view.deadline?.seizable ?? false

  return (
    <Card className="space-y-4 p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <AssetAvatar code={view.collateralCode} />
          <div>
            <div className="font-mono text-sm text-zinc-100">
              {view.collateralCode} <span className="text-zinc-500">collateral</span>
            </div>
            <div className="font-mono text-[11px] text-zinc-500">
              borrowing {view.debtCode}
            </div>
          </div>
        </div>
        <DeadlineChip view={view} />
      </div>

      {seizable && (
        <p className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs leading-relaxed text-rose-200">
          This position missed its attestation deadline. Anyone may now seize the full
          collateral, and it can no longer be repaid or topped up.
        </p>
      )}

      <div className="grid grid-cols-2 gap-4 text-sm">
        <div>
          <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-zinc-500">
            Collateral <span className="text-zinc-600">· public</span>
          </div>
          <div className="font-mono tabular-nums text-zinc-100">
            {view.collateralAmount.toFixed(4)} {view.collateralCode}
          </div>
        </div>
        <div>
          <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-zinc-500">
            Debt <span className="text-spectral/70">· private</span>
          </div>
          <div className="font-mono tabular-nums text-zinc-100">
            {hide(view.debtAmount)} {view.debtCode}
          </div>
        </div>
      </div>

      <div className="space-y-2">
        <div className="flex items-baseline justify-between">
          <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-zinc-500">
            Health factor
          </span>
          <span
            className={cx(
              'font-mono tabular-nums text-sm',
              healthTone(view.health) === 'good' && 'text-emerald-300',
              healthTone(view.health) === 'warn' && 'text-amber-300',
              healthTone(view.health) === 'danger' && 'text-rose-300',
            )}
          >
            {Number.isFinite(view.health) ? view.health.toFixed(2) : '∞'}
          </span>
        </div>
        <HealthBar health={view.health} />
        <div className="flex justify-between font-mono text-[10px] text-zinc-500">
          <span>
            LTV {revealed ? `${view.ltvPercent.toFixed(1)}%` : '••'} / {risk.maxLtvBps / 100}%
          </span>
          <span>{ltvUtilisation(view, risk).toFixed(0)}% of ceiling</span>
        </div>
      </div>

      <div className="flex flex-wrap gap-2 pt-1">
        <Button
          className="flex-1"
          disabled={seizable || busy !== null}
          onClick={() => onAttest(view)}
        >
          {busy === `attest:${view.stored.commitment}` ? 'Proving…' : 'Attest solvency'}
        </Button>
        <Button className="flex-1" disabled={seizable || busy !== null} onClick={() => onAct(view, 'borrow')}>
          Borrow
        </Button>
        <Button className="flex-1" disabled={seizable || busy !== null} onClick={() => onAct(view, 'repay')}>
          Repay
        </Button>
        <Button
          className="flex-1"
          disabled={seizable || busy !== null}
          onClick={() => onAct(view, 'withdraw')}
        >
          Withdraw
        </Button>
      </div>
    </Card>
  )
}

/** Borrow / repay / withdraw form. Mirrors the deposit/withdraw form patterns. */
function ActionForm({
  view,
  action,
  risk,
  busy,
  onSubmit,
  onCancel,
}: {
  view: PositionView
  action: Action
  risk: RiskView
  busy: string | null
  onSubmit: (amount: string) => void
  onCancel: () => void
}) {
  const [amount, setAmount] = useState('')
  const meta = assetMeta(action === 'withdraw' ? view.collateralCode : view.debtCode)
  const value = Number(amount || '0')

  const max =
    action === 'borrow'
      ? view.borrowable
      : action === 'repay'
        ? view.debtAmount
        : view.collateralAmount

  const label =
    action === 'borrow'
      ? `Borrow (${view.debtCode})`
      : action === 'repay'
        ? `Repay (${view.debtCode})`
        : `Withdraw collateral (${view.collateralCode})`

  const tooMuch = value > max + 1e-12
  const invalid = !(value > 0) || tooMuch

  return (
    <Card className="space-y-4 p-5">
      <SectionHeading title={label} />
      <Field label={`Amount (${meta.code ?? ''})`}>
        <TextInput
          mono
          inputMode="decimal"
          placeholder="0.00"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
      </Field>

      <div className="flex items-center justify-between text-xs">
        <span className="text-zinc-500">Max</span>
        <button
          type="button"
          className="font-mono tabular-nums text-spectral/80 transition hover:text-spectral"
          onClick={() => setAmount(max.toFixed(Math.min(7, meta.decimals)))}
        >
          {max.toFixed(4)}
        </button>
      </div>

      {action === 'borrow' && (
        <p className="text-xs leading-relaxed text-zinc-500">
          Borrow amounts are public on-chain — a pooled protocol cannot track solvency
          without them. Your total debt stays off-chain.
        </p>
      )}
      {action === 'withdraw' && (
        <p className="text-xs leading-relaxed text-zinc-500">
          Solvency is re-checked on the collateral you leave behind, at the{' '}
          {risk.maxLtvBps / 100}% ceiling.
        </p>
      )}
      {tooMuch && (
        <p className="text-xs text-rose-300">Exceeds the maximum for this action.</p>
      )}

      <div className="flex gap-2">
        <Button className="flex-1" disabled={invalid || busy !== null} onClick={() => onSubmit(amount)}>
          {busy ? 'Proving…' : 'Confirm'}
        </Button>
        <Button className="flex-1" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </Card>
  )
}

export function Lend({ embedded = false }: { embedded?: boolean }) {
  const [stored, setStored] = useState<StoredPosition[]>([])
  const [ledger, setLedger] = useState<number | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [active, setActive] = useState<{ view: PositionView; action: Action } | null>(null)
  const risk = DEFAULT_RISK
  // No action can be in flight until the verifiers are deployed; the prop is kept
  // so the plumbing is ready once they are.
  const busy: string | null = null

  useEffect(() => {
    setStored(loadPositions().filter((p) => p.status === 'open'))
  }, [])

  // Poll the ledger so the attestation countdown is live. Deadlines are measured in
  // ledgers, not wall-clock, so a stale reading would understate the urgency.
  useEffect(() => {
    let cancelled = false
    const poll = async () => {
      try {
        const res = await fetch(SOROBAN_RPC_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getLatestLedger' }),
        })
        const json = (await res.json()) as { result?: { sequence?: number } }
        if (!cancelled && typeof json.result?.sequence === 'number') {
          setLedger(json.result.sequence)
        }
      } catch {
        // Best-effort: a transient RPC failure just leaves the countdown unknown.
      }
    }
    void poll()
    const handle = setInterval(() => void poll(), 30_000)
    return () => {
      cancelled = true
      clearInterval(handle)
    }
  }, [])

  // Prices and the borrow index come from the contract in a live deployment. Until
  // the lending verifiers are deployed there is nothing to read, so these are unit
  // values — which makes debt figures equal to their scaled form.
  const views = useMemo(
    () =>
      stored.map((s) =>
        buildPositionView({
          stored: s,
          collateralPrice: ONE_PRICE,
          debtPrice: ONE_PRICE,
          borrowIndex: ONE_INDEX,
          risk,
          currentLedger: ledger,
        }),
      ),
    [stored, ledger, risk],
  )

  const atRisk = views.filter(
    (v) => v.deadline && (v.deadline.urgency === 'critical' || v.deadline.urgency === 'expired'),
  )

  function notImplemented(what: string) {
    setMsg(
      `${what} needs the lending verifiers deployed on-chain first — the circuits and contract are ready, but no verifier contract exists to check the proof yet.`,
    )
  }

  return (
    <div className={cx('space-y-6', !embedded && 'mx-auto max-w-3xl px-4 py-10')}>
      {atRisk.length > 0 && (
        <div className="rounded-xl border border-amber-400/30 bg-amber-400/10 px-4 py-3 text-sm text-amber-100">
          <span className="font-mono uppercase tracking-[0.14em]">Attention</span> —{' '}
          {atRisk.length} position{atRisk.length > 1 ? 's need' : ' needs'} a solvency
          attestation soon. Missing the deadline forfeits the entire collateral.
        </div>
      )}

      {msg && (
        <div className="rounded-xl border border-[#efe9dc]/12 bg-[#1c1710]/70 px-4 py-3 text-sm leading-relaxed text-zinc-300">
          {msg}
        </div>
      )}

      {views.length === 0 ? (
        <Card className="space-y-3 p-6 text-center">
          <p className="text-sm text-zinc-300">No lending positions yet.</p>
          <p className="text-xs leading-relaxed text-zinc-500">
            Open one by locking a shielded note as collateral. Your collateral is public
            so the position can be liquidated trustlessly; how much you borrow against it
            stays private.
          </p>
          <Button onClick={() => notImplemented('Opening a position')}>Open a position</Button>
        </Card>
      ) : active ? (
        <ActionForm
          view={active.view}
          action={active.action}
          risk={risk}
          busy={busy}
          onCancel={() => setActive(null)}
          onSubmit={() => {
            setActive(null)
            notImplemented('This action')
          }}
        />
      ) : (
        <div className="space-y-4">
          {views.map((v) => (
            <PositionCard
              key={v.stored.commitment}
              view={v}
              risk={risk}
              busy={busy}
              onAttest={() => notImplemented('Attesting solvency')}
              onAct={(view, action) => setActive({ view, action })}
            />
          ))}
        </div>
      )}
    </div>
  )
}

export default Lend
