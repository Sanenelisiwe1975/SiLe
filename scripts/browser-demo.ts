/**
 * The full demo script in headless Chromium (charger :8787 + web :3000 running, DEMO_PERIOD_SECONDS set):
 * merchant (demo key) publishes a plan → subscriber (passkey, separate context) checks out in one prompt →
 * first charge → "Try overcharge" rejected on-chain → CSV has tx + memo → second charge after the period →
 * subscriber revokes the key → next charge rejected by Tempo → dunning cancels → both views show it.
 * Run: pnpm tsx scripts/browser-demo.ts [screenshotDir]
 */
import { type BrowserContext, chromium } from 'playwright'

const shots = process.argv[2] ?? '.'
const WEB = process.env.WEB_URL ?? 'http://localhost:3000'
const browser = await chromium.launch()

async function newPage(ctx: BrowserContext, label: string) {
  const page = await ctx.newPage()
  page.setDefaultNavigationTimeout(180_000)
  page.on('pageerror', (e) => console.log(`[${label} pageerror]`, e.message))
  const cdp = await ctx.newCDPSession(page)
  await cdp.send('WebAuthn.enable')
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  })
  return page
}
const step = async (label: string, fn: () => Promise<unknown>) => {
  const t = Date.now()
  await fn()
  console.log(`✔ ${label} (${((Date.now() - t) / 1000).toFixed(1)}s)`)
}

const merchant = await newPage(await browser.newContext({ viewport: { width: 1280, height: 1000 } }), 'merchant')
const subscriber = await newPage(await browser.newContext(), 'subscriber')
const planName = `E2E ${Date.now().toString(36)}`

try {
  await step('merchant signs in with a fresh demo key and funds it', async () => {
    await merchant.goto(`${WEB}/merchant`)
    await merchant.evaluate(() => localStorage.clear())
    await merchant.reload()
    await merchant.getByRole('button', { name: 'Use demo key' }).click()
    await merchant.getByRole('button', { name: 'Get test funds' }).click()
    await merchant.getByRole('button', { name: 'Funding…' }).waitFor({ state: 'hidden', timeout: 60_000 })
  })

  let checkoutUrl = ''
  await step('merchant publishes a demo-period plan', async () => {
    await merchant.getByLabel('Name').fill(planName)
    await merchant.getByLabel(/Price/).fill('2.50')
    await merchant.getByRole('button', { name: 'Publish plan' }).click()
    const link = merchant.locator('a[href*="/checkout/"]', { hasText: 'http' })
    await link.waitFor({ timeout: 60_000 })
    checkoutUrl = (await link.textContent())!.trim()
    await merchant.getByText(planName).waitFor({ timeout: 30_000 }) // indexed into the plans list
  })
  console.log('  checkout:', checkoutUrl)

  await step('subscriber checks out with a passkey (one prompt)', async () => {
    await subscriber.goto(checkoutUrl)
    await subscriber.getByText(planName).waitFor({ timeout: 60_000 })
    await subscriber.getByRole('button', { name: 'Create passkey account' }).click()
    await subscriber.getByRole('button', { name: 'Get test funds' }).click()
    await subscriber.getByRole('button', { name: 'Funding…' }).waitFor({ state: 'hidden', timeout: 60_000 })
    await subscriber.getByRole('button', { name: /^Subscribe — 2\.50/ }).click()
    await subscriber.getByText('You’re subscribed').waitFor({ timeout: 120_000 })
  })

  await step('dashboard shows the subscriber with 1 paid invoice', async () => {
    const row = merchant.locator('tr', { hasText: planName })
    await row.waitFor({ timeout: 30_000 })
    await row.locator('td').nth(4).filter({ hasText: /^[1-9]/ }).waitFor({ timeout: 30_000 })
  })

  await step('"Try overcharge" is rejected by the protocol on-chain', async () => {
    const row = merchant.locator('tr', { hasText: planName })
    await row.getByRole('button', { name: 'Try overcharge' }).click()
    await row.getByText('rejected by protocol').waitFor({ timeout: 60_000 })
    console.log('  revert tx:', await row.locator('a[href*="/tx/"]').getAttribute('href'))
  })
  await merchant.screenshot({ path: `${shots}/merchant.png`, fullPage: true })

  await step('CSV export contains tx hash + memo for this merchant', async () => {
    const href = await merchant.getByText(/Export invoices/).getAttribute('href')
    const csv = await (await fetch(href!)).text()
    const [header, row] = csv.trim().split('\n')
    if (!header!.startsWith('tx_hash,memo') || !/^0x[0-9a-f]{64},0x53694c65/.test(row ?? '')) throw new Error(`bad csv: ${csv.slice(0, 200)}`)
  })
  await step('subscriber sees the subscription and charge #2 lands after the period', async () => {
    await subscriber.goto(`${WEB}/subscriptions`)
    const card = subscriber.locator('section', { hasText: planName })
    await card.waitFor({ timeout: 60_000 })
    await card.locator('dd').first().filter({ hasText: /^[2-9]/ }).waitFor({ timeout: 150_000 })
  })

  await step('subscriber revokes the billing key (one passkey prompt)', async () => {
    const card = subscriber.locator('section', { hasText: planName })
    await card.getByRole('button', { name: 'Revoke billing key' }).click()
    await card.getByText('Key revoked on-chain').waitFor({ timeout: 60_000 })
    await card.getByText('revoked / expired').waitFor({ timeout: 30_000 })
  })

  await step('next charge is rejected by Tempo and dunning cancels', async () => {
    const card = subscriber.locator('section', { hasText: planName })
    await card.getByText('Canceled: key revoked or expired').waitFor({ timeout: 150_000 })
    await subscriber.screenshot({ path: `${shots}/subscriptions.png`, fullPage: true })
    const row = merchant.locator('tr', { hasText: planName })
    await row.getByText('canceled').waitFor({ timeout: 30_000 })
    await merchant.getByText('Billing key revoked').waitFor({ timeout: 30_000 })
    await merchant.screenshot({ path: `${shots}/merchant-after.png`, fullPage: true })
  })
  console.log('BROWSER DEMO OK')
} catch (e) {
  await merchant.screenshot({ path: `${shots}/merchant-failure.png`, fullPage: true })
  await subscriber.screenshot({ path: `${shots}/subscriber-failure.png`, fullPage: true })
  console.log('✘', (e as Error).message.split('\n')[0])
  process.exitCode = 1
} finally {
  await browser.close()
}
