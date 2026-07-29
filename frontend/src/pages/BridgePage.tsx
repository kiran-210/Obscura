import { useState } from 'react'
import { cx } from '../lib/cx'
import { Act } from '../components/Act'
import { Bridge, type BridgeProgress } from '../components/Bridge'

/** Act 01 crossing droplet — a rule that fills as the bridge flow advances. */
function CrossingRule({ progress }: { progress: BridgeProgress }) {
  const frac = progress.total > 1 ? progress.step / (progress.total - 1) : 0
  const pct = progress.status === 'done' ? 100 : Math.round(frac * 100)
  const lit = progress.status === 'running' || progress.status === 'done'
  return (
    <div className="mb-6">
      <div className="coord-label mb-2 flex justify-between">
        <span>public world</span>
        <span>shielded pool</span>
      </div>
      <div className="relative h-6">
        <div className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-[#00CDCD]/12" />
        <div
          className="absolute left-0 top-1/2 h-px -translate-y-1/2 bg-spectral/60 transition-all duration-700"
          style={{ width: `${pct}%` }}
        />
        <div className="absolute top-1/2 -translate-y-1/2 transition-all duration-700" style={{ left: `calc(${pct}% - 5px)` }}>
          <span
            className={cx(
              'block h-2.5 w-2.5 rounded-full transition-colors',
              lit ? 'bg-spectral shadow-[0_0_10px_2px_rgba(237,235,230,0.45)]' : 'bg-[#00CDCD]/40',
            )}
          />
        </div>
      </div>
    </div>
  )
}

export function BridgePage() {
  const [cross, setCross] = useState<BridgeProgress>({ step: 0, total: 2, status: 'idle' })
  return (
    <Act
      no="Act 01"
      id="act-cross"
      title="Cross the veil"
      standfirst="Move value across the veil between the public Stellar network and the shielded pool. Every crossing out is proven, not trusted — a real ZK proof, verified on-chain."
      coords={['Stellar · SDF Horizon', 'Obscura · Shielded pool']}
    >
      <CrossingRule progress={cross} />
      <Bridge embedded onProgress={setCross} />
    </Act>
  )
}

export default BridgePage
