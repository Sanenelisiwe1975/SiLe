/**
 * Plan metadata lives in the plan's metadataURI. For the hackathon we inline it as a
 * `data:application/json,` URI (no IPFS dependency); anything else falls back to "Plan #id".
 */
export type PlanMeta = { name: string; description?: string }

const PREFIX = 'data:application/json,'

export function encodePlanMeta(meta: PlanMeta): string {
  return PREFIX + encodeURIComponent(JSON.stringify(meta))
}

export function decodePlanMeta(uri: string | undefined, planId: string): PlanMeta {
  if (uri?.startsWith(PREFIX)) {
    try {
      const m = JSON.parse(decodeURIComponent(uri.slice(PREFIX.length)))
      if (typeof m?.name === 'string' && m.name.trim()) return { name: m.name, description: m.description }
    } catch {
      /* fall through */
    }
  }
  return { name: `Plan #${planId}` }
}
