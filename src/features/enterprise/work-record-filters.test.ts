import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import {
  countWorkRecordStatuses,
  countWorkRecordTypes,
  filterWorkRecords,
  countUnresolvedWorkRecordTypes,
  readWorkRecordFilters,
  resetWorkRecordFilters,
  type WorkRecordFilterState,
  type WorkRecord,
} from './work-record-filters'

type Fixture = WorkRecord & { id: string }

const records: Fixture[] = [
  {
    id: 'conversation', title: '整理合同', goal: '请整理采购合同', currentEmployeeName: '小周',
    status: 'waiting-user', nextUserAction: '确认结果', updatedAt: 10,
    workType: { state: 'resolved', kind: 'conversation' },
  },
  {
    id: 'arrangement', title: '整理报表', goal: '编排月度报表流程', currentEmployeeName: '小李',
    status: 'completed', nextUserAction: null, updatedAt: 30,
    workType: { state: 'resolved', kind: 'arrangement' },
  },
  {
    id: 'loading', title: '等待分类', goal: '分类尚未返回', currentEmployeeName: '小王',
    status: 'running', nextUserAction: null, updatedAt: 20,
    workType: { state: 'loading' },
  },
  {
    id: 'unavailable', title: '分类失败', goal: '分类不可用', currentEmployeeName: '小赵',
    status: 'failed', nextUserAction: null, updatedAt: 40,
    workType: { state: 'unavailable' },
  },
]

const base: WorkRecordFilterState = { bucket: 'all', workType: 'all', search: '' }

describe('work record filters', () => {
  it('reads route state with mine/all/empty defaults and supports reset', () => {
    assert.deepEqual(readWorkRecordFilters({ name: 'records' }), { bucket: 'mine', workType: 'all', search: '' })
    assert.deepEqual(readWorkRecordFilters({ name: 'records', bucket: 'done', workType: 'arrangement', search: '  合同  ' }), {
      bucket: 'done', workType: 'arrangement', search: '  合同  ',
    })
    assert.deepEqual(resetWorkRecordFilters(), { bucket: 'all', workType: 'all', search: '' })
    assert.deepEqual(readWorkRecordFilters({ name: 'home' }), { bucket: 'mine', workType: 'all', search: '' })
  })

  it('uses intersection filtering, trims only the query boundary, and sorts updatedAt descending', () => {
    const result = filterWorkRecords(records, { ...base, bucket: 'all', workType: 'arrangement', search: '  编排  ' })
    assert.deepEqual(result.map(record => record.id), ['arrangement'])

    const sorted = filterWorkRecords(records, base)
    assert.deepEqual(sorted.map(record => record.id), ['unavailable', 'arrangement', 'loading', 'conversation'])
    assert.deepEqual(records.map(record => record.id), ['conversation', 'arrangement', 'loading', 'unavailable'])
  })

  it('keeps unknown types only in all and matches search case-sensitively', () => {
    assert.deepEqual(filterWorkRecords(records, { ...base, workType: 'conversation' }).map(record => record.id), ['conversation'])
    assert.deepEqual(filterWorkRecords(records, { ...base, search: '整理' }).map(record => record.id), ['arrangement', 'conversation'])
    const english: Fixture[] = [{ ...records[0], title: 'Monthly Report', goal: 'Quarterly Summary', currentEmployeeName: 'Alice' }]
    assert.equal(filterWorkRecords(english, { ...base, search: '  Report  ' }).length, 1)
    assert.equal(filterWorkRecords(english, { ...base, search: 'report' }).length, 0)
    assert.equal(filterWorkRecords(english, { ...base, search: 'Summary' }).length, 1)
    assert.equal(filterWorkRecords(english, { ...base, search: 'Alice' }).length, 1)
    assert.equal(filterWorkRecords(english, { ...base, search: 'conversation' }).length, 0)
    assert.equal(filterWorkRecords(english, { ...base, search: '  ' }).length, 1)
  })

  it('counts statuses by type and search, and types by status and search', () => {
    const filters = { bucket: 'all', workType: 'arrangement', search: '' } as const
    assert.deepEqual(countWorkRecordStatuses(records, filters), {
      all: 1, active: 0, mine: 0, done: 1, stopped: 0,
    })

    const searchFilters = { bucket: 'done', workType: 'all', search: '整理' } as const
    assert.deepEqual(countWorkRecordTypes(records, searchFilters), {
      all: 1, conversation: 0, arrangement: 1,
    })
  })

  it('status counts ignore the selected status, not type or search', () => {
    assert.deepEqual(countWorkRecordStatuses(records, { bucket: 'stopped', workType: 'conversation', search: '合同' }), {
      all: 1, active: 0, mine: 1, done: 0, stopped: 0,
    })
    assert.deepEqual(countWorkRecordStatuses(records, { bucket: 'mine', workType: 'all', search: '不存在' }), {
      all: 0, active: 0, mine: 0, done: 0, stopped: 0,
    })
  })

  it('type counts ignore the selected type and include unknown records only in all', () => {
    assert.deepEqual(countWorkRecordTypes(records, { ...base, workType: 'conversation' }), {
      all: 4, conversation: 1, arrangement: 1,
    })
    assert.deepEqual(countWorkRecordTypes(records, { ...base, bucket: 'active' }), {
      all: 1, conversation: 0, arrangement: 0,
    })
  })

  it('keeps mine overlapping other statuses and covers every status bucket', () => {
    const statuses: Fixture[] = ['arranging', 'running', 'waiting-user', 'completed', 'failed', 'paused'].map((status, index) => ({
      ...records[0], id: status, status: status as Fixture['status'], updatedAt: index,
      nextUserAction: status === 'failed' ? '重新试一次' : null,
    }))
    assert.deepEqual(countWorkRecordStatuses(statuses, base), { all: 6, active: 2, mine: 2, done: 1, stopped: 2 })
    assert.deepEqual(filterWorkRecords(statuses, { ...base, bucket: 'mine' }).map(record => record.id), ['failed', 'waiting-user'])
    assert.equal(filterWorkRecords(records, { ...base, bucket: 'done', workType: 'conversation' }).length, 0)
  })

  it('counts loading and unavailable separately within status/search, independent of type', () => {
    assert.deepEqual(countUnresolvedWorkRecordTypes(records, { ...base, workType: 'conversation' }), { loading: 1, unavailable: 1 })
    assert.deepEqual(countUnresolvedWorkRecordTypes(records, { ...base, bucket: 'active' }), { loading: 1, unavailable: 0 })
    assert.deepEqual(countUnresolvedWorkRecordTypes(records, { ...base, search: '失败' }), { loading: 0, unavailable: 1 })
  })

  it('returns zero counts and no records for empty input', () => {
    assert.deepEqual(filterWorkRecords([], base), [])
    assert.deepEqual(countWorkRecordStatuses([], base), { all: 0, active: 0, mine: 0, done: 0, stopped: 0 })
    assert.deepEqual(countWorkRecordTypes([], base), { all: 0, conversation: 0, arrangement: 0 })
    assert.deepEqual(countUnresolvedWorkRecordTypes([], base), { loading: 0, unavailable: 0 })
  })
})
