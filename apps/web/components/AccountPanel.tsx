'use client'

import { useState } from 'react'
import { DEFAULT_TOKEN, addressUrl } from '@sile/shared'
import { client } from '@/lib/chain'
import { formatAmount, short } from '@/lib/format'
import { useBalance, useToken } from '@/lib/hooks'
import { useSession } from '@/lib/session'
import { Button, Card, ErrorNote } from './ui'

/** Sign in (passkey or demo key), show address + balance, top up from the testnet faucet. */
export function AccountPanel({ title = 'Your account' }: { title?: string }) {
  const { session, ready, createPasskey, signInPasskey, useDemoKey, signOut } = useSession()
  const token = useToken(DEFAULT_TOKEN)
  const balance = useBalance(DEFAULT_TOKEN, session?.account.address)
  const [busy, setBusy] = useState<string>()
  const [error, setError] = useState<string>()

  const run = (label: string, fn: () => Promise<unknown> | void) => async () => {
    setBusy(label)
    setError(undefined)
    try {
      await fn()
      balance.refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message.split('\n')[0] : String(e))
    } finally {
      setBusy(undefined)
    }
  }

  if (!ready) return <Card>Loading…</Card>

  if (!session)
    return (
      <Card>
        <h2 className="mb-1 font-semibold">{title}</h2>
        <p className="mb-4 text-sm text-muted">
          Your passkey is your Tempo account. SiLe never holds it — you only grant a capped, revocable billing key.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button onClick={run('create', createPasskey)} disabled={!!busy}>
            {busy === 'create' ? 'Waiting for passkey…' : 'Create passkey account'}
          </Button>
          <Button variant="ghost" onClick={run('signin', signInPasskey)} disabled={!!busy}>
            Sign in with passkey
          </Button>
          <Button variant="ghost" onClick={run('demo', useDemoKey)} disabled={!!busy}>
            Use demo key
          </Button>
        </div>
        {error && <div className="mt-3"><ErrorNote>{error}</ErrorNote></div>}
      </Card>
    )

  const addr = session.account.address
  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold">{title}</h2>
          <a className="font-mono text-sm text-accent hover:underline" href={addressUrl(addr)} target="_blank" rel="noreferrer" title={addr}>
            {short(addr, 6)}
          </a>
          <span className="ml-2 text-xs text-muted">{session.kind === 'passkey' ? 'passkey' : 'demo key'}</span>
          <p className="mt-1 text-sm">
            Balance:{' '}
            <strong>{balance.data !== undefined && token ? formatAmount(balance.data, token.decimals, token.symbol) : '…'}</strong>
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={run('fund', () => client.faucet.fundSync({ account: addr }))} disabled={!!busy}>
            {busy === 'fund' ? 'Funding…' : 'Get test funds'}
          </Button>
          <Button variant="ghost" onClick={signOut}>
            Sign out
          </Button>
        </div>
      </div>
      {error && <div className="mt-3"><ErrorNote>{error}</ErrorNote></div>}
    </Card>
  )
}
