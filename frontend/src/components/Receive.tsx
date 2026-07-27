import { useState } from 'react'
import { CopyIcon, WraithMark } from './ui'

/** The receive cipher: a shareable code senders encrypt to, revealing nothing
 *  about balance or history. Extracted from the former single-scroll wallet. */
export function Receive({ receiveCode }: { receiveCode: string | null }) {
  const [copied, setCopied] = useState(false)
  async function copy() {
    if (!receiveCode) return
    try {
      await navigator.clipboard.writeText(receiveCode)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard unavailable */
    }
  }
  return (
    <div className="space-y-5">
      <div className="flex items-center justify-center rounded-2xl border border-ink-700 bg-ink-900/40 p-8">
        <WraithMark className="h-20 w-20 text-spectral/70" />
      </div>
      {receiveCode ? (
        <>
          <button
            type="button"
            onClick={copy}
            className="flex w-full items-center gap-2 rounded-xl border border-ink-700 bg-ink-900/60 px-4 py-4 text-left transition hover:border-spectral/40"
          >
            <span className="break-all font-mono text-sm text-zinc-200">{receiveCode}</span>
            <CopyIcon className="ml-auto h-4 w-4 shrink-0 text-zinc-500" />
          </button>
          {copied && <p className="text-center text-xs text-patina-300">Copied to clipboard</p>}
        </>
      ) : (
        <p className="rounded-xl border border-ink-700 bg-ink-900/50 px-4 py-4 text-center text-sm text-zinc-500">
          Connect your Stellar wallet to reveal your receive code.
        </p>
      )}
    </div>
  )
}

export default Receive
