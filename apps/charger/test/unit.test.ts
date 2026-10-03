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
})

describe('config', () => {
  it('parses dunning schedule and demo flag', () => {
    const c = loadConfig(env as any)
    expect(c.DUNNING_SCHEDULE_SECONDS).toEqual(SCHEDULE)
    expect(c.demo).toBe(true)
    expect(loadConfig({ ...env, DEMO_PERIOD_SECONDS: undefined } as any).demo).toBe(false)
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
