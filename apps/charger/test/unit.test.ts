import { eq } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'
import { getAddress } from 'viem'
import { Account } from 'viem/tempo'
import { verifyWebhook } from '@sile/shared/webhooks'
import { createApi } from '../src/api/index.js'
import type { Chain } from '../src/chain.js'
import { loadConfig } from '../src/config.js'
import { openDb, schema } from '../src/db/index.js'
import { decide } from '../src/dunning/policy.js'
import { EnvSecretKeyStore } from '../src/keys/keystore.js'
import type { ChargeEngine } from '../src/scheduler/engine.js'
import { Webhooks } from '../src/webhooks.js'

const SCHEDULE = [10, 30, 60]
const env = {
  OPERATOR_PRIVATE_KEY: '0x' + '11'.repeat(32),
  KEYSTORE_SECRET: 'k'.repeat(64),
  WEBHOOK_SECRET: 'w'.repeat(32),
  DUNNING_SCHEDULE_SECONDS: SCHEDULE.join(','),
  DEMO_PERIOD_SECONDS: '60',
}

describe('dunning policy', () => {
  it('retries insufficient balance on schedule, past-due on first failure, cancels when exhausted', () => {
    expect(decide('insufficient_balance', 1, SCHEDULE, 100)).toEqual({
      action: 'retry',
      retryAt: 110,
      countsAsAttempt: true,
      markPastDue: true,
    })
    expect(decide('insufficient_balance', 3, SCHEDULE, 100)).toMatchObject({ retryAt: 160, markPastDue: false })
    expect(decide('insufficient_balance', 4, SCHEDULE, 100)).toEqual({ action: 'cancel', reason: 'dunning_exhausted' })
  })
  it('stops immediately on revoked/expired keys', () => {
    expect(decide('key_invalid', 1, SCHEDULE, 0)).toEqual({ action: 'cancel', reason: 'key_revoked_or_expired' })
  })
  it('waits for next period on limit, halts on scope, backs off on transient without counting', () => {
    expect(decide('limit_exceeded', 1, SCHEDULE, 0)).toEqual({ action: 'wait_period' })
    expect(decide('scope_violation', 1, SCHEDULE, 0)).toMatchObject({ action: 'halt' })
    expect(decide('transient', 1, SCHEDULE, 0)).toMatchObject({ action: 'retry', countsAsAttempt: false })
  })
})

describe('keystore', () => {
  const ks = new EnvSecretKeyStore('s'.repeat(40))
  const pk = ('0x' + 'ab'.repeat(32)) as `0x${string}`
  it('roundtrips and does not leak plaintext', async () => {
    const sealed = await ks.seal(pk)
    expect(sealed).not.toContain('abab')
    expect(await ks.open(sealed)).toBe(pk)
  })
  it('rejects tampering and wrong secret', async () => {
    const sealed = await ks.seal(pk)
    const parts = sealed.split('.')
    parts[3] = Buffer.from('x'.repeat(66)).toString('base64')
    await expect(ks.open(parts.join('.'))).rejects.toThrow()
    await expect(new EnvSecretKeyStore('t'.repeat(40)).open(sealed)).rejects.toThrow()
  })
  it('rejects insecure secrets and placeholder defaults', () => {
    expect(() => new EnvSecretKeyStore('changeme12345678901234567890')).toThrow(/placeholder|insecure/i)
    expect(() => new EnvSecretKeyStore('short')).toThrow(/at least 32/i)
  })
})

describe('config', () => {
  it('parses dunning schedule and demo flag', () => {
    const c = loadConfig(env as any)
    expect(c.DUNNING_SCHEDULE_SECONDS).toEqual(SCHEDULE)
    expect(c.demo).toBe(true)
    expect(loadConfig({ ...env, DEMO_PERIOD_SECONDS: undefined } as any).demo).toBe(false)
  })
  it('rejects placeholder key store secrets', () => {
    expect(() => loadConfig({ ...env, KEYSTORE_SECRET: 'changeme12345678901234567890' } as any)).toThrow(/placeholder|insecure/i)
  })

  it('requires https for remote webhook URLs while allowing localhost', () => {
    expect(() => loadConfig({ ...env, WEBHOOK_URL: 'http://example.com/hook' } as any)).toThrow(/https/i)
    expect(() => loadConfig({ ...env, WEBHOOK_URL: 'http://localhost:3000/hook' } as any)).not.toThrow()
    expect(() => loadConfig({ ...env, WEBHOOK_URL: 'https://example.com/hook' } as any)).not.toThrow()
  })
})

describe('API: subscription intent', () => {
  it('mints a P256 key, stores it sealed, returns plan terms', async () => {
    const config = loadConfig(env as any)
    const db = await openDb(':memory:')
    const keys = new EnvSecretKeyStore(config.KEYSTORE_SECRET)
    const merchant = '0x00000000000000000000000000000000000000Aa'
    const token = '0x20C0000000000000000000000000000000000001'
    const chain = {
      chainId: 42431,
      operator: Account.fromSecp256k1(config.OPERATOR_PRIVATE_KEY as `0x${string}`),
      deployment: {
        planRegistry: '0x0000000000000000000000000000000000000001',
        subscriptionLedger: '0x0000000000000000000000000000000000000002',
        operator: '0x0000000000000000000000000000000000000003',
        startBlock: 0,
      },
      client: {
        readContract: vi.fn(async () => ({ merchant, token, amount: 5_000_000n, period: 60n, active: true })),
      },
    } as unknown as Chain
    const app = createApi({ db, chain, keys, engine: {} as ChargeEngine, config })
    const subscriber = '0x1111111111111111111111111111111111111111'

    const res = await app.request('/subscriptions/intent', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ planId: 1, subscriber }),
    })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body).toMatchObject({ keyType: 'p256', limit: '5000000', period: 60, recipient: merchant, token })
    expect(body.keyId).not.toBe(subscriber) // key id is accessKeyAddress, not the parent account

    const [row] = await db.select().from(schema.accessKeys)
    expect(row!.keyId).toBe(body.keyId)
    expect(row!.encryptedPrivateKey.startsWith('v1.')).toBe(true)
    const pk = await keys.open(row!.encryptedPrivateKey)
    expect(getAddress(Account.fromP256(pk, { access: subscriber }).accessKeyAddress)).toBe(body.keyId)

    const bad = await app.request('/subscriptions/intent', { method: 'POST', body: '{"planId":1}' })
    expect(bad.status).toBe(400)
  })
})

describe('charge engine recovery', () => {
  it('falls back to the local period schedule when key lookup is unavailable during reconciliation', async () => {
    const db = await openDb(':memory:')
    const config = loadConfig(env as any)
    const chain = {
      chainId: 42431,
      operator: Account.fromSecp256k1(config.OPERATOR_PRIVATE_KEY as `0x${string}`),
      deployment: {
        planRegistry: '0x0000000000000000000000000000000000000001',
        subscriptionLedger: '0x0000000000000000000000000000000000000002',
        operator: '0x0000000000000000000000000000000000000003',
        startBlock: 0,
      },
      client: {
        accessKey: {
          getRemainingLimit: vi.fn(async () => {
            throw new Error('key not found')
          }),
        },
      },
    } as unknown as Chain
    const engine = new (await import('../src/scheduler/engine.js')).ChargeEngine(
      db,
      chain,
      new EnvSecretKeyStore(config.KEYSTORE_SECRET),
      new Webhooks(db, config.WEBHOOK_SECRET, 'https://example.test/hook'),
      config,
    )

    const sub = {
      subId: '42',
      planId: '7',
      subscriber: '0x1111111111111111111111111111111111111111',
      merchant: '0x00000000000000000000000000000000000000Aa',
      accessKey: '0x2222222222222222222222222222222222222222',
      token: '0x20C0000000000000000000000000000000000001',
      amount: '100',
      period: 60,
      status: 'active' as const,
      invoicesPaid: 0,
      nextChargeAt: 0,
      managed: true,
      haltReason: null,
      createdBlock: 0,
      createdAt: 0,
    }
    const fallback = 1_700_000_000 + 60
    await expect((engine as any).nextChargeAtAfterPeriod(sub, fallback)).resolves.toBe(fallback)
  })

  it('reconciles stale pending invoices back to paid when the transfer memo is on-chain', async () => {
    const db = await openDb(':memory:')
    const config = loadConfig(env as any)
    const txHash = '0x' + '11'.repeat(32)
    const sub = {
      subId: '99',
      planId: '7',
      subscriber: '0x1111111111111111111111111111111111111111',
      merchant: '0x00000000000000000000000000000000000000Aa',
      accessKey: '0x2222222222222222222222222222222222222222',
      token: '0x20C0000000000000000000000000000000000001',
      amount: '100',
      period: 60,
      status: 'active' as const,
      invoicesPaid: 0,
      nextChargeAt: 0,
      managed: true,
      haltReason: null,
      createdBlock: 0,
      createdAt: 0,
    }
    await db.insert(schema.subscriptions).values(sub)
    const invoiceId = '0x' + '22'.repeat(32)
    await db.insert(schema.invoices).values({
      invoiceId,
      subId: sub.subId,
      seq: 0,
      amount: sub.amount,
      token: sub.token,
      status: 'pending',
      attempts: 0,
      createdAt: 0,
    })

    const chain = {
      chainId: 42431,
      operator: Account.fromSecp256k1(config.OPERATOR_PRIVATE_KEY as `0x${string}`),
      deployment: {
        planRegistry: '0x0000000000000000000000000000000000000001',
        subscriptionLedger: '0x0000000000000000000000000000000000000002',
        operator: '0x0000000000000000000000000000000000000003',
        startBlock: 0,
      },
      client: {
        getBlockNumber: vi.fn(async () => 100n),
        getLogs: vi.fn(async () => [{ transactionHash: txHash, args: { from: sub.subscriber, memo: invoiceId } }]),
        accessKey: {
          getRemainingLimit: vi.fn(async () => ({ remaining: 100n, periodEnd: 200n })),
        },
        readContract: vi.fn(async () => ({ invoicesPaid: 0n })),
        sendTransactionSync: vi.fn(async () => ({ transactionHash: txHash })),
      },
    } as unknown as Chain
    const engine = new (await import('../src/scheduler/engine.js')).ChargeEngine(
      db,
      chain,
      new EnvSecretKeyStore(config.KEYSTORE_SECRET),
      new Webhooks(db, config.WEBHOOK_SECRET, 'https://example.test/hook'),
      config,
    )

    await expect(engine.reconcileStaleInvoices()).resolves.toBe(1)
    const row = await db.query.invoices.findFirst({ where: eq(schema.invoices.invoiceId, invoiceId) })
    expect(row?.status).toBe('paid')
  })

  it('restores managed subscription schedules when the local nextChargeAt was cleared', async () => {
    const db = await openDb(':memory:')
    const config = loadConfig(env as any)
    const chain = {
      chainId: 42431,
      operator: Account.fromSecp256k1(config.OPERATOR_PRIVATE_KEY as `0x${string}`),
      deployment: {
        planRegistry: '0x0000000000000000000000000000000000000001',
        subscriptionLedger: '0x0000000000000000000000000000000000000002',
        operator: '0x0000000000000000000000000000000000000003',
        startBlock: 0,
      },
      client: {
        accessKey: {
          getRemainingLimit: vi.fn(async () => ({ remaining: 100n, periodEnd: 180n })),
        },
      },
    } as unknown as Chain
    const engine = new (await import('../src/scheduler/engine.js')).ChargeEngine(
      db,
      chain,
      new EnvSecretKeyStore(config.KEYSTORE_SECRET),
      new Webhooks(db, config.WEBHOOK_SECRET, 'https://example.test/hook'),
      config,
    )
    await db.insert(schema.subscriptions).values({
      subId: '88',
      planId: '1',
      subscriber: '0x1111111111111111111111111111111111111111',
      merchant: '0x00000000000000000000000000000000000000Aa',
      accessKey: '0x2222222222222222222222222222222222222222',
      token: '0x20C0000000000000000000000000000000000001',
      amount: '100',
      period: 60,
      status: 'active',
      invoicesPaid: 0,
      nextChargeAt: null,
      managed: true,
      haltReason: null,
      createdBlock: 0,
      createdAt: 0,
    })

    await expect(engine.reconcileManagedSubscriptions()).resolves.toBe(1)
    const row = await db.query.subscriptions.findFirst({ where: eq(schema.subscriptions.subId, '88') })
    expect(row?.nextChargeAt).toBe(180)
  })
})

describe('webhooks outbox', () => {
  it('delivers signed payloads and retries failures', async () => {
    const db = await openDb(':memory:')
    const calls: { body: string; sig: string | null }[] = []
    let fail = true
    const fetchImpl = vi.fn(async (_url: any, init: any) => {
      calls.push({ body: init.body, sig: init.headers['X-SiLe-Signature'] })
      return new Response(null, { status: fail ? 500 : 200 })
    }) as unknown as typeof fetch
    const wh = new Webhooks(db, 'w'.repeat(32), 'https://example.test/hook', fetchImpl)
    const sub = {
      subId: '1',
      planId: '1',
      subscriber: '0x1111111111111111111111111111111111111111',
      accessKey: '0x2222222222222222222222222222222222222222',
      status: 'active' as const,
      invoicesPaid: 0,
      nextChargeAt: null,
      createdAt: 0,
    }
    await wh.emit('subscription.created', sub)
    await wh.flush()
    const [d] = await db.select().from(schema.webhookDeliveries)
    expect(d!.status).toBe('pending')
    expect(d!.attempts).toBeGreaterThanOrEqual(1)
    expect(verifyWebhook('w'.repeat(32), calls[0]!.body, calls[0]!.sig)).toBe(true)

    fail = false
    await db.update(schema.webhookDeliveries).set({ nextAttemptAt: 0 })
    await wh.flush()
    const [d2] = await db.select().from(schema.webhookDeliveries)
    expect(d2!.status).toBe('delivered')
  })
})
