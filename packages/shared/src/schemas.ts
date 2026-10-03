import { z } from 'zod'

/** Zod schemas shared by charger API, web and SDK. Amounts travel as decimal strings of base units. */

export const zAddress = z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'address')
export const zHex32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/, 'bytes32')
export const zBaseUnits = z.string().regex(/^\d+$/, 'base units')
export const zId = z.union([z.string().regex(/^\d+$/), z.number().int().nonnegative()]).transform(String)

export const SubscriptionStatus = z.enum(['active', 'past_due', 'canceled'])
export type SubscriptionStatus = z.infer<typeof SubscriptionStatus>
/** Mirrors SubscriptionLedger.Status (None=0 is never exposed). */
export const STATUS_FROM_CHAIN: Record<number, SubscriptionStatus> = { 1: 'active', 2: 'past_due', 3: 'canceled' }

export const Plan = z.object({
  planId: z.string(),
  merchant: zAddress,
  token: zAddress,
  amount: zBaseUnits,
  period: z.number().int().positive(),
  active: z.boolean(),
  previousPlanId: z.string().nullable(),
  metadataURI: z.string(),
})
export type Plan = z.infer<typeof Plan>

export const Subscription = z.object({
  subId: z.string(),
  planId: z.string(),
  subscriber: zAddress,
  accessKey: zAddress,
  status: SubscriptionStatus,
  invoicesPaid: z.number().int().nonnegative(),
  nextChargeAt: z.number().int().nullable(), // unix seconds
  createdAt: z.number().int(),
})
export type Subscription = z.infer<typeof Subscription>

export const InvoiceStatus = z.enum(['pending', 'charged', 'paid', 'failed'])
export const Invoice = z.object({
  invoiceId: zHex32, // == memo
  subId: z.string(),
  seq: z.number().int().nonnegative(),
  amount: zBaseUnits,
  token: zAddress,
  status: InvoiceStatus,
  attempts: z.number().int().nonnegative(),
  txHash: zHex32.nullable(),
  lastError: z.string().nullable(),
  paidAt: z.number().int().nullable(),
})
export type Invoice = z.infer<typeof Invoice>

// ---- API bodies

/** Checkout step 1: charger mints a fresh P256 access key for this subscriber + plan. */
export const SubscriptionIntentRequest = z.object({ planId: zId, subscriber: zAddress })
export type SubscriptionIntentRequest = z.infer<typeof SubscriptionIntentRequest>
export const SubscriptionIntentResponse = z.object({
  intentId: z.string(),
  keyId: zAddress, // keychain key id (accessKeyAddress)
  publicKey: z.string().regex(/^0x[0-9a-fA-F]+$/),
  keyType: z.literal('p256'),
  /** Terms the subscriber must authorise. */
  token: zAddress,
  limit: zBaseUnits,
  period: z.number().int().positive(),
  expiry: z.number().int(),
  recipient: zAddress,
  ledger: zAddress,
  feePayer: zAddress,
})
export type SubscriptionIntentResponse = z.infer<typeof SubscriptionIntentResponse>

// ---- Webhooks

export const WebhookEventType = z.enum([
  'subscription.created',
  'subscription.charged',
  'subscription.past_due',
  'subscription.canceled',
])
export type WebhookEventType = z.infer<typeof WebhookEventType>
export const WebhookEvent = z.object({
  id: z.string(),
  type: WebhookEventType,
  createdAt: z.number().int(),
  data: z.object({
    subscription: Subscription,
    invoice: Invoice.optional(),
  }),
})
export type WebhookEvent = z.infer<typeof WebhookEvent>
