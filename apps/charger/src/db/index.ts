import { createClient } from '@libsql/client'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/libsql'
import * as schema from './schema.js'

export { schema }
export type Db = ReturnType<typeof drizzle<typeof schema>>

/** Hand-written DDL (mirrors schema.ts) so boot needs no migration tooling. */
const DDL = [
  `CREATE TABLE IF NOT EXISTS plans (plan_id TEXT PRIMARY KEY, merchant TEXT NOT NULL, token TEXT NOT NULL, amount TEXT NOT NULL,
    period INTEGER NOT NULL, active INTEGER NOT NULL, previous_plan_id TEXT, metadata_uri TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS access_keys (key_id TEXT PRIMARY KEY, intent_id TEXT NOT NULL UNIQUE, plan_id TEXT NOT NULL,
    subscriber TEXT NOT NULL, public_key TEXT NOT NULL, encrypted_private_key TEXT NOT NULL, created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS subscriptions (sub_id TEXT PRIMARY KEY, plan_id TEXT NOT NULL, subscriber TEXT NOT NULL,
    merchant TEXT NOT NULL, access_key TEXT NOT NULL, token TEXT NOT NULL, amount TEXT NOT NULL, period INTEGER NOT NULL,
    status TEXT NOT NULL, invoices_paid INTEGER NOT NULL DEFAULT 0, next_charge_at INTEGER, managed INTEGER NOT NULL,
    halt_reason TEXT, created_block INTEGER NOT NULL, created_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS subs_merchant ON subscriptions(merchant)`,
  `CREATE INDEX IF NOT EXISTS subs_subscriber ON subscriptions(subscriber)`,
  `CREATE INDEX IF NOT EXISTS subs_due ON subscriptions(next_charge_at)`,
  `CREATE TABLE IF NOT EXISTS invoices (invoice_id TEXT PRIMARY KEY, sub_id TEXT NOT NULL, seq INTEGER NOT NULL,
    amount TEXT NOT NULL, token TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, tx_hash TEXT,
    last_error TEXT, failure_kind TEXT, paid_at INTEGER, created_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS invoices_sub ON invoices(sub_id)`,
  `CREATE TABLE IF NOT EXISTS webhook_deliveries (id TEXT PRIMARY KEY, type TEXT NOT NULL, payload TEXT NOT NULL,
    status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, next_attempt_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
]

export async function openDb(url: string): Promise<Db> {
  const libsqlUrl = url === ':memory:' || url.startsWith('file:') || url.includes('://') ? url : `file:${url}`
  const client = createClient({ url: libsqlUrl })
  for (const stmt of DDL) await client.execute(stmt)
  return drizzle(client, { schema })
}

export async function getMeta(db: Db, key: string): Promise<string | undefined> {
  const row = await db.query.meta.findFirst({ where: eq(schema.meta.key, key) })
  return row?.value
}

export async function setMeta(db: Db, key: string, value: string) {
  await db.insert(schema.meta).values({ key, value }).onConflictDoUpdate({ target: schema.meta.key, set: { value } })
}
