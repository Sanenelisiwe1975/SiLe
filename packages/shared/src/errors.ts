/**
 * Classifies charge failures for dunning. Error text shapes were captured on Moderato by
 * scripts/spike.ts (see CLAUDE.md "Error shapes"). The useful text sits in `.details` somewhere
 * down the `.cause` chain, so we flatten the chain and match on strings.
 */
export type ChargeFailure =
  /** Subscriber balance too low → retry on the dunning schedule. */
  | 'insufficient_balance'
  /** Key revoked / expired / missing → stop immediately, cancel. */
  | 'key_invalid'
  /** Over the periodic limit → do not retry this period (charged already, or our bug). */
  | 'limit_exceeded'
  /** Recipient/selector not allowed by the key's scope → our bug, flag. */
  | 'scope_violation'
  /** Network / RPC / unknown → short backoff, not a dunning attempt. */
  | 'transient'

const RULES: [RegExp, ChargeFailure][] = [
  [/InsufficientBalance/i, 'insufficient_balance'],
  [/KeyAlreadyRevoked|KeyExpired|KeyNotFound|keychain validation failed/i, 'key_invalid'],
  [/SpendingLimitExceeded/i, 'limit_exceeded'],
  [/CallNotAllowed/i, 'scope_violation'],
]

export function errorText(e: unknown): string {
  const parts: string[] = []
  const seen = new Set<unknown>()
  let c: any = e
  while (c && typeof c === 'object' && !seen.has(c)) {
    seen.add(c)
    for (const k of ['shortMessage', 'details', 'message', 'reason']) {
      if (typeof c[k] === 'string') parts.push(c[k])
    }
    c = c.cause
  }
  if (typeof e === 'string') parts.push(e)
  return parts.join(' | ')
}

export function classifyChargeError(e: unknown): ChargeFailure {
  const text = errorText(e)
  for (const [re, kind] of RULES) if (re.test(text)) return kind
  return 'transient'
}
