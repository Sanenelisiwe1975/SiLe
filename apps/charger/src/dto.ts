import type { Invoice, Plan, Subscription } from '@sile/shared'
import type { schema } from './db/index.js'

type PlanRow = typeof schema.plans.$inferSelect
type SubRow = typeof schema.subscriptions.$inferSelect
type InvoiceRow = typeof schema.invoices.$inferSelect

export const planDto = (p: PlanRow): Plan => ({
  planId: p.planId,
  merchant: p.merchant,
  token: p.token,
  amount: p.amount,
  period: p.period,
  active: p.active,
  previousPlanId: p.previousPlanId,
  metadataURI: p.metadataUri,
})

export const subscriptionDto = (s: SubRow): Subscription => ({
  subId: s.subId,
  planId: s.planId,
  subscriber: s.subscriber,
  accessKey: s.accessKey,
  status: s.status,
  invoicesPaid: s.invoicesPaid,
  nextChargeAt: s.nextChargeAt,
  createdAt: s.createdAt,
})

export const invoiceDto = (i: InvoiceRow): Invoice => ({
  invoiceId: i.invoiceId,
  subId: i.subId,
  seq: i.seq,
  amount: i.amount,
  token: i.token,
  status: i.status,
  attempts: i.attempts,
  txHash: i.txHash,
  lastError: i.lastError,
  paidAt: i.paidAt,
})
