import FluidVolume from './FluidVolume'

/** The faint coordinate hairlines + overlapping circles of the landing hero,
 *  carried behind the app so /app lives in the same drafting-table world. */
function Coords() {
  const lines = [
    { deg: -15, top: '52%' },
    { deg: 1, top: '57%' },
    { deg: 7.6, top: '61%' },
  ]
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden">
      <svg
        className="absolute left-1/2 top-[50%]"
        style={{ width: 'min(82vh, 96vw)', height: 'min(82vh, 96vw)', transform: 'translate(-50%, -50%)' }}
        viewBox="0 0 1000 1000"
        fill="none"
        aria-hidden
      >
        <circle cx="500" cy="500" r="322" stroke="rgba(0,205,205,0.08)" strokeWidth="1.1" transform="translate(-150 -12)" />
        <circle cx="500" cy="500" r="286" stroke="rgba(0,205,205,0.08)" strokeWidth="1.1" transform="translate(146 22)" />
      </svg>
      {lines.map((l, i) => (
        <div
          key={i}
          className="absolute left-[-25%] h-px w-[150%]"
          style={{ top: l.top, background: 'rgba(0,205,205,0.09)', transform: `translateY(-50%) rotate(${l.deg}deg)`, transformOrigin: 'center' }}
        />
      ))}
    </div>
  )
}

/**
 * Ambient brand backdrop for the app surfaces — the same volumetric fluid the
 * landing hero runs, dimmed under a sepia scrim with film grain and coordinate
 * hairlines on top. One fixed instance behind /app and /faucet, replacing the
 * old cold monochrome DitherFluid so the whole product is one continuous world.
 */
export function BrandCanvas() {
  return (
    <div className="pointer-events-none fixed inset-0 -z-10 bg-[#FFFFFF]">
      <div className="absolute inset-0">
        <FluidVolume baseColor="#00FFFF" background="#FFFFFF" quality="medium" speed={0.85} />
      </div>
      {/* Sepia scrim — keeps the field as atmosphere, not a distraction under forms. */}
      <div className="absolute inset-0 bg-[#FFFFFF]/60" />
      <div className="wr-grain absolute inset-0 opacity-40" />
      <Coords />
    </div>
  )
}

export default BrandCanvas
