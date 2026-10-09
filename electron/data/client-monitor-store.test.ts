import { after, describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ClientMonitorStore, type ClientMonitorRecord } from './client-monitor-store'
import { ScopePath } from './scope-path'

const scope = { memberId: 'member-a', enterpriseId: 'enterprise-a' }
const roots: string[] = []

after(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function record(): ClientMonitorRecord {
  return {
    version: 1,
    clientTaskId: 'task-a',
    clientRunId: 'run-a',
    mirrorId: null,
    subscriptionId: 'sub-a',
    title: 'Task',
    taskType: 'conversation',
    modelId: 'model-a',
    lastSequence: 0,
    heartbeatActive: false,
    pending: [],
    updatedAt: Date.now(),
  }
}

describe('ClientMonitorStore', () => {
  it('roundtrips v2 proof and participant operations while rejecting unknown participant metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sep-client-monitor-v2-'))
    roots.push(root)
    const store = new ClientMonitorStore(root)
    const participation = { executionId: 'node-run', subscriptionId: 'node-sub', nodeId: 'node', status: 'FAILED' as const,
      startedAt: '2026-09-22T00:00:00.000Z', completedAt: '2026-09-22T00:00:01.000Z' }
    const saved: ClientMonitorRecord = { ...record(), liveRuns: { 'run-a': { protocolVersion: 2 } }, lastSequence: 1, pending: [
      { id: 'create', kind: 'create', clientRunId: 'run-a', payload: { clientTaskId: 'task-a', clientRunId: 'run-a', subscriptionId: 'sub-a', title: 'Task', protocolVersion: 2, queuedAt: participation.startedAt } },
      { id: 'event', kind: 'event', clientRunId: 'run-a', sequence: 1, payload: { clientRunId: 'run-a', sequence: 1, type: 'model_output', message: 'partial', occurredAt: participation.completedAt, participation } },
    ] }
    await store.save(scope, 'task-a', saved)
    assert.deepEqual(await new ClientMonitorStore(root).load(scope, 'task-a'), saved)
    const file = new ScopePath(root).clientMonitorFile(scope, 'task-a')
    const malformed = structuredClone(saved) as unknown as { pending: Array<{ payload: Record<string, unknown> }>; liveRuns: Record<string, unknown> }
    malformed.pending[1].payload.participation = { ...participation, guessed: true }
    await writeFile(file, JSON.stringify(malformed), 'utf8')
    assert.equal((await store.load(scope, 'task-a'))?.pending.length, 1)
    malformed.liveRuns['run-a'] = { protocolVersion: 2, participation: { ...participation, guessed: true } }
    await writeFile(file, JSON.stringify(malformed), 'utf8')
    assert.equal(await store.load(scope, 'task-a'), null)
    malformed.liveRuns['run-a'] = { protocolVersion: 3 }
    await writeFile(file, JSON.stringify(malformed), 'utf8')
    assert.equal(await store.load(scope, 'task-a'), null)
  })
  it('persists records and pending operations across store instances', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sep-client-monitor-store-'))
    roots.push(root)
    const store = new ClientMonitorStore(root)
    const saved = {
      ...record(),
      pending: [{
        id: 'op-1', kind: 'event' as const, sequence: 1,
        payload: { sequence: 1, type: 'run_started', occurredAt: '2026-09-22T00:00:00.000Z' },
      }],
    }
    await store.save(scope, 'task-a', saved)

    const reopened = new ClientMonitorStore(root)
    assert.deepEqual(await reopened.load(scope, 'task-a'), saved)
    assert.deepEqual(await reopened.listPending(scope), ['task-a'])
  })

  it('filters malformed pending entries but rejects malformed records', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sep-client-monitor-invalid-'))
    roots.push(root)
    const paths = new ScopePath(root)
    const store = new ClientMonitorStore(root)
    await store.save(scope, 'task-a', record())
    const file = paths.clientMonitorFile(scope, 'task-a')
    const value = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>
    value.pending = [
      { id: 'valid', kind: 'status', payload: { status: 'RUNNING' } },
      { broken: true },
    ]
    await writeFile(file, JSON.stringify(value), 'utf8')
    assert.equal((await store.load(scope, 'task-a'))?.pending.length, 1)

    value.lastSequence = -1
    await writeFile(file, JSON.stringify(value), 'utf8')
    assert.equal(await store.load(scope, 'task-a'), null)
  })

  it('deletes a completed record only when no pending work or heartbeat remains', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sep-client-monitor-delete-'))
    roots.push(root)
    const store = new ClientMonitorStore(root)
    await store.save(scope, 'task-a', record())
    await store.deleteIfEmpty(scope, 'task-a', record())
    assert.equal(await store.load(scope, 'task-a'), null)

    const mirrorOnly = { ...record(), mirrorId: 'mirror-a' }
    await store.save(scope, 'task-a', mirrorOnly)
    await store.deleteIfEmpty(scope, 'task-a', mirrorOnly)
    assert.ok(await store.load(scope, 'task-a'))

    const active = { ...mirrorOnly, heartbeatActive: true }
    await store.save(scope, 'task-a', active)
    await store.deleteIfEmpty(scope, 'task-a', active)
    assert.ok(await store.load(scope, 'task-a'))
  })
})
