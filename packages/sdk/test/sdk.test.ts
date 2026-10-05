import { describe, expect, it, vi } from 'vitest'
import { type Address, decodeFunctionData, encodeAbiParameters, keccak256, toHex } from 'viem'
import { Abis, Account } from 'viem/tempo'
import { planRegistryAbi, subscriptionLedgerAbi } from '@sile/abi'
import { ACCOUNT_KEYCHAIN, TIP20_SELECTORS } from '@sile/shared'
import {
  type SubscriptionIntentResponse,
  type TempoClient,
  buildCreatePlanCall,
  buildSubscribeCalls,
  getKeyAllowance,
  getSubscription,
  requestIntent,
  subscribe,
} from '../src/index'

const intent: SubscriptionIntentResponse = {
  intentId: 'int_1',
  keyId: '0x1111111111111111111111111111111111111111',
  publicKey: '0x04' + 'ab'.repeat(64),
  keyType: 'p256',
  token: '0x20C0000000000000000000000000000000000001',
  limit: '2500000',
  period: 60,
  expiry: 1_900_000_000,
  recipient: '0x2222222222222222222222222222222222222222',
  ledger: '0x3333333333333333333333333333333333333333',
  feePayer: '0x4444444444444444444444444444444444444444',
}

describe('call builders', () => {
  it('subscribe = [keychain.authorizeKey(scoped, periodic), ledger.subscribe]', () => {
    const [auth, sub] = buildSubscribeCalls(intent, 7n)
    expect(auth!.to).toBe(ACCOUNT_KEYCHAIN)
    expect(auth!.data.slice(0, 10)).toBe('0x980a6025') // canonical authorizeKey selector per Keychain spec
    const a = decodeFunctionData({ abi: Abis.accountKeychain, data: auth!.data }) as any
    const [keyId, sigType, r] = a.args
    expect(keyId).toBe(intent.keyId)
    expect(sigType).toBe(1)
    expect(r.enforceLimits).toBe(true)
    expect(r.allowAnyCalls).toBe(false)
    expect(r.limits).toEqual([{ token: intent.token, amount: 2_500_000n, period: 60n }])
    expect(r.allowedCalls).toEqual([
      { target: intent.token, selectorRules: [{ selector: TIP20_SELECTORS.transferWithMemo, recipients: [intent.recipient] }] },
    ])
    expect(r.expiry).toBe(1_900_000_000n)

    expect(sub!.to).toBe(intent.ledger)
    const s = decodeFunctionData({ abi: subscriptionLedgerAbi, data: sub!.data })
    expect(s.functionName).toBe('subscribe')
    expect(s.args).toEqual([7n, intent.keyId])
  })

  it('createPlan call encodes immutable terms', () => {
    const c = buildCreatePlanCall('0x5555555555555555555555555555555555555555', {
      token: intent.token as Address,
      amount: 9_990_000n,
      period: 2_592_000,
      metadataURI: 'data:application/json,{}',
    })
    const d = decodeFunctionData({ abi: planRegistryAbi, data: c.data })
    expect(d.args).toEqual([intent.token, 9_990_000n, 2_592_000n, 'data:application/json,{}', 0n])
  })
})

describe('requestIntent', () => {
  it('validates the charger response', async () => {
    const ok = vi.fn(async () => new Response(JSON.stringify(intent), { status: 201 })) as unknown as typeof fetch
    await expect(requestIntent('http://c/', 1n, intent.recipient as Address, ok)).resolves.toEqual(intent)
    expect((ok as any).mock.calls[0][0]).toBe('http://c/subscriptions/intent')

    const bad = vi.fn(async () => new Response(JSON.stringify({ ...intent, keyType: 'secp256k1' }))) as unknown as typeof fetch
    await expect(requestIntent('http://c', 1n, intent.recipient as Address, bad)).rejects.toThrow()

    const err = vi.fn(async () => new Response('nope', { status: 409 })) as unknown as typeof fetch
    await expect(requestIntent('http://c', 1n, intent.recipient as Address, err)).rejects.toThrow(/409/)
  })
})

describe('subscribe (mock client)', () => {
  it('sends ONE transaction with both calls and returns the sub id', async () => {
    const account = Account.fromSecp256k1(('0x' + '22'.repeat(32)) as `0x${string}`)
    const topic0 = keccak256(toHex('Subscribed(uint64,uint64,address,address)'))
    const pad = (v: string) => ('0x' + v.slice(2).padStart(64, '0')) as `0x${string}`
    const sendTransactionSync = vi.fn(async () => ({
      transactionHash: '0x' + 'aa'.repeat(32),
      logs: [
        {
          address: intent.ledger,
          topics: [topic0, pad(toHex(12n)), pad(toHex(7n)), pad(account.address)],
          data: encodeAbiParameters([{ type: 'address' }], [intent.keyId as Address]),
          blockNumber: 1n,
          logIndex: 0,
          transactionHash: '0x' + 'aa'.repeat(32),
          transactionIndex: 0,
          blockHash: '0x' + 'bb'.repeat(32),
          removed: false,
        },
      ],
    }))
    const client = { sendTransactionSync } as unknown as TempoClient
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(intent))) as unknown as typeof fetch

    const r = await subscribe(client, { account, chargerUrl: 'http://c', planId: 7n, fetchImpl })
    expect(r.subId).toBe(12n)
    expect(r.keyId).toBe(intent.keyId)
    expect(sendTransactionSync).toHaveBeenCalledTimes(1)
    expect((sendTransactionSync.mock.calls[0] as any)[0].calls).toHaveLength(2)
  })
})

describe('reads (mock client)', () => {
  it('maps ledger status and key allowance', async () => {
    const client = {
      readContract: vi.fn(async () => ({
        subscriber: intent.recipient,
        planId: 7n,
        status: 2,
        accessKey: intent.keyId,
        invoicesPaid: 3,
        lastPaidAt: 0n,
      })),
      accessKey: { getRemainingLimit: vi.fn(async () => ({ remaining: 0n, periodEnd: 0n })) },
    } as unknown as TempoClient
    const s = await getSubscription(client, { ledger: intent.ledger as Address, subId: 1n })
    expect(s).toMatchObject({ status: 'past_due', invoicesPaid: 3, lastPaidAt: null })
    const a = await getKeyAllowance(client, {
      subscriber: intent.recipient as Address,
      keyId: intent.keyId as Address,
      token: intent.token as Address,
    })
    expect(a).toEqual({ remaining: 0n, periodEnd: null, active: false })
  })
})
