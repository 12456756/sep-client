import type { ComputeAllowance, ComputeBreakdownDays, ComputeUsageBreakdown, PersonalWallet } from '../../shared/compute-credit-contracts'
import { computeBreakdownRowSchema, type ComputeBreakdownRow } from '../../shared/compute-credit-contracts'

export interface ComputeTrendPoint {
  label: string
  value: number
}

export function formatComputeAmount(value: string | null | undefined): string {
  if (value === null) return '不限额'
  if (value === undefined) return '—'
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return '—'
  return `¥${parsed !== 0 && Math.abs(parsed) < 0.01 ? parsed.toFixed(6).replace(/0+$/, '') : parsed.toFixed(2)}`
}

export function formatAllowanceValue(value: string | null | undefined): string {
  return value === null ? '不限额' : formatComputeAmount(value)
}

export function formatConfiguredLimit(value: string | null | undefined): string {
  return value === null || value === undefined ? '未设置' : formatComputeAmount(value)
}

export function formatOptionalComputeAmount(value: string | null | undefined): string {
  return value === null || value === undefined ? '—' : formatComputeAmount(value)
}

/** Add optional monetary fields without losing sub-cent precision before display rounding. */
export function sumComputeAmounts(values: Array<string | null | undefined>): string | undefined {
  const decimals = values.filter((value): value is string => typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value))
  if (!decimals.length) return undefined
  const precision = Math.max(4, ...decimals.map(value => value.split('.')[1]?.length ?? 0))
  const total = decimals.reduce((sum, value) => {
    const [integer, fraction = ''] = value.replace(/^-/, '').split('.')
    const amount = BigInt(integer + fraction.padEnd(precision, '0'))
    return sum + (value.startsWith('-') ? -amount : amount)
  }, 0n)
  const digits = (total < 0n ? -total : total).toString().padStart(precision + 1, '0')
  return `${total < 0n ? '-' : ''}${digits.slice(0, -precision)}.${digits.slice(-precision)}`
}

export function computeModelLabel(model: string | null | undefined): string {
  return model === 'media-real' ? '图片生成 / 编辑（历史未记录模型）' : model || '未记录模型'
}

export type ComputeDistribution = 'byModel' | 'byEmployee' | 'byMember' | 'byDepartment'

export function getComputeDistribution(value: unknown, dimension: ComputeDistribution): ComputeBreakdownRow[] {
  const rows = asRecord(value)[dimension]
  if (!Array.isArray(rows)) return []
  return rows.flatMap(row => {
    const parsed = computeBreakdownRowSchema.safeParse(row)
    return parsed.success ? [parsed.data] : []
  })
}

export function computeUsageDateError(start: string, end: string): string | null {
  for (const value of [start, end]) {
    if (value && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value)) return '请选择有效日期。'
  }
  return start && end && start > end ? '开始日期不能晚于结束日期。' : null
}

export function formatComputePercent(value: number | null): number {
  if (value === null || !Number.isFinite(value)) return 0
  return Math.min(100, Math.max(0, value))
}

/** Calculate the visible remaining allowance from the two monetary values. */
export function formatRemainingPercent(
  limitCNY: string | null | undefined,
  remainingCNY: string | null | undefined,
): number | null {
  if (limitCNY === null || remainingCNY === null || limitCNY === undefined || remainingCNY === undefined) return null
  const limit = Number(limitCNY)
  const remaining = Number(remainingCNY)
  if (!Number.isFinite(limit) || !Number.isFinite(remaining) || limit <= 0) return null
  return formatComputePercent((remaining / limit) * 100)
}

export function selectComputeBreakdown(
  days: ComputeBreakdownDays,
  overview: ComputeUsageBreakdown | null | undefined,
  requested: ComputeUsageBreakdown | null,
): ComputeUsageBreakdown | null {
  return days === 30 ? overview ?? null : requested
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
}

function valueText(value: unknown, fallback: string): string {
  if (typeof value === 'string' && value.length) return value
  if (typeof value === 'number') return String(value)
  return fallback
}

/** Normalize the platform's daily trend while retaining compatibility with older response names. */
export function getComputeTrendPoints(value: unknown): ComputeTrendPoint[] {
  const source = asRecord(value)
  const rows = Array.isArray(source.trend)
    ? source.trend
    : Array.isArray(source.series)
      ? source.series
      : Array.isArray(source.daily)
        ? source.daily
        : []
  return rows.flatMap((row, index) => {
    const item = asRecord(row)
    const raw = item.costCNY ?? item.amountCNY ?? item.value ?? item.totalCNY
    const number = typeof raw === 'string' || typeof raw === 'number' ? Number(raw) : Number.NaN
    return Number.isFinite(number)
      ? [{ label: valueText(item.date ?? item.label, `${index + 1}`), value: number }]
      : []
  })
}

/** Read the total from the current API shape and the legacy nested totals shape. */
export function getComputeTrendTotal(value: unknown): string | undefined {
  const source = asRecord(value)
  const totals = asRecord(source.totals)
  const raw = source.totalCNY ?? totals.costCNY ?? totals.totalCNY
  return typeof raw === 'string' || typeof raw === 'number' ? String(raw) : undefined
}

export interface ComputeCenterOverview {
  allowance: ComputeAllowance
  wallet: PersonalWallet
  breakdown: ComputeUsageBreakdown
}
