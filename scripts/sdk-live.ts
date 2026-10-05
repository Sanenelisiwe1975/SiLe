/**
 * Live check of @sile/sdk against Moderato + a running charger (:8787).
 * Run: pnpm tsx --env-file=.env scripts/sdk-live.ts
 */
import { type Hex, http } from 'viem'
import { generatePrivateKey } from 'viem/accounts'
import { tempoModerato } from 'viem/chains'
import { Account, createClient } from 'viem/tempo'
import { getDeployment } from '@sile/abi'
import { createPlan, getKeyAllowance, getSubscription, revokeSubscriptionKey, subscribe } from '@sile/sdk'
import { DEFAULT_TOKEN, txUrl } from '@sile/shared'

const CHARGER = process.env.CHARGER_URL ?? 'http://localhost:8787'
const client = createClient({ chain: tempoModerato, transport: http(), feeToken: DEFAULT_TOKEN })
const d = getDeployment(tempoModerato.id)
const sleep = (s: number) => new Promise((r) => setTimeout(r, s * 1000))

const merchant = Account.fromSecp256k1(process.env.MERCHANT_PRIVATE_KEY as Hex)
const { planId, txHash } = await createPlan(client, {
  account: merchant,
  registry: d.planRegistry,
  token: DEFAULT_TOKEN,
  amount: 1_500_000n,
  period: 60,
  metadataURI: 'data:application/json,' + encodeURIComponent(JSON.stringify({ name: 'SDK live' })),
})
console.log(`✔ createPlan → #${planId} ${txUrl(txHash)}`)
await sleep(6) // let the charger index the plan

const subscriber = Account.fromSecp256k1(generatePrivateKey())
await client.faucet.fundSync({ account: subscriber.address })
const sub = await subscribe(client, { account: subscriber, chargerUrl: CHARGER, planId })
console.log(`✔ subscribe → sub #${sub.subId}, key ${sub.keyId} ${txUrl(sub.txHash)}`)

let s = await getSubscription(client, { ledger: d.subscriptionLedger, subId: sub.subId })
for (let i = 0; i < 30 && s.invoicesPaid < 1; i++) {
  await sleep(2)
  s = await getSubscription(client, { ledger: d.subscriptionLedger, subId: sub.subId })
}
if (s.invoicesPaid < 1) throw new Error('first charge not recorded')
console.log(`✔ getSubscription → status=${s.status} invoicesPaid=${s.invoicesPaid}`)

const before = await getKeyAllowance(client, { subscriber: subscriber.address, keyId: sub.keyId, token: DEFAULT_TOKEN })
if (!before.active || before.remaining !== 0n) throw new Error(`unexpected allowance ${JSON.stringify(before, (_, v) => (typeof v === 'bigint' ? v.toString() : v))}`)
console.log(`✔ getKeyAllowance → active, remaining=0 this period (charged), resets at ${before.periodEnd}`)

const rv = await revokeSubscriptionKey(client, { account: subscriber, keyId: sub.keyId })
const after = await getKeyAllowance(client, { subscriber: subscriber.address, keyId: sub.keyId, token: DEFAULT_TOKEN })
if (after.active) throw new Error('key still active after revoke')
console.log(`✔ revokeSubscriptionKey → inactive ${txUrl(rv)}`)
console.log('SDK LIVE OK')
