/**
 * Creates a root .env with fresh Moderato TEST keys and funds them from the faucet.
 * Run: pnpm tsx scripts/init-env.ts   (refuses to overwrite an existing .env)
 */
import { randomBytes } from 'node:crypto'
import { existsSync, writeFileSync } from 'node:fs'
import { http } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { tempoModerato } from 'viem/chains'
import { createClient } from 'viem/tempo'
import { MODERATO } from '@sile/shared'

if (existsSync('.env')) {
  console.error('.env already exists — not overwriting.')
  process.exit(1)
}

const keys = { DEPLOYER: generatePrivateKey(), OPERATOR: generatePrivateKey(), MERCHANT: generatePrivateKey() }
const addr = (k: `0x${string}`) => privateKeyToAccount(k).address
const env = [
  '# Moderato testnet — TEST keys only. Source: https://tempo.xyz/developers/docs/quickstart/connection-details',
  `TEMPO_RPC_URL=${MODERATO.rpcUrl}`,
  `CHAIN_ID=${MODERATO.chainId}`,
  `DEPLOYER_PRIVATE_KEY=${keys.DEPLOYER}`,
  `OPERATOR_PRIVATE_KEY=${keys.OPERATOR}`,
  `OPERATOR_ADDRESS=${addr(keys.OPERATOR)}`,
  `MERCHANT_PRIVATE_KEY=${keys.MERCHANT}`,
  `MERCHANT_ADDRESS=${addr(keys.MERCHANT)}`,
  `KEYSTORE_SECRET=${randomBytes(32).toString('hex')}`,
  `WEBHOOK_SECRET=${randomBytes(32).toString('hex')}`,
  '# WEBHOOK_URL=https://example.com/sile-webhook',
  'DEMO_PERIOD_SECONDS=60',
  'DUNNING_SCHEDULE_SECONDS=10,30,60',
  'DATABASE_URL=./sile.sqlite',
  '',
].join('\n')
writeFileSync('.env', env)
console.log('wrote .env')

const client = createClient({ chain: tempoModerato, transport: http() })
for (const [name, k] of Object.entries(keys)) {
  await client.faucet.fundSync({ account: addr(k) })
  console.log(`funded ${name.toLowerCase()} ${addr(k)}`)
}
