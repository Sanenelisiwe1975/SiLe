import { formatUnits } from 'viem'

export const short = (a?: string | null, n = 4) => (a ? `${a.slice(0, 2 + n)}…${a.slice(-n)}` : '—')

export function formatAmount(base: string | bigint, decimals = 6, symbol?: string) {
  const v = formatUnits(BigInt(base), decimals)
  const [i, f = ''] = v.split('.')
  const pretty = `${Number(i).toLocaleString()}${f ? '.' + f.padEnd(2, '0') : '.00'}`
  return symbol ? `${pretty} ${symbol}` : pretty
}

export function formatPeriod(seconds: number) {
  const units: [number, string][] = [
    [30 * 86400, 'month'],
    [7 * 86400, 'week'],
    [86400, 'day'],
    [3600, 'hour'],
    [60, 'minute'],
    [1, 'second'],
  ]
  for (const [s, name] of units) {
    if (seconds % s === 0) {
      const n = seconds / s
      return n === 1 ? name : `${n} ${name}s`
    }
  }
  return `${seconds} seconds`
}

export function relativeTime(unix: number | null | undefined, now = Date.now() / 1000) {
  if (!unix) return '—'
  const d = Math.round(unix - now)
  const abs = Math.abs(d)
  const txt = abs < 60 ? `${abs}s` : abs < 3600 ? `${Math.round(abs / 60)}m` : abs < 86400 ? `${Math.round(abs / 3600)}h` : `${Math.round(abs / 86400)}d`
  return d >= 0 ? `in ${txt}` : `${txt} ago`
}
