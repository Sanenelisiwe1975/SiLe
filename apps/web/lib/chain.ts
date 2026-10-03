import { http } from 'viem'
import { tempoModerato } from 'viem/chains'
import { createClient } from 'viem/tempo'
import { DEFAULT_TOKEN } from '@sile/shared'

/** Browser Tempo client (Moderato). Fees default to the demo stablecoin. */
export const client = createClient({ chain: tempoModerato, transport: http(), feeToken: DEFAULT_TOKEN })
export type TempoClient = typeof client
