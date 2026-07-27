import type { CSSProperties, ReactNode } from 'react'
import slicesUrl from '../assets/slices.webp'
import slicesPoster from '../assets/slices-poster.webp'
import vortexUrl from '../assets/vortex.webp'
import vortexPoster from '../assets/vortex-poster.webp'
import cubeUrl from '../assets/cube.webp'
import cubePoster from '../assets/cube-poster.webp'

// Footer's light-variant grain — byte-for-byte identical to Landing.tsx footer.
const GRAIN =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='90' height='90'%3E%3Cfilter id='g'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/%3E%3CfeColorMatrix type='matrix' values='0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.4 0.4 0.4 0 -0.4'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23g)'/%3E%3C/svg%3E\")"

// One card per section — holds the gif and the text together.
const CARD = 'relative rounded-[1.75rem] border border-[#1b1610]/10 px-6 py-10 sm:px-10 sm:py-12'
const CARD_BG: CSSProperties = { background: 'rgba(247,244,236,0.55)' }

const BEATS = [
  {
    label: '01 · SHIELDED',
    coord: '[ Poseidon2 · Merkle ]',
    title: 'seal it in a note',
    body: 'bridge assets in and your balance becomes a Poseidon2 commitment — a note in a Merkle tree. hold private multi-asset balances; amount and owner stay inside the hash, only the root is ever public.',
  },
  {
    label: '02 · PROVEN',
    coord: '[ UltraHonk · Noir ]',
    title: 'prove, don’t reveal',
    body: 'to move, you build a zero-knowledge proof — you own a note, the sums balance, nothing double-spends. no amounts, no addresses leave the circuit. privacy comes from the circuit, not from trust.',
  },
  {
    label: '03 · UNLINKABLE',
    coord: '[ nullifier · spend ]',
    title: 'spend a nullifier, stay unlinkable',
    body: 'every exit is verified inside a Soroban contract over BN254 and Poseidon2 before any funds move. a spend reveals only a nullifier, so the old note and the new never link. no valid proof, no funds move.',
  },
]

const MODULES = [
  { k: 'DEPOSIT / WITHDRAW', d: 'assets in — or in from Ethereum, BLS-verified on Soroban.', to: '/deposit' },
  { k: 'PORTFOLIO', d: 'private multi-asset balances only you can see.', to: '/portfolio' },
  { k: 'PAY', d: 'confidential payments; amounts and parties hidden.', to: '/pay' },
  { k: 'SWAP', d: 'a zero-knowledge dark pool; orders matched blind.', to: '/swap' },
]

/** Transparent seamless loop as an animated WebP; swaps to a static poster
 *  frame under prefers-reduced-motion (picture media selection). */
function LoopAsset({ src, poster, className }: { src: string; poster: string; className?: string }) {
  return (
    <picture className="contents">
      <source media="(prefers-reduced-motion: reduce)" srcSet={poster} />
      <img src={src} alt="" aria-hidden className={className} />
    </picture>
  )
}

function Label({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] uppercase tracking-[0.18em] ${className}`}>
      {children}
    </div>
  )
}

export function StoryShielded({ onEnter }: { onEnter: () => void }) {
  return (
    <section className="relative w-full overflow-hidden bg-[#f4efe4] px-6 py-32 text-[#565243] sm:px-8 md:py-40">
      <div
        className="pointer-events-none absolute inset-0 z-0 opacity-50"
        style={{
          backgroundImage: GRAIN,
          backgroundSize: '90px 90px',
          maskImage: 'linear-gradient(to bottom, transparent, #000 16rem)',
          WebkitMaskImage: 'linear-gradient(to bottom, transparent, #000 16rem)',
        }}
      />

      <div className="relative z-10 mx-auto max-w-6xl">
        {/* intro */}
        <Label>
          <span className="text-[#3B382D]">public ledger</span>
          <span aria-hidden className="text-[#b3a081]">→</span>
          <span className="text-[#3B382D]">shielded layer</span>
        </Label>
        <h2
          className="mt-8 max-w-3xl font-display font-medium lowercase leading-[1.04] tracking-[-0.03em] text-[#24221B]"
          style={{ fontSize: 'clamp(2rem, 5.4vw, 3.6rem)' }}
        >
          public chains remember everything.{' '}
          <span className="text-[#565243]">the shielded layer forgets.</span>
        </h2>

        {/* PUBLIC LEDGER — one card: text + block stack */}
        <div className={`mt-14 md:mt-16 ${CARD}`} style={CARD_BG}>
          <div className="grid grid-cols-1 items-center gap-x-12 gap-y-8 md:grid-cols-[0.82fr_1.18fr]">
            <div className="order-2 max-w-md md:order-1">
              <p className="text-[15px] font-medium leading-relaxed text-[#565243]">
                every block on an open chain is permanent, public and linkable — amounts, balances,
                counterparties, readable by anyone with the address, forever. the ledger never forgets.
              </p>
              <Label className="mt-6">
                <span className="whitespace-nowrap text-[#3B382D]">public ledger</span>
                <span className="whitespace-nowrap text-[#9A9583]">[ every block · forever ]</span>
              </Label>
            </div>
            <div className="order-1 mx-auto w-[clamp(240px,40vw,460px)] md:order-2">
              <LoopAsset src={slicesUrl} poster={slicesPoster} className="block w-full" />
            </div>
          </div>
        </div>

        {/* SHIELDED CORE — one card: vortex + text */}
        <div className={`mt-8 ${CARD}`} style={CARD_BG}>
          <div className="grid grid-cols-1 items-center gap-x-12 gap-y-8 md:grid-cols-[1fr_1fr]">
            <div className="order-1 mx-auto w-[clamp(220px,34vw,420px)]">
              <LoopAsset src={vortexUrl} poster={vortexPoster} className="block w-full" />
              <span className="mt-3 block text-center font-mono text-[10px] uppercase tracking-[0.14em] text-[#78735F]">
                <span className="text-[#3B382D]">shielded core</span> · value drawn in
              </span>
            </div>
            <div className="order-2 max-w-md">
              <h3 className="font-display text-[clamp(1.5rem,3.2vw,2.2rem)] font-medium lowercase leading-[1.08] tracking-[-0.02em] text-[#24221B]">
                value falls into the pool and disappears.
              </h3>
              <p className="mt-5 text-[15px] font-medium leading-relaxed text-[#565243]">
                wraith bridges assets into a shielded layer on Stellar, where value moves behind
                zero-knowledge proofs verified on-chain by Soroban contracts. no valid proof, no funds move.
              </p>
            </div>
          </div>
        </div>

        {/* THE CRYPTOGRAPHY — one card: copy + proof beats */}
        <div className={`mt-8 ${CARD}`} style={CARD_BG}>
          <Label>
            <span className="text-[#3B382D]">the cryptography</span>
            <span className="text-[#9A9583]">[ UltraHonk · Poseidon2 · BN254 ]</span>
          </Label>
          <p className="mt-6 max-w-xl text-[15px] font-medium leading-relaxed text-[#565243]">
            every move out of the shielded layer is a zero-knowledge proof, checked on-chain inside a
            Soroban contract. privacy comes from the circuit; integrity from the verifier. the math is the lock.
          </p>

          <div className="mt-10 grid grid-cols-1 items-center gap-x-14 gap-y-12 md:mt-12 md:grid-cols-[0.85fr_1.15fr]">
            <div className="order-1 mx-auto w-[clamp(220px,30vw,380px)]">
              <LoopAsset src={cubeUrl} poster={cubePoster} className="block w-full" />
              <span className="mt-3 block text-center font-mono text-[10px] uppercase tracking-[0.14em] text-[#78735F]">
                <span className="text-[#3B382D]">zero-knowledge</span> · the circuit
              </span>
            </div>

            <div className="order-2 grid grid-cols-1 gap-y-8">
              {BEATS.map((b) => (
                <div key={b.label} className="border-t border-[#1b1610]/12 pt-5">
                  <div className="flex flex-wrap items-baseline gap-x-3 font-mono text-[11px] uppercase tracking-[0.18em]">
                    <span className="text-[#3B382D]">{b.label}</span>
                    <span className="text-[#9A9583]">{b.coord}</span>
                  </div>
                  <h3 className="mt-3 font-display text-[19px] font-medium lowercase leading-[1.1] tracking-[-0.02em] text-[#24221B]">
                    {b.title}
                  </h3>
                  <p className="mt-3 text-[14px] font-medium leading-relaxed text-[#565243]">{b.body}</p>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* modules + CTA — one card */}
        <div className={`mt-8 ${CARD}`} style={CARD_BG}>
          <div className="grid grid-cols-2 gap-px overflow-hidden rounded-[1rem] border border-[#1b1610]/12 bg-[#1b1610]/12 sm:grid-cols-4">
            {MODULES.map((m) => (
              <a key={m.k} href={`#${m.to}`} className="group block bg-[#f4efe4] px-5 py-7 transition hover:bg-[#efe9dc]">
                <div className="font-mono text-[11px] uppercase tracking-[0.18em] text-[#3B382D]">{m.k}</div>
                <p className="mt-3 text-[13px] leading-relaxed text-[#565243]">{m.d}</p>
                <span className="mt-4 inline-block font-mono text-[10px] uppercase tracking-[0.18em] text-[#78735F] transition-colors group-hover:text-[#4f3e22]">
                  open →
                </span>
              </a>
            ))}
          </div>
          <button
            onClick={onEnter}
            className="mt-10 font-mono text-[12px] uppercase tracking-[0.18em] text-[#78735F] transition hover:text-[#4f3e22]"
          >
            enter the shielded layer →
          </button>
        </div>
      </div>
    </section>
  )
}
