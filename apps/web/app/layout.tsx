import type { Metadata } from 'next'
import Link from 'next/link'
import type { ReactNode } from 'react'
import { SessionProvider } from '@/lib/session'
import './globals.css'

export const metadata: Metadata = {
  title: 'SiLe — recurring billing on Tempo',
  description: 'Non-custodial subscriptions: the chain enforces the billing terms, SiLe keeps the books.',
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen font-sans antialiased">
        <SessionProvider>
          <header className="border-b border-line bg-card">
            <nav className="mx-auto flex max-w-4xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3 text-sm">
              <Link href="/" className="text-base font-semibold tracking-tight">
                SiLe
              </Link>
              <Link href="/merchant" className="text-muted hover:text-ink">
                Merchant
              </Link>
              <Link href="/subscriptions" className="text-muted hover:text-ink">
                My subscriptions
              </Link>
              <span className="ml-auto text-xs text-muted">Tempo Moderato testnet</span>
            </nav>
          </header>
          <main className="mx-auto max-w-4xl px-4 py-8">{children}</main>
        </SessionProvider>
      </body>
    </html>
  )
}
