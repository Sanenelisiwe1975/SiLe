import { z } from 'zod'
import { DEFAULT_DUNNING_SCHEDULE_SECONDS, DEFAULT_TOKEN, MODERATO } from '@sile/shared'
import { validateKeyStoreSecret } from './keys/keystore.js'

function validateWebhookUrl(value: string): string {
  const url = new URL(value)
  const isLocal = ['localhost', '127.0.0.1', '::1'].includes(url.hostname) || url.hostname.endsWith('.localhost')
  if (url.protocol !== 'https:' && !isLocal) {
    throw new Error('WEBHOOK_URL must use HTTPS for remote endpoints; localhost HTTP is allowed for local development')
  }
  return value
}

const Env = z.object({
  TEMPO_RPC_URL: z.string().url().default(MODERATO.rpcUrl),
  CHAIN_ID: z.coerce.number().int().default(MODERATO.chainId),
  OPERATOR_PRIVATE_KEY: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  KEYSTORE_SECRET: z
    .string()
    .transform((value) => validateKeyStoreSecret(value))
    .pipe(z.string().min(32)),
  WEBHOOK_SECRET: z.string().min(16),
  WEBHOOK_URL: z.string().url().transform(validateWebhookUrl).optional(),
  FEE_TOKEN: z.string().regex(/^0x[0-9a-fA-F]{40}$/).default(DEFAULT_TOKEN),
  /** When set, the web uses this as the plan period and demo-only endpoints are enabled. */
  DEMO_PERIOD_SECONDS: z.coerce.number().int().positive().optional(),
  DUNNING_SCHEDULE_SECONDS: z
    .string()
    .default(DEFAULT_DUNNING_SCHEDULE_SECONDS.join(','))
    .transform((s) => s.split(',').map((x) => Number(x.trim())))
    .pipe(z.array(z.number().int().positive()).min(1)),
  DATABASE_URL: z.string().default('./sile.sqlite'),
  PORT: z.coerce.number().int().default(8787),
  TICK_SECONDS: z.coerce.number().positive().default(5),
  CORS_ORIGIN: z.string().default('*'),
})

export type Config = z.infer<typeof Env> & { demo: boolean }

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = Env.parse(env)
  return { ...parsed, demo: parsed.DEMO_PERIOD_SECONDS !== undefined }
}
