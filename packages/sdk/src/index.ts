/**
 * @sile/sdk — non-custodial recurring billing on Tempo.
 *
 * Merchants: `createPlan`. Subscribers: `subscribe` (one signature), `getSubscription`,
 * `getKeyAllowance`, `revokeSubscriptionKey`. Low-level call builders are exported for custom flows.
 * Every function takes a Tempo client from `viem/tempo` (`createClient`).
 */
import { type Account, type Address, type Hex, encodeFunctionData, parseEventLogs } from 'viem'
import { tempoModerato } from 'viem/chains'
import { Abis, createClient } from 'viem/tempo'
import { planRegistryAbi, subscriptionLedgerAbi } from '@sile/abi'
import {
  ACCOUNT_KEYCHAIN,
  STATUS_FROM_CHAIN,
  SubscriptionIntentResponse,
  type SubscriptionStatus,
  TIP20_SELECTORS,
} from '@sile/shared'

/** A Tempo client as returned by `createClient({ chain })` from `viem/tempo` (type-level only). */
const clientShape = () => createClient({ chain: tempoModerato })
export type TempoClient = ReturnType<typeof clientShape>
export type Call = { to: Address; data: Hex }
export { SubscriptionIntentResponse }

/** Keychain signature type for P256 keys (IAccountKeychain.SignatureType.P256). */
const SIGNATURE_TYPE_P256 = 1

// ------------------------------------------------------------------ merchant

export type PlanTerms = {
  token: Address
  /** Base units per period (TIP-20 stablecoins use 6 decimals; read `decimals()` to be sure). */
  amount: bigint
  /** Seconds. Tempo periods are fixed lengths (no calendar months). */
  period: number
  metadataURI?: string
  /** Set when publishing new terms that supersede an existing plan of yours. */
  previousPlanId?: bigint
}

export function buildCreatePlanCall(registry: Address, terms: PlanTerms): Call {
  return {
    to: registry,
    data: encodeFunctionData({
      abi: planRegistryAbi,
      functionName: 'createPlan',
      args: [terms.token, terms.amount, BigInt(terms.period), terms.metadataURI ?? '', terms.previousPlanId ?? 0n],
    }),
  }
}

/** Publish an immutable plan. Returns its id. */
export async function createPlan(
  client: TempoClient,
  p: PlanTerms & { account: Account; registry: Address },
): Promise<{ planId: bigint; txHash: Hex }> {
  const receipt = await client.sendTransactionSync({ account: p.account, calls: [buildCreatePlanCall(p.registry, p)] })
  const [ev] = parseEventLogs({ abi: planRegistryAbi, logs: receipt.logs, eventName: 'PlanCreated' })
  if (!ev) throw new Error('PlanCreated event not found')
  return { planId: ev.args.planId, txHash: receipt.transactionHash }
}

// ------------------------------------------------------------------ subscriber

/** Ask the merchant's SiLe charger to mint a billing key for this subscriber + plan. */
export async function requestIntent(
  chargerUrl: string,
  planId: bigint | string,
  subscriber: Address,
  fetchImpl: typeof fetch = fetch,
): Promise<SubscriptionIntentResponse> {
  const res = await fetchImpl(`${chargerUrl.replace(/\/$/, '')}/subscriptions/intent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ planId: planId.toString(), subscriber }),
  })
  if (!res.ok) throw new Error(`charger intent failed: HTTP ${res.status} ${await res.text().catch(() => '')}`)
  return SubscriptionIntentResponse.parse(await res.json())
}

/**
 * The access-key grant for a subscription: limit = plan amount per plan period, only
 * `transferWithMemo` on the plan token, only to the merchant, expiring at `expiry`.
 */
export function buildSubscriptionKey(intent: SubscriptionIntentResponse): Call {
  return {
    to: ACCOUNT_KEYCHAIN,
    data: encodeFunctionData({
      abi: Abis.accountKeychain,
      functionName: 'authorizeKey',
      args: [
        intent.keyId as Address,
        SIGNATURE_TYPE_P256,
        {
          expiry: BigInt(intent.expiry),
          enforceLimits: true,
          limits: [{ token: intent.token as Address, amount: BigInt(intent.limit), period: BigInt(intent.period) }],
          allowAnyCalls: false,
          allowedCalls: [
            {
              target: intent.token as Address,
              selectorRules: [{ selector: TIP20_SELECTORS.transferWithMemo, recipients: [intent.recipient as Address] }],
            },
          ],
        },
      ],
    } as never),
  }
}

/**
 * Calls for a one-signature checkout: authorise the key, then record the subscription.
 * Send them in ONE Tempo transaction signed by the subscriber's root key (e.g. a passkey).
 * The ledger verifies the key on-chain in the same transaction.
 */
export function buildSubscribeCalls(intent: SubscriptionIntentResponse, planId: bigint | string): Call[] {
  return [
    buildSubscriptionKey(intent),
    {
      to: intent.ledger as Address,
      data: encodeFunctionData({
        abi: subscriptionLedgerAbi,
        functionName: 'subscribe',
        args: [BigInt(planId), intent.keyId as Address],
      }),
    },
  ]
}

/** Full checkout: intent from the charger, then ONE root-signed tx. The first charge follows automatically. */
export async function subscribe(
  client: TempoClient,
  p: { account: Account; chargerUrl: string; planId: bigint | string; fetchImpl?: typeof fetch },
): Promise<{ subId: bigint; keyId: Address; txHash: Hex; intent: SubscriptionIntentResponse }> {
  const intent = await requestIntent(p.chargerUrl, p.planId, p.account.address, p.fetchImpl)
  const receipt = await client.sendTransactionSync({ account: p.account, calls: buildSubscribeCalls(intent, p.planId) })
  const [ev] = parseEventLogs({ abi: subscriptionLedgerAbi, logs: receipt.logs, eventName: 'Subscribed' })
  if (!ev) throw new Error('Subscribed event not found')
  return { subId: ev.args.subId, keyId: intent.keyId as Address, txHash: receipt.transactionHash, intent }
}

export type OnchainSubscription = {
  subId: bigint
  planId: bigint
  subscriber: Address
  accessKey: Address
  status: SubscriptionStatus
  invoicesPaid: number
  lastPaidAt: number | null
}

/** Read a subscription straight from the ledger (source of truth). */
export async function getSubscription(client: TempoClient, p: { ledger: Address; subId: bigint }): Promise<OnchainSubscription> {
  const s = await client.readContract({
    address: p.ledger,
    abi: subscriptionLedgerAbi,
    functionName: 'getSubscription',
    args: [p.subId],
  })
  const status = STATUS_FROM_CHAIN[s.status]
  if (!status) throw new Error(`unexpected status ${s.status}`)
  return {
    subId: p.subId,
    planId: s.planId,
    subscriber: s.subscriber,
    accessKey: s.accessKey,
    status,
    invoicesPaid: s.invoicesPaid,
    lastPaidAt: s.lastPaidAt === 0n ? null : Number(s.lastPaidAt),
  }
}

/** What the billing key can still pull this period, from the keychain precompile. `active` is false once revoked/expired. */
export async function getKeyAllowance(
  client: TempoClient,
  p: { subscriber: Address; keyId: Address; token: Address },
): Promise<{ remaining: bigint; periodEnd: number | null; active: boolean }> {
  const { remaining, periodEnd } = await client.accessKey.getRemainingLimit({
    account: p.subscriber,
    accessKey: p.keyId,
    token: p.token,
  })
  const end = periodEnd ? Number(periodEnd) : 0
  return { remaining, periodEnd: end || null, active: end > 0 }
}

/** Revoke the billing key. Tempo rejects every later charge; SiLe's dunning then cancels the subscription. */
export async function revokeSubscriptionKey(client: TempoClient, p: { account: Account; keyId: Address }): Promise<Hex> {
  const { receipt } = await client.accessKey.revokeSync({ account: p.account, accessKey: p.keyId })
  return receipt.transactionHash
}
