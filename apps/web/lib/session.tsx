'use client'

import { type ReactNode, createContext, useCallback, useContext, useEffect, useState } from 'react'
import type { Hex } from 'viem'
import { generatePrivateKey } from 'viem/accounts'
import { Account, WebAuthnP256 } from 'viem/tempo'

/**
 * Browser identity. The subscriber's ROOT key is either a passkey (WebAuthn P256, recommended)
 * or an explicit demo-only secp256k1 key, which is disabled unless NEXT_PUBLIC_ENABLE_DEMO_MODE=true.
 * SiLe never sees either; it only ever holds the scoped access key the subscriber authorises.
 */
type Root = ReturnType<typeof Account.fromWebAuthnP256> | ReturnType<typeof Account.fromSecp256k1>
export type Session = { kind: 'passkey' | 'demo'; account: Root } | null

type Stored = { kind: 'passkey'; id: string; publicKey: Hex } | { kind: 'demo'; privateKey: Hex }

const SESSION_KEY = 'sile.session'
const PASSKEYS_KEY = 'sile.passkeys' // credential id → public key (a passkey stores only its id on device)
const DEMO_MODE_ENABLED = process.env.NEXT_PUBLIC_ENABLE_DEMO_MODE === 'true'
const DEMO_DISABLED_MESSAGE = 'Demo mode is disabled in this build. Use a passkey account to continue.'

const storage = {
  get<T>(k: string): T | null {
    try {
      const v = localStorage.getItem(k)
      return v ? (JSON.parse(v) as T) : null
    } catch {
      return null
    }
  },
  set(k: string, v: unknown) {
    try {
      if (v === null) localStorage.removeItem(k)
      else localStorage.setItem(k, JSON.stringify(v))
    } catch {
      /* private mode: session just won't persist */
    }
  },
}

function restore(s: Stored): Session {
  if (s.kind === 'passkey') return { kind: 'passkey', account: Account.fromWebAuthnP256({ id: s.id, publicKey: s.publicKey }) }
  return { kind: 'demo', account: Account.fromSecp256k1(s.privateKey) }
}

type Ctx = {
  session: Session
  ready: boolean
  createPasskey: () => Promise<void>
  signInPasskey: () => Promise<void>
  useDemoKey: () => void
  signOut: () => void
}
const SessionContext = createContext<Ctx | null>(null)

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session>(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    if (!DEMO_MODE_ENABLED) {
      storage.set(SESSION_KEY, null)
      storage.set('sile.demo', null)
      setSession(null)
      setReady(true)
      return
    }
    const s = storage.get<Stored>(SESSION_KEY)
    if (s) setSession(restore(s))
    setReady(true)
  }, [])

  const remember = useCallback((s: Stored) => {
    storage.set(SESSION_KEY, s)
    setSession(restore(s))
  }, [])

  const createPasskey = useCallback(async () => {
    const credential = await WebAuthnP256.createCredential({ label: `SiLe subscriber ${new Date().toISOString().slice(0, 10)}` })
    const known = storage.get<Record<string, Hex>>(PASSKEYS_KEY) ?? {}
    storage.set(PASSKEYS_KEY, { ...known, [credential.id]: credential.publicKey })
    remember({ kind: 'passkey', id: credential.id, publicKey: credential.publicKey })
  }, [remember])

  const signInPasskey = useCallback(async () => {
    const known = storage.get<Record<string, Hex>>(PASSKEYS_KEY) ?? {}
    const credential = await WebAuthnP256.getCredential({
      async getPublicKey(c) {
        const pk = known[c.id]
        if (!pk) throw new Error('This passkey was created on another browser. Create a new one here.')
        return pk
      },
    })
    remember({ kind: 'passkey', id: credential.id, publicKey: credential.publicKey })
  }, [remember])

  const useDemoKey = useCallback(() => {
    if (!DEMO_MODE_ENABLED) throw new Error(DEMO_DISABLED_MESSAGE)
    const prev = storage.get<Stored>('sile.demo')
    const s: Stored = prev?.kind === 'demo' ? prev : { kind: 'demo', privateKey: generatePrivateKey() }
    storage.set('sile.demo', s)
    remember(s)
  }, [remember])

  const signOut = useCallback(() => {
    storage.set(SESSION_KEY, null)
    storage.set('sile.demo', null)
    setSession(null)
  }, [])

  return (
    <SessionContext.Provider value={{ session, ready, createPasskey, signInPasskey, useDemoKey, signOut }}>
      {children}
    </SessionContext.Provider>
  )
}

export function useSession() {
  const ctx = useContext(SessionContext)
  if (!ctx) throw new Error('useSession outside SessionProvider')
  return ctx
}
