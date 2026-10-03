import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { MODERATO } from '@sile/shared'

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <section className={`rounded-xl border border-line bg-card p-5 ${className}`}>{children}</section>
}

export function Button({
  variant = 'primary',
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'ghost' | 'danger' }) {
  const styles = {
    primary: 'bg-accent text-accent-ink hover:opacity-90',
    ghost: 'border border-line hover:bg-bg',
    danger: 'border border-bad text-bad hover:bg-bad hover:text-white',
  }[variant]
  return (
    <button
      {...props}
      className={`inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50 ${styles} ${className}`}
    />
  )
}

export function Mono({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <span className="font-mono text-[0.85em]" title={title}>
      {children}
    </span>
  )
}

export function TxLink({ hash, label }: { hash?: string | null; label?: string }) {
  if (!hash) return <span className="text-muted">—</span>
  return (
    <a className="font-mono text-[0.85em] text-accent underline-offset-2 hover:underline" href={`${MODERATO.explorerUrl}/tx/${hash}`} target="_blank" rel="noreferrer">
      {label ?? `${hash.slice(0, 10)}…`}
    </a>
  )
}

const STATUS_STYLE: Record<string, string> = {
  active: 'text-ok border-ok',
  paid: 'text-ok border-ok',
  past_due: 'text-warn border-warn',
  pending: 'text-muted border-line',
  charged: 'text-muted border-line',
  canceled: 'text-bad border-bad',
  failed: 'text-bad border-bad',
}
export function Badge({ status }: { status: string }) {
  return (
    <span className={`inline-block rounded-full border px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[status] ?? 'border-line text-muted'}`}>
      {status.replace('_', ' ')}
    </span>
  )
}

export function ErrorNote({ children }: { children: ReactNode }) {
  return <p className="rounded-lg border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad break-words">{children}</p>
}
