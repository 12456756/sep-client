import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { WorkItem } from './types'
import { groupWorkExecutions, resolveExecutionSelection } from './work-execution-groups'

const work = { id: 'root', title: '智能行李箱策划案', status: 'completed', createdAt: 1, updatedAt: 2, pinnedAt: 9 } as WorkItem
const second = { ...work, id: 'second', title: '旧名称', status: 'running', isActive: true, createdAt: 3, updatedAt: 4, executionGroup: { rootTaskId: 'root', number: 2 } } as WorkItem

test('one execution opens its detail directly; multiple executions open the list', () => {
  assert.equal(resolveExecutionSelection(groupWorkExecutions([work])[0]!).detail?.id, 'root')
  const group = groupWorkExecutions([work, second])[0]!
  assert.equal(resolveExecutionSelection(group).detail, null)
  assert.equal(resolveExecutionSelection(group, 'second').detail?.id, 'second')
  assert.equal(resolveExecutionSelection(group, 'unrelated').detail, null)
})

test('sidebar has one canonical title, pin and active status; executions are newest first', () => {
  const groups = groupWorkExecutions([second, work, { ...work, id: 'same-title' }])
  assert.equal(groups.length, 2)
  const group = groups.find(item => item.work.id === 'root')!
  assert.equal(group.work.title, work.title)
  assert.equal(group.work.pinnedAt, work.pinnedAt)
  assert.equal(group.work.isActive, true)
  assert.deepEqual(group.executions.map(item => item.id), ['second', 'root'])
  assert.deepEqual(group.executions.map(item => item.executionGroup?.number ?? 1), [2, 1])
})

test('missing legacy root keeps surviving executions reachable', () => {
  const group = groupWorkExecutions([second])[0]!
  assert.equal(group.work.id, 'root')
  assert.equal(resolveExecutionSelection(group).detail?.id, 'second')
})
