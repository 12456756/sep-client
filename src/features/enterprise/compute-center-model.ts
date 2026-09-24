import type { ComputeAllowance, ComputeUsageBreakdown, PersonalWallet } from '../../shared/compute-credit-contracts'

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

export function formatComputePercent(value: number | null): number {
  if (value === null || !Number.isFinite(value)) return 0
  return Math.min(100, Math.max(0, value))
}

export interface ComputeCenterOverview {
  allowance: ComputeAllowance
  wallet: PersonalWallet
  breakdown: ComputeUsageBreakdown
}
