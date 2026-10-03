/** Minimal structured logger. Never pass key material to it. */
const write = (level: string, msg: string, fields?: Record<string, unknown>) =>
  console.log(
    JSON.stringify({ t: new Date().toISOString(), level, msg, ...fields }, (_, v) => (typeof v === 'bigint' ? v.toString() : v)),
  )

export const log = {
  info: (msg: string, fields?: Record<string, unknown>) => write('info', msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => write('warn', msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => write('error', msg, fields),
}
