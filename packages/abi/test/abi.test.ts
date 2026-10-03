import { describe, expect, it } from 'vitest'
import { encodeFunctionData, toFunctionSelector } from 'viem'
import { MODERATO } from '@sile/shared'
import { getDeployment, planRegistryAbi, subscriptionLedgerAbi } from '../src/index.js'

describe('@sile/abi', () => {
  it('has a Moderato deployment', () => {
    const d = getDeployment(MODERATO.chainId)
    expect(d.subscriptionLedger).toMatch(/^0x[0-9a-fA-F]{40}$/)
    expect(() => getDeployment(1)).toThrow()
  })

  it('exposes the functions the charger and web rely on', () => {
    const names = (abi: readonly { type: string; name?: string }[]) =>
      abi.filter((x) => x.type === 'function').map((x) => x.name)
    expect(names(subscriptionLedgerAbi)).toEqual(
      expect.arrayContaining(['subscribe', 'cancel', 'markPaid', 'markPastDue', 'markCanceled', 'nextInvoiceId', 'getSubscription']),
    )
    expect(names(planRegistryAbi)).toEqual(expect.arrayContaining(['createPlan', 'deactivate', 'getPlan']))
  })

  it('types are precise (as const)', () => {
    const data = encodeFunctionData({
      abi: subscriptionLedgerAbi,
      functionName: 'subscribe',
      args: [1n, '0x0000000000000000000000000000000000000001'],
    })
    expect(data.slice(0, 10)).toBe(toFunctionSelector('subscribe(uint64,address)'))
  })
})
