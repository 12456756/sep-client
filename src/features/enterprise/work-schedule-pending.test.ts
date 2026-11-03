import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import type { ElectronAPI } from '../../shared/ipc'
import type { CreateWorkSchedule } from '../../shared/scheduled-tasks'
import { clearPendingWorkSchedule, readPendingWorkSchedule, retainWorkSchedule } from './work-schedule-pending'

test('unknown creation outcomes retain the exact immutable request and remain isolated by API, account and work', () => {
  const api = {} as ElectronAPI, other = {} as ElectronAPI
  const request: CreateWorkSchedule = { requestId: '11111111-1111-4111-8111-111111111111', taskId: 'work', expectedPlanHash: 'a'.repeat(64),
    name: 'Report', timezone: 'UTC', scheduledAt: 2000, recurrence: { frequency: 'once', interval: 1 } }
  retainWorkSchedule(api, 'account', request)
  request.name = 'Mutated'
  assert.equal(readPendingWorkSchedule(api, 'account', 'work')!.name, 'Report')
  assert.equal(readPendingWorkSchedule(api, 'other', 'work'), undefined)
  assert.equal(readPendingWorkSchedule(other, 'account', 'work'), undefined)
  assert.equal(readPendingWorkSchedule(api, 'account', 'other'), undefined)
  const loaded = readPendingWorkSchedule(api, 'account', 'work')!
  loaded.name = 'Mutated again'
  assert.equal(readPendingWorkSchedule(api, 'account', 'work')!.name, 'Report')
  clearPendingWorkSchedule(api, 'account', 'work')
  assert.equal(readPendingWorkSchedule(api, 'account', 'work'), undefined)
})
