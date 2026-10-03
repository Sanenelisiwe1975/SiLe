import type { Address } from 'viem'
import { deployments } from './generated.js'

export { planRegistryAbi, subscriptionLedgerAbi, deployments } from './generated.js'

export type Deployment = { planRegistry: Address; subscriptionLedger: Address; operator: Address; startBlock: number }

export function getDeployment(chainId: number): Deployment {
  const d = (deployments as Record<number, Deployment | undefined>)[chainId]
  if (!d) throw new Error(`no SiLe deployment for chain ${chainId}`)
  return d
}
