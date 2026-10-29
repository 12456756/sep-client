import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AutoPlanningController } from './auto-planning-controller'
import { planningRecordSummary } from '../../shared/auto-planning'
import type { ElectronAPI } from '../../shared/ipc'
import type { PlanningRecordChange, PlanningRecordSnapshot } from '../../shared/auto-planning'
import type { ArrangementPlanningProgress } from '../../shared/types'

const owner = { memberId: 'm', enterpriseId: 'e' }
const snapshot = (): PlanningRecordSnapshot => ({ draft: { id: 'draft-a', owner, mode: 'auto', revision: 2, schemaVersion: 1, title: 'Research', goal: 'Research',
  status: 'planning', createdAt: 1, updatedAt: 2, nodes: [], confirmedInputs: [], sharedSkillIds: [], conversation: null, workspace: { mode: 'shared', path: null },
  permissions: { preset: 'read-only' }, lastPlanning: { planningId: 'p', status: 'planning', message: null } }, progress: { owner, draftId: 'draft-a', planningId: 'p', modelId: 'model', sequence: 1, events: [] } })

function harness() {
  let progress!: (event: ArrangementPlanningProgress) => void
  let change!: (event: PlanningRecordChange) => void
  let release!: (value: unknown) => void
  let reads = 0
  const api = { onArrangementPlanningEvent(callback: typeof progress) { progress = callback; return () => {} },
    onPlanningRecordChanged(callback: typeof change) { change = callback; return () => {} },
    async listPlanningRecords() { return { success: true, records: [] } },
    async getPlanningRecord() { reads++; return new Promise(resolve => { release = resolve }) },
  } as unknown as ElectronAPI
  const controller = new AutoPlanningController(owner, api)
  const detach = controller.attach()
  return { controller, detach, progress: (event: ArrangementPlanningProgress) => progress(event), change: (event: PlanningRecordChange) => change(event),
    release: (value: unknown) => release(value), reads: () => reads }
}

test('reopening reuses the cached snapshot and deduplicates an in-flight read', async () => {
  const h = harness()
  const first = h.controller.load('draft-a'), second = h.controller.load('draft-a')
  assert.equal(h.reads(), 1)
  h.release({ success: true, snapshot: snapshot() })
  await Promise.all([first, second])
  assert.equal(h.controller.getRecord('draft-a')?.draft.status, 'planning')
  h.detach()
})

test('a slow snapshot cannot overwrite live planning progress or a newer draft revision', async () => {
  const h = harness()
  const pending = h.controller.load('draft-a')
  const saved = snapshot()
  h.progress({ owner, draftId: 'draft-a', planningId: 'p', sequence: 3, draftRevision: 2, occurredAt: 3, type: 'arrangement_plan_ready', data: { planSummary: 'Latest plan' } })
  h.controller.updateDraft({ ...saved.draft, revision: 4, status: 'ready' })
  h.release({ success: true, snapshot: saved })
  await pending
  assert.equal(h.controller.getRecord('draft-a')?.draft.revision, 4)
  assert.equal(h.controller.getRecord('draft-a')?.progress?.events.at(-1)?.data.planSummary, 'Latest plan')
  h.detach()
})

test('an old session response and another owner cannot populate the current record cache', async () => {
  const h = harness()
  const pending = h.controller.load('draft-a')
  h.change({ owner: { memberId: 'other', enterpriseId: 'e' }, draftId: 'other', record: null })
  h.detach()
  h.release({ success: true, snapshot: snapshot() })
  await pending
  assert.equal(h.controller.getRecord('draft-a'), undefined)
  assert.deepEqual(h.controller.getRecords(), [])
})

test('a deleted record cannot be resurrected by an older read or progress event', async () => {
  const h = harness()
  const pending = h.controller.load('draft-a')
  h.controller.remove('draft-a')
  h.release({ success: true, snapshot: snapshot() })
  await pending
  h.progress({ owner, draftId: 'draft-a', planningId: 'p', draftRevision: 2, occurredAt: 3, type: 'arrangement_plan_ready', data: {} })
  assert.equal(h.controller.getRecord('draft-a'), undefined)
  assert.deepEqual(h.controller.getRecords(), [])
  h.detach()
})

test('a status notification arriving during a stale read triggers one fresh read', async () => {
  const h = harness()
  const pending = h.controller.load('draft-a')
  const latest = snapshot()
  latest.draft = { ...latest.draft, revision: 3, status: 'ready' }
  h.change({ owner, draftId: 'draft-a', record: planningRecordSummary(latest.draft) })
  h.release({ success: true, snapshot: snapshot() })
  await pending
  assert.equal(h.reads(), 2)
  h.release({ success: true, snapshot: latest })
  await h.controller.load('draft-a')
  assert.equal(h.controller.getRecord('draft-a')?.draft.status, 'ready')
  h.detach()
})

test('progress updates only the selected record and never republishes the whole work list', async () => {
  const h = harness()
  const pending = h.controller.load('draft-a')
  h.release({ success: true, snapshot: snapshot() })
  await pending
  let listNotifications = 0
  h.controller.subscribe(() => listNotifications++)
  for (let sequence = 2; sequence < 200; sequence++) h.progress({ owner, draftId: 'draft-a', planningId: 'p', sequence, draftRevision: 2, occurredAt: sequence, type: 'arrangement_employee_considering', data: {} })
  assert.equal(listNotifications, 0)
  assert.equal(h.controller.getRecord('draft-a')?.progress?.events.length, 128)
  h.detach()
})

test('late initial lists cannot discard records pushed after subscribing', async () => {
  let release!: (value: unknown) => void
  let changed!: (value: PlanningRecordChange) => void
  const api = { listPlanningRecords: () => new Promise(resolve => { release = resolve }),
    onArrangementPlanningEvent: () => () => {}, onPlanningRecordChanged: (callback: typeof changed) => { changed = callback; return () => {} },
  } as unknown as ElectronAPI
  const controller = new AutoPlanningController(owner, api)
  const detach = controller.attach()
  changed({ owner, draftId: 'draft-a', record: planningRecordSummary(snapshot().draft) })
  release({ success: true, records: [] })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(controller.getRecords()[0]?.id, 'draft-a')
  detach()
})

test('submission remains owned by the session after the page listener leaves and duplicate requests share it', async () => {
  let release!: (value: unknown) => void
  let calls = 0
  const api = { listPlanningRecords: async () => ({ success: true, records: [] }),
    onArrangementPlanningEvent: () => () => {}, onPlanningRecordChanged: () => () => {},
    createAndPlanArrangement: () => { calls++; return new Promise(resolve => { release = resolve }) },
  } as unknown as ElectronAPI
  const controller = new AutoPlanningController(owner, api)
  const detach = controller.attach()
  const unsubscribePage = controller.subscribeRecord('draft-a', () => {})
  const input = { requestId: 'request', modelId: 'model', document: snapshot().draft }
  const first = controller.start(input), second = controller.start(input)
  unsubscribePage()
  assert.equal(calls, 1)
  release({ success: true, snapshot: snapshot() })
  await Promise.all([first, second])
  assert.equal(controller.getRecord('draft-a')?.draft.status, 'planning')
  detach()
})

test('list errors are reported only to the current session and rejected reads remain retryable', async () => {
  const failures: unknown[] = []
  const api = { listPlanningRecords: async () => ({ success: false, error: { message: 'Network unavailable' } }),
    onArrangementPlanningEvent: () => () => {}, onPlanningRecordChanged: () => () => {},
    getPlanningRecord: async () => ({ success: false }),
  } as unknown as ElectronAPI
  const controller = new AutoPlanningController(owner, api, error => failures.push(error))
  const detach = controller.attach()
  await assert.rejects(controller.load('draft-a'))
  assert.equal(failures.length, 1)
  api.getPlanningRecord = async () => ({ success: true, snapshot: snapshot() })
  await controller.load('draft-a')
  assert.equal(controller.getRecord('draft-a')?.draft.status, 'planning')
  detach()
})
