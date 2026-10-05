'use client'

import Link from 'next/link'
import { useParams } from 'next/navigation'
import { useEffect, useState } from 'react'
import { type Address, type Hex, parseEventLogs } from 'viem'
import { planRegistryAbi, subscriptionLedgerAbi } from '@sile/abi'
import { buildSubscribeCalls } from '@sile/sdk'
import { KEY_EXPIRY_MONTHS, addressUrl } from '@sile/shared'
import { AccountPanel } from '@/components/AccountPanel'
import { Badge, Button, Card, ErrorNote, Mono, TxLink } from '@/components/ui'
import { client } from '@/lib/chain'
import { type ChargerConfig, type SubscriptionDetail, charger } from '@/lib/charger'
import { formatAmount, formatPeriod, short } from '@/lib/format'
import { useBalance, usePoll, useToken } from '@/lib/hooks'
import { decodePlanMeta } from '@/lib/planMeta'
import { useSession } from '@/lib/session'

type OnchainPlan = { merchant: Address; token: Address; amount: bigint; period: bigint; active: boolean }
type Step = 'idle' | 'intent' | 'sign' | 'confirm' | 'charging' | 'done'

const STEP_LABEL: Record<Step, string> = {
  idle: '',
  intent: 'Preparing a billing key…',
  sign: 'Approve with your passkey…',
  confirm: 'Confirming on Tempo…',
  charging: 'Waiting for the first charge…',
  done: 'Subscribed',
}

export default function CheckoutPage() {
  const { planId } = useParams<{ planId: string }>()
  const { session } = useSession()
  const [config, setConfig] = useState<ChargerConfig>()
  const [plan, setPlan] = useState<OnchainPlan>()
  const [loadError, setLoadError] = useState<string>()
  const [step, setStep] = useState<Step>('idle')
  const [error, setError] = useState<string>()
  const [subTx, setSubTx] = useState<Hex>()
  const [subId, setSubId] = useState<string>()
  const [planName, setPlanName] = useState<string>()

  const token = useToken(plan?.token)
  const balance = useBalance(plan?.token, session?.account.address)

  useEffect(() => {
    ;(async () => {
      const cfg = await charger.config()
      setConfig(cfg)
      const p = (await client.readContract({
        address: cfg.planRegistry,
        abi: planRegistryAbi,
        functionName: 'getPlan',
        args: [BigInt(planId)],
      })) as OnchainPlan
      setPlan(p)
      // Name comes from metadata (charger index); terms above are always read from chain.
      charger.plan(planId).then((x) => setPlanName(decodePlanMeta(x.metadataURI, planId).name)).catch(() => {})
    })().catch((e) => setLoadError(e instanceof Error ? e.message.split('\n')[0] : String(e)))
  }, [planId])

  // After subscribing, follow the charger until the first invoice is paid.
  const detail = usePoll<SubscriptionDetail>(subId ? () => charger.subscription(subId) : null, 2000, [subId])
  useEffect(() => {
    if (step === 'charging' && detail.data && detail.data.invoicesPaid >= 1) setStep('done')
  }, [step, detail.data])

  async function subscribe() {
    if (!session || !plan) return
    setError(undefined)
    try {
      setStep('intent')
      const intent = await charger.intent(planId, session.account.address)
      setStep('sign')
      // ONE signature: authorise the scoped access key + record the subscription, atomically.
      const receipt = await client.sendTransactionSync({
        account: session.account,
        calls: buildSubscribeCalls(intent, planId),
      })
      setStep('confirm')
      setSubTx(receipt.transactionHash)
      const [ev] = parseEventLogs({ abi: subscriptionLedgerAbi, logs: receipt.logs, eventName: 'Subscribed' })
      if (!ev) throw new Error('Subscribed event missing')
      setSubId(ev.args.subId.toString())
      setStep('charging')
    } catch (e) {
      setStep('idle')
      setError(e instanceof Error ? (e as any).shortMessage ?? e.message.split('\n')[0] : String(e))
    }
  }

  if (loadError) return <ErrorNote>Could not load plan #{planId}: {loadError}</ErrorNote>
  if (!plan || !config || !token) return <p className="text-muted">Loading plan…</p>

  const price = formatAmount(plan.amount, token.decimals, token.symbol)
  const every = formatPeriod(Number(plan.period))
  const balanceKnown = balance.data !== undefined
  const lowBalance = balanceKnown && balance.data! < plan.amount
  const busy = step !== 'idle' && step !== 'done'
  const firstInvoice = detail.data?.invoices.find((i) => i.seq === 0)

  return (
    <div className="grid gap-6 md:grid-cols-[1fr_1.1fr]">
      <Card>
        <p className="text-sm text-muted">
          {planName && planName !== `Plan #${planId}` ? <><strong className="text-ink">{planName}</strong> · </> : null}Plan #{planId}
        </p>
        <h1 className="mt-1 text-3xl font-semibold">
          {price}
          <span className="text-base font-normal text-muted"> / {every}</span>
        </h1>
        <p className="mt-1 text-sm">
          Merchant{' '}
          <a className="font-mono text-accent hover:underline" href={addressUrl(plan.merchant)} target="_blank" rel="noreferrer">
            {short(plan.merchant, 6)}
          </a>
        </p>
        {!plan.active && <div className="mt-3"><ErrorNote>This plan no longer accepts subscribers.</ErrorNote></div>}

        <h2 className="mt-6 text-sm font-semibold">What you authorise</h2>
        <ul className="mt-2 space-y-2 text-sm">
          <li>• At most <strong>{price}</strong> per <strong>{every}</strong> — enforced by Tempo, not by SiLe.</li>
          <li>• Only <Mono>transferWithMemo</Mono> of {token.symbol}, and only to this merchant.</li>
          <li>• The billing key expires in {KEY_EXPIRY_MONTHS} months. Revoke it any time from My subscriptions.</li>
          <li>• SiLe pays the network fee for every charge — you pay exactly {price}.</li>
        </ul>
      </Card>

      <div className="space-y-4">
        <AccountPanel title="Pay with" />
        {session && (
          <Card>
            {step === 'done' || step === 'charging' ? (
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <h2 className="font-semibold">{step === 'done' ? 'You’re subscribed' : STEP_LABEL.charging}</h2>
                  {detail.data && <Badge status={detail.data.status} />}
                </div>
                <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
                  <dt className="text-muted">Subscription</dt>
                  <dd>#{subId}</dd>
                  <dt className="text-muted">Authorised in</dt>
                  <dd><TxLink hash={subTx} /></dd>
                  <dt className="text-muted">First charge</dt>
                  <dd>{firstInvoice?.txHash ? <TxLink hash={firstInvoice.txHash} /> : 'pending…'}</dd>
                  <dt className="text-muted">Invoice memo</dt>
                  <dd>{firstInvoice ? <Mono title={firstInvoice.invoiceId}>{short(firstInvoice.invoiceId, 8)}</Mono> : '—'}</dd>
                </dl>
                <Link href="/subscriptions" className="inline-block text-sm text-accent hover:underline">
                  Manage my subscriptions →
                </Link>
              </div>
            ) : (
              <div className="space-y-3">
                <Button className="w-full py-3 text-base" onClick={subscribe} disabled={busy || !plan.active || !balanceKnown || lowBalance}>
                  {busy ? STEP_LABEL[step] : `Subscribe — ${price} / ${every}`}
                </Button>
                {lowBalance && <p className="text-sm text-warn">Balance is below one payment. Use “Get test funds” above.</p>}
                <p className="text-xs text-muted">
                  One {session.kind === 'passkey' ? 'passkey prompt' : 'signature'}: it authorises the billing key and records
                  the subscription in a single Tempo transaction. The first charge follows within seconds.
                </p>
                {error && <ErrorNote>{error}</ErrorNote>}
              </div>
            )}
          </Card>
        )}
      </div>
    </div>
  )
}
