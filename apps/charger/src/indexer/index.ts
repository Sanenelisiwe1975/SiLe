import { and, eq } from 'drizzle-orm'
import { type Address, getAddress, parseEventLogs } from 'viem'
import { planRegistryAbi, subscriptionLedgerAbi } from '@sile/abi'
import { STATUS_FROM_CHAIN } from '@sile/shared'
import type { Chain } from '../chain.js'
import { type Db, getMeta, schema, setMeta } from '../db/index.js'
import { subscriptionDto } from '../dto.js'
import { log } from '../log.js'
import type { Webhooks } from '../webhooks.js'

const CHUNK = 2_000n
const abi = [...planRegistryAbi, ...subscriptionLedgerAbi]

/**
 * Ingests PlanRegistry + SubscriptionLedger events into the DB cache.
 * Charges are confirmed from their own receipts by the scheduler; the ledger `Paid` event
 * (which carries the transfer tx hash) is the on-chain reconciliation record.
 */
export class Indexer {
  constructor(
    private db: Db,
    private chain: Chain,
    private webhooks: Webhooks,
  ) {}

  async poll(): Promise<number> {
    const { client, deployment } = this.chain
    const last = BigInt((await getMeta(this.db, 'lastBlock')) ?? deployment.startBlock - 1)
    const head = await client.getBlockNumber()
    let processed = 0
    for (let from = last + 1n; from <= head; from += CHUNK) {
      const to = from + CHUNK - 1n < head ? from + CHUNK - 1n : head
      const raw = await client.getLogs({
        address: [deployment.planRegistry, deployment.subscriptionLedger],
        fromBlock: from,
        toBlock: to,
      })
      const logs = parseEventLogs({ abi, logs: raw, strict: false })
      for (const l of logs) await this.apply(l as any)
      processed += logs.length
      await setMeta(this.db, 'lastBlock', to.toString())
    }
    return processed
  }

  private async apply(l: { eventName: string; args: any; address: Address; blockNumber: bigint }) {
    const { deployment } = this.chain
    const fromRegistry = getAddress(l.address) === deployment.planRegistry
    const now = Math.floor(Date.now() / 1000)

    if (fromRegistry && l.eventName === 'PlanCreated') {
      const a = l.args
      const row = {
        planId: a.planId.toString(),
        merchant: getAddress(a.merchant),
        token: getAddress(a.token),
        amount: a.amount.toString(),
        period: Number(a.period),
        active: true,
        previousPlanId: a.previousPlanId === 0n ? null : a.previousPlanId.toString(),
        metadataUri: a.metadataURI,
      }
      await this.db.insert(schema.plans).values(row).onConflictDoNothing()
      log.info('plan created', { planId: row.planId, merchant: row.merchant })
      return
    }
    if (fromRegistry && l.eventName === 'PlanDeactivated') {
      await this.db.update(schema.plans).set({ active: false }).where(eq(schema.plans.planId, l.args.planId.toString()))
      return
    }
    if (fromRegistry) return

    const subId = l.args.subId?.toString() as string | undefined
    if (!subId) return

    if (l.eventName === 'Subscribed') {
      const planId = l.args.planId.toString()
      const plan = await this.db.query.plans.findFirst({ where: eq(schema.plans.planId, planId) })
      if (!plan) throw new Error(`Subscribed for unknown plan ${planId}`) // logs are ordered; plan must exist
      const subscriber = getAddress(l.args.subscriber)
      const accessKey = getAddress(l.args.accessKey)
      // We can only charge subscriptions whose key we minted for this subscriber + plan.
      const key = await this.db.query.accessKeys.findFirst({
        where: and(eq(schema.accessKeys.keyId, accessKey), eq(schema.accessKeys.subscriber, subscriber)),
      })
      const managed = !!key && key.planId === planId
      const row = {
        subId,
        planId,
        subscriber,
        merchant: plan.merchant,
        accessKey,
        token: plan.token,
        amount: plan.amount,
        period: plan.period,
        status: 'active' as const,
        invoicesPaid: 0,
        nextChargeAt: managed ? now : null, // first charge immediately: period 0 budget is available at authorise
        managed,
        haltReason: managed ? null : 'unknown_key',
        createdBlock: Number(l.blockNumber),
        createdAt: now,
      }
      const inserted = await this.db.insert(schema.subscriptions).values(row).onConflictDoNothing().returning()
      if (inserted[0]) await this.webhooks.emit('subscription.created', subscriptionDto(inserted[0]))
      log.info('subscribed', { subId, planId, subscriber, managed })
      return
    }

    const sub = await this.db.query.subscriptions.findFirst({ where: eq(schema.subscriptions.subId, subId) })
    if (!sub) return

    if (l.eventName === 'Paid') {
      const seq = Number(l.args.seq)
      if (seq + 1 > sub.invoicesPaid) {
        await this.db.update(schema.subscriptions).set({ invoicesPaid: seq + 1 }).where(eq(schema.subscriptions.subId, subId))
      }
      await this.db
        .update(schema.invoices)
        .set({ status: 'paid', txHash: l.args.txHash })
        .where(eq(schema.invoices.invoiceId, l.args.invoiceId))
      return
    }

    if (l.eventName === 'StatusChanged') {
      const status = STATUS_FROM_CHAIN[Number(l.args.status)]
      if (!status || status === sub.status) return
      const [updated] = await this.db
        .update(schema.subscriptions)
        .set({ status, ...(status === 'canceled' ? { nextChargeAt: null } : {}) })
        .where(eq(schema.subscriptions.subId, subId))
        .returning()
      // Webhooks for operator-driven transitions are emitted by the scheduler; this catches
      // subscriber/merchant cancels made directly on-chain.
      if (status === 'canceled' && updated && sub.status !== 'canceled') {
        await this.webhooks.emit('subscription.canceled', subscriptionDto(updated))
      }
    }
  }
}
