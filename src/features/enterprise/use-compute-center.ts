import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  ComputeCenterOverview,
  ComputeUsageBreakdownResult,
  ComputeUsageRecordsResult,
  WalletTransactionsResult,
} from '../../shared/ipc'
import type { ComputeBreakdownDays, ComputePageQuery, ComputeUsageQuery } from '../../shared/compute-credit-contracts'
import {
  beginComputeLoad,
  beginComputeRequest,
  correctComputePageQuery,
  createComputeRequestState,
  failComputeLoad,
  finishComputeLoad,
  invalidateComputeRequest,
  isCurrentComputeRequest,
  resolveComputeQuery,
  type ComputeLoadResult,
  type ComputeLoadState,
} from './compute-request-state'

export type ComputeCenterTab = 'overview' | 'usage' | 'wallet'

export interface ComputeCenterState {
  overview: ComputeLoadState<ComputeCenterOverview>
  walletTransactions: ComputeLoadState<NonNullable<WalletTransactionsResult['data']>>
  usageRecords: ComputeLoadState<NonNullable<ComputeUsageRecordsResult['data']>>
  breakdown: ComputeLoadState<NonNullable<ComputeUsageBreakdownResult['data']>>
  usageQuery: ComputeUsageQuery
  walletQuery: ComputePageQuery
  refresh: () => void
  loadWalletTransactions: (query?: ComputePageQuery) => void
  loadUsageRecords: (query?: ComputeUsageQuery) => void
  loadBreakdown: (days: ComputeBreakdownDays) => void
}

const DEFAULT_PAGE: ComputePageQuery = { page: 1, pageSize: 20 }
const DEFAULT_USAGE_QUERY: ComputeUsageQuery = { page: 1, pageSize: 20 }
const DEFAULT_ERROR = '暂时无法获取算力数据，请稍后重试。'

function useComputeRequest<T>(initialLoading = false) {
  const [state, setState] = useState<ComputeLoadState<T>>({ data: null, loading: initialLoading, error: null })
  const request = useRef(createComputeRequestState())
  const mounted = useRef(false)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      request.current = invalidateComputeRequest(request.current)
    }
  }, [])

  const run = useCallback(async (
    load: (isCurrent: () => boolean) => Promise<ComputeLoadResult<T>>,
    fallbackError: string,
  ): Promise<void> => {
    if (!mounted.current) return
    request.current = beginComputeRequest(request.current)
    const version = request.current.version
    const isCurrent = () => isCurrentComputeRequest(request.current, version, mounted.current)
    setState(beginComputeLoad)
    try {
      const result = await load(isCurrent)
      if (isCurrent()) setState(current => isCurrent() ? finishComputeLoad(current, result, fallbackError) : current)
    } catch {
      if (isCurrent()) setState(current => isCurrent() ? failComputeLoad(current, fallbackError) : current)
    }
  }, [])

  return { state, run, request }
}

export function useComputeCenter(activeTab: ComputeCenterTab): ComputeCenterState {
  const { state: overview, run: runOverview } = useComputeRequest<ComputeCenterOverview>(true)
  const { state: walletTransactions, run: runWallet, request: walletRequest } = useComputeRequest<NonNullable<WalletTransactionsResult['data']>>()
  const { state: usageRecords, run: runUsage, request: usageRequest } = useComputeRequest<NonNullable<ComputeUsageRecordsResult['data']>>()
  const { state: breakdown, run: runBreakdown } = useComputeRequest<NonNullable<ComputeUsageBreakdownResult['data']>>()
  const [usageQuery, setUsageQuery] = useState<ComputeUsageQuery>({ ...DEFAULT_USAGE_QUERY })
  const [walletQuery, setWalletQuery] = useState<ComputePageQuery>({ ...DEFAULT_PAGE })
  // Refs make back-to-back loads/refreshes observe the latest query before React renders.
  const usageQueryRef = useRef(usageQuery)
  const walletQueryRef = useRef(walletQuery)

  const loadOverview = useCallback(() => {
    void runOverview(() => window.electronAPI.getComputeCenterOverview(), DEFAULT_ERROR)
  }, [runOverview])

  const loadWalletTransactions = useCallback((query?: ComputePageQuery) => {
    const nextQuery = resolveComputeQuery(walletQueryRef.current, query)
    void runWallet(async isCurrent => {
      walletQueryRef.current = nextQuery
      setWalletQuery(nextQuery)
      const result = await window.electronAPI.getPersonalWalletTransactions(nextQuery)
      if (!isCurrent() || !result.success || !result.data) return result
      const corrected = correctComputePageQuery(nextQuery, result.data)
      if (!corrected) return result
      walletQueryRef.current = corrected
      setWalletQuery(corrected)
      // A logical load has at most one corrective fetch, even if totals keep shrinking.
      return window.electronAPI.getPersonalWalletTransactions(corrected)
    }, '个人钱包流水加载失败，请稍后重试。')
  }, [runWallet])

  const loadUsageRecords = useCallback((query?: ComputeUsageQuery) => {
    const nextQuery = resolveComputeQuery(usageQueryRef.current, query)
    void runUsage(async isCurrent => {
      usageQueryRef.current = nextQuery
      setUsageQuery(nextQuery)
      const result = await window.electronAPI.getComputeUsageRecords(nextQuery)
      if (!isCurrent() || !result.success || !result.data) return result
      const corrected = correctComputePageQuery(nextQuery, result.data)
      if (!corrected) return result
      usageQueryRef.current = corrected
      setUsageQuery(corrected)
      return window.electronAPI.getComputeUsageRecords(corrected)
    }, '消费明细加载失败，请稍后重试。')
  }, [runUsage])

  const loadBreakdown = useCallback((days: ComputeBreakdownDays) => {
    void runBreakdown(() => window.electronAPI.getComputeUsageBreakdown(days), '消费趋势加载失败，请稍后重试。')
  }, [runBreakdown])

  useEffect(() => { loadOverview() }, [loadOverview])
  useEffect(() => {
    if (activeTab === 'wallet' && !walletRequest.current.attempted) loadWalletTransactions()
    if (activeTab === 'usage' && !usageRequest.current.attempted) loadUsageRecords()
  }, [activeTab, loadUsageRecords, loadWalletTransactions, usageRequest, walletRequest])

  const refresh = useCallback(() => {
    loadOverview()
    if (activeTab === 'wallet') loadWalletTransactions()
    if (activeTab === 'usage') loadUsageRecords()
  }, [activeTab, loadOverview, loadUsageRecords, loadWalletTransactions])

  return { overview, walletTransactions, usageRecords, breakdown, usageQuery, walletQuery, refresh, loadWalletTransactions, loadUsageRecords, loadBreakdown }
}
