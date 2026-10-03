/**
 * Drives the real checkout UI in headless Chromium with a virtual WebAuthn authenticator,
 * so the passkey path (create credential → one-prompt subscribe) is exercised end to end.
 * Needs charger (:8787) and web (:3000) running.
 * Run: pnpm tsx scripts/browser-checkout.ts <planId> [screenshotDir]
 */
import { chromium } from 'playwright'

const planId = process.argv[2] ?? '1'
const shots = process.argv[3] ?? '.'
const WEB = process.env.WEB_URL ?? 'http://localhost:3000'

const browser = await chromium.launch()
const context = await browser.newContext()
const page = await context.newPage()
page.setDefaultNavigationTimeout(180_000) // first dev-mode compile is slow
page.on('pageerror', (e) => console.log('[pageerror]', e.message))
page.on('console', (m) => m.type() === 'error' && console.log('[console]', m.text()))

const cdp = await context.newCDPSession(page)
await cdp.send('WebAuthn.enable')
await cdp.send('WebAuthn.addVirtualAuthenticator', {
  options: {
    protocol: 'ctap2',
    transport: 'internal',
    hasResidentKey: true,
    hasUserVerification: true,
    isUserVerified: true,
    automaticPresenceSimulation: true,
  },
})

const step = async (label: string, fn: () => Promise<unknown>) => {
  const t = Date.now()
  await fn()
  console.log(`✔ ${label} (${((Date.now() - t) / 1000).toFixed(1)}s)`)
}

try {
  await step('checkout page loads plan', async () => {
    await page.goto(`${WEB}/checkout/${planId}`)
    await page.getByText(`Plan #${planId}`).waitFor({ timeout: 90_000 })
  })
  await step('create passkey account (virtual authenticator)', async () => {
    await page.getByRole('button', { name: 'Create passkey account' }).click()
    await page.getByText('passkey', { exact: true }).waitFor({ timeout: 30_000 })
  })
  await step('fund from faucet', async () => {
    await page.getByRole('button', { name: 'Get test funds' }).click()
    await page.getByRole('button', { name: 'Funding…' }).waitFor({ state: 'hidden', timeout: 60_000 })
    await page.getByRole('button', { name: /^Subscribe — / }).and(page.locator(':enabled')).waitFor({ timeout: 60_000 })
  })
  await page.screenshot({ path: `${shots}/checkout-before.png`, fullPage: true })
  await step('subscribe with ONE passkey signature → first charge lands', async () => {
    await page.getByRole('button', { name: /^Subscribe — / }).click()
    await page.getByText('You’re subscribed').waitFor({ timeout: 120_000 })
  })
  await page.screenshot({ path: `${shots}/checkout-done.png`, fullPage: true })
  const links = await page.locator('a[href*="/tx/"]').evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).href))
  console.log('tx links:', links)
  console.log('BROWSER CHECKOUT OK')
} catch (e) {
  await page.screenshot({ path: `${shots}/checkout-failure.png`, fullPage: true })
  console.log('✘', (e as Error).message.split('\n')[0])
  process.exitCode = 1
} finally {
  await browser.close()
}
