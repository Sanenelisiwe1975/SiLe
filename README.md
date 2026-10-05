# SiLe

**Recurring billing for stablecoins on Tempo, where the chain enforces the billing terms.**

A subscriber grants the merchant a scoped Tempo **access key**: at most the plan amount, once per period, only
`transferWithMemo` of one token, only to the merchant, expiring in 12 months. SiLe's charger pulls each period by
signing a direct transfer with that key. **No SiLe contract ever holds or moves money.** The contracts only keep
the books, and Tempo's protocol enforces the limits. If the merchant (or SiLe) tries to take more, the transaction
is rejected on-chain. The subscriber can revoke the key at any time, and no one's cooperation is needed.

Built for the Colosseum Crypto World's Fair hackathon (Tempo track). Apache-2.0.

## How it works

```
Subscriber (passkey)                              Merchant
   │ checkout: ONE signature                         │ publishes Plan {token, amount, period}
   │   calls = [ keychain.authorizeKey(key, limit=amount/period,
   │                scope=token.transferWithMemo→merchant, expiry=12mo),
   │             ledger.subscribe(planId, key) ]
   ▼                                                 ▼
┌──────────────────────────── Tempo ─────────────────────────────┐
│ Account Keychain precompile: enforces limit, period, scope, expiry │
│ TIP-20 token:                transferWithMemo(merchant, amt, memo)  │
│ PlanRegistry / SubscriptionLedger: plans, status, paid invoices     │
└────────────────────────────────────────────────────────────────────┘
   ▲ each period: transfer signed by the access key,        ▲ markPaid(subId, memo, txHash)
   │ fee paid by the operator                                │
┌──┴──────────────────────── SiLe charger ───────────────────┴──┐
│ indexer · scheduler · dunning · encrypted key store · API · webhooks │
└───────────────────────────────────────────────────────────────┘
```

| Concern | Who enforces it |
|---|---|
| At most `amount` per `period`, to the merchant only | **Tempo** (TIP-1011 periodic limit + call scope) |
| Revocation, expiry | **Tempo** (Account Keychain) |
| Which plan / subscription / invoice a payment belongs to | SiLe ledger + 32-byte memo on every transfer |
| *When* to charge, retries, past-due, cancel | SiLe charger (it can only ask; the chain decides) |

Design notes and every verified protocol fact (with sources) are in [`docs/architecture.md`](docs/architecture.md)
and [`CLAUDE.md`](CLAUDE.md).

### Things we learned on Moderato that shaped the design
- Spending limits only cover direct `transfer`/`transferWithMemo`/`approve` calls where `msg.sender == tx.origin`.
  So charges are never routed through a contract.
- **Sender-paid fees count against the access key's limit.** The charger therefore sponsors every charge's fee,
  and the subscriber pays exactly the plan price.
- A `.transfer()` scope does not allow `transferWithMemo`, so the key is scoped to `transferWithMemo` itself.
- `authorizeKey` + `subscribe` batched in one root-signed transaction is **one passkey prompt**. Using
  `keyAuthorization` would need two prompts. `SubscriptionLedger.subscribe` reads the keychain in that same tx and
  refuses keys that are missing, revoked, unlimited, expiring too soon, or below the plan amount.
- With a limit equal to the plan amount, double-charging within a period is impossible at the protocol level.

## Verified on Moderato (testnet)

| Step | Transaction |
|---|---|
| Subscribe: authorise key + record subscription, one signature | [0xe857…4f8a](https://explore.testnet.tempo.xyz/tx/0xe85777359abbbbd2135f81f1b301695e65ae566438029e68f0cffab29b164f8a) |
| Charge #1 (memo = invoice id) | [0xb9b8…b996](https://explore.testnet.tempo.xyz/tx/0xb9b80b441dbeec6c217f087e476bc47ccc5c6239b5a73c56486a8e2dd29db996) |
| Over-limit pull (amount + 1) → **reverted by Tempo** | [0xfe0f…4101](https://explore.testnet.tempo.xyz/tx/0xfe0fae9d7335f0005bd9181477558b7c10ef2098902cd53dfda2fcd567d84101) |
| Charge #2 after the period | [0xab9b…4d75](https://explore.testnet.tempo.xyz/tx/0xab9b4fab6a4e94dceb7dd605b7486255d8df082b3b17d619d6e5aaf267c94d75) |
| Subscriber revokes key → next charge rejected (`KeyAlreadyRevoked`) → canceled | [0x09bb…7a76](https://explore.testnet.tempo.xyz/tx/0x09bbbab5889427c7ab94add96f96e27a1f7c0128ef25cfa61a3667eaf8b07a76) |

Contracts: `PlanRegistry` [`0x55db…82C5`](https://explore.testnet.tempo.xyz/address/0x55db89fE84e2Bd0ed895702a4382BF42EE6882C5),
`SubscriptionLedger` [`0x8010…e4D5`](https://explore.testnet.tempo.xyz/address/0x80106042b1c49C4e993921D16b9d11cB3056e4D5)
([`contracts/deployments/42431.json`](contracts/deployments/42431.json)).

## Repository

```
contracts/          Foundry: PlanRegistry, SubscriptionLedger, libs/Invoice (memo codec), tests, Deploy script
apps/charger/       Node service: indexer, scheduler (charge engine), dunning, key store, REST API, webhooks
apps/web/           Next.js: checkout (passkey), merchant dashboard, my subscriptions
packages/sdk/       @sile/sdk: createPlan, subscribe, getSubscription, getKeyAllowance, revokeSubscriptionKey
packages/shared/    constants (sourced), memo codec, error classifier, zod schemas, webhook signing
packages/abi/       generated ABIs + deployment addresses
scripts/            protocol spikes, live checks, headless-browser demo test
```

## Run it

Prerequisites: Node 20+, pnpm 9, [Foundry](https://getfoundry.sh) (`foundryup`; upstream Foundry supports Tempo).

```bash
git submodule update --init --recursive   # forge-std + OpenZeppelin
pnpm install
pnpm tsx scripts/init-env.ts              # .env with fresh TEST keys, funded from the Moderato faucet

# Deploy your own contracts. The charger's operator key must hold OPERATOR_ROLE on the ledger.
cd contracts && set -a && . ../.env && set +a
forge script script/Deploy.s.sol --rpc-url moderato --broadcast --tempo.fee-token 0x20c0000000000000000000000000000000000001
# copy the two addresses (and the deploy block as startBlock) into contracts/deployments/42431.json
forge build && cd .. && pnpm gen:abi

pnpm --filter @sile/charger dev       # http://localhost:8787
pnpm --filter web dev                 # http://localhost:3000
```

Then open **/merchant**, publish a plan (the "Demo" period bills every `DEMO_PERIOD_SECONDS`), open its checkout
link in another browser profile, create a passkey account, fund it, and subscribe.

## Tests

| Command | What it proves |
|---|---|
| `pnpm test:contracts` | 25 Forge tests, including memo vectors shared with TS, the ledger's key checks, and the invoice sequence |
| `pnpm test` / `pnpm typecheck` | unit tests for shared, abi, sdk and charger (dunning policy, key store, API, webhooks) |
| `pnpm spike` | protocol assumptions on Moderato (limits, scopes, fees, rollover, error shapes) |
| `pnpm --filter @sile/charger e2e` | real charger on Moderato: two charges, overcharge revert, revoke → cancel, balance dunning |
| `pnpm tsx --env-file=.env scripts/sdk-live.ts` | every SDK function against Moderato |
| `pnpm tsx scripts/browser-demo.ts` | the full demo in headless Chromium with a virtual passkey |

## SDK

```ts
import { createClient } from 'viem/tempo'
import { tempoModerato } from 'viem/chains'
import { subscribe, getKeyAllowance, revokeSubscriptionKey } from '@sile/sdk'

const client = createClient({ chain: tempoModerato, feeToken: '0x20c0000000000000000000000000000000000001' })
const { subId, keyId } = await subscribe(client, { account, chargerUrl: 'http://localhost:8787', planId: 1n })
await getKeyAllowance(client, { subscriber: account.address, keyId, token })   // read live from the keychain
await revokeSubscriptionKey(client, { account, keyId })                          // payments stop at the protocol
```

## Webhooks

`subscription.created | charged | past_due | canceled`, POSTed to `WEBHOOK_URL` with
`X-SiLe-Signature: t=<unix>,v1=<hex HMAC-SHA256(WEBHOOK_SECRET, "<t>.<body>")>`. Verify with
`verifyWebhook` from `@sile/shared/webhooks`. Deliveries go through an outbox with retries.

## Trust model and limits

- **Worst case if the charger is compromised:** at most `amount` per `period`, only to the merchant, until the
  subscriber revokes or the key expires. Tempo enforces that bound, not SiLe.
- **Access-key custody:** keys are AES-256-GCM encrypted at rest with an env secret (hackathon). The `KeyStore`
  interface has a KMS adapter stub for production.
- **Periods are fixed seconds.** Tempo has no calendar months, so "monthly" means 30 days.
- **Hackathon scope:** single token per plan, SQLite (the schema is Postgres-portable), no proration, plan
  metadata inlined as a `data:` URI, passkey public keys remembered per browser.

## License

[Apache-2.0](LICENSE)
