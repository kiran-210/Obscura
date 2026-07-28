import type { ReactNode } from 'react'

/**
 * Act — one editorial spread of the shielded film. A numbered act with a
 * grotesque title, an Inter standfirst and the landing's coordinate-label pair,
 * wrapping an embedded flow verbatim. Its id is the act-nav's smooth-scroll target.
 */
export function Act({
  no,
  id,
  title,
  standfirst,
  coords,
  titleAside,
  maxWidthClassName = 'max-w-2xl',
  children,
}: {
  no: string
  id: string
  title: string
  standfirst: string
  coords: string[]
  titleAside?: ReactNode
  maxWidthClassName?: string
  children: ReactNode
}) {
  return (
    <section id={id} className="scroll-mt-24 border-t border-[#00CDCD]/10">
      <div className={`mx-auto w-full ${maxWidthClassName} px-5 py-16 sm:py-24`}>
        <div className="mb-9 flex items-start justify-between gap-6">
          <div>
            <div className="coord-label mb-3">{no}</div>
            <div className="flex items-center gap-3">
              <h2 className="display-hd text-[2rem] leading-none sm:text-[2.6rem]">{title}</h2>
              {titleAside}
            </div>
            <p className="mt-4 max-w-md text-sm leading-relaxed text-zinc-300">{standfirst}</p>
          </div>
          <ul className="hidden shrink-0 space-y-1.5 pt-1 text-right sm:block">
            {coords.map((c) => (
              <li key={c} className="coord-label">
                [ {c} ]
              </li>
            ))}
          </ul>
        </div>
        {children}
      </div>
    </section>
  )
}

export default Act
