/**
 * Smoke test of the deployed contracts against the REAL keychain precompile on Moderato.
 * Run: pnpm tsx --env-file=.env scripts/smoke-ledger.ts <PlanRegistry> <SubscriptionLedger>
 *
 * merchant createPlan → subscriber signs ONE tx (keyAuthorization + ledger.subscribe, fee sponsored)
 * → charger charges with ledger.nextInvoiceId memo → operator markPaid → negative: low-limit key rejected.
 */
import { readFileSync } from 'node:fs'
import { type Address, type Hex, encodeFunctionData, http, parseEventLogs } from 'viem'
import { generatePrivateKey } from 'viem/accounts'
import { tempoModerato } from 'viem/chains'
import { Abis, Account, Expiry, P256, Scopes, createClient } from 'viem/tempo'

const [registry, ledger] = process.argv.slice(2) as [Address, Address]
if (!registry || !ledger) throw new Error('usage: smoke-ledger.ts <registry> <ledger>')

const ALPHA_USD = '0x20c0000000000000000000000000000000000001' as const
const EXPLORER = 'https://explore.testnet.tempo.xyz/tx/'
const abi = (n: string) => JSON.parse(readFileSync(`contracts/out/${n}.sol/${n}.json`, 'utf8')).abi
const registryAbi = abi('PlanRegistry')
const ledgerAbi = abi('SubscriptionLedger')
const errAbi = [...ledgerAbi, ...registryAbi]

const client = createClient({ chain: tempoModerato, transport: http(), feeToken: ALPHA_USD })
const operator = Account.fromSecp256k1(process.env.OPERATOR_PRIVATE_KEY as Hex)
const merchantAcct = Account.fromSecp256k1(process.env.MERCHANT_PRIVATE_KEY as Hex)
const subscriber = Account.fromSecp256k1(generatePrivateKey()) // fresh, funded below
await client.faucet.fundSync({ account: subscriber.address })

const AMOUNT = 1_000_000n
const PERIOD = 60

// 1. merchant creates a plan
const planRc = await client.sendTransactionSync({
  account: merchantAcct,
  calls: [
    {
      to: registry,
      data: encodeFunctionData({
        abi: registryAbi,
        functionName: 'createPlan',
        args: [ALPHA_USD, AMOUNT, BigInt(PERIOD), 'ipfs://smoke', 0n],
      }),
    },
  ],
})
const [planEv] = parseEventLogs({ abi: registryAbi, logs: planRc.logs, eventName: 'PlanCreated' }) as any[]
const planId = planEv.args.planId as bigint
console.log(`plan ${planId} created ${EXPLORER}${planRc.transactionHash}`)

// 2. one signature: authorise key + subscribe
async function subscribeWithKey(limit: bigint) {
  const key = Account.fromP256(P256.randomPrivateKey(), { access: subscriber })
  const keyAuthorization = await client.accessKey.signAuthorization({
    account: subscriber,
    accessKey: key,
    expiry: Expiry.months(12),
    limits: [{ token: ALPHA_USD, limit, period: PERIOD }],
    scopes: [Scopes.tip20(ALPHA_USD).transferWithMemo({ recipients: [merchantAcct.address] })],
  })
  const rc = await client.sendTransactionSync({
    account: subscriber,
    feePayer: operator,
    keyAuthorization,
    calls: [
      {
        to: ledger,
        data: encodeFunctionData({ abi: ledgerAbi, functionName: 'subscribe', args: [planId, key.accessKeyAddress] }),
      },
    ],
  })
  return { key, rc }
}

const { key, rc: subRc } = await subscribeWithKey(AMOUNT)
const [subEv] = parseEventLogs({ abi: ledgerAbi, logs: subRc.logs, eventName: 'Subscribed' }) as any[]
const subId = subEv.args.subId as bigint
console.log(`subscribed sub ${subId} key ${key.accessKeyAddress} in ONE tx ${EXPLORER}${subRc.transactionHash}`)

// 3. charge with the ledger-defined memo
const memo = (await client.readContract({ address: ledger, abi: ledgerAbi, functionName: 'nextInvoiceId', args: [subId] })) as Hex
const chargeRc = await client.sendTransactionSync({
  account: key,
  feePayer: operator,
  calls: [
    {
      to: ALPHA_USD,
      data: encodeFunctionData({ abi: Abis.tip20, functionName: 'transferWithMemo', args: [merchantAcct.address, AMOUNT, memo] }),
    },
  ],
})
console.log(`charged memo ${memo} ${EXPLORER}${chargeRc.transactionHash}`)

// 4. operator records it
const paidRc = await client.sendTransactionSync({
  account: operator,
  calls: [
    {
      to: ledger,
      data: encodeFunctionData({ abi: ledgerAbi, functionName: 'markPaid', args: [subId, memo, chargeRc.transactionHash] }),
    },
  ],
})
const s = (await client.readContract({ address: ledger, abi: ledgerAbi, functionName: 'getSubscription', args: [subId] })) as any
console.log(`markPaid ${EXPLORER}${paidRc.transactionHash} → invoicesPaid=${s.invoicesPaid} status=${s.status}`)
if (s.invoicesPaid !== 1 || s.status !== 1) throw new Error('unexpected ledger state')

// 5. negative: a key whose limit is below the plan amount must be rejected by subscribe()
try {
  await subscribeWithKey(AMOUNT - 1n)
  throw new Error('UNEXPECTED: low-limit subscribe succeeded')
} catch (e: any) {
  const msg = `${e.shortMessage ?? e.message}`
  if (msg.startsWith('UNEXPECTED')) throw e
  const data = (() => {
    for (let c = e; c; c = c.cause) if (typeof c.data === 'string') return c.data as Hex
  })()
  const { decodeErrorResult } = await import('viem')
  const name = data ? decodeErrorResult({ abi: errAbi, data }).errorName : msg
  console.log(`low-limit key rejected by subscribe(): ${name}`)
  if (name !== 'KeyLimitTooLow') throw new Error(`expected KeyLimitTooLow, got ${name}`)
}
console.log('SMOKE OK')
