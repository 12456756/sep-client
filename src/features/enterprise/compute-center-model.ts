import type { ComputeAllowance, ComputeBreakdownDays, ComputeUsageBreakdown, PersonalWallet } from '../../shared/compute-credit-contracts'

export function formatComputeAmount(value: string | null | undefined): string {
  if (value === null) return '不限额'
  if (value === undefined) return '—'
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return '—'
  return `¥${parsed.toFixed(2)}`
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

export interface ComputeCenterOverview {
  allowance: ComputeAllowance
  wallet: PersonalWallet
  breakdown: ComputeUsageBreakdown
}
