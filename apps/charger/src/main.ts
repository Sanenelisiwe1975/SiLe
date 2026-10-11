import { serve } from '@hono/node-server'
import { createApi } from './api/index.js'
import { createChain } from './chain.js'
import { loadConfig } from './config.js'
import { openDb } from './db/index.js'
import { Indexer } from './indexer/index.js'
import { EnvSecretKeyStore } from './keys/keystore.js'
import { log } from './log.js'
import { ChargeEngine } from './scheduler/engine.js'
import { Webhooks } from './webhooks.js'

const config = loadConfig()
const db = await openDb(config.DATABASE_URL)
const chain = createChain(config)
const keys = new EnvSecretKeyStore(config.KEYSTORE_SECRET)
const webhooks = new Webhooks(db, config.WEBHOOK_SECRET, config.WEBHOOK_URL)
const indexer = new Indexer(db, chain, webhooks)
const engine = new ChargeEngine(db, chain, keys, webhooks, config)

/** One loop: index → reconcile stale state → charge → flush webhooks. Sequential so the operator never races its own txs. */
let stopping = false
async function loop() {
  try {
    const recovered = await engine.reconcileStaleInvoices()
    const repaired = await engine.reconcileManagedSubscriptions()
    if (recovered > 0 || repaired > 0) log.info('startup reconciliation', { recovered, repaired })
  } catch (e) {
    log.error('startup reconciliation failed', { error: String(e).slice(0, 300) })
  }

  while (!stopping) {
    try {
      await indexer.poll()
      await engine.tick()
      await webhooks.flush()
    } catch (e) {
      log.error('loop error', { error: String(e).slice(0, 300) })
    }
    await new Promise((r) => setTimeout(r, config.TICK_SECONDS * 1000))
  }
}

serve({ fetch: createApi({ db, chain, keys, engine, config }).fetch, port: config.PORT })
log.info('charger up', {
  port: config.PORT,
  chainId: chain.chainId,
  ledger: chain.deployment.subscriptionLedger,
  operator: chain.operator.address,
  demo: config.demo,
  dunning: config.DUNNING_SCHEDULE_SECONDS,
})
void loop()

process.on('SIGINT', () => {
  stopping = true
  process.exit(0)
})
