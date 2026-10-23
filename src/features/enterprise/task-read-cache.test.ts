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
  it('ignores delayed single and list events for a successfully deleted record', () => {
    const removed = new Set(['task-a'])
    const current = [task('other')]
    assert.deepEqual(mergeTaskUpdate(current, task(), removed), current)
    assert.deepEqual(mergeTaskList(current, [task(), task('other')], removed).map(item => item.id), ['other'])
    assert.deepEqual(mergeTaskUpdate([task(), ...current], task('other'), removed).map(item => item.id), ['other'])
  })

  it('does not let a stale running snapshot reactivate a user-paused task', () => {
    const paused = { ...task(), status: 'paused' as const, activeRunId: null, lastRunId: 'run-a', lastRunEndedAt: 10 }
    const stale = { ...task(), queuedAt: 9 }
    assert.deepEqual(mergeTaskUpdate([paused], stale), [paused])
    assert.deepEqual(mergeTaskList([paused], [stale]), [paused])
    const pausing = { ...paused, activeRunId: 'run-a' }
    assert.deepEqual(mergeTaskUpdate([pausing], task()), [pausing])
    assert.deepEqual(mergeTaskList([pausing], [task()]), [pausing])
  })

  it('accepts a later explicit retry after a terminal run', () => {
    const paused = { ...task(), status: 'paused' as const, activeRunId: null, lastRunId: 'run-a', lastRunEndedAt: 10 }
    const retry = { ...task(), activeRunId: 'run-b', queuedAt: 11 }
    assert.equal(mergeTaskUpdate([paused], retry)[0]?.activeRunId, 'run-b')
    assert.equal(mergeTaskList([paused], [retry])[0]?.activeRunId, 'run-b')
    const started = { ...task(), activeRunId: 'run-b', queuedAt: null, currentRunStartedAt: 11 }
    assert.equal(mergeTaskUpdate([paused], started)[0]?.activeRunId, 'run-b')
  })

  it('accepts a new run after an explicit retry has returned the task to pending', () => {
    const pending = { ...task(), status: 'pending' as const, activeRunId: null }
    const admitted = { ...pending, activeRunId: 'run-b' }
    assert.equal(mergeTaskUpdate([pending], admitted)[0]?.activeRunId, 'run-b')
  })

  it('does not let an older terminal snapshot replace a newer active run', () => {
    const current = { ...task(), activeRunId: 'run-new' }
    const stale = { ...current, status: 'paused' as const, activeRunId: null, lastRunId: 'run-old' }
    assert.deepEqual(mergeTaskUpdate([current], stale), [current])
    assert.deepEqual(mergeTaskList([current], [stale]), [current])
    const settled = { ...current, status: 'completed' as const, activeRunId: null, lastRunId: 'run-new' }
    assert.equal(mergeTaskUpdate([current], settled)[0]?.status, 'completed')
    assert.deepEqual(mergeTaskUpdate([current], { ...current, activeRunId: 'run-old' }), [current])
    assert.deepEqual(mergeTaskList([current], [{ ...current, activeRunId: null, status: 'pending' }]), [current])
  })

  it('does not restore an old terminal run over a newer terminal or retry preparation', () => {
    const current = { ...task(), status: 'paused' as const, activeRunId: null, lastRunId: 'run-new', lastRunEndedAt: 20 }
    const oldTerminal = { ...current, status: 'completed' as const, lastRunId: 'run-old', lastRunEndedAt: 10 }
    assert.deepEqual(mergeTaskUpdate([current], oldTerminal), [current])
    assert.deepEqual(mergeTaskList([current], [oldTerminal]), [current])
    const retrying = { ...current, status: 'pending' as const, startedAt: null }
    const sameOldRun = { ...retrying, status: 'failed' as const }
    assert.deepEqual(mergeTaskUpdate([retrying], sameOldRun), [retrying])
    const oldEventAfterRetryStarted = { ...retrying, status: 'running' as const, activeRunId: 'run-new' }
    assert.deepEqual(mergeTaskUpdate([retrying], oldEventAfterRetryStarted), [retrying])
  })

  it('keeps a live run when an initial query returns an older lifecycle snapshot', () => {
    const live = { ...task(), activeRunId: 'run-new', queuedAt: 20 }
    const stale = { ...task(), activeRunId: null, status: 'pending' as const, queuedAt: 10 }
    const [merged] = mergeInitialTaskQuery([live], [stale], new Set(), false)
    assert.equal(merged?.activeRunId, 'run-new')
    assert.equal(merged?.queuedAt, 20)
  })

  it('does not restore deleted records from a query started before deletion', () => {
    const removed = new Set(['task-a'])
    for (const receivedList of [false, true]) {
      const current = [task(), task('other')]
      const next = mergeInitialTaskQuery(current, [task()], new Set(), receivedList, removed)
      assert.deepEqual(next.map(item => item.id), ['other'])
    }
    // A new account gets a new deletion set, not the previous account tombstones.
    assert.deepEqual(mergeTaskUpdate([], task(), new Set()), [task()])
  })

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
