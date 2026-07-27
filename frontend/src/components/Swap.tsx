import { useEffect, useRef, useState } from 'react'
import { useWraith } from '../hooks/useWraith'
import { useProofFlow } from '../hooks/useProofFlow'
import { usePriceQuote } from '../hooks/usePriceQuote'
import { formatAmount, formatPrice, parseAmount } from '../lib/format'
import type { OpenOrder, OrderSide } from '../lib/wraith-sdk'
import { TOKEN_OPTIONS } from '../lib/tokens'
import { cx } from '../lib/cx'
import {
  Badge,
  Button,
  Card,
  ChartIcon,
  ChevronDownIcon,
  Field,
  PageIntro,
  SectionHeading,
  Select,
  TextInput,
  ToggleGroup,
  XIcon,
} from './ui'
import { ProofProgress } from './ProofProgress'
import { PriceChart } from './PriceChart'

function timeAgo(timestamp: number): string {
  const mins = Math.max(0, Math.round((Date.now() - timestamp) / 60000))
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.round(mins / 60)
  return `${hours}h ago`
}

function OrderRow({
  order,
  canceling,
  onCancel,
}: {
  order: OpenOrder
  canceling: boolean
  onCancel: () => void
}) {
  const buy = order.side === 'buy'
  return (
    <li className="flex items-center gap-4 py-3.5">
      <Badge tone={buy ? 'accent' : 'neutral'} className="uppercase">
        {order.side}
      </Badge>
      <div className="min-w-0">
        <div className="text-sm font-medium text-zinc-100">{order.pair}</div>
        <div className="text-xs text-zinc-500">
          filled {order.filled} / {order.amount} · {timeAgo(order.createdAt)}
        </div>
      </div>
      <div className="ml-auto text-right">
        <div className="font-mono text-sm tabular-nums text-zinc-100">
          {order.price} {order.quote}
        </div>
        <div className="text-xs text-zinc-500">
          {order.amount} {order.base}
        </div>
      </div>
      <Button variant="outline" size="sm" loading={canceling} onClick={onCancel}>
        Cancel
      </Button>
    </li>
  )
}

function OrderSkeleton() {
  return (
    <ul className="divide-y divide-ink-800">
      {[0, 1].map((i) => (
        <li key={i} className="flex items-center gap-4 py-3.5">
          <div className="h-6 w-12 animate-pulse rounded-full bg-ink-700" />
          <div className="space-y-2">
            <div className="h-3.5 w-20 animate-pulse rounded bg-ink-700" />
            <div className="h-2.5 w-28 animate-pulse rounded bg-ink-800" />
          </div>
          <div className="ml-auto h-7 w-16 animate-pulse rounded bg-ink-800" />
        </li>
      ))}
    </ul>
  )
}

/** Open orders — a companion panel beside the order form. Collapses to a
 *  full-height vertical band on the side; controlled by the parent so the row
 *  can animate the recentre when it opens / closes. */
function OpenOrders({
  orders,
  loadingOrders,
  cancelingId,
  onCancel,
  open,
  onToggle,
}: {
  orders: OpenOrder[]
  loadingOrders: boolean
  cancelingId: string | null
  onCancel: (id: string) => void
  open: boolean
  onToggle: () => void
}) {
  if (!open) {
    return (
      <button
        type="button"
        onClick={onToggle}
        aria-label="Expand open orders"
        className="flex h-full w-full flex-col items-center justify-center gap-3 rounded-2xl border border-ink-700 bg-ink-900/40 py-4 transition hover:border-spectral/40"
      >
        <ChartIcon className="h-4 w-4 shrink-0 text-spectral/70" />
        <span className="whitespace-nowrap font-mono text-[10px] uppercase tracking-[0.18em] text-zinc-400 rotate-180 [writing-mode:vertical-rl]">
          Open orders · {orders.length}
        </span>
      </button>
    )
  }

  return (
    <Card className="h-fit w-full p-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h3 className="panel-title text-sm">Open orders</h3>
          <span className="font-mono text-xs text-zinc-500">{orders.length}</span>
        </div>
        <button
          type="button"
          onClick={onToggle}
          aria-label="Collapse open orders"
          className="text-zinc-500 transition hover:text-zinc-200"
        >
          <ChevronDownIcon className="h-4 w-4 -rotate-90" />
        </button>
      </div>
      <div className="mt-2 max-h-[50vh] overflow-auto">
        {loadingOrders ? (
          <OrderSkeleton />
        ) : orders.length === 0 ? (
          <p className="py-10 text-center text-sm text-zinc-500">No open orders.</p>
        ) : (
          <ul className="divide-y divide-ink-800">
            {orders.map((order) => (
              <OrderRow
                key={order.id}
                order={order}
                canceling={cancelingId === order.id}
                onCancel={() => void onCancel(order.id)}
              />
            ))}
          </ul>
        )}
      </div>
    </Card>
  )
}

export function Swap({ embedded }: { embedded?: boolean } = {}) {
  const { sdk, orders, loadingOrders, refreshOrders, refreshBalances } = useWraith()
  const proof = useProofFlow()

  const [side, setSide] = useState<OrderSide>('buy')
  const [base, setBase] = useState('XLM')
  const [quote, setQuote] = useState('USDC')
  const [price, setPrice] = useState('')
  const [amount, setAmount] = useState('')
  const [cancelingId, setCancelingId] = useState<string | null>(null)
  const [showChart, setShowChart] = useState(true)
  const [ordersOpen, setOrdersOpen] = useState(true)

  const { price: marketPrice, live: livePrice } = usePriceQuote(base, quote)
  const priceEdited = useRef(false)

  useEffect(() => {
    priceEdited.current = false
  }, [base, quote])

  useEffect(() => {
    if (marketPrice != null && !priceEdited.current) setPrice(formatPrice(marketPrice))
  }, [base, quote, marketPrice])

  function onPriceChange(value: string) {
    priceEdited.current = true
    setPrice(value)
  }

  function useMarketPrice() {
    if (marketPrice == null) return
    priceEdited.current = false
    setPrice(formatPrice(marketPrice))
  }

  const valid = base !== quote && parseAmount(price) > 0 && parseAmount(amount) > 0
  const total = valid ? parseAmount(price) * parseAmount(amount) : 0

  async function onPlace() {
    const result = await proof.run(() => sdk.placeOrder({ base, quote, side, price, amount }))
    if (result) {
      await refreshOrders()
      await refreshBalances()
    }
  }

  function closeOverlay() {
    const succeeded = proof.status === 'done'
    proof.reset()
    if (succeeded) {
      setPrice('')
      setAmount('')
    }
  }

  async function onCancel(id: string) {
    setCancelingId(id)
    try {
      await sdk.cancelOrder(id)
      await refreshOrders()
      await refreshBalances()
    } finally {
      setCancelingId(null)
    }
  }

  return (
    <div className={embedded ? 'space-y-5' : 'space-y-6'}>
      {!embedded && (
        <PageIntro title="Swap" subtitle="Dark-pool DEX. Orders stay sealed until matched, so there is no front-running." />
      )}

      <div className="flex items-stretch justify-center gap-4">
        <div
          className={cx(
            'hidden shrink-0 overflow-hidden transition-[width] duration-300 ease-out lg:block',
            showChart ? 'w-[22rem]' : 'w-12',
          )}
        >
          {showChart ? (
            <Card className="flex h-full flex-col p-4">
              <div className="mb-1 flex items-center justify-between">
                <div className="flex min-w-0 items-center gap-2">
                  <ChartIcon className="h-4 w-4 shrink-0 text-zinc-500" />
                  <span className="panel-title whitespace-nowrap text-sm">
                    {base} / {quote}
                  </span>
                  {marketPrice != null && (
                    <span className="truncate font-mono text-[11px] tabular-nums text-zinc-300">
                      {formatPrice(marketPrice)}
                    </span>
                  )}
                  <span
                    className={cx(
                      'font-mono text-[10px] uppercase tracking-[0.16em]',
                      livePrice ? 'text-spectral/70' : 'text-zinc-600',
                    )}
                  >
                    {livePrice ? 'live' : 'est'}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => setShowChart(false)}
                  aria-label="Hide chart"
                  className="text-zinc-500 transition hover:text-zinc-200"
                >
                  <XIcon className="h-4 w-4" />
                </button>
              </div>
              <div className="min-h-0 flex-1">
                <PriceChart pair={`${base}/${quote}`} price={marketPrice} />
              </div>
            </Card>
          ) : (
            <button
              type="button"
              onClick={() => setShowChart(true)}
              aria-label="Add chart"
              className="flex h-full w-full flex-col items-center justify-center gap-3 rounded-2xl border border-ink-700 bg-ink-900/40 py-4 transition hover:border-spectral/40"
            >
              <ChartIcon className="h-4 w-4 shrink-0 text-spectral/70" />
              <span className="whitespace-nowrap font-mono text-[10px] uppercase tracking-[0.18em] text-zinc-400 [writing-mode:vertical-rl]">
                Chart
              </span>
            </button>
          )}
        </div>

        <Card className="w-full shrink-0 self-start p-6 lg:w-[26rem]">
          <SectionHeading icon={<ChartIcon className="h-4 w-4" />} title="Place order" />

          <div className="mb-4 mt-3 grid grid-cols-2 gap-3">
            <Field label="Base">
              <Select value={base} onChange={(e) => setBase(e.target.value)} options={TOKEN_OPTIONS} />
            </Field>
            <Field label="Quote">
              <Select value={quote} onChange={(e) => setQuote(e.target.value)} options={TOKEN_OPTIONS} />
            </Field>
          </div>
          {base === quote && <p className="mb-3 text-xs text-spectral/80">Pick two different tokens.</p>}

          <div className="space-y-4">
            <ToggleGroup
              value={side}
              onChange={setSide}
              options={[
                { value: 'buy', label: 'Buy' },
                { value: 'sell', label: 'Sell' },
              ]}
            />
            <Field
              label={`Price (${quote} per ${base})`}
              hint={
                marketPrice != null ? (
                  <span className="flex items-center gap-1.5">
                    <span>
                      Market{' '}
                      <span className="font-mono tabular-nums text-zinc-300">
                        {formatPrice(marketPrice)}
                      </span>{' '}
                      {quote} · {livePrice ? 'live' : 'est'}
                    </span>
                    <button
                      type="button"
                      onClick={useMarketPrice}
                      className="font-mono text-spectral/80 transition hover:text-spectral"
                    >
                      use
                    </button>
                  </span>
                ) : undefined
              }
            >
              <TextInput
                mono
                inputMode="decimal"
                placeholder="0.0000"
                value={price}
                onChange={(e) => onPriceChange(e.target.value)}
              />
            </Field>
            <Field label={`Amount (${base})`}>
              <TextInput
                mono
                inputMode="decimal"
                placeholder="0.00"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </Field>
            <div className="flex items-center justify-between text-sm">
              <span className="text-zinc-500">Est. {side === 'buy' ? 'cost' : 'proceeds'}</span>
              <span className="font-mono tabular-nums text-zinc-200">
                {formatAmount(total)} {quote}
              </span>
            </div>
            <Button className="w-full" disabled={!valid} onClick={() => void onPlace()}>
              Place order
            </Button>
          </div>
        </Card>

        <div
          className={cx(
            'hidden shrink-0 overflow-hidden transition-[width] duration-300 ease-out lg:block',
            ordersOpen ? 'w-72' : 'w-12',
          )}
        >
          <OpenOrders
            orders={orders}
            loadingOrders={loadingOrders}
            cancelingId={cancelingId}
            onCancel={onCancel}
            open={ordersOpen}
            onToggle={() => setOrdersOpen((v) => !v)}
          />
        </div>
      </div>

      <ProofProgress
        flow={proof}
        title="Placing sealed order"
        subject={parseAmount(amount) > 0 ? `${amount} ${base}` : undefined}
        onClose={closeOverlay}
      />
    </div>
  )
}
