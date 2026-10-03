# SiLe architecture

## One-line model
The **chain enforces the terms** (a periodic spending limit plus a recipient scope on an access key).
**SiLe keeps the books** (plans, subscriptions, invoices) and **runs the clock** (charger).
No SiLe contract ever custodies or moves funds.

```
 Subscriber (root key / passkey)                Merchant
        │ 1. checkout: authorise access key            │ creates Plan (PlanRegistry)
        │    limit=amount, period=plan.period,         │
        │    scope=token.transferWithMemo→merchant,    │
        │    expiry=12mo   + subscribe(planId, keyId)  │
        ▼                                              ▼
 ┌──────────────── Tempo (Moderato) ─────────────────────────────┐
 │ AccountKeychain 0xAAAA…  ── enforces limit/period/scope/expiry │
 │ TIP-20 token            ── transferWithMemo(merchant,amt,memo) │
 │ PlanRegistry            ── plan terms (immutable, versioned)   │
 │ SubscriptionLedger      ── status + paid-period bookkeeping    │
 └───────────────────────────────────────────────────────────────┘
        ▲ 2. charge: tx from subscriber account,      ▲ 3. markPaid(subId, invoiceId, txHash)
        │    signed by access key, fee sponsored      │    (operator role)
 ┌──────┴──────────── SiLe charger (Node) ────────────┴──────────┐
 │ keys/ KeyStore (AES-GCM, KMS stub)   scheduler/   dunning/     │
 │ indexer/ (events + TransferWithMemo) api/ (REST + webhooks)    │
 │ db/ Drizzle + SQLite                                           │
 └───────────────────────────────────────────────────────────────┘
        ▲ REST                                     │ HMAC webhooks
   apps/web: checkout · merchant dashboard · my subscriptions
```

## Contracts (Solidity, Foundry)
- **PlanRegistry**: `createPlan(token, amount, period, metadataURI) → planId`, owned by `msg.sender` (merchant).
  Terms are immutable; a change means a new plan with `previousPlanId`. `deactivate(planId)` stops new subscriptions.
  Events: `PlanCreated`, `PlanDeactivated`.
- **SubscriptionLedger**: `subscribe(planId, accessKey) → subId` (`msg.sender` = subscriber); `cancel(subId)`
  (subscriber or merchant); operator-only `markPaid(subId, invoiceId, txHash)`, `markPastDue(subId)`, `markCanceled(subId)`.
  States: `Active → PastDue → Active` (on recovery) or `→ Canceled` (terminal). OpenZeppelin `AccessControl` (`OPERATOR_ROLE`).
  Storage per subscription is minimal (plan, subscriber, key, status, paidThroughPeriod). Invoice detail goes in events.
  - *Approved (spike-verified):* in `subscribe`, read the keychain precompile (`getKey`, `getRemainingLimitWithPeriod`)
    to require that the key exists, isn't revoked, outlives one period, and has `remaining >= plan.amount`. Then the ledger
    only ever records subscriptions the chain can actually bill. (The period and scope can't be read back fully;
    the charger checks those off-chain.)
- **libs/Invoice.sol**: memo codec. `invoiceId == memo` (bytes32), deterministic in `(ledger, subId, periodIndex)`:
  `bytes4 "SiLe" | uint8 version | bytes3 reserved | uint64 subId | uint32 periodIndex | bytes12 deploymentTag`,
  where `deploymentTag = bytes12(keccak256(chainId, ledger))`. Retries of the same period reuse the same memo,
  which makes them idempotent and lets one memo join an on-chain transfer to an off-chain invoice. Shared test vectors are run in both Forge and Vitest.

## Billing clock
- The key's `periodEnd` starts at `authorizeTime + period` and the first period's budget is available
  immediately, so the **first charge happens at subscribe time**.
- The charger anchors the schedule to the chain: `nextChargeAt = periodEnd` from
  `getRemainingLimit`. Before signing, it checks `remaining >= amount` and `paidThroughPeriod < periodIndex`.
- **Double charging within a period is impossible at the protocol level**: limit = amount, so a second pull reverts.
- `DEMO_PERIOD_SECONDS` overrides the period in checkout and plan creation, so a "monthly" plan bills every 60 s.

## Charge transaction
- Tempo tx: `from = subscriber`, signed by the subscription's P256 access key, `calls = [token.transferWithMemo(merchant, amount, memo)]`,
  `feePayer = operator` (secp256k1). **Mandatory:** the spike showed sender-paid fees count against the spending limit, so an unsponsored charge of exactly `amount` would fail.
- `nonceKey: 'expiring'` lets charges for many subscriptions go out concurrently without nonce coordination.
- On a success receipt: `markPaid` (operator tx), write the invoice row, emit `subscription.charged`.

## Dunning
Classify each failure:
| Failure | Action |
|---|---|
| Insufficient balance | retry at +1h / +6h / +24h (`DUNNING_SCHEDULE_SECONDS`; demo 10/30/60 s); `markPastDue` after first failure; `markCanceled` after the last |
| `KeyExpired`, revoked key, `KeyNotFound`, `CallNotAllowed`, `SpendingLimitExceeded` | stop immediately → `markCanceled` (revoked/expired) or flag for review (limit/scope = our bug) |
| RPC / transient | short exponential backoff; does not count as a dunning attempt |

## Indexer
Polls `getLogs` from the last processed block: `PlanCreated`, `Subscribed`, `Paid`, `StatusChanged`, keychain
`KeyRevoked` (filter on known keyIds, so revokes are seen before the next charge), and TIP-20 `TransferWithMemo`
filtered on memos with the `SiLe` prefix (memo is indexed). The DB is a cache; the chain is the source of truth.

## Checkout (one signature, spike-verified)
1. Web asks the charger `POST /subscriptions/intent {planId, subscriber}`. The charger creates a P256 key, stores it encrypted,
   and returns `{ keyId, publicKey }`.
2. The subscriber signs **one** Tempo tx: attach `keyAuthorization` (limit = amount, period, scope =
   `Scopes.tip20(token)` transferWithMemo → merchant, expiry 12 months) and call `ledger.subscribe(planId, keyId)`.
   The tx is fee-sponsored by the operator (checked with a zero-balance account). Key ID = `accessKeyAddress`.
3. The indexer sees `Subscribed`, the scheduler charges period 0 immediately, and the UI shows the first receipt.

## API and webhooks
REST: `GET /plans`, `GET /subscriptions?merchant=|subscriber=`, `GET /invoices.csv` (txHash, memo, amount, period),
`GET /metrics` (MRR = Σ active plan amount normalised to 30 days), `POST /subscriptions/intent`, `POST /demo/overcharge`.
Webhooks: `subscription.created|charged|past_due|canceled`, body signed `X-SiLe-Signature: t=<ts>,v1=HMAC_SHA256(secret, t.body)`.

## Demo script (protocol proofs)
1. Subscribe in one flow. 2. First charge lands (explorer link + memo). 3. A second charge lands after 60 s.
4. "Overcharge" button: charger signs `amount + 1` with a fixed gas limit (skips simulation) → lands **on-chain as a reverted tx with `SpendingLimitExceeded`**. Bonus: transfer to a
   non-merchant address → `CallNotAllowed`. 5. Subscriber revokes the key → next charge is rejected → dunning cancels.

## Trust model
- **Merchant/charger compromise:** at most `amount` per period, only to the merchant address, until expiry or revoke.
  That is the subscriber's worst case, and the protocol enforces it.
- **Subscriber:** can revoke at any time from the root key. SiLe can't block that.
- **Key custody:** keys are encrypted at rest with an env secret (hackathon); there is a KMS adapter interface for production.
