import { type Address, type Hex, http } from 'viem'
import { tempoModerato } from 'viem/chains'
import { Account, createClient } from 'viem/tempo'
import { type Deployment, getDeployment } from '@sile/abi'
import type { Config } from './config.js'

export type Chain = ReturnType<typeof createChain>

export function createChain(config: Config, deployment: Deployment = getDeployment(config.CHAIN_ID)) {
  if (config.CHAIN_ID !== tempoModerato.id) throw new Error(`unsupported chain ${config.CHAIN_ID}`)
  const client = createClient({
    chain: tempoModerato,
    transport: http(config.TEMPO_RPC_URL),
    feeToken: config.FEE_TOKEN as Address,
  })
  const operator = Account.fromSecp256k1(config.OPERATOR_PRIVATE_KEY as Hex)
  return { client, operator, deployment, chainId: config.CHAIN_ID }
}

/** Rebuild a subscription's access-key signer. `.address` is the SUBSCRIBER; key id is `.accessKeyAddress`. */
export function accessKeyAccount(privateKey: Hex, subscriber: Address) {
  return Account.fromP256(privateKey, { access: subscriber })
}
