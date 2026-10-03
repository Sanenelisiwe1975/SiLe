import type { Address, Hex } from 'viem'

/**
 * Verified Tempo constants. Every value carries its source; verified 2026-10-03
 * (and exercised on Moderato by scripts/spike.ts). Do not add a value without a source.
 */

// Source: https://tempo.xyz/developers/docs/quickstart/connection-details
export const MODERATO = {
  chainId: 42431,
  name: 'Tempo Testnet (Moderato)',
  rpcUrl: 'https://rpc.moderato.tempo.xyz',
  wsUrl: 'wss://rpc.moderato.tempo.xyz',
  explorerUrl: 'https://explore.testnet.tempo.xyz',
} as const

// Source: https://tempo.xyz/developers/docs/quickstart/faucet
export const FAUCET = {
  httpUrl: 'https://tempo.xyz/developers/api/faucet', // POST {"address": "<lowercase address>"}
  rpcMethod: 'tempo_fundAddress',
} as const

// Source: https://tempo.xyz/developers/docs/quickstart/faucet (testnet faucet assets, 1M each)
export const TESTNET_TOKENS = {
  pathUSD: '0x20c0000000000000000000000000000000000000',
  AlphaUSD: '0x20c0000000000000000000000000000000000001',
  BetaUSD: '0x20c0000000000000000000000000000000000002',
  ThetaUSD: '0x20c0000000000000000000000000000000000003',
  OUSD: '0x20c0000000000000000000006a37da5c996874be',
} as const satisfies Record<string, Address>

/** Default billing + fee token for the demo. */
export const DEFAULT_TOKEN: Address = TESTNET_TOKENS.AlphaUSD

// Source: https://tempo.xyz/developers/docs/protocol/transactions/AccountKeychain
export const ACCOUNT_KEYCHAIN: Address = '0xaAAAaaAA00000000000000000000000000000000'

// Source: https://tempo.xyz/developers/docs/protocol/tip20/spec (selectors as exported by viem/tempo Selectors.tip20)
export const TIP20_SELECTORS = {
  transfer: '0xa9059cbb',
  transferWithMemo: '0x95777d59',
} as const satisfies Record<string, Hex>

/** Explorer link helpers. */
export const txUrl = (hash: Hex, explorer: string = MODERATO.explorerUrl) => `${explorer}/tx/${hash}`
export const addressUrl = (addr: Address, explorer: string = MODERATO.explorerUrl) => `${explorer}/address/${addr}`

/** SiLe defaults. */
export const KEY_EXPIRY_MONTHS = 12
export const SECONDS_PER_MONTH = 30 * 24 * 60 * 60 // Tempo periods are fixed seconds; no calendar months
export const DEFAULT_DUNNING_SCHEDULE_SECONDS = [3600, 21600, 86400] as const
