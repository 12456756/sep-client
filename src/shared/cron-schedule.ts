import { CronExpressionParser } from 'cron-parser'

/** Five-field, minute-resolution schedules only; avoid ambiguous DOM/DOW union semantics. */
export function isValidCron(expression: string): boolean {
  const fields = expression.trim().split(/\s+/)
  if (fields.length !== 5 || fields.some(field => !/^[\d*,/-]+$/.test(field)) || (fields[2] !== '*' && fields[4] !== '*')) return false
  try { CronExpressionParser.parse(expression, { currentDate: new Date('2026-01-01T00:00:00Z'), tz: 'UTC' }).next(); return true } catch { return false }
}

export function cronPreview(expression: string, timezone: string, after: number, count = 3): number[] {
  const iterator = CronExpressionParser.parse(expression, { currentDate: new Date(after), tz: timezone })
  return Array.from({ length: count }, () => iterator.next().getTime())
}

export function latestCronTime(expression: string, timezone: string, at: number): number {
  return CronExpressionParser.parse(expression, { currentDate: new Date(at + 1), tz: timezone }).prev().getTime()
}
