import type { ComputePageQuery } from '../../shared/compute-credit-contracts'

export interface ComputeLoadState<T> {
  data: T | null
  loading: boolean
  error: string | null
}

export interface ComputeLoadResult<T> {
  success: boolean
  data?: T
  error?: { message: string }
}

interface ComputeRequestState {
  version: number
  attempted: boolean
}

export function createComputeRequestState(): ComputeRequestState {
  return { version: 0, attempted: false }
}

export function beginComputeRequest(state: ComputeRequestState): ComputeRequestState {
  return { version: state.version + 1, attempted: true }
}

export function invalidateComputeRequest(state: ComputeRequestState): ComputeRequestState {
  return { version: state.version + 1, attempted: false }
}

export function isCurrentComputeRequest(state: ComputeRequestState, version: number, mounted: boolean): boolean {
  return mounted && state.version === version
}

export function resolveComputeQuery<Q extends ComputePageQuery>(current: Q, query?: Q): Q {
  return { ...(query ?? current) }
}

export function correctComputePageQuery<Q extends ComputePageQuery>(
  query: Q,
  response: { total: number },
  alreadyCorrected = false,
): Q | null {
  const lastPage = Math.max(1, Math.ceil(response.total / query.pageSize))
  return !alreadyCorrected && query.page > lastPage ? { ...query, page: lastPage } : null
}

export function beginComputeLoad<T>(state: ComputeLoadState<T>): ComputeLoadState<T> {
  return { ...state, loading: true, error: null }
}

export function failComputeLoad<T>(state: ComputeLoadState<T>, error: string): ComputeLoadState<T> {
  return { ...state, loading: false, error }
}

export function finishComputeLoad<T>(state: ComputeLoadState<T>, result: ComputeLoadResult<T>, fallbackError: string): ComputeLoadState<T> {
  return result.success
    ? { data: result.data ?? null, loading: false, error: null }
    : failComputeLoad(state, result.error?.message ?? fallbackError)
}
