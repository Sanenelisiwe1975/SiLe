import { and, eq, isNotNull, lte, ne } from 'drizzle-orm'
import { type Address, type Hex, encodeFunctionData, getAbiItem } from 'viem'
import { Abis } from 'viem/tempo'
import { subscriptionLedgerAbi } from '@sile/abi'
import { type ChargeFailure, classifyChargeError, encodeInvoiceMemo, errorText } from '@sile/shared'
import { type Chain, accessKeyAccount } from '../chain.js'
import type { Config } from '../config.js'
import { type Db, schema } from '../db/index.js'
import { decide } from '../dunning/policy.js'
import { invoiceDto, subscriptionDto } from '../dto.js'
import type { KeyStore } from '../keys/keystore.js'
import { log } from '../log.js'
import type { Webhooks } from '../webhooks.js'

type Sub = typeof schema.subscriptions.$inferSelect
type Inv = typeof schema.invoices.$inferSelect

const LOG_SCAN_CHUNK = 10_000n
const OVERCHARGE_GAS = 600_000n
const transferWithMemoEvent = getAbiItem({ abi: Abis.tip20, name: 'TransferWithMemo' })
const nowSec = () => Math.floor(Date.now() / 1000)

/**
 * The billing clock. Each tick charges every managed subscription whose `nextChargeAt` has passed:
 *   transferWithMemo signed by the subscription's access key, fee sponsored by the operator
 *   (mandatory — sender-paid fees count against the key's limit), then `markPaid` on the ledger.
 * The protocol enforces amount/period/recipient; this engine only decides *when* to ask.
 */
export class ChargeEngine {
  #running = false

  constructor(
    private db: Db,
    private chain: Chain,
    private keys: KeyStore,
    private webhooks: Webhooks,
    private config: Config,
  ) {}

  async tick(now = nowSec()): Promise<number> {
    if (this.#running) return 0
    this.#running = true
    try {
      await this.reconcileStaleInvoices()
      const due = await this.db.query.subscriptions.findMany({
        where: and(
          eq(schema.subscriptions.managed, true),
          ne(schema.subscriptions.status, 'canceled'),
          isNotNull(schema.subscriptions.nextChargeAt),
          lte(schema.subscriptions.nextChargeAt, now),
        ),
      })
      for (const sub of due) {
        try {
          await this.process(sub)
        } catch (e) {
          log.error('process failed', { subId: sub.subId, error: errorText(e).slice(0, 300) })
          await this.setSub(sub.subId, { nextChargeAt: nowSec() + 15 })
        }
      }
      return due.length
    } finally {
      this.#running = false
    }
  }

  async reconcileStaleInvoices(): Promise<number> {
    const stale = await this.db.query.invoices.findMany({
      where: eq(schema.invoices.status, 'pending'),
    })
    const charged = await this.db.query.invoices.findMany({
      where: eq(schema.invoices.status, 'charged'),
    })
    const rows = [...stale, ...charged]
    let recovered = 0

    for (const invoice of rows) {
      const sub = await this.db.query.subscriptions.findFirst({ where: eq(schema.subscriptions.subId, invoice.subId) })
      if (!sub) continue
      const txHash = await this.findTransferByMemo(sub, invoice.invoiceId as Hex)
      if (!txHash) continue
      try {
        await this.recordPaid(sub, invoice, txHash)
        recovered += 1
      } catch (e) {
        log.warn('invoice reconcile failed', { subId: sub.subId, invoiceId: invoice.invoiceId, error: errorText(e).slice(0, 200) })
      }
    }

    return recovered
  }

  async reconcileManagedSubscriptions(): Promise<number> {
    const managed = await this.db.query.subscriptions.findMany({
      where: and(eq(schema.subscriptions.managed, true), ne(schema.subscriptions.status, 'canceled')),
    })

    let repaired = 0
    for (const sub of managed) {
      if (sub.nextChargeAt !== null) continue
      try {
        const { periodEnd } = await this.limit(sub)
        const nextChargeAt = periodEnd && periodEnd > 0n ? Number(periodEnd) : nowSec() + sub.period
        await this.setSub(sub.subId, { nextChargeAt })
        repaired += 1
      } catch (e) {
        log.warn('managed subscription repair failed', {
          subId: sub.subId,
          error: errorText(e).slice(0, 200),
        })
      }
    }
    return repaired
  }

  private memoFor(sub: Sub, seq = sub.invoicesPaid): Hex {
    const { chainId, deployment } = this.chain
    return encodeInvoiceMemo({ chainId, ledger: deployment.subscriptionLedger, subId: BigInt(sub.subId), seq })
  }

  private async openInvoice(sub: Sub): Promise<Inv> {
    const invoiceId = this.memoFor(sub)
    const existing = await this.db.query.invoices.findFirst({ where: eq(schema.invoices.invoiceId, invoiceId) })
    if (existing) return existing
    const [row] = await this.db
      .insert(schema.invoices)
      .values({
        invoiceId,
        subId: sub.subId,
        seq: sub.invoicesPaid,
        amount: sub.amount,
        token: sub.token,
        status: 'pending',
        createdAt: nowSec(),
      })
      .returning()
    return row!
  }

  private async signer(sub: Sub) {
    const key = await this.db.query.accessKeys.findFirst({ where: eq(schema.accessKeys.keyId, sub.accessKey) })
    if (!key) throw new Error(`no key material for ${sub.accessKey}`)
    return accessKeyAccount(await this.keys.open(key.encryptedPrivateKey), sub.subscriber as Address)
  }

  private limit(sub: Sub) {
    return this.chain.client.accessKey.getRemainingLimit({
      account: sub.subscriber as Address,
      accessKey: sub.accessKey as Address,
      token: sub.token as Address,
    })
  }

  async process(sub: Sub) {
    const invoice = await this.openInvoice(sub)
    if (invoice.status === 'charged' && invoice.txHash) return this.recordPaid(sub, invoice, invoice.txHash as Hex)

    const amount = BigInt(sub.amount)
    const { remaining, periodEnd } = await this.limit(sub)
    // periodEnd == 0 means the key is missing/revoked/expired: still attempt the charge so the
    // recorded failure is the protocol's own rejection.
    if (periodEnd && periodEnd > 0n && remaining < amount) {
      // Budget already used this period. Either we charged and crashed before recording, or it's early.
      const tx = await this.findTransferByMemo(sub, invoice.invoiceId as Hex)
      if (tx) {
        log.warn('reconciled charge found on-chain', { subId: sub.subId, tx })
        return this.recordPaid(sub, await this.markCharged(invoice, tx), tx)
      }
      return this.setSub(sub.subId, { nextChargeAt: Number(periodEnd) })
    }

    try {
      const receipt = await this.chain.client.sendTransactionSync({
        account: await this.signer(sub),
        feePayer: this.chain.operator,
        calls: [
          {
            to: sub.token as Address,
            data: encodeFunctionData({
              abi: Abis.tip20,
              functionName: 'transferWithMemo',
              args: [sub.merchant as Address, amount, invoice.invoiceId as Hex],
            }),
          },
        ],
      })
      log.info('charged', { subId: sub.subId, seq: invoice.seq, tx: receipt.transactionHash })
      await this.recordPaid(sub, await this.markCharged(invoice, receipt.transactionHash), receipt.transactionHash)
    } catch (e) {
      await this.handleFailure(sub, invoice, classifyChargeError(e), e)
    }
  }

  private async markCharged(invoice: Inv, txHash: Hex): Promise<Inv> {
    const [row] = await this.db
      .update(schema.invoices)
      .set({ status: 'charged', txHash, attempts: invoice.attempts + 1, lastError: null, failureKind: null })
      .where(eq(schema.invoices.invoiceId, invoice.invoiceId))
      .returning()
    return row!
  }

  private async nextChargeAtAfterPeriod(sub: Sub, fallback: number): Promise<number> {
    try {
      const { periodEnd } = await this.limit(sub)
      return periodEnd && periodEnd > 0n ? Number(periodEnd) : fallback
    } catch {
      return fallback
    }
  }

  /** Transfer landed → record it on the ledger, schedule the next period from the chain's periodEnd. */
  private async recordPaid(sub: Sub, invoice: Inv, txHash: Hex) {
    try {
      await this.ledgerTx('markPaid', [BigInt(sub.subId), invoice.invoiceId as Hex, txHash])
    } catch (e) {
      const onChain = await this.chain.client.readContract({
        address: this.chain.deployment.subscriptionLedger,
        abi: subscriptionLedgerAbi,
        functionName: 'getSubscription',
        args: [BigInt(sub.subId)],
      })
      if (onChain.invoicesPaid <= invoice.seq) {
        log.warn('markPaid failed; will retry', { subId: sub.subId, error: errorText(e).slice(0, 200) })
        return this.setSub(sub.subId, { nextChargeAt: nowSec() + 15 })
      }
    }
    const paidAt = nowSec()
    const [inv] = await this.db
      .update(schema.invoices)
      .set({ status: 'paid', paidAt })
      .where(eq(schema.invoices.invoiceId, invoice.invoiceId))
      .returning()
    const updated = await this.setSub(sub.subId, {
      invoicesPaid: invoice.seq + 1,
      status: 'active',
      nextChargeAt: await this.nextChargeAtAfterPeriod(sub, paidAt + sub.period),
    })
    await this.webhooks.emit('subscription.charged', subscriptionDto(updated), invoiceDto(inv!))
  }

  private async handleFailure(sub: Sub, invoice: Inv, kind: ChargeFailure, err: unknown) {
    const now = nowSec()
    const d = decide(kind, invoice.attempts + 1, this.config.DUNNING_SCHEDULE_SECONDS, now)
    const counts = d.action !== 'retry' || d.countsAsAttempt
    const message = errorText(err).slice(0, 500)
    log.warn('charge failed', { subId: sub.subId, seq: invoice.seq, kind, action: d.action })

    const terminal = d.action === 'cancel' || d.action === 'halt'
    const [inv] = await this.db
      .update(schema.invoices)
      .set({
        attempts: invoice.attempts + (counts ? 1 : 0),
        lastError: message,
        failureKind: kind,
        ...(terminal ? { status: 'failed' as const } : {}),
      })
      .where(eq(schema.invoices.invoiceId, invoice.invoiceId))
      .returning()

    switch (d.action) {
      case 'retry': {
        if (d.markPastDue && sub.status === 'active') {
          await this.ledgerTx('markPastDue', [BigInt(sub.subId)])
          const updated = await this.setSub(sub.subId, { status: 'past_due', nextChargeAt: d.retryAt })
          await this.webhooks.emit('subscription.past_due', subscriptionDto(updated), invoiceDto(inv!))
        } else {
          await this.setSub(sub.subId, { nextChargeAt: d.retryAt })
        }
        return
      }
      case 'cancel': {
        await this.ledgerTx('markCanceled', [BigInt(sub.subId)]).catch((e) =>
          log.warn('markCanceled failed (already canceled?)', { subId: sub.subId, error: errorText(e).slice(0, 200) }),
        )
        const updated = await this.setSub(sub.subId, { status: 'canceled', nextChargeAt: null, haltReason: d.reason })
        await this.webhooks.emit('subscription.canceled', subscriptionDto(updated), invoiceDto(inv!))
        return
      }
      case 'wait_period': {
        await this.setSub(sub.subId, {
          nextChargeAt: await this.nextChargeAtAfterPeriod(sub, now + sub.period),
        })
        return
      }
      case 'halt':
        log.error('subscription halted', { subId: sub.subId, reason: d.reason })
        await this.setSub(sub.subId, { nextChargeAt: null, haltReason: d.reason })
        return
    }
  }

  /** Crash recovery: find a transfer from the subscriber carrying this invoice's memo (memo is indexed). */
  private async findTransferByMemo(sub: Sub, memo: Hex): Promise<Hex | undefined> {
    const head = await this.chain.client.getBlockNumber()
    for (let from = BigInt(sub.createdBlock); from <= head; from += LOG_SCAN_CHUNK) {
      const to = from + LOG_SCAN_CHUNK - 1n < head ? from + LOG_SCAN_CHUNK - 1n : head
      const logs = await this.chain.client.getLogs({
        address: sub.token as Address,
        event: transferWithMemoEvent,
        args: { from: sub.subscriber as Address, memo },
        fromBlock: from,
        toBlock: to,
      })
      if (logs[0]) return logs[0].transactionHash
    }
    return undefined
  }

  private async ledgerTx(
    functionName: 'markPaid' | 'markPastDue' | 'markCanceled',
    args: readonly [bigint] | readonly [bigint, Hex, Hex],
  ) {
    const receipt = await this.chain.client.sendTransactionSync({
      account: this.chain.operator,
      calls: [
        {
          to: this.chain.deployment.subscriptionLedger,
          data: encodeFunctionData({ abi: subscriptionLedgerAbi, functionName, args } as any),
        },
      ],
    })
    log.info(functionName, { subId: args[0], tx: receipt.transactionHash })
    return receipt
  }

  private async setSub(subId: string, patch: Partial<Sub>): Promise<Sub> {
    const [row] = await this.db
      .update(schema.subscriptions)
      .set(patch)
      .where(eq(schema.subscriptions.subId, subId))
      .returning()
    return row!
  }

  /**
   * DEMO ONLY: try to pull amount + 1 with a fixed gas limit so simulation is skipped and the
   * protocol's SpendingLimitExceeded lands on-chain as a reverted tx (explorer-visible).
   */
  async overcharge(subId: string) {
    const sub = await this.db.query.subscriptions.findFirst({ where: eq(schema.subscriptions.subId, subId) })
    if (!sub) throw new Error('unknown subscription')
    const receipt = await this.chain.client.sendTransactionSync({
      account: await this.signer(sub),
      feePayer: this.chain.operator,
      gas: OVERCHARGE_GAS,
      throwOnReceiptRevert: false,
      calls: [
        {
          to: sub.token as Address,
          data: encodeFunctionData({
            abi: Abis.tip20,
            functionName: 'transferWithMemo',
            args: [sub.merchant as Address, BigInt(sub.amount) + 1n, this.memoFor(sub)],
          }),
        },
      ],
    } as any)
    log.info('demo overcharge', { subId, status: receipt.status, tx: receipt.transactionHash })
    return { txHash: receipt.transactionHash as Hex, status: receipt.status as 'success' | 'reverted' }
  }
}
