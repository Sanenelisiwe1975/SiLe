import Link from 'next/link'
import { Card } from '@/components/ui'

export default function Home() {
  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight">Recurring billing for stablecoins</h1>
        <p className="mt-2 max-w-2xl text-muted">
          Subscribers grant a merchant a scoped Tempo access key: at most the plan amount, once per period, only to the
          merchant. <strong className="text-ink">The chain enforces the terms</strong>; SiLe only keeps the books. No contract
          ever holds or moves your money, and you can revoke at any time.
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Link href="/merchant">
          <Card className="h-full transition hover:border-accent">
            <h2 className="font-semibold">I'm a merchant →</h2>
            <p className="mt-1 text-sm text-muted">Create a plan, share the checkout link, watch charges land with memos.</p>
          </Card>
        </Link>
        <Link href="/subscriptions">
          <Card className="h-full transition hover:border-accent">
            <h2 className="font-semibold">My subscriptions →</h2>
            <p className="mt-1 text-sm text-muted">See what you pay, every receipt on-chain, and revoke a billing key.</p>
          </Card>
        </Link>
      </div>
    </div>
  )
}
