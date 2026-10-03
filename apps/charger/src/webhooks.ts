import { randomUUID } from 'node:crypto'
import { and, eq, lte } from 'drizzle-orm'
import type { Invoice, Subscription, WebhookEvent, WebhookEventType } from '@sile/shared'
import { SIGNATURE_HEADER, signWebhook } from '@sile/shared/webhooks'
import { type Db, schema } from './db/index.js'
import { log } from './log.js'

const MAX_ATTEMPTS = 5

export class Webhooks {
  constructor(
    private db: Db,
    private secret: string,
    private url: string | undefined,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  /** Persist the event (outbox), then try to deliver. Delivery failures are retried by `flush`. */
  async emit(type: WebhookEventType, subscription: Subscription, invoice?: Invoice) {
    const now = Math.floor(Date.now() / 1000)
    const event: WebhookEvent = { id: `evt_${randomUUID()}`, type, createdAt: now, data: { subscription, invoice } }
    await this.db.insert(schema.webhookDeliveries).values({
      id: event.id,
      type,
      payload: JSON.stringify(event),
      status: 'pending',
      nextAttemptAt: now,
      createdAt: now,
    })
    log.info('webhook', { type, subId: subscription.subId })
    void this.flush()
  }

  async flush() {
    if (!this.url) return
    const now = Math.floor(Date.now() / 1000)
    const due = await this.db.query.webhookDeliveries.findMany({
      where: and(eq(schema.webhookDeliveries.status, 'pending'), lte(schema.webhookDeliveries.nextAttemptAt, now)),
      limit: 20,
    })
    for (const d of due) {
      const attempts = d.attempts + 1
      try {
        const res = await this.fetchImpl(this.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', [SIGNATURE_HEADER]: signWebhook(this.secret, d.payload) },
          body: d.payload,
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        await this.db
          .update(schema.webhookDeliveries)
          .set({ status: 'delivered', attempts, lastError: null })
          .where(eq(schema.webhookDeliveries.id, d.id))
      } catch (e) {
        await this.db
          .update(schema.webhookDeliveries)
          .set({
            attempts,
            lastError: String(e),
            status: attempts >= MAX_ATTEMPTS ? 'failed' : 'pending',
            nextAttemptAt: now + 2 ** attempts * 5,
          })
          .where(eq(schema.webhookDeliveries.id, d.id))
      }
    }
  }
}
