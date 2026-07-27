import { useEffect, useRef, useState } from 'react'
import { FREIGHTER_INSTALL_URL, useWallet } from '../hooks/useWallet'
import { truncateKey } from '../lib/format'
import { cx } from '../lib/cx'
import { Badge, Button, ChevronDownIcon, CopyIcon } from './ui'

export function ConnectWallet() {
  const wallet = useWallet()
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function onPointerDown(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [])

  async function copyAddress() {
    if (!wallet.address) return
    try {
      await navigator.clipboard.writeText(wallet.address)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard may be unavailable; ignore silently.
    }
  }

  if (wallet.status === 'not-installed') {
    return (
      <a href={FREIGHTER_INSTALL_URL} target="_blank" rel="noreferrer" className="btn btn-outline">
        Install Freighter
      </a>
    )
  }

  if (wallet.status === 'connected' && wallet.address) {
    return (
      <div className="relative" ref={menuRef}>
        <button type="button" onClick={() => setOpen((o) => !o)} className="btn btn-outline gap-2.5">
          <span className={cx('h-2 w-2 rounded-full', wallet.isTestnet ? 'bg-patina-400' : 'bg-amber-400')} />
          <span className="font-mono text-xs">{truncateKey(wallet.address)}</span>
          <ChevronDownIcon className="h-3.5 w-3.5 text-zinc-500" />
        </button>

        {open && (
          <div className="absolute right-0 z-40 mt-2 w-72 rounded-xl border border-ink-700 bg-ink-850 p-3 shadow-panel animate-fade-in">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-medium text-zinc-400">Connected</span>
              <Badge tone={wallet.isTestnet ? 'success' : 'warn'}>{wallet.network ?? 'Unknown'}</Badge>
            </div>

            <button
              type="button"
              onClick={copyAddress}
              className="flex w-full items-center gap-2 rounded-lg border border-ink-700 bg-ink-900/70 px-3 py-2 text-left transition hover:border-spectral/40"
            >
              <span className="break-all font-mono text-xs text-zinc-300">{wallet.address}</span>
              <CopyIcon className="ml-auto h-4 w-4 shrink-0 text-zinc-500" />
            </button>
            {copied && <p className="mt-1.5 text-xs text-patina-300">Copied to clipboard</p>}

            {!wallet.isTestnet && (
              <p className="mt-2 text-xs text-amber-400">Switch Freighter to Testnet for this demo.</p>
            )}

            <Button
              variant="ghost"
              className="mt-2 w-full justify-start"
              onClick={() => {
                wallet.disconnect()
                setOpen(false)
              }}
            >
              Disconnect
            </Button>
          </div>
        )}
      </div>
    )
  }

  // Only a user-initiated connect shows "Connecting…". The initial silent probe
  // ('checking') must NOT render as busy, or the button looks like it's stuck
  // trying to connect on every load.
  const busy = wallet.status === 'connecting'
  return (
    <div className="flex items-center gap-3">
      {wallet.error && wallet.status === 'disconnected' && (
        <span className="hidden text-xs text-red-300 sm:inline">{wallet.error}</span>
      )}
      <Button onClick={() => void wallet.connect()} loading={busy}>
        {busy ? 'Connecting…' : 'Connect Wallet'}
      </Button>
    </div>
  )
}
