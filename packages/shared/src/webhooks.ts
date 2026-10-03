import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Webhook signatures: header `X-SiLe-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, `${t}.${body}`)>`.
 * Receivers should reject timestamps older than `toleranceSeconds` to block replays.
 */
export const SIGNATURE_HEADER = 'X-SiLe-Signature'

export function signWebhook(secret: string, body: string, t = Math.floor(Date.now() / 1000)): string {
  const v1 = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')
  return `t=${t},v1=${v1}`
}

export function verifyWebhook(
  secret: string,
  body: string,
  header: string | null | undefined,
  { toleranceSeconds = 300, now = Math.floor(Date.now() / 1000) } = {},
): boolean {
  if (!header) return false
  const parts = Object.fromEntries(header.split(',').map((kv) => kv.split('=', 2) as [string, string]))
  const t = Number(parts.t)
  if (!Number.isFinite(t) || !parts.v1 || Math.abs(now - t) > toleranceSeconds) return false
  const expected = Buffer.from(signWebhook(secret, body, t).split('v1=')[1]!, 'hex')
  const got = Buffer.from(parts.v1, 'hex')
  return got.length === expected.length && timingSafeEqual(got, expected)
}
