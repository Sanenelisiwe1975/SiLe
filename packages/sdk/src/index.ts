import { type Address, type Hex, encodeFunctionData } from 'viem'
import { Abis } from 'viem/tempo'
import { subscriptionLedgerAbi } from '@sile/abi'
import { ACCOUNT_KEYCHAIN, type SubscriptionIntentResponse, TIP20_SELECTORS } from '@sile/shared'

export type Call = { to: Address; data: Hex }

/** Keychain signature type for P256 keys (IAccountKeychain.SignatureType.P256). */
const SIGNATURE_TYPE_P256 = 1

/**
 * The access-key grant for a subscription: limit = plan amount per plan period, only
 * `transferWithMemo` on the plan token, only to the merchant, expiring at `expiry`.
 */
export function buildSubscriptionKey(intent: SubscriptionIntentResponse): Call {
  return {
    to: ACCOUNT_KEYCHAIN,
    data: encodeFunctionData({
      abi: Abis.accountKeychain,
      functionName: 'authorizeKey',
      args: [
        intent.keyId as Address,
        SIGNATURE_TYPE_P256,
        {
          expiry: BigInt(intent.expiry),
          enforceLimits: true,
          limits: [{ token: intent.token as Address, amount: BigInt(intent.limit), period: BigInt(intent.period) }],
          allowAnyCalls: false,
          allowedCalls: [
            {
              target: intent.token as Address,
              selectorRules: [{ selector: TIP20_SELECTORS.transferWithMemo, recipients: [intent.recipient as Address] }],
            },
          ],
        },
      ],
    } as never),
  }
}

/**
 * Calls for a one-signature checkout: authorise the key, then record the subscription.
 * Send them in ONE Tempo transaction signed by the subscriber's root key (passkey):
 *   client.sendTransactionSync({ account, calls: buildSubscribeCalls(intent, planId) })
 * The ledger verifies the key on-chain in the same transaction.
 */
export function buildSubscribeCalls(intent: SubscriptionIntentResponse, planId: bigint | string): Call[] {
  return [
    buildSubscriptionKey(intent),
    {
      to: intent.ledger as Address,
      data: encodeFunctionData({
        abi: subscriptionLedgerAbi,
        functionName: 'subscribe',
        args: [BigInt(planId), intent.keyId as Address],
      }),
    },
  ]
}
