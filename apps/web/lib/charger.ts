import type { Invoice, Plan, Subscription, SubscriptionIntentResponse } from '@sile/shared'

export const CHARGER_URL = process.env.NEXT_PUBLIC_CHARGER_URL ?? 'http://localhost:8787'

export type ChargerConfig = {
  chainId: number
  rpcUrl: string
  explorerUrl: string
  planRegistry: `0x${string}`
  subscriptionLedger: `0x${string}`
  feePayer: `0x${string}`
  feeToken: `0x${string}`
  demoPeriodSeconds: number | null
}
export type SubscriptionView = Subscription & { haltReason: string | null; plan?: Plan }
export type SubscriptionDetail = Subscription & { haltReason: string | null; invoices: Invoice[] }
export type Metrics = {
  mrr: string
  collected: string
  counts: { active: number; pastDue: number; canceled: number }
  failedInvoices: Invoice[]
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${CHARGER_URL}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
    cache: 'no-store',
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error ?? `charger ${path} → HTTP ${res.status}`)
  }
  return res.json() as Promise<T>
}

export const charger = {
  config: () => api<ChargerConfig>('/config'),
  plans: (merchant?: string) => api<Plan[]>(`/plans${merchant ? `?merchant=${merchant}` : ''}`),
  intent: (planId: string, subscriber: string) =>
    api<SubscriptionIntentResponse>('/subscriptions/intent', {
      method: 'POST',
      body: JSON.stringify({ planId, subscriber }),
    }),
  subscriptions: (q: { merchant?: string; subscriber?: string }) =>
    api<SubscriptionView[]>(`/subscriptions?${new URLSearchParams(q as Record<string, string>)}`),
  subscription: (id: string) => api<SubscriptionDetail>(`/subscriptions/${id}`),
  metrics: (merchant: string) => api<Metrics>(`/merchants/${merchant}/metrics`),
  csvUrl: (merchant: string) => `${CHARGER_URL}/merchants/${merchant}/invoices.csv`,
  overcharge: (subId: string) =>
    api<{ txHash: `0x${string}`; status: 'success' | 'reverted'; url: string }>(`/demo/overcharge/${subId}`, {
      method: 'POST',
    }),
}
