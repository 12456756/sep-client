import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyWorkOrder, enterWorkHubRoute, refreshWorkOrder, workStatusIndicator } from './work-hub-state'
import { resetWorkRecordFilters } from './work-record-filters'

test('opening a work preserves filters and entering records restores its requested filters', () => {
  const initial = { filters: { ...resetWorkRecordFilters(), search: '合同', bucket: 'mine' as const }, selectedWorkId: null }
  const selected = enterWorkHubRoute(initial, { name: 'work', workId: 'a' })
  assert.equal(selected.filters, initial.filters)
  assert.equal(selected.selectedWorkId, 'a')
  assert.deepEqual(enterWorkHubRoute(selected, { name: 'arrange' }), selected)
  assert.deepEqual(enterWorkHubRoute(selected, { name: 'records', bucket: 'done' }), {
    selectedWorkId: 'a', filters: { bucket: 'done', workType: 'all', search: '' },
  })
})

test('status glyphs distinguish queued, unstarted, pending confirmation and failure', () => {
  assert.equal(workStatusIndicator({ status: 'arranging' }), 'unstarted')
  assert.equal(workStatusIndicator({ status: 'running', queuedAt: 10, isActive: false }), 'queued')
  assert.equal(workStatusIndicator({ status: 'arranging', queuedAt: 10, isActive: true }), 'queued')
  assert.equal(workStatusIndicator({ status: 'running', queuedAt: 10, currentRunStartedAt: 20, isActive: true }), 'running')
  assert.equal(workStatusIndicator({ status: 'waiting-user', queuedAt: 10 }), 'attention')
  assert.equal(workStatusIndicator({ status: 'failed', queuedAt: 10 }), 'failed')
})

test('token timestamps keep stable order; state changes and newly inserted works refresh it', () => {
  const a = { id: 'a', status: 'running' as const, isActive: true, currentEmployeeId: 'e', workType: { state: 'loading' as const }, updatedAt: 10 }
  const b = { ...a, id: 'b', updatedAt: 20 }
  const first = refreshWorkOrder([a, b])
  assert.deepEqual(first.ids, ['b', 'a'])
  const tokenUpdate = [{ ...a, updatedAt: 30 }, b]
  assert.equal(refreshWorkOrder(tokenUpdate, first), first)
  assert.equal(refreshWorkOrder([...tokenUpdate].reverse(), first), first)
  assert.deepEqual(applyWorkOrder(tokenUpdate, first).map(work => work.id), ['b', 'a'])
  assert.deepEqual(refreshWorkOrder([{ ...a, status: 'completed', updatedAt: 40 }, b], first).ids, ['a', 'b'])
  assert.deepEqual(refreshWorkOrder([...tokenUpdate, { ...a, id: 'c', updatedAt: 50 }], first).ids, ['c', 'a', 'b'])
})
