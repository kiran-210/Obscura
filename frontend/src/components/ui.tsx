import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  SVGProps,
} from 'react'
import { cx } from '../lib/cx'
import type { AssetCode } from '../lib/obscura-sdk'
import { truncateKey } from '../lib/format'
import { CoinBadge, ObscuraMark } from './BrandIcons'

// The obscura mark lives with the other brand glyphs; re-exported so `import
// { ObscuraMark } from './ui'` call sites resolve here.
export { ObscuraMark } from './BrandIcons'

// --- Icons (inherit currentColor) -------------------------------------------

export function ChevronDownIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden {...props}>
      <path d="m6 9 6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export function CheckIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden {...props}>
      <path d="m5 13 4 4L19 7" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export function XIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden {...props}>
      <path d="M6 6l12 12M18 6 6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}

export function CopyIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden {...props}>
      <rect x="9" y="9" width="11" height="11" rx="2.5" stroke="currentColor" strokeWidth="1.8" />
      <path d="M5 15V6.5A1.5 1.5 0 0 1 6.5 5H15" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  )
}

export function EyeGlyph({ off, ...props }: SVGProps<SVGSVGElement> & { off?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden {...props}>
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" stroke="currentColor" strokeWidth="1.7" />
      <circle cx="12" cy="12" r="2.6" stroke="currentColor" strokeWidth="1.7" />
      {off && <path d="M4 4l16 16" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />}
    </svg>
  )
}

export function ArrowDownIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden {...props}>
      <path d="M12 5v14m0 0 6-6m-6 6-6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export function ArrowUpIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden {...props}>
      <path d="M12 19V5m0 0-6 6m6-6 6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export function ShieldIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden {...props}>
      <path
        d="M12 3 5 6v5c0 4.4 3 7.7 7 9 4-1.3 7-4.6 7-9V6l-7-3z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      <path d="m9 12 2 2 4-4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export function ChartIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden {...props}>
      <path d="M5 4v16h16" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <rect x="8" y="11" width="2.5" height="6" rx="1" fill="currentColor" />
      <rect x="13" y="7" width="2.5" height="10" rx="1" fill="currentColor" />
      <rect x="18" y="13" width="2.5" height="4" rx="1" fill="currentColor" opacity="0.7" />
    </svg>
  )
}

export function Spinner({ className }: { className?: string }) {
  return <ObscuraMark className={cx('animate-spin', className)} />
}

// --- Primitives -------------------------------------------------------------

type ButtonVariant = 'primary' | 'outline' | 'ghost' | 'danger'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: 'md' | 'sm'
  loading?: boolean
}

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: 'btn-primary',
  outline: 'btn-outline',
  ghost: 'btn-ghost',
  danger: 'btn-danger',
}

export function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  className,
  children,
  disabled,
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cx('btn', VARIANT_CLASS[variant], size === 'sm' && 'btn-sm', className)}
      disabled={disabled || loading}
      {...rest}
    >
      {loading && <Spinner className="h-4 w-4" />}
      {children}
    </button>
  )
}

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cx('card', className)}>{children}</div>
}

export function Field({
  label,
  hint,
  htmlFor,
  children,
}: {
  label: string
  hint?: ReactNode
  htmlFor?: string
  children: ReactNode
}) {
  return (
    <div>
      <label className="label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {hint && <div className="mt-1.5 text-xs text-zinc-500">{hint}</div>}
    </div>
  )
}

interface TextInputProps extends InputHTMLAttributes<HTMLInputElement> {
  mono?: boolean
}

export function TextInput({ mono, className, ...rest }: TextInputProps) {
  return <input className={cx('input', mono && 'input-mono', className)} {...rest} />
}

interface SelectOption {
  value: string
  label: string
}

interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'children'> {
  options: SelectOption[]
}

export function Select({ options, className, ...rest }: SelectProps) {
  return (
    <div className="relative">
      <select className={cx('input cursor-pointer appearance-none pr-9', className)} {...rest}>
        {options.map((o) => (
          <option key={o.value} value={o.value} className="bg-ink-850 text-zinc-100">
            {o.label}
          </option>
        ))}
      </select>
      <ChevronDownIcon className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
    </div>
  )
}

type BadgeTone = 'neutral' | 'accent' | 'success' | 'warn' | 'danger'

const BADGE_TONE: Record<BadgeTone, string> = {
  neutral: 'bg-ink-700/60 text-zinc-300',
  accent: 'bg-spectral/15 text-spectral-soft',
  success: 'bg-patina-500/15 text-patina-300',
  warn: 'bg-amber-500/15 text-amber-300',
  danger: 'bg-red-500/15 text-red-300',
}

export function Badge({
  tone = 'neutral',
  className,
  children,
}: {
  tone?: BadgeTone
  className?: string
  children: ReactNode
}) {
  return <span className={cx('badge', BADGE_TONE[tone], className)}>{children}</span>
}

export function AssetAvatar({ code, className }: { code: AssetCode; className?: string }) {
  return <CoinBadge name={code} size="lg" className={className} />
}

export function PageIntro({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div>
      <h1 className="text-2xl font-semibold leading-tight tracking-tight text-zinc-100">{title}</h1>
      <p className="mt-1.5 max-w-xl text-sm text-zinc-400">{subtitle}</p>
    </div>
  )
}

export function SectionHeading({
  icon,
  title,
  hint,
}: {
  icon?: ReactNode
  title: string
  hint?: ReactNode
}) {
  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-2.5">
        {icon && <span className="text-zinc-500">{icon}</span>}
        <h2 className="panel-title">{title}</h2>
      </div>
      {hint && <span className="font-mono text-xs text-zinc-500">{hint}</span>}
    </div>
  )
}

interface ToggleOption<T extends string> {
  value: T
  label: string
  /** Tailwind classes applied when this option is active. */
  activeClassName?: string
}

export function ToggleGroup<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T
  onChange: (value: T) => void
  options: ToggleOption<T>[]
}) {
  return (
    <div className="grid grid-cols-2 gap-1 rounded-xl border border-ink-700 bg-ink-900/60 p-1">
      {options.map((option) => {
        const active = value === option.value
        return (
          <button
            key={option.value}
            type="button"
            onClick={() => onChange(option.value)}
            className={cx(
              'rounded-lg py-2 text-sm font-semibold transition',
              active
                ? (option.activeClassName ??
                    'bg-spectral/15 text-zinc-100 shadow-[inset_0_0_0_1px_rgba(214,192,131,0.4)]')
                : 'text-zinc-400 hover:text-zinc-200',
            )}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}

export function TxBanner({
  status,
  hash,
  error,
  successLabel,
}: {
  status: 'idle' | 'pending' | 'done' | 'error'
  hash: string | null
  error: string | null
  successLabel: string
}) {
  if (status === 'done' && hash) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-emerald-500/20 bg-emerald-500/10 px-3.5 py-2.5 text-sm text-emerald-300 animate-fade-in">
        <CheckIcon className="h-4 w-4 shrink-0" />
        <span>{successLabel}</span>
        <span className="ml-auto font-mono text-xs text-emerald-400/70">{truncateKey(hash, 6, 6)}</span>
      </div>
    )
  }
  if (status === 'error') {
    return (
      <div className="rounded-xl border border-red-500/20 bg-red-500/10 px-3.5 py-2.5 text-sm text-red-300 animate-fade-in">
        {error ?? 'Transaction failed.'}
      </div>
    )
  }
  return null
}
