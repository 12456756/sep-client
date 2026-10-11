import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import type { ClientTask, WorkTypeReadResult } from '../../shared/types'
import { TaskReadCache, mergeInitialTaskQuery, mergeTaskList, mergeTaskUpdate } from './task-read-cache'

const task = (id = 'task-a'): ClientTask => ({
  id, title: '工作', prompt: '目标', status: 'running', workDir: null,
  createdAt: 1, startedAt: 2, completedAt: null, error: null, files: [], logs: [],
  ownerId: 'member-a', ownerEnterpriseId: 'enterprise-a', subscriptionId: 'employee-a', activeRunId: 'run-a',
})
const type: WorkTypeReadResult = { state: 'resolved', kind: 'arrangement' }

describe('task query/event reconciliation', () => {
  it('preserves queried type on both raw single and list updates', () => {
    const current = [{ ...task(), workType: type }]
    assert.deepEqual(mergeTaskUpdate(current, { ...task(), title: '实时标题' })[0].workType, type)
    assert.deepEqual(mergeTaskList(current, [task()])[0].workType, type)
    assert.equal(mergeTaskList(current, [task('other')]).length, 1)
  })

  it('adds late query classification without replacing live execution fields', () => {
    const current = [{ ...task(), title: '实时标题', status: 'completed' as const }]
    const next = mergeInitialTaskQuery(current, [{ ...task(), workType: type }], new Set(['task-a']), true)
    assert.equal(next[0].title, '实时标题')
    assert.equal(next[0].status, 'completed')
    assert.deepEqual(next[0].workType, type)
    assert.deepEqual(mergeInitialTaskQuery([], [{ ...task(), workType: type }], new Set(), true), [])
  })

  it('upgrades unavailable live types from a late list query and never downgrades resolved types', () => {
    const unavailable: WorkTypeReadResult = { state: 'unavailable' }
    const current = [{ ...task(), title: '实时标题', workType: unavailable }]
    const next = mergeInitialTaskQuery(current, [{ ...task(), workType: type }], new Set(['task-a']), true)
    assert.equal(next[0].title, '实时标题')
    assert.deepEqual(next[0].workType, type)
    const failed = { ...task(), workType: unavailable }
    assert.deepEqual(mergeTaskUpdate(next, failed)[0].workType, type)
    assert.deepEqual(mergeTaskList(next, [failed])[0].workType, type)
  })

  it('ignores a pending failed query once a list confirms the type', async () => {
    let finish!: (type: WorkTypeReadResult) => void
    const applied: WorkTypeReadResult[] = []
    const cache = new TaskReadCache(() => new Promise(resolve => { finish = resolve }), (_, value) => applied.push(value))
    cache.ensure(task())
    cache.retain([{ ...task(), workType: type }])
    finish({ state: 'unavailable' })
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(applied, [])
    assert.deepEqual(cache.preserve(task()).workType, type)
    cache.retain([{ ...task(), workType: { state: 'unavailable' } }])
    assert.deepEqual(cache.preserve({ ...task(), workType: { state: 'unavailable' } }).workType, type)
  })

  it('deduplicates early queries and ignores results after deletion or scope disposal', async () => {
    let finish!: (type: WorkTypeReadResult) => void
    let reads = 0
    const applied: WorkTypeReadResult[] = []
    const cache = new TaskReadCache(async () => { reads += 1; return new Promise(resolve => { finish = resolve }) }, (_, value) => applied.push(value))
    cache.ensure(task())
    cache.ensure(task())
    assert.equal(reads, 1)
    cache.retain([])
    finish(type)
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(applied, [])
    cache.ensure(task())
    cache.dispose()
    finish(type)
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(applied, [])
  })

  it('keeps successful reads on raw events and retries failures only on meaningful changes', async () => {
    let reads = 0
    const cache = new TaskReadCache(async () => { reads += 1; return reads === 1 ? { state: 'unavailable' } : type }, () => {})
    cache.ensure(task())
    await new Promise(resolve => setImmediate(resolve))
    cache.ensure({ ...task(), title: '流式刷新' })
    assert.equal(reads, 1)
    cache.ensure({ ...task(), status: 'completed' })
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(cache.preserve(task()).workType, type)
    cache.ensure(task())
    assert.equal(reads, 2)
  })

  it('deduplicates explicit retries and recovers an unavailable type without task changes', async () => {
    let finish!: (type: WorkTypeReadResult) => void
    let reads = 0
    const cache = new TaskReadCache(() => { reads += 1; return new Promise(resolve => { finish = resolve }) }, () => {})
    cache.ensure(task())
    finish({ state: 'unavailable' })
    await new Promise(resolve => setImmediate(resolve))
    const unavailable = cache.preserve(task())
    cache.retry(unavailable)
    cache.retry(unavailable)
    assert.equal(reads, 2)
    finish(type)
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(cache.preserve(task()).workType, type)
  })
})
