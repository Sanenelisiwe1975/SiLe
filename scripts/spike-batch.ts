/**
 * Spike 2: can ONE root signature authorise an access key AND subscribe, by calling the keychain
 * precompile directly inside the Tempo tx batch? (Avoids a second passkey prompt for keyAuthorization.)
 * Run: pnpm tsx --env-file=.env scripts/spike-batch.ts
 */
import { type Address, type Hex, encodeFunctionData, http, parseEventLogs } from 'viem'
import { generatePrivateKey } from 'viem/accounts'
import { tempoModerato } from 'viem/chains'
import { Abis, Account, Expiry, P256, createClient } from 'viem/tempo'
import { getDeployment, planRegistryAbi, subscriptionLedgerAbi } from '@sile/abi'
import { ACCOUNT_KEYCHAIN, TESTNET_TOKENS, TIP20_SELECTORS, txUrl } from '@sile/shared'

const token = TESTNET_TOKENS.AlphaUSD
const client = createClient({ chain: tempoModerato, transport: http(), feeToken: token })
const d = getDeployment(tempoModerato.id)
const merchant = Account.fromSecp256k1(process.env.MERCHANT_PRIVATE_KEY as Hex)

const authorizeKeyAbi = Abis.accountKeychain.filter((x: any) => x.name === 'authorizeKey')
console.log('authorizeKey ABI variants:', authorizeKeyAbi.map((x: any) => JSON.stringify(x.inputs.map((i: any) => i.type))))

const planRc = await client.sendTransactionSync({
  account: merchant,
  calls: [{ to: d.planRegistry, data: encodeFunctionData({ abi: planRegistryAbi, functionName: 'createPlan', args: [token, 1_000_000n, 60n, 'ipfs://batch', 0n] }) }],
})
const planId = (parseEventLogs({ abi: planRegistryAbi, logs: planRc.logs, eventName: 'PlanCreated' })[0]!.args as any).planId

const root = Account.fromSecp256k1(generatePrivateKey())
await client.faucet.fundSync({ account: root.address })
const key = Account.fromP256(P256.randomPrivateKey(), { access: root })

let signatures = 0
const countingRoot = { ...root, signTransaction: async (...a: any[]) => (signatures++, (root.signTransaction as any)(...a)) }

const authorizeData = encodeFunctionData({
  abi: Abis.accountKeychain,
  functionName: 'authorizeKey',
  args: [
    key.accessKeyAddress,
    1, // P256
    {
      expiry: BigInt(Expiry.months(12)),
      enforceLimits: true,
      limits: [{ token, amount: 1_000_000n, period: 60n }],
      allowAnyCalls: false,
      allowedCalls: [{ target: token, selectorRules: [{ selector: TIP20_SELECTORS.transferWithMemo, recipients: [merchant.address] }] }],
    },
  ],
} as any)
console.log('authorizeKey selector', authorizeData.slice(0, 10), '(spec canonical 0x980a6025)')

const rc = await client.sendTransactionSync({
  account: countingRoot as any,
  calls: [
    { to: ACCOUNT_KEYCHAIN as Address, data: authorizeData },
    { to: d.subscriptionLedger, data: encodeFunctionData({ abi: subscriptionLedgerAbi, functionName: 'subscribe', args: [planId, key.accessKeyAddress] }) },
  ],
})
console.log(`batch status=${rc.status} root signatures=${signatures} ${txUrl(rc.transactionHash)}`)
const lim = await client.accessKey.getRemainingLimit({ account: root.address, accessKey: key.accessKeyAddress, token })
console.log('limit after batch', lim)

// key must be usable for a scoped transferWithMemo
const pay = await client.sendTransactionSync({
  account: key,
  feePayer: Account.fromSecp256k1(process.env.OPERATOR_PRIVATE_KEY as Hex),
  calls: [{ to: token, data: encodeFunctionData({ abi: Abis.tip20, functionName: 'transferWithMemo', args: [merchant.address, 1_000_000n, `0x${'00'.repeat(32)}`] }) }],
})
console.log(`charge with batch-authorised key: ${pay.status} ${txUrl(pay.transactionHash)}`)
