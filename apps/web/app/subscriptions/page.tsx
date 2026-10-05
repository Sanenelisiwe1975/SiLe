'use client'

import { useState } from 'react'
import type { Address } from 'viem'
import { AccountPanel } from '@/components/AccountPanel'
import { Badge, Button, Card, ErrorNote, Mono, TxLink } from '@/components/ui'
import { client } from '@/lib/chain'
import { type SubscriptionView, charger } from '@/lib/charger'
import { formatAmount, formatPeriod, relativeTime, short } from '@/lib/format'
import { usePoll, useToken } from '@/lib/hooks'
import { decodePlanMeta } from '@/lib/planMeta'
import { useSession } from '@/lib/session'

export default function SubscriptionsPage() {
  const { session } = useSession()
  const subscriber = session?.account.address
  const subs = usePoll(subscriber ? () => charger.subscriptions({ subscriber }) : null, 3000, [subscriber])

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">My subscriptions</h1>
        <p className="text-sm text-muted">
          Each subscription is a billing key you authorised. Tempo caps what it can pull; revoking it stops payments at the
          protocol level — no merchant cooperation needed.
        </p>
      </div>
      <AccountPanel />
      {subscriber && subs.data?.length === 0 && <p className="text-sm text-muted">No subscriptions for this account yet.</p>}
      {subs.error && <ErrorNote>{subs.error}</ErrorNote>}
      {subs.data?.map((s) => <SubscriptionCard key={s.subId} sub={s} />)}
    </div>
  )
}

function SubscriptionCard({ sub }: { sub: SubscriptionView }) {
  const { session } = useSession()
  const token = useToken(sub.plan?.token as Address | undefined)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [revokeTx, setRevokeTx] = useState<string>()

  // Live view of the key straight from the keychain precompile (not from SiLe).
  const limit = usePoll(
    sub.plan
      ? () =>
          client.accessKey.getRemainingLimit({
            account: sub.subscriber as Address,
            accessKey: sub.accessKey as Address,
            token: sub.plan!.token as Address,
          })
      : null,
    5000,
    [sub.accessKey],
  )
  const detail = usePoll(open ? () => charger.subscription(sub.subId) : null, 4000, [open, sub.subId])

  const keyDead = limit.data !== undefined && !limit.data.periodEnd
  const fmt = (v: string | bigint) => (token ? formatAmount(v, token.decimals, token.symbol) : '…')
  const name = sub.plan ? decodePlanMeta(sub.plan.metadataURI, sub.planId).name : `Plan #${sub.planId}`

  async function revoke() {
    if (!session) return
    setBusy(true)
    setError(undefined)
    try {
      const { receipt } = await client.accessKey.revokeSync({ account: session.account, accessKey: sub.accessKey as Address })
      setRevokeTx(receipt.transactionHash)
      limit.refresh()
    } catch (e) {
      setError(e instanceof Error ? ((e as any).shortMessage ?? e.message.split('\n')[0]) : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="font-semibold">{name}</h2>
            <Badge status={sub.status} />
          </div>
          <p className="text-sm text-muted">
            {sub.plan ? `${fmt(sub.plan.amount)} / ${formatPeriod(sub.plan.period)}` : '…'} · merchant{' '}
            <Mono title={sub.plan?.merchant}>{short(sub.plan?.merchant)}</Mono> · subscription #{sub.subId}
          </p>
        </div>
        {!keyDead && sub.status !== 'canceled' && (
          <Button variant="danger" onClick={revoke} disabled={busy || !session}>
            {busy ? 'Revoking…' : 'Revoke billing key'}
          </Button>
        )}
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
        <div>
          <dt className="text-muted">Payments made</dt>
          <dd className="font-medium">{sub.invoicesPaid}</dd>
        </div>
        <div>
          <dt className="text-muted">Next charge</dt>
          <dd className="font-medium">{sub.status === 'canceled' || keyDead ? '—' : relativeTime(sub.nextChargeAt)}</dd>
        </div>
        <div>
          <dt className="text-muted" title="Read live from Tempo's keychain">
            Key allowance left (on-chain)
          </dt>
          <dd className="font-medium">
            {keyDead ? <span className="text-bad">revoked / expired</span> : limit.data ? fmt(limit.data.remaining) : '…'}
          </dd>
        </div>
        <div>
          <dt className="text-muted">Billing key</dt>
          <dd>
            <Mono title={sub.accessKey}>{short(sub.accessKey)}</Mono>
          </dd>
        </div>
      </dl>

      {revokeTx && (
        <p className="mt-3 rounded-lg border border-line bg-bg px-3 py-2 text-sm">
          Key revoked on-chain (<TxLink hash={revokeTx} label="tx" />). Tempo will reject the merchant’s next charge; the
          subscription then shows as canceled.
        </p>
      )}
      {sub.status === 'canceled' && sub.haltReason && (
        <p className="mt-3 text-sm text-muted">Canceled: {sub.haltReason.replaceAll('_', ' ')}.</p>
      )}
      {error && <div className="mt-3"><ErrorNote>{error}</ErrorNote></div>}

      <button className="mt-4 text-sm text-accent hover:underline" onClick={() => setOpen((o) => !o)}>
        {open ? 'Hide receipts' : 'Show receipts'}
      </button>
      {open && (
        <table className="mt-2 w-full text-sm">
          <thead className="text-left text-muted">
            <tr>
              <th className="py-1 font-normal">#</th>
              <th className="font-normal">Amount</th>
              <th className="font-normal">Status</th>
              <th className="font-normal">Transaction</th>
              <th className="font-normal">Memo</th>
            </tr>
          </thead>
          <tbody>
            {detail.data?.invoices.map((i) => (
              <tr key={i.invoiceId} className="border-t border-line">
                <td className="py-1.5">{i.seq + 1}</td>
                <td>{fmt(i.amount)}</td>
                <td>
                  <Badge status={i.status} />
                </td>
                <td>
                  <TxLink hash={i.txHash} />
                </td>
                <td>
                  <Mono title={i.invoiceId}>{short(i.invoiceId, 6)}</Mono>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  )
}
