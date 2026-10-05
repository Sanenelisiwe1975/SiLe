'use client'

import { useEffect, useState } from 'react'
import { type Address, encodeFunctionData, parseEventLogs, parseUnits } from 'viem'
import { planRegistryAbi } from '@sile/abi'
import { DEFAULT_TOKEN, type Plan } from '@sile/shared'
import { AccountPanel } from '@/components/AccountPanel'
import { Badge, Button, Card, ErrorNote, Mono, TxLink } from '@/components/ui'
import { client } from '@/lib/chain'
import { type ChargerConfig, type SubscriptionView, charger } from '@/lib/charger'
import { formatAmount, formatPeriod, relativeTime, short } from '@/lib/format'
import { usePoll, useToken } from '@/lib/hooks'
import { decodePlanMeta, encodePlanMeta } from '@/lib/planMeta'
import { useSession } from '@/lib/session'

const errMsg = (e: unknown) => (e instanceof Error ? ((e as any).shortMessage ?? e.message.split('\n')[0]) : String(e))

export default function MerchantPage() {
  const { session } = useSession()
  const merchant = session?.account.address
  const [config, setConfig] = useState<ChargerConfig>()
  useEffect(() => {
    charger.config().then(setConfig).catch(() => {})
  }, [])

  const plans = usePoll(merchant ? () => charger.plans(merchant) : null, 3000, [merchant])
  const subs = usePoll(merchant ? () => charger.subscriptions({ merchant }) : null, 3000, [merchant])
  const metrics = usePoll(merchant ? () => charger.metrics(merchant) : null, 3000, [merchant])
  const token = useToken(DEFAULT_TOKEN)
  const fmt = (v: string | bigint) => (token ? formatAmount(v, token.decimals, token.symbol) : '…')

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Merchant dashboard</h1>
        <p className="text-sm text-muted">Plans, subscribers and every charge, reconciled by tx hash and memo.</p>
      </div>
      <AccountPanel title="Merchant account" />

      {merchant && config && token && (
        <>
          <div className="grid gap-4 sm:grid-cols-4">
            <Stat
              label="MRR (30-day)"
              value={metrics.data ? fmt(metrics.data.mrr) : '…'}
              hint={config.demoPeriodSeconds ? `Demo plans bill every ${formatPeriod(config.demoPeriodSeconds)}, normalised to 30 days` : undefined}
            />
            <Stat label="Collected" value={metrics.data ? fmt(metrics.data.collected) : '…'} />
            <Stat label="Active" value={metrics.data?.counts.active ?? '…'} />
            <Stat
              label="Past due / canceled"
              value={metrics.data ? `${metrics.data.counts.pastDue} / ${metrics.data.counts.canceled}` : '…'}
            />
          </div>

          <div className="grid gap-6 lg:grid-cols-[1fr_1.4fr]">
            <CreatePlan config={config} decimals={token.decimals} symbol={token.symbol} onCreated={plans.refresh} />
            <Plans plans={plans.data ?? []} fmt={fmt} onChange={plans.refresh} />
          </div>

          <Subscribers subs={subs.data ?? []} fmt={fmt} />

          {metrics.data && metrics.data.failedInvoices.length > 0 && (
            <Card>
              <h2 className="mb-3 font-semibold">Failed and retrying charges</h2>
              <table className="w-full text-sm">
                <thead className="text-left text-muted">
                  <tr>
                    <th className="py-1 font-normal">Sub</th>
                    <th className="font-normal">Invoice</th>
                    <th className="font-normal">Reason</th>
                    <th className="font-normal">Attempts</th>
                    <th className="font-normal">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {metrics.data.failedInvoices.map((i) => (
                    <tr key={i.invoiceId} className="border-t border-line">
                      <td className="py-1.5">#{i.subId}</td>
                      <td>
                        <Mono title={i.invoiceId}>{short(i.invoiceId, 6)}</Mono>
                      </td>
                      <td className="max-w-xs truncate" title={i.lastError ?? ''}>
                        {failureLabel(i.lastError)}
                      </td>
                      <td>{i.attempts}</td>
                      <td>
                        <Badge status={i.status} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}

          <div className="flex justify-end">
            <a href={charger.csvUrl(merchant)} className="text-sm text-accent hover:underline">
              Export invoices (CSV: tx hash + memo) ↓
            </a>
          </div>
        </>
      )}
    </div>
  )
}

function failureLabel(err: string | null) {
  if (!err) return '—'
  if (/InsufficientBalance/.test(err)) return 'Insufficient balance'
  if (/KeyAlreadyRevoked/.test(err)) return 'Billing key revoked'
  if (/KeyExpired/.test(err)) return 'Billing key expired'
  if (/SpendingLimitExceeded/.test(err)) return 'Over spending limit'
  if (/CallNotAllowed/.test(err)) return 'Outside key scope'
  return err.slice(0, 60)
}

function Stat({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return (
    <Card className="p-4">
      <p className="text-xs text-muted">{label}</p>
      <p className="mt-1 text-xl font-semibold">{value}</p>
      {hint && <p className="mt-1 text-xs text-muted">{hint}</p>}
    </Card>
  )
}

function CreatePlan({
  config,
  decimals,
  symbol,
  onCreated,
}: {
  config: ChargerConfig
  decimals: number
  symbol: string
  onCreated: () => void
}) {
  const { session } = useSession()
  const periods: [number, string][] = [
    ...(config.demoPeriodSeconds ? ([[config.demoPeriodSeconds, `Demo (${formatPeriod(config.demoPeriodSeconds)})`]] as [number, string][]) : []),
    [86400, 'Daily'],
    [7 * 86400, 'Weekly'],
    [30 * 86400, 'Monthly (30 days)'],
  ]
  const [name, setName] = useState('Pro')
  const [amount, setAmount] = useState('9.99')
  const [period, setPeriod] = useState(periods[0]![0])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [created, setCreated] = useState<{ planId: string; tx: string }>()

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!session) return
    setBusy(true)
    setError(undefined)
    try {
      const receipt = await client.sendTransactionSync({
        account: session.account,
        calls: [
          {
            to: config.planRegistry,
            data: encodeFunctionData({
              abi: planRegistryAbi,
              functionName: 'createPlan',
              args: [DEFAULT_TOKEN as Address, parseUnits(amount, decimals), BigInt(period), encodePlanMeta({ name }), 0n],
            }),
          },
        ],
      })
      const [ev] = parseEventLogs({ abi: planRegistryAbi, logs: receipt.logs, eventName: 'PlanCreated' })
      setCreated({ planId: ev!.args.planId.toString(), tx: receipt.transactionHash })
      onCreated()
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setBusy(false)
    }
  }

  const checkoutUrl = created && `${window.location.origin}/checkout/${created.planId}`
  return (
    <Card>
      <h2 className="mb-3 font-semibold">New plan</h2>
      <form onSubmit={submit} className="space-y-3 text-sm">
        <label className="block">
          <span className="text-muted">Name</span>
          <input className="mt-1 w-full rounded-lg border border-line bg-bg px-3 py-2" value={name} onChange={(e) => setName(e.target.value)} required maxLength={60} />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="text-muted">Price ({symbol})</span>
            <input
              className="mt-1 w-full rounded-lg border border-line bg-bg px-3 py-2"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              inputMode="decimal"
              pattern="^\d+(\.\d{1,6})?$"
              required
            />
          </label>
          <label className="block">
            <span className="text-muted">Billing period</span>
            <select className="mt-1 w-full rounded-lg border border-line bg-bg px-3 py-2" value={period} onChange={(e) => setPeriod(Number(e.target.value))}>
              {periods.map(([s, label]) => (
                <option key={s} value={s}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <p className="text-xs text-muted">Terms are immutable on-chain. Changing price means publishing a new plan.</p>
        <Button type="submit" disabled={busy || !session} className="w-full">
          {busy ? 'Publishing…' : 'Publish plan'}
        </Button>
        {error && <ErrorNote>{error}</ErrorNote>}
        {created && checkoutUrl && (
          <div className="rounded-lg border border-ok/40 bg-ok/10 p-3">
            <p>
              Plan #{created.planId} published (<TxLink hash={created.tx} label="tx" />). Checkout link:
            </p>
            <a className="break-all font-mono text-accent hover:underline" href={checkoutUrl}>
              {checkoutUrl}
            </a>
          </div>
        )}
      </form>
    </Card>
  )
}

function Plans({ plans, fmt, onChange }: { plans: Plan[]; fmt: (v: string) => string; onChange: () => void }) {
  const { session } = useSession()
  const [busy, setBusy] = useState<string>()
  const [error, setError] = useState<string>()

  async function deactivate(p: Plan) {
    if (!session) return
    setBusy(p.planId)
    setError(undefined)
    try {
      const cfg = await charger.config()
      await client.sendTransactionSync({
        account: session.account,
        calls: [
          {
            to: cfg.planRegistry,
            data: encodeFunctionData({ abi: planRegistryAbi, functionName: 'deactivate', args: [BigInt(p.planId)] }),
          },
        ],
      })
      onChange()
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setBusy(undefined)
    }
  }

  return (
    <Card>
      <h2 className="mb-3 font-semibold">Plans</h2>
      {plans.length === 0 ? (
        <p className="text-sm text-muted">No plans yet. Plans appear here a few seconds after publishing.</p>
      ) : (
        <ul className="divide-y divide-line text-sm">
          {[...plans].reverse().map((p) => (
            <li key={p.planId} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
              <span className="font-medium">{decodePlanMeta(p.metadataURI, p.planId).name}</span>
              <span className="text-muted">
                {fmt(p.amount)} / {formatPeriod(p.period)}
              </span>
              {!p.active && <Badge status="canceled" />}
              <span className="ml-auto flex gap-3">
                {p.active && (
                  <>
                    <a className="text-accent hover:underline" href={`/checkout/${p.planId}`} target="_blank" rel="noreferrer">
                      Checkout ↗
                    </a>
                    <button className="text-muted hover:text-bad" disabled={busy === p.planId} onClick={() => deactivate(p)}>
                      {busy === p.planId ? '…' : 'Deactivate'}
                    </button>
                  </>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      {error && <div className="mt-2"><ErrorNote>{error}</ErrorNote></div>}
    </Card>
  )
}

function Subscribers({ subs, fmt }: { subs: SubscriptionView[]; fmt: (v: string) => string }) {
  const [over, setOver] = useState<Record<string, { url: string; status: string } | { error: string } | 'busy'>>({})

  async function overcharge(subId: string) {
    setOver((o) => ({ ...o, [subId]: 'busy' }))
    try {
      const r = await charger.overcharge(subId)
      setOver((o) => ({ ...o, [subId]: { url: r.url, status: r.status } }))
    } catch (e) {
      setOver((o) => ({ ...o, [subId]: { error: errMsg(e) } }))
    }
  }

  return (
    <Card>
      <h2 className="mb-3 font-semibold">Subscribers</h2>
      {subs.length === 0 ? (
        <p className="text-sm text-muted">No subscribers yet. Share a checkout link.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="text-left text-muted">
              <tr>
                <th className="py-1 font-normal">Sub</th>
                <th className="font-normal">Subscriber</th>
                <th className="font-normal">Plan</th>
                <th className="font-normal">Status</th>
                <th className="font-normal">Paid</th>
                <th className="font-normal">Next charge</th>
                <th className="font-normal" title="Demo: ask the protocol to pull amount + 1">
                  Protocol check
                </th>
              </tr>
            </thead>
            <tbody>
              {subs.map((s) => {
                const o = over[s.subId]
                return (
                  <tr key={s.subId} className="border-t border-line align-top">
                    <td className="py-1.5">#{s.subId}</td>
                    <td>
                      <Mono title={s.subscriber}>{short(s.subscriber)}</Mono>
                    </td>
                    <td>
                      {s.plan ? `${decodePlanMeta(s.plan.metadataURI, s.planId).name} · ${fmt(s.plan.amount)}` : `#${s.planId}`}
                    </td>
                    <td>
                      <Badge status={s.status} />
                      {s.haltReason && s.status === 'canceled' && (
                        <span className="ml-1 text-xs text-muted">{s.haltReason.replaceAll('_', ' ')}</span>
                      )}
                    </td>
                    <td>{s.invoicesPaid}</td>
                    <td>{s.status === 'canceled' ? '—' : relativeTime(s.nextChargeAt)}</td>
                    <td>
                      {s.status !== 'canceled' && s.haltReason !== 'unknown_key' && (
                        <>
                          {!o && (
                            <button className="text-xs text-accent hover:underline" onClick={() => overcharge(s.subId)}>
                              Try overcharge
                            </button>
                          )}
                          {o === 'busy' && <span className="text-xs text-muted">sending…</span>}
                          {o && o !== 'busy' && 'url' in o && (
                            <a className="text-xs hover:underline" href={o.url} target="_blank" rel="noreferrer">
                              {o.status === 'reverted' ? (
                                <span className="text-ok">✔ rejected by protocol ↗</span>
                              ) : (
                                <span className="text-bad">accepted?! ↗</span>
                              )}
                            </a>
                          )}
                          {o && o !== 'busy' && 'error' in o && <span className="text-xs text-bad">{o.error}</span>}
                        </>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-3 text-xs text-muted">
        “Try overcharge” asks the subscriber’s key to pay plan amount + 1. Tempo rejects it on-chain with{' '}
        <Mono>SpendingLimitExceeded</Mono>; no SiLe code is involved in that check.
      </p>
    </Card>
  )
}
