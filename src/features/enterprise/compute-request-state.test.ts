import assert from 'node:assert/strict'
import test from 'node:test'
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
} from './compute-request-state'

test('only the newest request can settle, including stale failures', () => {
  const first = beginComputeRequest(createComputeRequestState())
  const latest = beginComputeRequest(first)
  assert.equal(isCurrentComputeRequest(latest, first.version, true), false)
  assert.equal(isCurrentComputeRequest(latest, latest.version, true), true)
  assert.equal(latest.attempted, true)
})

test('independent resources do not invalidate one another', () => {
  const usage = beginComputeRequest(createComputeRequestState())
  const wallet = beginComputeRequest(beginComputeRequest(createComputeRequestState()))
  assert.equal(isCurrentComputeRequest(usage, usage.version, true), true)
  assert.equal(isCurrentComputeRequest(wallet, wallet.version, true), true)
})

test('unmount invalidates pending requests even after an effect remount', () => {
  const pending = beginComputeRequest(createComputeRequestState())
  assert.equal(isCurrentComputeRequest(pending, pending.version, false), false)
  const invalidated = invalidateComputeRequest(pending)
  assert.equal(invalidated.attempted, false)
  assert.equal(isCurrentComputeRequest(invalidated, pending.version, true), false)
  const remounted = beginComputeRequest(invalidated)
  assert.equal(isCurrentComputeRequest(remounted, pending.version, true), false)
  assert.equal(isCurrentComputeRequest(remounted, remounted.version, true), true)
})

test('a failed first attempt stays attempted and a manual retry gets a new version', () => {
  const attempted = beginComputeRequest(createComputeRequestState())
  finishComputeLoad({ data: null, loading: true, error: null }, { success: false }, 'failed')
  assert.equal(attempted.attempted, true)
  const retry = beginComputeRequest(attempted)
  assert.equal(retry.attempted, true)
  assert.equal(isCurrentComputeRequest(retry, attempted.version, true), false)
})

test('refresh snapshots the current page, page size and all usage filters', () => {
  const current = { page: 4, pageSize: 50, employeeId: 'employee-1', memberId: 'member-1', startDate: '2026-10-01', endDate: '2026-10-16' }
  const refresh = resolveComputeQuery(current)
  assert.deepEqual(refresh, current)
  assert.notEqual(refresh, current)
})

test('an explicit query replaces the current query, allowing filters to be cleared', () => {
  const current = { page: 4, pageSize: 50, employeeId: 'employee-1' }
  const next = { page: 1, pageSize: 20 }
  const resolved = resolveComputeQuery(current, next)
  assert.deepEqual(resolved, next)
  assert.notEqual(resolved, next)
  next.page = 2
  assert.equal(resolved.page, 1)
})

test('loading and both API and transport failures preserve existing data', () => {
  const data = { records: [{ id: 'existing' }] }
  const loading = beginComputeLoad({ data, loading: false, error: 'previous failure' })
  assert.deepEqual(loading, { data, loading: true, error: null })
  assert.deepEqual(finishComputeLoad(loading, { success: false, error: { message: 'API failure' } }, 'fallback'), {
    data, loading: false, error: 'API failure',
  })
  assert.deepEqual(failComputeLoad(loading, 'network failure'), {
    data, loading: false, error: 'network failure',
  })
  assert.deepEqual(finishComputeLoad(loading, { success: false }, 'fallback'), {
    data, loading: false, error: 'fallback',
  })
})

test('a successful retry replaces old data and clears the error', () => {
  assert.deepEqual(finishComputeLoad({ data: 'old', loading: true, error: 'failed' }, { success: true, data: 'new' }, 'fallback'), {
    data: 'new', loading: false, error: null,
  })
})

test('a shrinking total corrects to the last page without dropping filters or page size', () => {
  const query = { page: 5, pageSize: 20, employeeId: 'employee-1', startDate: '2026-10-01' }
  assert.deepEqual(correctComputePageQuery(query, { total: 41 }), { ...query, page: 3 })
  assert.equal(query.page, 5)
  assert.equal(correctComputePageQuery({ ...query, page: 3 }, { total: 41 }), null)
})

test('empty totals correct to page one and never to page zero', () => {
  assert.deepEqual(correctComputePageQuery({ page: 5, pageSize: 50 }, { total: 0 }), { page: 1, pageSize: 50 })
  assert.equal(correctComputePageQuery({ page: 1, pageSize: 50 }, { total: 0 }), null)
})

test('only one page correction is allowed in a logical request even if the total shrinks again', () => {
  const query = { page: 5, pageSize: 20 }
  const corrected = correctComputePageQuery(query, { total: 41 })
  assert.ok(corrected)
  assert.equal(correctComputePageQuery(corrected, { total: 0 }, true), null)
})
