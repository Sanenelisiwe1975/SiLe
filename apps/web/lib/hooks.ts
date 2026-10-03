'use client'

import { useCallback, useEffect, useState } from 'react'
import type { Address } from 'viem'
import { Abis } from 'viem/tempo'
import { client } from './chain'

/** Poll an async source. Returns latest data, error, and a manual refresh. */
export function usePoll<T>(fn: (() => Promise<T>) | null, ms = 4000, deps: unknown[] = []) {
  const [data, setData] = useState<T>()
  const [error, setError] = useState<string>()
  const [tick, setTick] = useState(0)
  const refresh = useCallback(() => setTick((t) => t + 1), [])
  useEffect(() => {
    if (!fn) return
    let alive = true
    const run = () =>
      fn()
        .then((d) => alive && (setData(d), setError(undefined)))
        .catch((e) => alive && setError(e instanceof Error ? e.message : String(e)))
    run()
    const id = setInterval(run, ms)
    return () => {
      alive = false
      clearInterval(id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick, ms])
  return { data, error, refresh }
}

const tokenCache = new Map<string, Promise<{ symbol: string; decimals: number }>>()
export function useToken(token?: Address) {
  const [info, setInfo] = useState<{ symbol: string; decimals: number }>()
  useEffect(() => {
    if (!token) return
    const key = token.toLowerCase()
    if (!tokenCache.has(key)) {
      tokenCache.set(
        key,
        Promise.all([
          client.readContract({ address: token, abi: Abis.tip20, functionName: 'symbol' }),
          client.readContract({ address: token, abi: Abis.tip20, functionName: 'decimals' }),
        ]).then(([symbol, decimals]) => ({ symbol, decimals: Number(decimals) })),
      )
    }
    tokenCache.get(key)!.then(setInfo).catch(() => setInfo({ symbol: 'USD', decimals: 6 }))
  }, [token])
  return info
}

export function useBalance(token?: Address, owner?: Address) {
  return usePoll(
    token && owner ? () => client.readContract({ address: token, abi: Abis.tip20, functionName: 'balanceOf', args: [owner] }) : null,
    5000,
    [token, owner],
  )
}
