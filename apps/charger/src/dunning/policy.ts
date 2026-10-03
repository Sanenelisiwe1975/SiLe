import type { ChargeFailure } from '@sile/shared'

export type DunningDecision =
  /** Try again at `retryAt`. `countsAsAttempt` = false for transient errors. */
  | { action: 'retry'; retryAt: number; countsAsAttempt: boolean; markPastDue: boolean }
  /** Give up and cancel on the ledger. */
  | { action: 'cancel'; reason: string }
  /** Nothing to retry this period; resume at the next period boundary. */
  | { action: 'wait_period' }
  /** Stop charging and flag for a human (configuration bug). */
  | { action: 'halt'; reason: string }

export const TRANSIENT_RETRY_SECONDS = 15

/**
 * @param attempts number of counted failed attempts for this invoice INCLUDING this one (1-based)
 * @param schedule seconds to wait after the 1st, 2nd, … failure (e.g. [3600, 21600, 86400])
 */
export function decide(kind: ChargeFailure, attempts: number, schedule: readonly number[], now: number): DunningDecision {
  switch (kind) {
    case 'insufficient_balance': {
      if (attempts > schedule.length) return { action: 'cancel', reason: 'dunning_exhausted' }
      return { action: 'retry', retryAt: now + schedule[attempts - 1]!, countsAsAttempt: true, markPastDue: attempts === 1 }
    }
    case 'key_invalid':
      return { action: 'cancel', reason: 'key_revoked_or_expired' }
    case 'limit_exceeded':
      return { action: 'wait_period' }
    case 'scope_violation':
      return { action: 'halt', reason: 'scope_violation' }
    case 'transient':
      return { action: 'retry', retryAt: now + TRANSIENT_RETRY_SECONDS, countsAsAttempt: false, markPastDue: false }
  }
}
