import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ComputeUsageAnalysis } from '../../components/enterprise/ComputeUsageAnalysis'
import { ComputePagination, ComputeUsageTab, ComputeWalletTab, computeUsageDetails } from '../../components/enterprise/ComputeUsageTables'
import type { ComputeCenterState } from './use-compute-center'

function render(element: React.ReactElement): string {
  const previous = Reflect.get(globalThis, 'React')
  Object.defineProperty(globalThis, 'React', { configurable: true, value: React })
  try { return renderToStaticMarkup(element) }
  finally {
    if (previous === undefined) Reflect.deleteProperty(globalThis, 'React')
    else Object.defineProperty(globalThis, 'React', { configurable: true, value: previous })
  }
}

function state(patch: Partial<ComputeCenterState> = {}): ComputeCenterState {
  const empty = { data: null, loading: false, error: null }
  const noop = () => {}
  return { overview: empty, breakdown: empty, usageRecords: empty, walletTransactions: empty,
    usageQuery: { page: 1, pageSize: 20 }, walletQuery: { page: 1, pageSize: 20 }, refresh: noop,
    loadUsageRecords: noop, loadWalletTransactions: noop, loadBreakdown: noop, ...patch }
}

test('pagination renders totals, page sizes and bounded navigation including empty pages', () => {
  const html = render(React.createElement(ComputePagination, { query: { page: 2, pageSize: 20 }, total: 41, totalPages: 3, loading: false, label: '消费明细', onChange: () => {} }))
  assert.match(html, /共 41 条/)
  assert.match(html, /第 2 \/ 3 页/)
  assert.match(html, /value="100"/)
  assert.doesNotMatch(html, /disabled/)
  const empty = render(React.createElement(ComputePagination, { query: { page: 1, pageSize: 20 }, total: 0, totalPages: 0, loading: false, label: '钱包流水', onChange: () => {} }))
  assert.equal((empty.match(/disabled=""/g) ?? []).length, 4)
  assert.match(empty, /第 1 \/ 1 页/)
})

test('usage rows show image usage and missing money is not unlimited', () => {
  const model = state({ usageRecords: { data: { records: [{ id: 'img', modelId: 'media-real', costCNY: '0.0042' }], total: 1, totalPages: 1, page: 1, pageSize: 20 }, loading: false, error: null } })
  const html = render(React.createElement(ComputeUsageTab, { state: model, onDetail: () => {} }))
  assert.match(html, /图片生成 \/ 编辑（历史未记录模型）/)
  assert.match(html, /¥0.0042/)
  assert.doesNotMatch(html, /不限额/)
  assert.match(html, /开始日期/)
  assert.match(html, /消费明细下一页/)
})

test('failed refresh retains rows but exposes a retry and disables stale pagination', () => {
  const model = state({ usageRecords: { data: { records: [{ id: 'retained', modelId: 'gpt-image-2' }], total: 50, totalPages: 3, page: 1, pageSize: 20 }, loading: false, error: '刷新失败' } })
  const html = render(React.createElement(ComputeUsageTab, { state: model, onDetail: () => {} }))
  assert.match(html, /gpt-image-2/)
  assert.match(html, /role="alert"/)
  assert.match(html, /刷新失败/)
  assert.match(html, /重试/)
  assert.match(html, /aria-label="消费明细下一页"[^>]*disabled/)
})

test('analysis renders server model totals and hides unavailable administration dimensions', () => {
  const html = render(React.createElement(ComputeUsageAnalysis, { loading: false, error: null, data: { callCount: 23, inputTokens: 1000, outputTokens: 120, byModel: [
    { key: 'gpt-image-2', label: 'gpt-image-2', costCNY: '5.20', callCount: 3, pct: 50 },
    { key: 'media-real', label: 'media-real', costCNY: '5.20', callCount: 20, pct: 50 },
  ], byMember: [], byDepartment: [] } }))
  assert.match(html, /gpt-image-2/)
  assert.match(html, /历史未记录模型/)
  assert.match(html, /¥5.20/)
  assert.match(html, /调用次数/)
  assert.doesNotMatch(html, />成员<|>部门</)
})

test('usage details expose tokens, record and funding without inventing absent values', () => {
  const detail = computeUsageDetails({ id: 'r1', modelId: 'media-real', inputTokens: 0, costCNY: '0.42' })
  assert.deepEqual(detail.entries.find(([label]) => label === '输入 Token'), ['输入 Token', '不适用'])
  assert.deepEqual(detail.entries.find(([label]) => label === '总消费'), ['总消费', '¥0.42'])
  assert.ok(detail.entries.some(([label, value]) => label === '记录 ID' && value === 'r1'))
  assert.equal(detail.entries.some(([, value]) => value === '不限额'), false)
})

test('wallet adjustments use amount direction rather than transaction type', () => {
  const model = state({ walletTransactions: { data: { total: 1, totalPages: 1, page: 1, pageSize: 20, records: [{ id: 'w1', type: 'ADJUSTMENT', amountCNY: '10.00', balanceAfterCNY: '20.00', createdAt: '2026-10-16' }] }, loading: false, error: null } })
  const html = render(React.createElement(ComputeWalletTab, { state: model, onDetail: () => {} }))
  assert.match(html, /compute-money-positive/)
  assert.match(html, /钱包流水下一页/)
  assert.match(html, /调整/)
})
