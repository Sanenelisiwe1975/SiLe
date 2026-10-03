/**
 * End-to-end charger run on Moderato using the real indexer, engine and API (in-process, fresh DB).
 * Run: pnpm --filter @sile/charger e2e
 *
 *  A: subscribe in ONE signature (key minted by the charger, authorised by public key) → charge #1 →
 *     charge #2 after the period → over-limit attempt reverts on-chain → subscriber revokes →
 *     next charge rejected by the protocol → dunning cancels immediately.
 *  B: subscriber drains balance → insufficient balance → past_due → retries → canceled.
 */
import { type Address, type Hex, encodeFunctionData, parseEventLogs } from 'viem'
import { generatePrivateKey } from 'viem/accounts'
import { Abis, Account, Scopes } from 'viem/tempo'
import { eq } from 'drizzle-orm'
import { planRegistryAbi, subscriptionLedgerAbi } from '@sile/abi'
import { type SubscriptionIntentResponse, txUrl } from '@sile/shared'
import { createApi } from '../src/api/index.js'
import { createChain } from '../src/chain.js'
import { loadConfig } from '../src/config.js'
import { openDb, schema } from '../src/db/index.js'
import { Indexer } from '../src/indexer/index.js'
import { EnvSecretKeyStore } from '../src/keys/keystore.js'
import { ChargeEngine } from '../src/scheduler/engine.js'
import { Webhooks } from '../src/webhooks.js'

const PERIOD = 20
const AMOUNT = 1_000_000n
const config = loadConfig({ ...process.env, DUNNING_SCHEDULE_SECONDS: '3,3,3', DEMO_PERIOD_SECONDS: String(PERIOD) })
const db = await openDb(':memory:')
const chain = createChain(config)
const { client, deployment } = chain
const keys = new EnvSecretKeyStore(config.KEYSTORE_SECRET)
const events: string[] = []
const webhooks = new Webhooks(db, config.WEBHOOK_SECRET, undefined)
const emit = webhooks.emit.bind(webhooks)
webhooks.emit = async (type, sub, inv) => {
  events.push(`${type}#${sub.subId}`)
  return emit(type, sub, inv)
}
const indexer = new Indexer(db, chain, webhooks)
const engine = new ChargeEngine(db, chain, keys, webhooks, config)
const api = createApi({ db, chain, keys, engine, config })

const sleep = (s: number) => new Promise((r) => setTimeout(r, s * 1000))
const now = () => Math.floor(Date.now() / 1000)
let failures = 0
const check = (ok: boolean, msg: string) => {
  console.log(`${ok ? '✔' : '✘'} ${msg}`)
  if (!ok) failures++
}
const sub = async (id: string) => (await db.query.subscriptions.findFirst({ where: eq(schema.subscriptions.subId, id) }))!
const invoicesOf = (id: string) => db.query.invoices.findMany({ where: eq(schema.invoices.subId, id) })
const ledgerSub = (id: string) =>
  client.readContract({
    address: deployment.subscriptionLedger,
    abi: subscriptionLedgerAbi,
    functionName: 'getSubscription',
    args: [BigInt(id)],
  })
async function runUntil(id: string, pred: (s: Awaited<ReturnType<typeof sub>>) => boolean, label: string, maxSec = 120) {
  const start = now()
  while (now() - start < maxSec) {
    await indexer.poll()
    await engine.tick()
    if (pred(await sub(id))) return true
    await sleep(2)
  }
  check(false, `timeout waiting for ${label}`)
  return false
}

const merchant = Account.fromSecp256k1(process.env.MERCHANT_PRIVATE_KEY as Hex)
console.log('indexing from deployment block… (first poll may take a moment)')
await indexer.poll()

// ---- merchant creates a plan
const planRc = await client.sendTransactionSync({
  account: merchant,
  calls: [
    {
      to: deployment.planRegistry,
      data: encodeFunctionData({
        abi: planRegistryAbi,
        functionName: 'createPlan',
        args: [config.FEE_TOKEN as Address, AMOUNT, BigInt(PERIOD), 'ipfs://e2e', 0n],
      }),
    },
  ],
})
const planId = (parseEventLogs({ abi: planRegistryAbi, logs: planRc.logs, eventName: 'PlanCreated' })[0]!.args as any)
  .planId as bigint
console.log(`plan ${planId} (${PERIOD}s period)`)

/** Mirrors the web checkout: intent from API → ONE root-signed tx (keyAuthorization + subscribe). */
async function checkout(subscriber: ReturnType<typeof Account.fromSecp256k1>) {
  const res = await api.request('/subscriptions/intent', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ planId: planId.toString(), subscriber: subscriber.address }),
  })
  const intent = (await res.json()) as SubscriptionIntentResponse
  const keyAuthorization = await client.accessKey.signAuthorization({
    account: subscriber,
    accessKey: { publicKey: intent.publicKey as Hex, type: 'p256' },
    expiry: intent.expiry,
    limits: [{ token: intent.token as Address, limit: BigInt(intent.limit), period: intent.period }],
    scopes: [Scopes.tip20(intent.token as Address).transferWithMemo({ recipients: [intent.recipient as Address] })],
  } as any)
  const rc = await client.sendTransactionSync({
    account: subscriber,
    keyAuthorization,
    calls: [
      {
        to: intent.ledger as Address,
        data: encodeFunctionData({
          abi: subscriptionLedgerAbi,
          functionName: 'subscribe',
          args: [planId, intent.keyId as Address],
        }),
      },
    ],
  })
  const subId = (parseEventLogs({ abi: subscriptionLedgerAbi, logs: rc.logs, eventName: 'Subscribed' })[0]!.args as any)
    .subId.toString() as string
  console.log(`subscribed #${subId} in one tx ${txUrl(rc.transactionHash)}`)
  return { subId, intent }
}

// ================= A: happy path → overcharge → revoke =================
console.log('\n== A: charge, recur, overcharge, revoke')
const alice = Account.fromSecp256k1(generatePrivateKey())
await client.faucet.fundSync({ account: alice.address })
const A = await checkout(alice)

await runUntil(A.subId, (s) => s.invoicesPaid >= 1, 'charge #1')
let invs = await invoicesOf(A.subId)
check(invs.some((i) => i.seq === 0 && i.status === 'paid' && !!i.txHash), `charge #1 paid ${txUrl(invs[0]!.txHash as Hex)}`)
check((await ledgerSub(A.subId)).invoicesPaid === 1, 'ledger invoicesPaid = 1')
check((await sub(A.subId)).managed, 'subscription is managed (key minted by charger)')

const nextAt = (await sub(A.subId)).nextChargeAt!
check(nextAt > now(), `next charge scheduled from chain periodEnd (+${nextAt - now()}s)`)
await engine.tick()
check((await sub(A.subId)).invoicesPaid === 1, 'no early charge before periodEnd')

const over = await engine.overcharge(A.subId)
check(over.status === 'reverted', `over-limit charge reverted on-chain ${txUrl(over.txHash)}`)

await runUntil(A.subId, (s) => s.invoicesPaid >= 2, 'charge #2', PERIOD + 60)
invs = await invoicesOf(A.subId)
check(invs.some((i) => i.seq === 1 && i.status === 'paid'), `charge #2 paid ${txUrl(invs.find((i) => i.seq === 1)!.txHash as Hex)}`)

const revoke = await client.accessKey.revokeSync({ account: alice, accessKey: A.intent.keyId as Address })
console.log(`alice revoked key ${txUrl(revoke.receipt.transactionHash)}`)
await runUntil(A.subId, (s) => s.status === 'canceled', 'cancel after revoke', PERIOD + 60)
const failedA = (await invoicesOf(A.subId)).find((i) => i.seq === 2)
check(failedA?.failureKind === 'key_invalid', `next charge rejected by protocol: ${failedA?.lastError?.match(/KeyAlreadyRevoked|KeyExpired|KeyNotFound/)?.[0]}`)
check((await ledgerSub(A.subId)).status === 3, 'ledger status = Canceled')

// ================= B: insufficient balance → dunning =================
console.log('\n== B: insufficient balance dunning')
const bob = Account.fromSecp256k1(generatePrivateKey())
await client.faucet.fundSync({ account: bob.address })
const B = await checkout(bob)
await runUntil(B.subId, (s) => s.invoicesPaid >= 1, 'bob charge #1')
// Bob moves all his billing-token balance away (fees for this tx paid in pathUSD).
const bal = await client.readContract({ address: config.FEE_TOKEN as Address, abi: Abis.tip20, functionName: 'balanceOf', args: [bob.address] })
await client.sendTransactionSync({
  account: bob,
  feeToken: '0x20c0000000000000000000000000000000000000',
  calls: [
    {
      to: config.FEE_TOKEN as Address,
      data: encodeFunctionData({ abi: Abis.tip20, functionName: 'transfer', args: [merchant.address, bal] }),
    },
  ],
})
console.log(`bob drained ${bal} base units`)
await runUntil(B.subId, (s) => s.status === 'past_due', 'past_due', PERIOD + 60)
check((await ledgerSub(B.subId)).status === 2, 'ledger status = PastDue after first failure')
await runUntil(B.subId, (s) => s.status === 'canceled', 'canceled after retries', 120)
const failedB = (await invoicesOf(B.subId)).find((i) => i.seq === 1)
check(failedB?.failureKind === 'insufficient_balance' && failedB.attempts === 4, `dunning attempts=${failedB?.attempts} then canceled`)
check((await ledgerSub(B.subId)).status === 3, 'ledger status = Canceled')

// ================= webhooks + API =================
for (const e of [`subscription.created#${A.subId}`, `subscription.charged#${A.subId}`, `subscription.canceled#${A.subId}`, `subscription.past_due#${B.subId}`])
  check(events.includes(e), `webhook ${e}`)
const csv = await (await api.request(`/merchants/${merchant.address}/invoices.csv`)).text()
check(csv.includes(invs[0]!.txHash!) && csv.includes(invs[0]!.invoiceId), 'CSV export keyed on tx hash + memo')
const metrics = (await (await api.request(`/merchants/${merchant.address}/metrics`)).json()) as any
check(metrics.counts.canceled >= 2, `metrics: ${JSON.stringify(metrics.counts)}`)

console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nE2E OK')
process.exit(failures ? 1 : 0)
