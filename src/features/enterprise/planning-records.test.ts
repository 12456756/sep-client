import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mergePlanningRecords, planningRecordWork } from './planning-records'
import type { PlanningRecordSummary } from '../../shared/auto-planning'
import type { WorkItem } from './types'

const record: PlanningRecordSummary = { id: 'draft-a', owner: { memberId: 'm', enterpriseId: 'e' }, title: 'Research', goal: 'Research goal',
  status: 'planning', revision: 2, createdAt: 1, updatedAt: 2, workDir: null, lastPlanning: { planningId: 'p', status: 'planning', message: null } }

test('planning records are visible as arrangements without inventing an execution run', () => {
  const work = planningRecordWork(record)
  assert.equal(work.status, 'arranging')
  assert.equal(work.planningDraft?.id, record.id)
  assert.equal(work.isActive, false)
  assert.deepEqual(work.workType, { state: 'resolved', kind: 'arrangement' })
  assert.equal(work.nextUserAction, null)
})

test('ready, cancelled and failed planning records retain their next action', () => {
  assert.equal(planningRecordWork({ ...record, status: 'ready' }).status, 'waiting-user')
  assert.equal(planningRecordWork({ ...record, status: 'planning-failed' }).status, 'failed')
  assert.equal(planningRecordWork({ ...record, status: 'editing', lastPlanning: { planningId: 'p', status: 'cancelled', message: null } }).status, 'paused')
})

test('confirmation replaces the draft only after its classified task is available and keeps the row identity', () => {
  const confirmed = { ...record, status: 'confirmed' as const, confirmedWorkPlanId: 'task-a' }
  assert.equal(mergePlanningRecords([], [confirmed]).length, 1)
  const task = { ...planningRecordWork(record), id: 'task-a', planningDraft: undefined, workType: { state: 'loading' as const } } as WorkItem
  assert.equal(mergePlanningRecords([task], [confirmed]).length, 1)
  const merged = mergePlanningRecords([{ ...task, workType: { state: 'resolved', kind: 'arrangement' } }], [confirmed])
  assert.equal(merged.length, 1)
  assert.equal(merged[0].id, 'task-a')
  assert.equal(merged[0].recordKey, 'draft-a')
  assert.equal(merged[0].planningDraft, undefined)
  assert.deepEqual(mergePlanningRecords([], [confirmed], new Set(['task-a'])), [])
})
