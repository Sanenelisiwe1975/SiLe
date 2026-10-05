# SiLe demo script (about 3 minutes)

Every step below has been run end to end by `scripts/browser-demo.ts` against Moderato.

## Before recording (10 minutes ahead)

1. `.env` has `DEMO_PERIOD_SECONDS=60` and `DUNNING_SCHEDULE_SECONDS=10,30,60`.
2. Start both services and leave them running:
   - `pnpm --filter @sile/charger dev` (check that http://localhost:8787/health shows `"ok": true`)
   - `pnpm --filter web dev`, then open http://localhost:3000/merchant once so Next compiles it before you record.
3. Use **two browser windows** side by side:
   - **Window A (merchant):** http://localhost:3000/merchant → **Use demo key** → **Get test funds**.
   - **Window B (subscriber):** an incognito/second profile, kept empty for now.
   - Use Chrome or Edge with a working passkey (Windows Hello / Touch ID / phone).
4. Have the explorer ready in a tab: https://explore.testnet.tempo.xyz
5. Optional rehearsal: `pnpm tsx scripts/browser-demo.ts` (~4 min) proves the stack is healthy.

## The script

| Time | Do | Say |
|---|---|---|
| 0:00 | Show the home page. | "Stripe Billing for stablecoins, but the billing terms are enforced by Tempo itself. SiLe never holds or moves your money." |
| 0:15 | **A:** New plan → name "Pro", price 2.50, period **Demo (1 minute)** → **Publish plan**. | "A merchant publishes a plan on-chain. The terms are immutable. 'Monthly' here bills every minute so we can watch it." |
| 0:30 | Copy the checkout link into **B**. Point at "What you authorise". | "The subscriber sees exactly what they're granting: at most 2.50 per minute, only `transferWithMemo`, only to this merchant, expiring in 12 months." |
| 0:45 | **B:** **Create passkey account** → **Get test funds**. | "Their account is a passkey. No seed phrase, and SiLe never sees it." |
| 1:00 | **B:** **Subscribe**, then approve **one** passkey prompt. Wait for "You're subscribed" and the first-charge link. | "One signature authorises a scoped billing key and records the subscription in the same transaction. Seconds later the first charge lands, carrying an invoice memo." |
| 1:20 | Click the first-charge tx link and show the memo and transfer on the explorer. | "A plain stablecoin transfer from the subscriber to the merchant. SiLe paid the fee, so the subscriber paid exactly 2.50." |
| 1:35 | **A:** The subscriber row appears (Paid 1). Click **Try overcharge**, then follow the "rejected by protocol" link. | "Now the merchant tries to take 2.50 plus one cent. That isn't our code saying no: Tempo reverts it on-chain with `SpendingLimitExceeded`." |
| 1:55 | Wait for **Paid 2** (≤ 60 s after the first charge; fill with the next line). | "Each period the limit resets on-chain and the charger pulls again. Double-charging inside a period is impossible." |
| 2:15 | **B:** **My subscriptions**: payments, live key allowance, **Show receipts**. | "The subscriber sees every receipt, and the remaining allowance read straight from the chain." |
| 2:30 | **B:** **Revoke billing key**, then approve one passkey prompt. | "And they can walk away at any time. No cancellation form; the key is simply dead." |
| 2:40 | Wait for the next charge attempt (≤ 60 s): **B** shows "Canceled: key revoked or expired"; **A** shows canceled and "Billing key revoked". | "The merchant's next pull is rejected by Tempo, and SiLe's dunning cancels the subscription and fires a webhook." |
| 2:55 | **A:** **Export invoices (CSV)**. | "Every charge reconciles by tx hash and memo. Chain-enforced terms, off-chain convenience." |

## If something goes wrong

- **Checkout button stays disabled:** the balance hasn't loaded or is too low. Click **Get test funds**.
- **No subscriber row in A:** the charger indexes every 5 s. Check `curl localhost:8787/health` (`lastBlock` should be advancing).
- **Charge #2 hasn't appeared:** periods run from the moment the key was authorised; give it up to 60 s, plus 5 s for the charger to notice.
- **Passkey prompt fails:** use **Use demo key** in window B. The flow is identical; it just signs with a key held in the browser.
- **Need a guaranteed run:** play back the screenshots from `pnpm tsx scripts/browser-demo.ts <dir>`.
