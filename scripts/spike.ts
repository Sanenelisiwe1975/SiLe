/**
 * SiLe protocol spike (Moderato). Run: pnpm spike
 *
 * Verifies the assumptions SiLe is built on before any scaffolding:
 *  a. faucet funding
 *  b. authorise a P256 access key with a periodic limit + recipient scope
 *  c. transferWithMemo signed by the key succeeds (fee sponsored by an operator)
 *  d. over-limit / out-of-scope charges are rejected by the protocol
 *  e. key authorisation + a contract call in ONE root-signed Tempo tx
 *  f. memo type / event shape
 *  plus: does Scopes.transfer cover transferWithMemo? do fees count against the limit?
 *        recurring reset, revoked-key and insufficient-balance error shapes.
 *
 * Test-only keys are persisted to .spike-state.json (gitignored) so reruns reuse funded accounts.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import {
  type Address,
  type Hex,
  decodeErrorResult,
  decodeEventLog,
  encodeFunctionData,
  formatUnits,
  http,
  pad,
  parseEventLogs,
  stringToHex,
} from 'viem'
import { generatePrivateKey } from 'viem/accounts'
import { tempoModerato } from 'viem/chains'
import { Abis, Account, Expiry, P256, Scopes, createClient } from 'viem/tempo'

const ALPHA_USD = '0x20c0000000000000000000000000000000000001' as const
const KEYCHAIN = '0xaAAAaaAA00000000000000000000000000000000' as const
const PERIOD = 30 // seconds
const EXPLORER = 'https://explore.testnet.tempo.xyz/tx/'

const client = createClient({ chain: tempoModerato, transport: http(), feeToken: ALPHA_USD })

// ---------- helpers ----------
const findings: string[] = []
const note = (s: string) => {
  findings.push(s)
  console.log(`  ✔ ${s}`)
}
const step = (s: string) => console.log(`\n=== ${s}`)

const errorAbi = [...Abis.accountKeychain, ...Abis.tip20] as const
function describeError(e: unknown): string {
  const parts: string[] = []
  let c: any = e
  const seen = new Set()
  while (c && !seen.has(c)) {
    seen.add(c)
    const msg = (c.shortMessage ?? c.message ?? '').split('\n')[0]
    parts.push(`${c.name ?? 'Error'}: ${msg}`)
    for (const d of [c.data, c.data?.data, c.raw]) {
      if (typeof d === 'string' && d.startsWith('0x') && d.length >= 10) {
        try {
          const r = decodeErrorResult({ abi: errorAbi, data: d as Hex })
          parts.push(`decoded: ${r.errorName}(${JSON.stringify(r.args, (_, v) => (typeof v === 'bigint' ? v.toString() : v))})`)
        } catch {
          parts.push(`raw data: ${d.slice(0, 74)}`)
        }
      }
    }
    if (c.details) parts.push(`details: ${String(c.details).slice(0, 300)}`)
    c = c.cause
  }
  return parts.join('\n      ')
}
async function expectFailure(label: string, fn: () => Promise<unknown>) {
  try {
    const r: any = await fn()
    console.log(`  ✘ UNEXPECTED SUCCESS (${label}) ${r?.transactionHash ?? ''}`)
    findings.push(`UNEXPECTED: ${label} succeeded`)
  } catch (e) {
    const d = describeError(e)
    console.log(`  ✔ ${label} rejected:\n      ${d}`)
    findings.push(`${label} rejected → ${d.split('\n')[0]} | ${d.match(/decoded: \w+/)?.[0] ?? 'no decoded error'}`)
  }
}
const balance = (a: Address) =>
  client.readContract({ address: ALPHA_USD, abi: Abis.tip20, functionName: 'balanceOf', args: [a] })
const remaining = (account: Address, key: Address) =>
  client.accessKey.getRemainingLimit({ account, accessKey: key, token: ALPHA_USD })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

type State = { root: Hex; operator: Hex; merchant: Hex }
const STATE_FILE = '.spike-state.json'
const state: State = existsSync(STATE_FILE)
  ? JSON.parse(readFileSync(STATE_FILE, 'utf8'))
  : { root: generatePrivateKey(), operator: generatePrivateKey(), merchant: generatePrivateKey() }
writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))

const root = Account.fromSecp256k1(state.root) // subscriber
const operator = Account.fromSecp256k1(state.operator) // charger: fee payer
const merchant = Account.fromSecp256k1(state.merchant).address
const newKey = (owner = root) => Account.fromP256(P256.randomPrivateKey(), { access: owner })

console.log({ subscriber: root.address, operator: operator.address, merchant })

// ---------- a. faucet ----------
step('a. faucet')
const chainId = await client.getChainId()
note(`connected chainId=${chainId}`)
for (const a of [root.address, operator.address]) {
  if ((await balance(a)) < 1_000_000n) await client.faucet.fundSync({ account: a })
}
const decimals = await client.readContract({ address: ALPHA_USD, abi: Abis.tip20, functionName: 'decimals' })
const ONE = 10n ** BigInt(decimals)
note(`AlphaUSD decimals=${decimals}; subscriber balance=${formatUnits(await balance(root.address), decimals)}`)

// ---------- scope question: does .transfer() allow transferWithMemo? ----------
step('scope: transfer-only key attempting transferWithMemo')
{
  const k = newKey()
  await client.accessKey.authorizeSync({
    account: root,
    accessKey: k,
    expiry: Expiry.days(1),
    limits: [{ token: ALPHA_USD, limit: ONE, period: PERIOD }],
    scopes: [Scopes.tip20(ALPHA_USD).transfer({ recipients: [merchant] })],
  })
  await expectFailure('transferWithMemo with transfer-only scope', () =>
    client.sendTransactionSync({
      account: k,
      feePayer: operator,
      calls: [
        {
          to: ALPHA_USD,
          data: encodeFunctionData({
            abi: Abis.tip20,
            functionName: 'transferWithMemo',
            args: [merchant, ONE / 10n, pad('0x01', { size: 32 })],
          }),
        },
      ],
    }),
  )
}

// ---------- b. authorise the subscription key ----------
step('b. authorise P256 key: periodic limit + transferWithMemo→merchant scope, fee sponsored')
const subKey = newKey()
const auth = await client.accessKey.authorizeSync({
  account: root,
  accessKey: subKey,
  feePayer: operator,
  expiry: Expiry.months(12),
  limits: [{ token: ALPHA_USD, limit: ONE, period: PERIOD }],
  scopes: [Scopes.tip20(ALPHA_USD).transferWithMemo({ recipients: [merchant] })],
})
note(`key ${subKey.accessKeyAddress} authorised (tx ${EXPLORER}${auth.receipt.transactionHash})`)
note(`authorize with feePayer=operator: status=${auth.receipt.status}`)
{
  const r = await remaining(root.address, subKey.accessKeyAddress)
  const now = BigInt(Math.floor(Date.now() / 1000))
  note(`after authorise: remaining=${r.remaining} periodEnd=${r.periodEnd} (≈now+${r.periodEnd! - now}s)`)
}

const memoFor = (period: number) => pad(stringToHex(`SiLe-spike-${period}`), { size: 32, dir: 'right' })
const charge = (key: ReturnType<typeof newKey>, amount: bigint, memo: Hex, to: Address = merchant, sponsored = true) =>
  client.sendTransactionSync({
    account: key,
    ...(sponsored ? { feePayer: operator } : {}),
    calls: [
      {
        to: ALPHA_USD,
        data: encodeFunctionData({ abi: Abis.tip20, functionName: 'transferWithMemo', args: [to, amount, memo] }),
      },
    ],
  })

// ---------- c. charge 1 ----------
step('c. charge #1 signed by access key, fee sponsored')
const subBefore = await balance(root.address)
const opBefore = await balance(operator.address)
const c1 = await charge(subKey, ONE, memoFor(0))
note(`charge #1 status=${c1.status} ${EXPLORER}${c1.transactionHash}`)
note(`subscriber paid exactly ${formatUnits(subBefore - (await balance(root.address)), decimals)} (operator paid fee ${formatUnits(opBefore - (await balance(operator.address)), decimals)})`)
note(`tx.from=${c1.from} (subscriber=${root.address})`)

// ---------- f. memo ----------
step('f. memo / event shape')
{
  const logs = parseEventLogs({ abi: Abis.tip20, logs: c1.logs, eventName: 'TransferWithMemo' })
  const l = logs[0]!
  note(`TransferWithMemo args=${JSON.stringify(l.args, (_, v) => (typeof v === 'bigint' ? v.toString() : v))}`)
  note(`memo roundtrip equal=${l.args.memo === memoFor(0)} topics=${l.topics.length}`)
  const all = c1.logs.map((x) => {
    try {
      return decodeEventLog({ abi: [...Abis.tip20, ...Abis.accountKeychain], ...x }).eventName
    } catch {
      return `${x.address}:${x.topics[0]?.slice(0, 10)}`
    }
  })
  note(`events in charge tx: ${all.join(', ')}`)
}

// ---------- d. over-limit / out of scope ----------
step('d. protocol rejections')
await expectFailure('second charge in same period (limit exhausted)', () => charge(subKey, ONE, memoFor(0)))
await expectFailure('transfer to non-merchant recipient', () => charge(subKey, 1n, memoFor(0), operator.address))
{
  const r = await remaining(root.address, subKey.accessKeyAddress)
  const now = BigInt(Math.floor(Date.now() / 1000))
  const wait = Number(r.periodEnd! - now) + 3
  console.log(`  …waiting ${wait}s for period rollover (remaining now ${r.remaining})`)
  await sleep(wait * 1000)
  const r2 = await remaining(root.address, subKey.accessKeyAddress)
  note(`after rollover: remaining=${r2.remaining} periodEnd=${r2.periodEnd}`)
  await expectFailure('over-limit charge (amount+1) in fresh period', () => charge(subKey, ONE + 1n, memoFor(1)))
  const c2 = await charge(subKey, ONE, memoFor(1))
  note(`charge #2 after rollover status=${c2.status} ${EXPLORER}${c2.transactionHash}`)
  // Skip estimation (fixed gas) to see whether an over-limit charge lands on-chain as a revert.
  await expectFailure('over-limit charge broadcast with fixed gas', async () => {
    const rc = await client.sendTransactionSync({
      account: subKey,
      feePayer: operator,
      gas: 600_000n,
      calls: [
        {
          to: ALPHA_USD,
          data: encodeFunctionData({ abi: Abis.tip20, functionName: 'transferWithMemo', args: [merchant, ONE, memoFor(1)] }),
        },
      ],
      throwOnReceiptRevert: false,
    } as any)
    console.log(`      on-chain receipt: status=${rc.status} ${EXPLORER}${rc.transactionHash}`)
    if (rc.status === 'reverted') throw new Error(`reverted on-chain ${EXPLORER}${rc.transactionHash}`)
    return rc
  })
}

// ---------- fees vs limit ----------
step('fees vs spending limit (unsponsored)')
{
  const k = newKey()
  await client.accessKey.authorizeSync({
    account: root,
    accessKey: k,
    expiry: Expiry.days(1),
    limits: [{ token: ALPHA_USD, limit: ONE, period: PERIOD }],
    scopes: [Scopes.tip20(ALPHA_USD).transferWithMemo({ recipients: [merchant] })],
  })
  const before = await balance(root.address)
  await charge(k, ONE / 2n, memoFor(9), merchant, false)
  const spent = before - (await balance(root.address))
  const r = await remaining(root.address, k.accessKeyAddress)
  note(`unsponsored: balance dropped ${spent} (amount ${ONE / 2n} + fee ${spent - ONE / 2n}); remaining limit=${r.remaining} (fees ${r.remaining === ONE / 2n ? 'NOT' : 'ARE'} counted)`)
}

// ---------- e. batching ----------
step('e. authorise key + contract call in ONE root-signed tx')
{
  const artifact = JSON.parse(readFileSync('scripts/spike/out/Probe.sol/Probe.json', 'utf8'))
  const probeAbi = artifact.abi
  const dep = await client.sendTransactionSync({
    account: root,
    calls: [{ data: artifact.bytecode.object as Hex }],
  } as any)
  const probe = dep.contractAddress as Address
  note(`Probe deployed at ${probe}`)

  const k = newKey()
  const keyAuthorization = await client.accessKey.signAuthorization({
    account: root,
    accessKey: k,
    expiry: Expiry.months(12),
    limits: [{ token: ALPHA_USD, limit: ONE, period: PERIOD }],
    scopes: [Scopes.tip20(ALPHA_USD).transferWithMemo({ recipients: [merchant] })],
  })
  try {
    const rc = await client.sendTransactionSync({
      account: root,
      feePayer: operator,
      keyAuthorization,
      calls: [{ to: probe, data: encodeFunctionData({ abi: probeAbi, functionName: 'ping', args: [k.accessKeyAddress, ALPHA_USD] }) }],
    })
    const [p] = parseEventLogs({ abi: probeAbi, logs: rc.logs, eventName: 'Pinged' }) as any[]
    note(`ONE tx (keyAuthorization + call, root-signed, sponsored): status=${rc.status} ${EXPLORER}${rc.transactionHash}`)
    note(`Probe saw: sender=${p.args.sender} txKey=${p.args.txKey} expiry=${p.args.expiry} enforceLimits=${p.args.enforceLimits} revoked=${p.args.isRevoked} remaining=${p.args.remaining} periodEnd=${p.args.periodEnd}`)
  } catch (e) {
    console.log(`  ✘ keyAuthorization+call failed:\n      ${describeError(e)}`)
    findings.push(`batch via keyAuthorization FAILED: ${describeError(e).split('\n')[0]}`)
  }
}

// ---------- revoke ----------
step('revoke then charge')
{
  const rv = await client.accessKey.revokeSync({ account: root, accessKey: subKey.accessKeyAddress })
  note(`revoked ${EXPLORER}${rv.receipt.transactionHash}`)
  const r = await remaining(root.address, subKey.accessKeyAddress)
  note(`after revoke: remaining=${r.remaining}`)
  await expectFailure('charge with revoked key', () => charge(subKey, 1n, memoFor(2)))
}

// ---------- insufficient balance ----------
step('insufficient balance (fresh unfunded subscriber, everything sponsored)')
{
  const poor = Account.fromSecp256k1(generatePrivateKey())
  const k = newKey(poor)
  try {
    const a = await client.accessKey.authorizeSync({
      account: poor,
      accessKey: k,
      feePayer: operator,
      expiry: Expiry.days(1),
      limits: [{ token: ALPHA_USD, limit: ONE, period: PERIOD }],
      scopes: [Scopes.tip20(ALPHA_USD).transferWithMemo({ recipients: [merchant] })],
    })
    note(`unfunded account authorised key with sponsored fees: status=${a.receipt.status}`)
    await expectFailure('charge from empty account', () => charge(k, ONE, memoFor(3)))
  } catch (e) {
    console.log(`  ✘ sponsored authorise for unfunded account failed:\n      ${describeError(e)}`)
    findings.push(`sponsored authorise (unfunded) FAILED: ${describeError(e).split('\n')[0]}`)
  }
}

step('SUMMARY')
for (const f of findings) console.log(` - ${f}`)
