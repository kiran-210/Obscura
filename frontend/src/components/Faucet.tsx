import { useState } from 'react'
import { useWallet } from '../hooks/useWallet'
import { CURATED_TOKENS } from '../lib/tokens'
import { faucetMint } from '../lib/faucet'
import { truncateKey } from '../lib/format'
import { CoinBadge } from './BrandIcons'
import { Button } from './ui'
import { ConnectWallet } from './ConnectWallet'

const FAUCET_TOKENS = CURATED_TOKENS.filter((t) => t.faucet && t.sac)
const DRIP = 1000

/** Testnet faucet: mint mock USDC to the connected wallet. */
export function Faucet() {
  const wallet = useWallet()
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<Record<string, string>>({})
  const connected = wallet.status === 'connected'

  async function mint(code: string, sac: string, decimals: number) {
    setBusy(code)
    setMsg((m) => ({ ...m, [code]: '' }))
    try {
      const hash = await faucetMint(sac, BigInt(DRIP) * 10n ** BigInt(decimals))
      setMsg((m) => ({ ...m, [code]: `✓ Minted ${DRIP.toLocaleString()} ${code} · ${truncateKey(hash, 6, 6)}` }))
    } catch (e) {
      setMsg((m) => ({ ...m, [code]: e instanceof Error ? e.message : 'Mint failed.' }))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="mx-auto w-full max-w-[460px] px-4 py-6">
      <header className="mb-6 flex items-center justify-between">
        <a href="#/app" className="text-sm text-zinc-400 transition hover:text-zinc-200">
          ← Wallet
        </a>
        <ConnectWallet />
      </header>

      <section className="rounded-2xl border border-ink-700 bg-ink-850/70 p-6 shadow-panel">
        <h1 className="text-lg font-semibold tracking-tight text-zinc-100">Testnet faucet</h1>
        <p className="mt-1 text-sm text-zinc-400">
          Mint mock tokens to your connected wallet, then deposit them into the shielded pool. These
          are open-mint testnet tokens — not real assets.
        </p>

        {!connected && (
          <p className="mt-4 rounded-xl border border-ink-700 bg-ink-900/50 px-3.5 py-3 text-center text-sm text-zinc-500">
            Connect your Stellar wallet to mint.
          </p>
        )}

        <div className="mt-4 space-y-2">
          {FAUCET_TOKENS.map((t) => (
            <div
              key={t.code}
              className="flex items-center gap-3 rounded-2xl border border-ink-800 bg-ink-900/40 p-3"
            >
              <CoinBadge name={t.icon} size="lg" />
              <div className="min-w-0">
                <div className="text-sm font-semibold tracking-tight text-zinc-100">{t.code}</div>
                <div className="truncate text-xs text-zinc-400">{t.name}</div>
              </div>
              <Button
                size="sm"
                className="ml-auto"
                disabled={!connected || busy !== null}
                loading={busy === t.code}
                onClick={() => void mint(t.code, t.sac as string, t.decimals)}
              >
                {busy === t.code ? 'Minting…' : `Mint ${DRIP.toLocaleString()}`}
              </Button>
            </div>
          ))}
        </div>

        <div className="mt-3 space-y-1">
          {FAUCET_TOKENS.map((t) =>
            msg[t.code] ? (
              <p key={t.code} className="text-xs text-zinc-500">
                <span className="font-medium text-zinc-400">{t.code}</span> · {msg[t.code]}
              </p>
            ) : null,
          )}
        </div>
      </section>
    </div>
  )
}
