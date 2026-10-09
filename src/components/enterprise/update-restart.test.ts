import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ElectronAPI } from '../../shared/ipc'
import { readUpdateTaskStatus } from './update-restart'

function api(value: unknown): Pick<ElectronAPI, 'getTaskStats'> {
  return { getTaskStats: async () => value } as Pick<ElectronAPI, 'getTaskStats'>
}

test('allows restart only when all three active task counts are zero', async () => {
  assert.deepEqual(await readUpdateTaskStatus(api({ success: true, stats: {
    running: 0, pending: 0, waitingApproval: 0, paused: 9, interrupted: 3,
  } })), { status: 'ready' })
  for (const key of ['running', 'pending', 'waitingApproval']) {
    const stats = { running: 0, pending: 0, waitingApproval: 0, [key]: 2 }
    assert.deepEqual(await readUpdateTaskStatus(api({ success: true, stats })), { status: 'blocked', ...stats })
  }
})

test('fails closed for failed, absent, negative, fractional and invalid task stats', async () => {
  const counts = { running: 0, pending: 0, waitingApproval: 0 }
  for (const value of [undefined, { success: false }, { success: true }, { success: 'true', stats: counts },
    { success: true, stats: { ...counts, running: -1 } },
    { success: true, stats: { ...counts, pending: 0.5 } },
    { success: true, stats: { ...counts, waitingApproval: '0' } },
    { success: true, stats: { ...counts, running: Infinity } },
  ]) assert.deepEqual(await readUpdateTaskStatus(api(value)), { status: 'error' })
})

test('does not expose task IPC failure details', async () => {
  const failing = { getTaskStats: async () => { throw new Error('https://secret.invalid/token') } }
  assert.deepEqual(await readUpdateTaskStatus(failing), { status: 'error' })
  assert.deepEqual(await readUpdateTaskStatus(api({ success: false, error: { message: '/secret/path' } })), { status: 'error' })
})
