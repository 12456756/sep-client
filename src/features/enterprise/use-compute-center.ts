import { useCallback, useEffect, useState } from 'react'
import type {
  ComputeCenterOverview,
  ComputeUsageBreakdownResult,
  ComputeUsageRecordsResult,
  WalletTransactionsResult,
} from '../../shared/ipc'
import type { ComputeBreakdownDays, ComputePageQuery, ComputeUsageQuery } from '../../shared/compute-credit-contracts'

export type ComputeCenterTab = 'overview' | 'usage' | 'wallet'

interface LoadState<T> {
  data: T | null
  loading: boolean
  error: string | null
}

export interface ComputeCenterState {
  overview: LoadState<ComputeCenterOverview>
  walletTransactions: LoadState<NonNullable<WalletTransactionsResult['data']>>
  usageRecords: LoadState<NonNullable<ComputeUsageRecordsResult['data']>>
  breakdown: LoadState<NonNullable<ComputeUsageBreakdownResult['data']>>
  refresh: () => void
  loadWalletTransactions: (query?: ComputePageQuery) => void
  loadUsageRecords: (query?: ComputeUsageQuery) => void
  loadBreakdown: (days: ComputeBreakdownDays) => void
}

const DEFAULT_PAGE: ComputePageQuery = { page: 1, pageSize: 20 }
const DEFAULT_USAGE_QUERY: ComputeUsageQuery = { page: 1, pageSize: 20 }

function failureMessage(result: { success: boolean; error?: { message: string } }): string | null {
  return result.success ? null : result.error?.message ?? '暂时无法获取算力数据，请稍后重试。'
}

export function useComputeCenter(activeTab: ComputeCenterTab): ComputeCenterState {
  const [overview, setOverview] = useState<LoadState<ComputeCenterOverview>>({ data: null, loading: true, error: null })
  const [walletTransactions, setWalletTransactions] = useState<ComputeCenterState['walletTransactions']>({ data: null, loading: false, error: null })
  const [usageRecords, setUsageRecords] = useState<ComputeCenterState['usageRecords']>({ data: null, loading: false, error: null })
  const [breakdown, setBreakdown] = useState<ComputeCenterState['breakdown']>({ data: null, loading: false, error: null })

  const loadOverview = useCallback(() => {
    setOverview(current => ({ ...current, loading: true, error: null }))
    void window.electronAPI.getComputeCenterOverview().then(result => {
      const error = failureMessage(result)
      setOverview({ data: result.success ? result.data ?? null : null, loading: false, error })
    }).catch(() => setOverview({ data: null, loading: false, error: '暂时无法获取算力数据，请稍后重试。' }))
  }, [])

  const loadWalletTransactions = useCallback((query: ComputePageQuery = DEFAULT_PAGE) => {
    setWalletTransactions(current => ({ ...current, loading: true, error: null }))
    void window.electronAPI.getPersonalWalletTransactions(query).then(result => {
      const error = failureMessage(result)
      setWalletTransactions({ data: result.success ? result.data ?? null : null, loading: false, error })
    }).catch(() => setWalletTransactions({ data: null, loading: false, error: '个人钱包流水加载失败，请稍后重试。' }))
  }, [])

  const loadUsageRecords = useCallback((query: ComputeUsageQuery = DEFAULT_USAGE_QUERY) => {
    setUsageRecords(current => ({ ...current, loading: true, error: null }))
    void window.electronAPI.getComputeUsageRecords(query).then(result => {
      const error = failureMessage(result)
      setUsageRecords({ data: result.success ? result.data ?? null : null, loading: false, error })
    }).catch(() => setUsageRecords({ data: null, loading: false, error: '消费明细加载失败，请稍后重试。' }))
  }, [])

  const loadBreakdown = useCallback((days: ComputeBreakdownDays) => {
    setBreakdown({ data: null, loading: true, error: null })
    void window.electronAPI.getComputeUsageBreakdown(days).then(result => {
      const error = failureMessage(result)
      setBreakdown({ data: result.success ? result.data ?? null : null, loading: false, error })
    }).catch(() => setBreakdown({ data: null, loading: false, error: '消费趋势加载失败，请稍后重试。' }))
  }, [])

  useEffect(() => { loadOverview() }, [loadOverview])
  useEffect(() => {
    if (activeTab === 'wallet' && !walletTransactions.data && !walletTransactions.loading) loadWalletTransactions()
    if (activeTab === 'usage' && !usageRecords.data && !usageRecords.loading) loadUsageRecords()
  }, [activeTab, loadUsageRecords, loadWalletTransactions, usageRecords.data, usageRecords.loading, walletTransactions.data, walletTransactions.loading])

  const refresh = useCallback(() => {
    loadOverview()
    if (activeTab === 'wallet') loadWalletTransactions()
    if (activeTab === 'usage') loadUsageRecords()
  }, [activeTab, loadOverview, loadUsageRecords, loadWalletTransactions])

  return { overview, walletTransactions, usageRecords, breakdown, refresh, loadWalletTransactions, loadUsageRecords, loadBreakdown }
}
