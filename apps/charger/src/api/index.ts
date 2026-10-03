import { randomUUID } from 'node:crypto'
import { and, desc, eq, inArray } from 'drizzle-orm'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { HTTPException } from 'hono/http-exception'
import { type Address, getAddress } from 'viem'
import { Account, Expiry, P256 } from 'viem/tempo'
import { planRegistryAbi } from '@sile/abi'
import {
  KEY_EXPIRY_MONTHS,
  MODERATO,
  SECONDS_PER_MONTH,
  SubscriptionIntentRequest,
  type SubscriptionIntentResponse,
  txUrl,
  zAddress,
} from '@sile/shared'
import type { Chain } from '../chain.js'
import type { Config } from '../config.js'
import { type Db, getMeta, schema } from '../db/index.js'
import { invoiceDto, planDto, subscriptionDto } from '../dto.js'
import type { KeyStore } from '../keys/keystore.js'
import type { ChargeEngine } from '../scheduler/engine.js'

export type ApiDeps = { db: Db; chain: Chain; keys: KeyStore; engine: ChargeEngine; config: Config }

const addressParam = (v: string | undefined, name: string): Address => {
  const r = zAddress.safeParse(v)
  if (!r.success) throw new HTTPException(400, { message: `invalid ${name}` })
  return getAddress(r.data)
}

export function createApi({ db, chain, keys, engine, config }: ApiDeps) {
  const app = new Hono()
  app.use('*', cors({ origin: config.CORS_ORIGIN }))
  app.onError((err, c) => {
    if (err instanceof HTTPException) return c.json({ error: err.message }, err.status)
    console.error(err)
    return c.json({ error: 'internal error' }, 500)
  })

  app.get('/health', async (c) =>
    c.json({ ok: true, chainId: chain.chainId, lastBlock: (await getMeta(db, 'lastBlock')) ?? null }),
  )

  /** Public config the web app needs. */
  app.get('/config', (c) =>
    c.json({
      chainId: chain.chainId,
      rpcUrl: config.TEMPO_RPC_URL,
      explorerUrl: MODERATO.explorerUrl,
      planRegistry: chain.deployment.planRegistry,
      subscriptionLedger: chain.deployment.subscriptionLedger,
      feePayer: chain.operator.address,
      feeToken: config.FEE_TOKEN,
      demoPeriodSeconds: config.DEMO_PERIOD_SECONDS ?? null,
    }),
  )

  app.get('/plans', async (c) => {
    const merchant = c.req.query('merchant')
    const rows = await db.query.plans.findMany({
      where: merchant ? eq(schema.plans.merchant, addressParam(merchant, 'merchant')) : undefined,
    })
    return c.json(rows.map(planDto))
  })

  app.get('/plans/:id', async (c) => {
    const row = await db.query.plans.findFirst({ where: eq(schema.plans.planId, c.req.param('id')) })
    if (!row) throw new HTTPException(404, { message: 'plan not found' })
    return c.json(planDto(row))
  })

  /**
   * Checkout step 1: mint a fresh P256 access key for (subscriber, plan) and return the exact terms
   * the subscriber must authorise. The private key never leaves the charger.
   */
  app.post('/subscriptions/intent', async (c) => {
    const body = SubscriptionIntentRequest.safeParse(await c.req.json().catch(() => null))
    if (!body.success) throw new HTTPException(400, { message: body.error.message })
    const subscriber = getAddress(body.data.subscriber)

    const plan = await chain.client
      .readContract({
        address: chain.deployment.planRegistry,
        abi: planRegistryAbi,
        functionName: 'getPlan',
        args: [BigInt(body.data.planId)],
      })
      .catch(() => {
        throw new HTTPException(404, { message: 'plan not found' })
      })
    if (!plan.active) throw new HTTPException(409, { message: 'plan inactive' })

    const privateKey = P256.randomPrivateKey()
    const key = Account.fromP256(privateKey, { access: subscriber })
    const keyId = getAddress(key.accessKeyAddress) // viem returns it lowercase; store checksummed
    const intentId = `int_${randomUUID()}`
    await db.insert(schema.accessKeys).values({
      keyId,
      intentId,
      planId: body.data.planId,
      subscriber,
      publicKey: key.publicKey,
      encryptedPrivateKey: await keys.seal(privateKey),
      createdAt: Math.floor(Date.now() / 1000),
    })

    const res: SubscriptionIntentResponse = {
      intentId,
      keyId,
      publicKey: key.publicKey,
      keyType: 'p256',
      token: plan.token,
      limit: plan.amount.toString(),
      period: Number(plan.period),
      expiry: Expiry.months(KEY_EXPIRY_MONTHS),
      recipient: plan.merchant,
      ledger: chain.deployment.subscriptionLedger,
      feePayer: chain.operator.address,
    }
    return c.json(res, 201)
  })

  app.get('/subscriptions', async (c) => {
    const merchant = c.req.query('merchant')
    const subscriber = c.req.query('subscriber')
    if (!merchant && !subscriber) throw new HTTPException(400, { message: 'merchant or subscriber required' })
    const rows = await db.query.subscriptions.findMany({
      where: and(
        merchant ? eq(schema.subscriptions.merchant, addressParam(merchant, 'merchant')) : undefined,
        subscriber ? eq(schema.subscriptions.subscriber, addressParam(subscriber, 'subscriber')) : undefined,
      ),
      orderBy: desc(schema.subscriptions.createdAt),
    })
    const plans = await db.query.plans.findMany({
      where: inArray(schema.plans.planId, [...new Set(rows.map((r) => r.planId)), '']),
    })
    const planById = new Map(plans.map((p) => [p.planId, planDto(p)]))
    return c.json(rows.map((r) => ({ ...subscriptionDto(r), haltReason: r.haltReason, plan: planById.get(r.planId) })))
  })

  app.get('/subscriptions/:id', async (c) => {
    const sub = await db.query.subscriptions.findFirst({ where: eq(schema.subscriptions.subId, c.req.param('id')) })
    if (!sub) throw new HTTPException(404, { message: 'subscription not found' })
    const invs = await db.query.invoices.findMany({
      where: eq(schema.invoices.subId, sub.subId),
      orderBy: desc(schema.invoices.seq),
    })
    return c.json({ ...subscriptionDto(sub), haltReason: sub.haltReason, invoices: invs.map(invoiceDto) })
  })

  app.get('/merchants/:merchant/metrics', async (c) => {
    const merchant = addressParam(c.req.param('merchant'), 'merchant')
    const subs = await db.query.subscriptions.findMany({ where: eq(schema.subscriptions.merchant, merchant) })
    const ids = subs.map((s) => s.subId)
    const invs = ids.length ? await db.query.invoices.findMany({ where: inArray(schema.invoices.subId, ids) }) : []
    const active = subs.filter((s) => s.status === 'active')
    // MRR normalised to a 30-day month (Tempo periods are fixed seconds).
    const mrr = active.reduce((acc, s) => acc + (BigInt(s.amount) * BigInt(SECONDS_PER_MONTH)) / BigInt(s.period), 0n)
    const collected = invs.filter((i) => i.status === 'paid').reduce((acc, i) => acc + BigInt(i.amount), 0n)
    return c.json({
      mrr: mrr.toString(),
      collected: collected.toString(),
      counts: {
        active: active.length,
        pastDue: subs.filter((s) => s.status === 'past_due').length,
        canceled: subs.filter((s) => s.status === 'canceled').length,
      },
      failedInvoices: invs.filter((i) => i.failureKind && i.status !== 'paid').map(invoiceDto),
    })
  })

  /** Reconciliation export keyed on tx hash + memo. */
  app.get('/merchants/:merchant/invoices.csv', async (c) => {
    const merchant = addressParam(c.req.param('merchant'), 'merchant')
    const subs = await db.query.subscriptions.findMany({ where: eq(schema.subscriptions.merchant, merchant) })
    const subById = new Map(subs.map((s) => [s.subId, s]))
    const invs = subs.length
      ? await db.query.invoices.findMany({ where: inArray(schema.invoices.subId, [...subById.keys()]) })
      : []
    const header = 'tx_hash,memo,sub_id,seq,subscriber,plan_id,token,amount,status,paid_at,explorer_url'
    const lines = invs.map((i) => {
      const s = subById.get(i.subId)!
      return [
        i.txHash ?? '',
        i.invoiceId,
        i.subId,
        i.seq,
        s.subscriber,
        s.planId,
        i.token,
        i.amount,
        i.status,
        i.paidAt ? new Date(i.paidAt * 1000).toISOString() : '',
        i.txHash ? txUrl(i.txHash as `0x${string}`) : '',
      ].join(',')
    })
    c.header('content-type', 'text/csv')
    c.header('content-disposition', `attachment; filename="sile-invoices-${merchant}.csv"`)
    return c.body([header, ...lines].join('\n') + '\n')
  })

  if (config.demo) {
    /** DEMO: attempt amount + 1 → protocol rejects with SpendingLimitExceeded (on-chain revert). */
    app.post('/demo/overcharge/:id', async (c) => {
      const r = await engine.overcharge(c.req.param('id'))
      return c.json({ ...r, url: txUrl(r.txHash) })
    })
    /** DEMO: run a billing tick now instead of waiting for the interval. */
    app.post('/demo/tick', async (c) => c.json({ processed: await engine.tick() }))
  }

  return app
}
