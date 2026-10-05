# SiLe — project rules for Claude

SiLe is a non-custodial recurring-billing protocol on Tempo ("Stripe Billing for stablecoins").
A subscriber authorises a merchant-held, scoped P256 **access key** with a **periodic TIP-20
spending limit** (TIP-1011). The SiLe charger pulls each period by signing a direct
`transferWithMemo` with that key. **The chain enforces billing terms; our contracts only keep the
books. No SiLe contract ever moves money.**

Hackathon: Colosseum Crypto World's Fair, Tempo track. Hard deadline **2026-10-12 23:59 PT**.
Priority: a working end-to-end demo over completeness.

## Non-negotiable rules

1. **Charges are direct `transferWithMemo` calls signed by the subscription's access key.** Never route
   a charge through a contract and never use `transferFrom`/`approve`. Spending limits only apply to
   TIP-20 `transfer`/`transferWithMemo`/`approve` (and `startReward`) when `msg.sender == tx.origin`.
   A contract-mediated charge would silently bypass the subscriber's limit.
2. SiLe contracts never hold or move tokens. They store bookkeeping and emit events.
3. Do not guess any chain fact. Every constant lives in `packages/shared/src/constants.ts` with a source-URL
   comment. If the docs contradict this file or the brief, trust the docs, say so, and propose the
   smallest change.
4. Never mark a step done unless it ran: tests, typecheck, or the actual script on Moderato.
5. Commit after each build step, and only with a working state.
6. Access-key private keys are never logged and never stored in plaintext. They live behind `KeyStore`
   (AES-GCM with `KEYSTORE_SECRET`; the KMS adapter is a stub).
7. TypeScript strict mode everywhere except `contracts/`. Licence: Apache-2.0.

## Verified protocol facts (checked 2026-10-03)

| Fact | Value | Source |
|---|---|---|
| Moderato chain ID | `42431` | https://tempo.xyz/developers/docs/quickstart/connection-details |
| Moderato RPC (HTTP / WS) | `https://rpc.moderato.tempo.xyz` / `wss://rpc.moderato.tempo.xyz` | same |
| Moderato explorer | `https://explore.testnet.tempo.xyz` | same |
| Faucet (HTTP) | `POST https://tempo.xyz/developers/api/faucet` with body `{"address":"<lowercase addr>"}` | https://tempo.xyz/developers/docs/quickstart/faucet |
| Faucet (RPC) | `tempo_fundAddress <addr>` on the Moderato RPC; viem: `client.faucet.fundSync({ account })` | same; https://viem.sh/tempo/actions/faucet.fund |
| Faucet tokens (1M each) | pathUSD `0x20c0…0000`, AlphaUSD `0x20c0…0001`, BetaUSD `0x20c0…0002`, ThetaUSD `0x20c0…0003`, OUSD `0x20c0000000000000000000006a37da5c996874be` | faucet page |
| Account Keychain precompile | `0xAAAAAAAA00000000000000000000000000000000` | https://tempo.xyz/developers/docs/protocol/transactions/AccountKeychain |
| Memo type | `bytes32`. `transferWithMemo(address to, uint256 amount, bytes32 memo)` (no return value). Event `TransferWithMemo(address indexed from, address indexed to, uint256 value, bytes32 indexed memo)` | https://tempo.xyz/developers/docs/protocol/tip20/spec, https://tempo.xyz/developers/docs/guide/payments/transfer-memos |
| Token decimals | 6 per the docs' examples (`parseUnits(x, 6)`). **Read `decimals()` at runtime**; never hard-code it | TIP-20 spec |
| Recurring limit | `period > 0` seconds. `periodEnd = authorizeTime + period`. On `now >= periodEnd`, `remaining` resets to `max` and `periodEnd` advances by whole periods | https://github.com/tempoxyz/tempo/blob/main/tips/tip-1011.md |
| Limited scope | Only TIP-20 `transfer`, `transferWithMemo`, `approve`, `startReward`, and only when `msg.sender == tx.origin`. `transferFrom` and native value are NOT limited | Keychain spec; Tempo tx spec |
| Call scopes | `(target, selector, recipients[])`. Recipient lists only for TIP-20 transfer/approve(+memo) selectors. Violation → `CallNotAllowed` | TIP-1011 |
| Over-limit | Reverts the whole tx with `SpendingLimitExceeded` | Keychain spec |
| Revoked key | `keyId` can never be re-authorised on that account → one fresh key per subscription | Keychain spec |
| Expired/revoked key tx | Rejected at validation (`KeyExpired` etc.), not executed | Keychain spec |
| Limited keys | Cannot call keychain mutators and cannot `CREATE`/`CREATE2` | Keychain spec |
| Batching | Tempo tx (type `0x76`) has `calls: Call[]`, executed atomically | https://tempo.xyz/developers/docs/protocol/transactions/spec-tempo-transaction |
| Fee sponsorship | `fee_payer_signature` (secp256k1 only); viem `feePayer: Account` | Tempo tx spec; viem `accessKey.authorize` params |
| Key auth in tx | `key_authorization` (signed by root) can ride on a tx; the new key may sign that same tx | Tempo tx spec |
| No native token | `BALANCE`/`CALLVALUE` return 0. Fees are paid in a USD TIP-20. Calls to non-TIP-20 contracts default to pathUSD fees | https://tempo.xyz/developers/docs/quickstart/evm-compatibility |
| Gas | New storage slot 250k gas; account creation 250k; contract bytes 1000 gas/byte | same |
| Calendar months | Not supported; periods are fixed seconds | https://tempo.xyz/blog/subscriptions-on-tempo/ |

### viem/tempo API (viem 2.57.x)
- Chains: `import { tempoModerato } from 'viem/chains'` (also `Chain.moderato` from `viem/tempo`).
- Client: `createClient({ testnet: true, feeToken })` from `viem/tempo` comes with `tempoActions`.
- Keys: `Account.fromP256(P256.randomPrivateKey(), { access: rootAccount })`.
- Authorise: `client.accessKey.authorizeSync({ accessKey, expiry, limits: [{ token, limit, period }], scopes: [Scopes.tip20(token).transfer({ recipients })] })`.
  `accessKey` may be `{ publicKey, type: 'p256' }`, so the browser only needs the charger's public key.
- Deferred: `client.accessKey.signAuthorization(...)`, then pass `keyAuthorization` to any write.
- Reads: `client.accessKey.getRemainingLimit({ account, accessKey, token }) → { remaining, periodEnd }`, `getMetadata`.
- Revoke: `client.accessKey.revokeSync({ accessKey })`.
- Helpers: `Expiry.hours(n)`, `Period.months(1)` / `Period.seconds(n)`; ABIs: `Abis.tip20` from `viem/tempo`.
- Docs MCP/search: https://viem.sh/api/mcp. Raw markdown for any page is at `<url>.md`.

### Verified on Moderato by `scripts/spike.ts` (2026-10-03, viem 2.57.2)
- **Key ID ≠ `.address`.** `Account.fromP256(pk, { access: root })` returns an account whose `.address` is the
  ROOT account. The keychain key ID is `.accessKeyAddress`. Always store and query `accessKeyAddress`.
- **Scope must name `transferWithMemo`.** A `Scopes.tip20(t).transfer(...)` key calling `transferWithMemo` → `CallNotAllowed`.
  Use `Scopes.tip20(t).transferWithMemo({ recipients: [merchant] })` (selector `0x95777d59`).
- **Fees DO count against the spending limit** when the sender pays them (unsponsored 0.5 transfer used 0.500035 of the limit).
  ⇒ **Every charge MUST be fee-sponsored** (`feePayer: operator`). Sponsored: the subscriber pays exactly the amount.
- **One signature checkout works:** a root-signed tx with `keyAuthorization` + `calls: [contract call]` (fee sponsored) succeeds.
  The called contract sees `msg.sender = subscriber` and can read the new key from the keychain precompile in the same tx
  (`getKey` and `getRemainingLimitWithPeriod` return the fresh key). `getTransactionKey()` = `0x0` (root).
- **ONE root signature (best for passkeys):** `calls: [keychain.authorizeKey(keyId, 1 /*P256*/, KeyRestrictions), ledger.subscribe(planId, keyId)]` signed once by the root works (scripts/spike-batch.ts). `keyAuthorization` + call needs TWO root signatures (auth digest + tx). Canonical selector `0x980a6025` = viem `Abis.accountKeychain` 3-arg overload.
- **Sponsored authorise works for a zero-balance account** (fee payer covers everything).
- Right after authorise: `remaining = limit`, `periodEnd ≈ now + period`. Rollover observed after `periodEnd`.
- Memo: `bytes32`. Charge tx events: `AccessKeySpend, Transfer, TransferWithMemo, Transfer` (the last one is the fee).
  `TransferWithMemo` args are `{from, to, amount, memo}`, with memo indexed (4 topics).
- Error shapes (simulation via `eth_fillTransaction`/estimate; nothing is broadcast, no fee burned):
  | Case | Where | Text / data |
  |---|---|---|
  | over limit | revert, data `0x8a9e71ea` | `Account keychain error: SpendingLimitExceeded` |
  | wrong recipient / selector | revert | `Account keychain error: CallNotAllowed` |
  | revoked key | `InternalRpcError` (validation) | `keychain validation failed: AccountKeychainError(KeyAlreadyRevoked)` |
  | insufficient balance | revert | `TIP20 token error: InsufficientBalance { available, required, token }` |
  Classify on the message string; walk `err.cause` (the text is in `.details`).
- With a fixed `gas`, viem skips estimation: an over-limit charge **lands on-chain as a reverted tx** (explorer-visible). Use this for the demo.

## Commands (filled in as the repo is scaffolded)
- Prerequisites: Node 20+, `corepack enable` (pnpm), Foundry via `foundryup` (upstream Foundry supports Tempo; `tempo-foundry` is deprecated).
- `pnpm i` · `pnpm build` · `pnpm typecheck` · `pnpm test` · `pnpm typecheck:scripts` (Turborepo, concurrency 2: parallel tsgo processes crash on this low-memory/near-full-disk machine)
- Contracts: `cd contracts && forge build && forge test`. `foundry.toml` sets `tempo = true`.
- Deploy (from contracts/, with .env loaded): `forge script script/Deploy.s.sol --rpc-url moderato --broadcast --tempo.fee-token 0x20c0000000000000000000000000000000000001`
- Spike: `pnpm spike` · Contract smoke test on Moderato: `pnpm tsx --env-file=.env scripts/smoke-ledger.ts <registry> <ledger>`
- Deployed addresses: `contracts/deployments/<chainId>.json`
- Charger: `pnpm --filter @sile/charger dev` (reads root .env) · E2E on Moderato: `pnpm --filter @sile/charger e2e` (~3 min; full demo path + dunning)
- ABIs after contract changes: `cd contracts && forge build && cd .. && pnpm gen:abi`
- Web: `pnpm --filter web dev` (NEXT_PUBLIC_CHARGER_URL, default http://localhost:8787)
- Browser checkout test (charger + web running): `pnpm tsx scripts/browser-checkout.ts <planId> [shotDir]` (headless Chromium + virtual WebAuthn authenticator)
- SDK live check (charger running): `pnpm tsx --env-file=.env scripts/sdk-live.ts`
- Browser demo test (charger + web running): `pnpm tsx scripts/browser-demo.ts [shotDir]` (the full demo script: publish → passkey checkout → overcharge rejected → 2nd charge → revoke → cancel)
- Workspace packages ship TS source: use extensionless relative imports (Turbopack does not map `.js`→`.ts`).

## Env vars
`TEMPO_RPC_URL`, `CHAIN_ID`, `DEPLOYER_PRIVATE_KEY`, `OPERATOR_PRIVATE_KEY` (charger: `markPaid` + fee payer),
`MERCHANT_ADDRESS`, `KEYSTORE_SECRET`, `WEBHOOK_SECRET`, `DEMO_PERIOD_SECONDS` (e.g. 60),
`DUNNING_SCHEDULE_SECONDS` (default `3600,21600,86400`; demo `10,30,60`), `DATABASE_URL` (SQLite file).

## Conventions
- Charger DB: SQLite via `@libsql/client` + Drizzle (better-sqlite3 fails to build on this Windows box). Schema avoids SQLite-only types.
- Store every address checksummed (`getAddress`): viem returns `accessKeyAddress` lowercase.
- Demo period: the merchant creates the plan with `DEMO_PERIOD_SECONDS` as its on-chain period, so chain terms always equal billing reality.
- Package scope `@sile/*`. Amounts are `bigint` in base units end to end; format only in the UI.
- Zod at every API boundary. Invoice memo codec lives in `@sile/shared`, mirrors `contracts/src/libs/Invoice.sol`, and both are tested against shared vectors.
- Keep contracts small: storage writes cost 250k gas on Tempo. Prefer events to per-invoice storage.
