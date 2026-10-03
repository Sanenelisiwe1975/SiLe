import { describe, expect, it } from 'vitest'
import vectors from '../vectors/invoice.json' with { type: 'json' }
import type { Address, Hex } from 'viem'
import {
  InvalidMemoError,
  SubscriptionIntentRequest,
  classifyChargeError,
  decodeInvoiceMemo,
  deploymentTag,
  encodeInvoiceMemo,
  isSileMemo,
} from '../src/index.js'
import { signWebhook, verifyWebhook } from '../src/webhooks.js'

describe('invoice memo codec (shared vectors with Invoice.sol)', () => {
  for (const c of vectors.cases) {
    it(`chain ${c.chainId} ledger ${c.ledger.slice(0, 8)} sub ${c.subId} seq ${c.seq}`, () => {
      const args = { chainId: BigInt(c.chainId), ledger: c.ledger as Address, subId: BigInt(c.subId), seq: c.seq }
      expect(deploymentTag(args.chainId, args.ledger)).toBe(c.deploymentTag)
      expect(encodeInvoiceMemo(args)).toBe(c.memo)
      expect(decodeInvoiceMemo(c.memo as Hex)).toEqual({
        subId: args.subId,
        seq: c.seq,
        deploymentTag: c.deploymentTag,
      })
    })
  }

  it('rejects foreign memos', () => {
    const good = vectors.cases[0]!.memo as Hex
    expect(isSileMemo(good)).toBe(true)
    expect(isSileMemo(('0x00' + good.slice(4)) as Hex)).toBe(false) // magic
    expect(isSileMemo((good.slice(0, 10) + '02' + good.slice(12)) as Hex)).toBe(false) // version
    expect(isSileMemo((good.slice(0, 12) + '000001' + good.slice(18)) as Hex)).toBe(false) // reserved
    expect(() => decodeInvoiceMemo('0x1234')).toThrow(InvalidMemoError)
  })
})

describe('classifyChargeError (shapes captured on Moderato)', () => {
  const nested = (details: string) => ({ shortMessage: 'outer', cause: { cause: { details } } })
  it.each([
    ['Account keychain error: SpendingLimitExceeded(SpendingLimitExceeded)', 'limit_exceeded'],
    ['Account keychain error: CallNotAllowed(CallNotAllowed)', 'scope_violation'],
    ['Revm error: keychain validation failed: AccountKeychainError(KeyAlreadyRevoked(KeyAlreadyRevoked))', 'key_invalid'],
    ['TIP20 token error: InsufficientBalance(InsufficientBalance { available: 0, required: 1000000 })', 'insufficient_balance'],
    ['fetch failed', 'transient'],
  ])('%s → %s', (details, kind) => {
    expect(classifyChargeError(nested(details))).toBe(kind)
  })
})

describe('webhook signatures', () => {
  it('signs and verifies, rejects tampering and stale timestamps', () => {
    const body = JSON.stringify({ hello: 'world' })
    const h = signWebhook('s3cret', body, 1000)
    expect(verifyWebhook('s3cret', body, h, { now: 1010 })).toBe(true)
    expect(verifyWebhook('s3cret', body + ' ', h, { now: 1010 })).toBe(false)
    expect(verifyWebhook('other', body, h, { now: 1010 })).toBe(false)
    expect(verifyWebhook('s3cret', body, h, { now: 2000 })).toBe(false)
    expect(verifyWebhook('s3cret', body, null)).toBe(false)
  })
})

describe('schemas', () => {
  it('coerces numeric plan ids', () => {
    const r = SubscriptionIntentRequest.parse({ planId: 3, subscriber: '0x' + '1'.repeat(40) })
    expect(r.planId).toBe('3')
  })
})
