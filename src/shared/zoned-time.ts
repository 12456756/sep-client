export function localDateTime(timestamp: number, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(timestamp)
  const part = (name: string) => parts.find(item => item.type === name)?.value ?? ''
  return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}`
}

/** Reject nonexistent or repeated wall times instead of choosing a DST offset. */
export function scheduledInstant(local: string, timezone: string): number {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local)) throw new Error('Enter a complete local date and time.')
  const naive = Date.parse(`${local}:00Z`)
  if (!Number.isFinite(naive) || localDateTime(naive, 'UTC') !== local) throw new Error('Invalid local date or time.')
  const offsets = new Set<number>()
  for (let hours = -36; hours <= 36; hours += 6) {
    const sample = naive + hours * 3600000
    offsets.add(Date.parse(`${localDateTime(sample, timezone)}:00Z`) - sample)
  }
  const matches = [...offsets].map(offset => naive - offset).filter(value => localDateTime(value, timezone) === local)
  if (matches.length !== 1) throw new Error('This local time is in a DST gap or repeated hour. Choose another time.')
  return matches[0]!
}
