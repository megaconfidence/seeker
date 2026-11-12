import clsx from 'clsx'
import { LoaderCircle } from 'lucide-react'
import { forwardRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from 'react'

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: 'sm' | 'md'
  icon?: ReactNode
  loading?: boolean
}

const buttonVariants: Record<ButtonVariant, string> = {
  primary: 'bg-fg text-inverse hover:opacity-90 disabled:opacity-40',
  secondary: 'border border-line-strong bg-raised text-fg hover:bg-hover disabled:opacity-50',
  ghost: 'text-muted hover:bg-hover hover:text-fg disabled:opacity-40',
  danger: 'border border-line-strong text-bad hover:bg-bad/10 disabled:opacity-50',
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', icon, loading, className, children, disabled, type = 'button', ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      className={clsx(
        'inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md font-medium whitespace-nowrap transition-[background-color,opacity,color,scale] duration-150 select-none enabled:active:scale-[0.97]',
        size === 'sm' ? 'h-7 px-2.5 text-[12.5px]' : 'h-8.5 px-3.5 text-[13px]',
        buttonVariants[variant],
        className,
      )}
      {...props}
    >
      {loading ? <LoaderCircle className="size-3.5 animate-spin" /> : icon}
      {children}
    </button>
  )
})

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string
  size?: 'sm' | 'md'
}

export function IconButton({ label, size = 'md', className, children, type = 'button', ...props }: IconButtonProps) {
  return (
    <button
      type={type}
      aria-label={label}
      title={label}
      className={clsx(
        'inline-flex shrink-0 items-center justify-center rounded-md text-muted transition-[background-color,color,scale] duration-150 hover:bg-hover hover:text-fg enabled:active:scale-[0.92] disabled:opacity-40',
        size === 'sm' ? 'size-7' : 'size-8.5',
        className,
      )}
      {...props}
    >
      {children}
    </button>
  )
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input(
  { className, ...props },
  ref,
) {
  return (
    <input
      ref={ref}
      className={clsx(
        'h-8.5 w-full rounded-md border border-line-strong bg-raised px-3 text-[13px] text-fg placeholder:text-subtle focus:border-fg/30 focus:outline-none',
        className,
      )}
      {...props}
    />
  )
})

export function Toggle({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean
  onChange: (value: boolean) => void
  label: string
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={clsx(
        'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:opacity-50',
        checked ? 'bg-fg' : 'bg-line-strong',
      )}
    >
      <span
        className={clsx(
          'inline-block size-4 rounded-full bg-inverse shadow-sm transition-transform',
          checked ? 'translate-x-[18px]' : 'translate-x-0.5',
        )}
      />
    </button>
  )
}

export function Spinner({ className }: { className?: string }) {
  return <LoaderCircle className={clsx('animate-spin text-subtle', className ?? 'size-4')} />
}

export function Progress({ value, className, tone = 'fg' }: { value: number; className?: string; tone?: 'fg' | 'accent' | 'ok' }) {
  return (
    <div className={clsx('h-1 overflow-hidden rounded-full bg-line', className)}>
      <div
        className={clsx(
          'h-full rounded-full transition-[width] duration-500',
          tone === 'accent' ? 'bg-accent' : tone === 'ok' ? 'bg-ok' : 'bg-fg',
        )}
        style={{ width: `${Math.max(0, Math.min(100, value))}%` }}
      />
    </div>
  )
}

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: ReactNode
  subtitle?: ReactNode
  actions?: ReactNode
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-[22px] font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-1 text-[13px] text-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  )
}

export function Section({
  title,
  count,
  actions,
  children,
  className,
}: {
  title: ReactNode
  count?: number
  actions?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section className={clsx('mb-10', className)}>
      <div className="mb-3 flex items-center justify-between gap-4">
        <h2 className="text-[14px] font-semibold">
          {title}
          {count !== undefined && <span className="ml-2 font-normal text-subtle tabular">{count}</span>}
        </h2>
        {actions}
      </div>
      {children}
    </section>
  )
}

export function Empty({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-line-strong px-6 py-14 text-center">
      {icon && <div className="mb-3 text-subtle">{icon}</div>}
      <p className="font-medium">{title}</p>
      {children && <div className="mt-1 max-w-sm text-[13px] text-muted">{children}</div>}
    </div>
  )
}

export function Tabs<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T
  onChange: (value: T) => void
  options: { value: T; label: ReactNode }[]
}) {
  return (
    <div className="inline-flex rounded-md border border-line-strong p-0.5">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          className={clsx(
            'h-7 rounded px-3 text-[12.5px] font-medium transition-colors',
            value === option.value ? 'bg-hover text-fg' : 'text-muted hover:text-fg',
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

export function Badge({ children, tone = 'default', className }: { children: ReactNode; tone?: 'default' | 'ok' | 'warn' | 'bad' | 'accent'; className?: string }) {
  return (
    <span
      className={clsx(
        'inline-flex h-5 items-center gap-1 rounded px-1.5 text-[11.5px] font-medium whitespace-nowrap',
        tone === 'ok' && 'bg-ok/12 text-ok',
        tone === 'warn' && 'bg-warn/14 text-warn',
        tone === 'bad' && 'bg-bad/12 text-bad',
        tone === 'accent' && 'bg-accent/14 text-accent',
        tone === 'default' && 'bg-hover text-muted',
        className,
      )}
    >
      {children}
    </span>
  )
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-3 py-4 sm:flex-row sm:items-start sm:justify-between sm:gap-8">
      <div className="min-w-0 sm:max-w-sm">
        <div className="text-[13px] font-medium">{label}</div>
        {hint && <div className="mt-0.5 text-[12.5px] text-muted">{hint}</div>}
      </div>
      <div className="flex shrink-0 items-center gap-2 sm:justify-end">{children}</div>
    </div>
  )
}

export function Select<T extends string>({
  value,
  onChange,
  options,
  className,
}: {
  value: T
  onChange: (value: T) => void
  options: { value: T; label: string }[]
  className?: string
}) {
  return (
    <select
      value={value}
      onChange={(event) => onChange(event.target.value as T)}
      className={clsx(
        'h-8.5 rounded-md border border-line-strong bg-raised px-2.5 text-[13px] text-fg focus:border-fg/30 focus:outline-none',
        className,
      )}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  )
}
