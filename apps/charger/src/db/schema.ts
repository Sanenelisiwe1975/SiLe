import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/**
 * SQLite for the hackathon. Kept Postgres-portable: no SQLite-only types, amounts as decimal
 * strings (→ numeric), unix-second integers (→ bigint), text ids.
 * The chain is the source of truth; this is a cache plus charger working state.
 */

export const plans = sqliteTable('plans', {
  planId: text('plan_id').primaryKey(),
  merchant: text('merchant').notNull(),
  token: text('token').notNull(),
  amount: text('amount').notNull(),
  period: integer('period').notNull(),
  active: integer('active', { mode: 'boolean' }).notNull(),
  previousPlanId: text('previous_plan_id'),
  metadataUri: text('metadata_uri').notNull(),
})

/** A minted access key awaiting (or bound to) an on-chain subscription. */
export const accessKeys = sqliteTable('access_keys', {
  keyId: text('key_id').primaryKey(),
  intentId: text('intent_id').notNull().unique(),
  planId: text('plan_id').notNull(),
  subscriber: text('subscriber').notNull(),
  publicKey: text('public_key').notNull(),
  encryptedPrivateKey: text('encrypted_private_key').notNull(),
  createdAt: integer('created_at').notNull(),
})

export const subscriptions = sqliteTable(
  'subscriptions',
  {
    subId: text('sub_id').primaryKey(),
    planId: text('plan_id').notNull(),
    subscriber: text('subscriber').notNull(),
    merchant: text('merchant').notNull(),
    accessKey: text('access_key').notNull(),
    token: text('token').notNull(),
    amount: text('amount').notNull(),
    period: integer('period').notNull(),
    status: text('status', { enum: ['active', 'past_due', 'canceled'] }).notNull(),
    invoicesPaid: integer('invoices_paid').notNull().default(0),
    /** null = not chargeable by us (no key we minted, halted, or canceled). */
    nextChargeAt: integer('next_charge_at'),
    managed: integer('managed', { mode: 'boolean' }).notNull(),
    haltReason: text('halt_reason'),
    createdBlock: integer('created_block').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('subs_merchant').on(t.merchant), index('subs_subscriber').on(t.subscriber), index('subs_due').on(t.nextChargeAt)],
)

export const invoices = sqliteTable(
  'invoices',
  {
    invoiceId: text('invoice_id').primaryKey(), // == memo
    subId: text('sub_id').notNull(),
    seq: integer('seq').notNull(),
    amount: text('amount').notNull(),
    token: text('token').notNull(),
    /** pending → charged (transfer landed, markPaid outstanding) → paid; or failed (gave up). */
    status: text('status', { enum: ['pending', 'charged', 'paid', 'failed'] }).notNull(),
    attempts: integer('attempts').notNull().default(0),
    txHash: text('tx_hash'),
    lastError: text('last_error'),
    failureKind: text('failure_kind'),
    paidAt: integer('paid_at'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('invoices_sub').on(t.subId)],
)

export const webhookDeliveries = sqliteTable('webhook_deliveries', {
  id: text('id').primaryKey(),
  type: text('type').notNull(),
  payload: text('payload').notNull(),
  status: text('status', { enum: ['pending', 'delivered', 'failed'] }).notNull(),
  attempts: integer('attempts').notNull().default(0),
  lastError: text('last_error'),
  nextAttemptAt: integer('next_attempt_at').notNull(),
  createdAt: integer('created_at').notNull(),
})

export const meta = sqliteTable('meta', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
})
