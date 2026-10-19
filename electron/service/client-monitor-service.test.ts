import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import type { TaskOwnerScope } from '../data/scope-path'
import type { ClientMonitorRecord, ClientMonitorStore } from '../data/client-monitor-store'
import type { ClientMonitorApiPort, ClientTaskEventRequest, ClientTaskHeartbeatRequest, ClientTaskStatusRequest, CreateClientTaskRequest } from '../common/platform/client-monitor-api'
import { ClientMonitorApiError } from '../common/platform/client-monitor-api'
import { ClientMonitorService } from './client-monitor-service'
import { createHash } from 'node:crypto'

const scope: TaskOwnerScope = { memberId: 'member-a', enterpriseId: 'enterprise-a' }

class MemoryStore {
  records = new Map<string, ClientMonitorRecord>()
  async inspect(scope: TaskOwnerScope, taskId: string): Promise<ClientMonitorRecord | null> {
    const record = await this.load(scope, taskId)
    return record ? structuredClone(record) : null
  }
  async load(_scope: TaskOwnerScope, taskId: string): Promise<ClientMonitorRecord | null> { return this.records.get(taskId) ?? null }
  async save(_scope: TaskOwnerScope, taskId: string, record: ClientMonitorRecord): Promise<void> { this.records.set(taskId, structuredClone(record)) }
  async deleteIfEmpty(_scope: TaskOwnerScope, taskId: string, record: ClientMonitorRecord): Promise<void> {
    if (record.pending.length === 0 && !record.heartbeatActive && !record.mirrorId) this.records.delete(taskId)
  }
  async listPending(): Promise<string[]> { return [...this.records.keys()] }
}

class FakeApi implements ClientMonitorApiPort {
  calls: string[] = []
  events: ClientTaskEventRequest[] = []
  creates: CreateClientTaskRequest[] = []
  beforeCreate?: (taskId: string) => Promise<void>
  async createTask(request: CreateClientTaskRequest): Promise<{ id: string }> { this.creates.push(request); this.calls.push(`create:${request.clientTaskId}:${request.clientRunId}`); await this.beforeCreate?.(request.clientTaskId); return { id: 'mirror-1' } }
  async updateStatus(_mirrorId: string, request: ClientTaskStatusRequest): Promise<void> { this.calls.push(`status:${request.status}`) }
  async sendHeartbeat(_mirrorId: string, request: ClientTaskHeartbeatRequest): Promise<void> { this.calls.push(`heartbeat:${request.clientVersion}`) }
  async sendEvent(_mirrorId: string, request: ClientTaskEventRequest): Promise<void> { this.calls.push(`event:${request.sequence}`); this.events.push(request) }
}

type QueueInput = Parameters<ClientMonitorService['taskQueued']>[0]
const queued = (runId: string): QueueInput => ({ taskId: 'task-a', runId, subscriptionId: 'sub-a', title: 'Task', modelId: 'model', taskType: 'conversation', prompt: 'initial prompt' })

function service(store: MemoryStore, api: ClientMonitorApiPort, options: Partial<ConstructorParameters<typeof ClientMonitorService>[0]> = {}): ClientMonitorService {
  return new ClientMonitorService({ store: store as unknown as ClientMonitorStore, api, scopeProvider: () => scope, sleep: async () => undefined, minSendIntervalMs: 0, ...options })
}

describe('ClientMonitorService', () => {
  it('previews local repair and content differences without sending, saving or starting recovery', async () => {
    const store = new MemoryStore(); const api = new FakeApi()
    const endedAt = '2026-10-10T00:00:01.000Z'
    store.records.set('task-a', { version: 1, clientTaskId: 'task-a', clientRunId: 'run-1', mirrorId: 'mirror-1', subscriptionId: 'sub-a', title: 'Task', taskType: 'conversation', modelId: 'model', lastSequence: 0, pending: [
      { id: 'paused', kind: 'status', clientRunId: 'run-1', payload: { status: 'PAUSED', completedAt: endedAt } },
    ], sentEvents: [], heartbeatActive: false, updatedAt: 10 })
    const before = structuredClone(store.records)
    let writes = 0
    store.save = async () => { writes++; throw new Error('Preview must not write') }
    const monitor = service(store, api, { history: { read: async () => [{ taskId: 'task-a', title: 'Task', taskType: 'conversation', runs: [
      { runId: 'run-1', subscriptionId: 'sub-a', modelId: 'model', prompt: '', messages: [{ messageId: 'reply', type: 'model_output', content: 'x'.repeat(2100), occurredAt: 11, completeness: 'complete' }], recoveryReason: 'source-missing' },
    ] }] } })
    const preview = await monitor.previewRecovery()
    assert.deepEqual(preview, { tasks: 1, normalizedOperations: 1, bodyMessages: 1, bodyChunks: 3,
      metadataEvents: 3, ambiguous: 0, sourceMissing: 1, cloudReconciliationRequired: true })
    assert.equal(writes, 0)
    assert.deepEqual(store.records, before)
    assert.deepEqual(api.calls, [])
    await monitor.stop()
  })

  it('discards a preview when the account changes while reading local history', async () => {
    const store = new MemoryStore(); const api = new FakeApi()
    let current: TaskOwnerScope | null = scope
    const monitor = service(store, api, { scopeProvider: () => current, history: { read: async () => {
      current = { memberId: 'other', enterpriseId: 'other' }
      return []
    } } })
    assert.equal(await monitor.previewRecovery(), null)
    assert.deepEqual(api.calls, [])
    await monitor.stop()
  })

  it('replays the identical event after server acceptance but before the local acknowledgement is saved', async () => {
    const store = new MemoryStore(); const api = new FakeApi()
    let now = 100
    const write = store.save.bind(store)
    let failAcknowledgement = true
    store.save = async (owner, id, record) => {
      if (failAcknowledgement && record.sentEvents?.some(event => event.type === 'model_output')) {
        failAcknowledgement = false
        throw new Error('Simulated acknowledgement write failure')
      }
      await write(owner, id, record)
    }
    const monitor = service(store, api, { now: () => now })
    await monitor.taskQueued(queued('run-1'))
    await monitor.taskOutput({ taskId: 'task-a', runId: 'run-1', messageId: 'reply', content: 'answer', completeness: 'complete', occurredAt: 11 })
    assert.equal(store.records.get('task-a')?.pending[0].kind, 'event')
    await monitor.stop()
    now += 30_001
    const restarted = service(store, api, { now: () => now })
    await restarted.resumePending(); await restarted.stop()
    const bodies = api.events.filter(event => event.type === 'model_output')
    assert.equal(bodies.length, 2)
    assert.deepEqual(bodies[0], bodies[1])
    assert.equal(store.records.get('task-a')?.pending.length, 0)
    assert.equal(store.records.get('task-a')?.sentEvents?.filter(event => event.type === 'model_output').length, 1)
  })

  it('stops draining when both acknowledgement and retry persistence fail', async () => {
    const store = new MemoryStore(); const api = new FakeApi()
    const monitor = service(store, api)
    await monitor.taskQueued(queued('run-1'))
    const write = store.save.bind(store)
    let diskFailed = false
    store.save = async (owner, id, record) => {
      if (diskFailed) throw new Error('Simulated persistent disk failure')
      await write(owner, id, record)
    }
    const send = api.sendEvent.bind(api)
    api.sendEvent = async (mirrorId, event) => { await send(mirrorId, event); diskFailed = true }
    await monitor.taskOutput({ taskId: 'task-a', runId: 'run-1', messageId: 'reply', content: 'answer', occurredAt: 11 })
    assert.equal(api.events.length, 1)
    assert.equal(store.records.get('task-a')?.pending[0].kind, 'event')
    await monitor.stop()
  })

  it('preserves queued mutations after an acknowledgement write rejects the previous chain', async () => {
    const store = new MemoryStore(); const api = new FakeApi()
    const monitor = service(store, api, { now: () => 100 })
    await monitor.taskQueued(queued('run-1'))
    const write = store.save.bind(store)
    let signalAcknowledgement!: () => void
    let rejectAcknowledgement!: () => void
    const entered = new Promise<void>(resolve => { signalAcknowledgement = resolve })
    const blocked = new Promise<void>((_resolve, reject) => {
      rejectAcknowledgement = () => reject(new Error('Simulated acknowledgement write failure'))
    })
    let firstAcknowledgement = true
    store.save = async (owner, id, record) => {
      if (firstAcknowledgement && record.sentEvents?.some(event => event.type === 'model_output')) {
        firstAcknowledgement = false
        signalAcknowledgement()
        await blocked
      }
      await write(owner, id, record)
    }
    const first = monitor.taskOutput({ taskId: 'task-a', runId: 'run-1', messageId: 'first', content: 'first answer', occurredAt: 11 })
    await entered
    const second = monitor.taskOutput({ taskId: 'task-a', runId: 'run-1', messageId: 'second', content: 'second answer', occurredAt: 12 })
    rejectAcknowledgement()
    await Promise.all([first, second])
    assert.deepEqual(store.records.get('task-a')?.pending.flatMap(operation => operation.kind === 'event' && operation.payload.type === 'model_output'
      ? [operation.payload.message] : []), ['first answer', 'second answer'])
    assert.equal(api.events.filter(event => event.type === 'model_output').length, 1)
    await monitor.stop()
  })

  it('upgrades indexed content from its cloud manifest when no local manifest remains', async () => {
    const store = new MemoryStore(); const api = new FakeApi()
    const messageId = Buffer.from('run-1-assistant').toString('base64url')
    const manifest = { version: 1, messageId, type: 'model_output', chunks: 1, source: 'canonical', completeness: 'unverified' }
    const cloud: ClientTaskEventRequest[] = [
      { clientRunId: 'run-1', sequence: 1, type: 'model_output', stepKey: `content:v1:${messageId}:0:1`, message: 'answer', occurredAt: new Date(11).toISOString() },
      { clientRunId: 'run-1', sequence: 2, type: 'content_manifest', message: JSON.stringify(manifest), occurredAt: new Date(11).toISOString() },
    ]
    store.records.set('task-a', { version: 1, clientTaskId: 'task-a', clientRunId: 'run-1', mirrorId: 'mirror-1', subscriptionId: 'sub-a', title: 'Task', taskType: 'conversation', modelId: 'model', lastSequence: 2, pending: [], heartbeatActive: false, updatedAt: 12,
      contentIndex: { [`run-1:${messageId}`]: { sourceId: 'run-1-assistant', digest: createHash('sha256').update('answer').digest('hex'), clientRunId: 'run-1', sequences: [1], manifestSequence: 2, confirmed: true } } })
    let reads = 0
    const remoteApi = Object.assign(api, { getDetail: async () => { reads++; return { id: 'mirror-1', clientTaskId: 'task-a', events: cloud } } })
    const history = { read: async () => [{ taskId: 'task-a', title: 'Task', taskType: 'conversation' as const, runs: [{ runId: 'run-1', subscriptionId: 'sub-a', modelId: 'model', prompt: '', messages: [{ messageId: 'run-1-assistant', type: 'model_output' as const, content: 'answer', occurredAt: 11, source: 'canonical' as const, completeness: 'complete' as const }] }] }] }
    const monitor = service(store, remoteApi, { history })
    await monitor.resumePending(); await monitor.stop()
    const restarted = service(store, remoteApi, { history })
    await restarted.resumePending(); await restarted.stop()
    assert.equal(reads, 1)
    assert.equal(api.events.length, 1)
    assert.equal(api.events[0].type, 'content_manifest')
    assert.equal(JSON.parse(api.events[0].message!).completeness, 'complete')
    assert.equal(JSON.parse(api.events[0].message!).messageId, messageId)
  })

  it('maps cloud stable content without reuploading its body or duplicating its manifest', async () => {
    const store = new MemoryStore(); const api = new FakeApi()
    const monitor = service(store, api)
    await monitor.taskQueued(queued('run-1'))
    await monitor.taskOutput({ taskId: 'task-a', runId: 'run-1', messageId: 'legacy-source', content: 'answer', completeness: 'complete', occurredAt: 11 })
    const cloud = structuredClone(api.events)
    const wireId = JSON.parse(cloud.find(event => event.type === 'content_manifest')!.message!).messageId
    const saved = store.records.get('task-a')!
    store.records.set('task-a', { ...saved, contentIndex: undefined, sentEvents: undefined })
    api.events = []
    const remoteApi = Object.assign(api, { getDetail: async () => ({ id: 'mirror-1', clientTaskId: 'task-a', events: cloud }) })
    const restored = service(store, remoteApi, { history: { read: async () => [{ taskId: 'task-a', title: 'Task', taskType: 'conversation', runs: [{ runId: 'run-1', subscriptionId: 'sub-a', modelId: 'model', prompt: '', messages: [{ messageId: 'canonical-source', type: 'model_output', content: 'answer', occurredAt: 11, completeness: 'complete' }] }] }] } })
    await restored.resumePending(); await restored.resumePending(); await restored.stop()
    assert.deepEqual(api.events, [])
    const entry = Object.values(store.records.get('task-a')!.contentIndex!)[0]
    assert.deepEqual(entry.sequences, [1])
    assert.equal(entry.manifestSequence, 2)
    assert.equal(entry.confirmed, true)
    assert.equal(entry.wireMessageId, wireId)
  })

  it('never downgrades complete manifests during partial or unverified history recovery', async () => {
    const store = new MemoryStore(); const api = new FakeApi()
    const monitor = service(store, api)
    await monitor.taskQueued(queued('run-1'))
    await monitor.taskOutput({ taskId: 'task-a', runId: 'run-1', messageId: 'message', content: 'answer', completeness: 'complete', occurredAt: 11 })
    for (const completeness of ['partial', 'unverified'] as const) {
      const recovered = service(store, api, { history: { read: async () => [{ taskId: 'task-a', title: 'Task', taskType: 'conversation', runs: [{ runId: 'run-1', subscriptionId: 'sub-a', modelId: 'model', prompt: '', messages: [{ messageId: 'message', type: 'model_output', content: 'answer', occurredAt: 11, completeness }] }] }] } })
      await recovered.resumePending(); await recovered.stop()
    }
    assert.equal(api.events.filter(event => event.type === 'model_output').length, 1)
    assert.deepEqual(api.events.filter(event => event.type === 'content_manifest').map(event => JSON.parse(event.message!).completeness), ['complete'])
  })

  it('does not upgrade an indexed message using metadata from another participation', async () => {
    const store = new MemoryStore(); const api = new FakeApi()
    const monitor = service(store, api)
    await monitor.taskQueued({ ...queued('run-1'), protocolVersion: 2, participation: { executionId: 'run-1', subscriptionId: 'sub-a' } })
    await monitor.taskOutput({ taskId: 'task-a', runId: 'run-1', messageId: 'message', content: 'answer', completeness: 'unverified', occurredAt: 11 })
    const saved = store.records.get('task-a')!
    store.records.set('task-a', { ...saved, sentEvents: saved.sentEvents!.map(event => event.type === 'content_manifest'
      ? { ...event, participation: { executionId: 'foreign-node', subscriptionId: 'sub-a', nodeId: 'foreign' } } : event) })
    const count = api.events.length
    const recovered = service(store, api, { history: { read: async () => [{ taskId: 'task-a', title: 'Task', taskType: 'conversation', runs: [{ runId: 'run-1', subscriptionId: 'sub-a', modelId: 'model', prompt: '', messages: [{ messageId: 'message', type: 'model_output', content: 'answer', occurredAt: 11, completeness: 'complete' }] }] }] } })
    await recovered.resumePending(); await recovered.stop()
    assert.equal(api.events.length, count)
  })

  it('reports real lifecycle and uploads only input/output content', async () => {
    const store = new MemoryStore()
    const api = new FakeApi()
    const monitor = service(store, api)
    await monitor.taskQueued(queued('run-1'))
    await monitor.taskStarted({ taskId: 'task-a', runId: 'run-1', startedAt: Date.now() })
    await monitor.taskInput({ taskId: 'task-a', runId: 'run-1', content: 'hello' })
    await monitor.taskOutput({ taskId: 'task-a', runId: 'run-1', content: 'world' })
    await monitor.taskEvent({ taskId: 'task-a', runId: 'run-1', subscriptionId: 'sub-a', sequence: 1, type: 'tool_execution_start', occurredAt: Date.now(), data: { input: 'secret' } })
    await monitor.taskFinished({ taskId: 'task-a', runId: 'run-1', status: 'COMPLETED', completedAt: Date.now() })
    assert.deepEqual(api.calls, ['create:task-a:run-1', 'status:RUNNING', 'event:1', 'event:2', 'event:3', 'event:4', 'event:5', 'status:COMPLETED', 'event:6'])
    assert.deepEqual(api.events.filter(event => event.type === 'user_input' || event.type === 'model_output').map(event => ({ type: event.type, message: event.message })), [
      { type: 'user_input', message: 'hello' },
      { type: 'model_output', message: 'world' },
    ])
    assert.equal('data' in api.events[0], false)
  })

  it('uploads completed status after the final model output', async () => {
    const store = new MemoryStore()
    const api = new FakeApi()
    const monitor = service(store, api)
    await monitor.taskQueued(queued('run-1'))
    await monitor.taskOutput({ taskId: 'task-a', runId: 'run-1', content: 'final answer' })
    await monitor.taskFinished({ taskId: 'task-a', runId: 'run-1', status: 'COMPLETED', completedAt: 1_700_000_000_000 })

    assert.deepEqual(api.calls, ['create:task-a:run-1', 'event:1', 'event:2', 'status:COMPLETED', 'event:3'])
  })

  it('keeps one queue per task and increments sequence across runs', async () => {
    const store = new MemoryStore()
    const api = new FakeApi()
    const monitor = service(store, api)
    await monitor.taskQueued(queued('run-1'))
    await monitor.taskInput({ taskId: 'task-a', runId: 'run-1', content: 'one' })
    await monitor.taskQueued(queued('run-2'))
    await monitor.taskInput({ taskId: 'task-a', runId: 'run-2', content: 'two' })
    assert.deepEqual(api.calls, ['create:task-a:run-1', 'event:1', 'event:2', 'create:task-a:run-2', 'event:3', 'event:4'])
    assert.deepEqual(api.events.map(item => item.sequence), [1, 2, 3, 4])
  })

  it('replays legacy status, heartbeat, and ordinary event outbox operations', async () => {
    const store = new MemoryStore()
    const api = new FakeApi()
    store.records.set('task-a', {
      version: 1, clientTaskId: 'task-a', clientRunId: 'run-1', mirrorId: 'mirror-1', subscriptionId: 'sub-a', title: 'Task', taskType: 'conversation', modelId: 'model', lastSequence: 4, heartbeatActive: true, updatedAt: Date.now(),
      pending: [
        { id: 'status', kind: 'status', payload: { status: 'RUNNING' } },
        { id: 'heartbeat', kind: 'heartbeat', payload: { clientVersion: '1.0.0' } },
        { id: 'ordinary', kind: 'event', sequence: 5, payload: { sequence: 5, type: 'tool_execution_start', occurredAt: new Date().toISOString() } },
      ],
    })
    await service(store, api).resumePending()
    assert.deepEqual(api.calls, ['status:RUNNING', 'heartbeat:1.0.0', 'event:5'])
    assert.equal(store.records.get('task-a')?.pending.length, 0)
  })

  it('preserves pure whitespace and losslessly chunks fully redacted long content', async () => {
    const store = new MemoryStore()
    const api = new FakeApi()
    const monitor = service(store, api)
    await monitor.taskQueued(queued('run-1'))
    await monitor.taskInput({ taskId: 'task-a', runId: 'run-1', content: '   ' })
    await monitor.taskOutput({ taskId: 'task-a', runId: 'run-1', content: `Bearer abc ${'x😀'.repeat(4000)}` })
    await monitor.taskInput({ taskId: 'task-a', runId: 'run-1', content: '   \t  ' })
    assert.ok(api.events.length > 8)
    assert.equal(api.events.some(event => event.message === '   \t  '), true)
    const longEvents = api.events.filter(event => event.type === 'model_output')
    assert.equal(longEvents.map(e => e.message).join(''), `Bearer [redacted] ${'x😀'.repeat(4000)}`)
    const ids = longEvents.map(e => e.stepKey?.split(':')[2])
    assert.equal(new Set(ids).size, 1)
    longEvents.forEach((e, i) => {
      assert.equal(e.stepKey, `content:v1:${ids[0]}:${i}:${longEvents.length}`)
      assert.ok((e.message ?? '').length <= 1000)
      assert.equal(e.clientRunId, 'run-1')
    })
  })

  it('retains an unsent content operation when SEP is unavailable', async () => {
    const store = new MemoryStore()
    const api: ClientMonitorApiPort = {
      createTask: async () => { throw new ClientMonitorApiError('offline', 503) },
      updateStatus: async () => { throw new Error('must not run') },
      sendHeartbeat: async () => { throw new Error('must not run') },
      sendEvent: async () => { throw new Error('must not run') },
    }
    const monitor = service(store, api, { maxAttempts: 1 })
    await monitor.taskQueued(queued('run-1'))
    await monitor.taskInput({ taskId: 'task-a', runId: 'run-1', content: 'hello' })
    assert.deepEqual(store.records.get('task-a')?.pending.map(item => item.kind), ['create', 'event', 'event'])
    const manifest = store.records.get('task-a')?.pending.at(-1)
    assert.equal(manifest?.kind === 'event' ? manifest.payload.type : undefined, 'content_manifest')
  })
  it('serializes sends globally while persisting a second task before the first finishes', async () => {
    const store = new MemoryStore()
    const api = new FakeApi()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    api.beforeCreate = async id => { if (id === 'task-a') await gate }
    const monitor = service(store, api)
    const first = monitor.taskQueued(queued('run-1'))
    await new Promise(resolve => setImmediate(resolve))
    const second = monitor.taskQueued({ ...queued('run-2'), taskId: 'task-b' })
    await new Promise(resolve => setImmediate(resolve))
    assert.ok(store.records.has('task-b'))
    assert.equal(api.calls.length, 1)
    release()
    await Promise.all([first, second])
    assert.equal(api.calls.length, 2)
  })

  it('persists a global 429 window and does not retry it early', async () => {
    const store = new MemoryStore()
    const api = new FakeApi()
    let now = 1_700_000_000_000
    let attempts = 0
    api.beforeCreate = async () => {
      if (++attempts === 1) throw new ClientMonitorApiError('rate limited', 429, 60_000)
    }
    const monitor = service(store, api, { now: () => now })
    await monitor.taskQueued(queued('run-1'))
    await monitor.taskQueued({ ...queued('run-2'), taskId: 'task-b' })
    await monitor.resumePending()
    assert.equal(attempts, 1)
    now += 60_000
    await monitor.resumePending()
    assert.equal(attempts, 3)
    await monitor.stop()
  })

  it('reports FAILED rather than completing on model output and keeps per-operation run ids', async () => {
    const store = new MemoryStore()
    const api = new FakeApi()
    const monitor = service(store, api)
    await monitor.taskQueued(queued('run-1'))
    await monitor.taskQueued(queued('run-2'))
    await monitor.taskOutput({ taskId: 'task-a', runId: 'run-1', content: 'partial' })
    assert.equal(api.events[0].clientRunId, 'run-1')
    assert.match(api.events[0].stepKey!, /^content:v1:[A-Za-z0-9_-]{1,100}:0:1$/)
    assert.equal(api.calls.includes('status:COMPLETED'), false)
    await monitor.taskFinished({ taskId: 'task-a', runId: 'run-1', status: 'FAILED', completedAt: Date.now() })
    assert.ok(api.calls.includes('status:FAILED'))
    assert.equal(api.events.at(-1)?.type, 'monitor_state')
  })

  it('skips only explicit old-run status 409 so the new run can drain', async () => {
    const store = new MemoryStore()
    const api = new FakeApi()
    const monitor = service(store, api)
    await monitor.taskQueued(queued('run-1'))
    await monitor.taskQueued(queued('run-2'))
    const record = store.records.get('task-a')!
    store.records.set('task-a', { ...record, pending: [
      { id: 'old-status', kind: 'status', clientRunId: 'run-1', payload: { status: 'FAILED', clientRunId: 'run-1' } },
      { id: 'new-status', kind: 'status', clientRunId: 'run-2', payload: { status: 'RUNNING', clientRunId: 'run-2' } },
    ] })
    api.updateStatus = async (_id, request) => {
      api.calls.push(`status:${request.clientRunId}`)
      if (request.clientRunId === 'run-1') throw new ClientMonitorApiError('old run', 409)
    }
    await monitor.resumePending()
    assert.deepEqual(api.calls.slice(-2), ['status:run-1', 'status:run-2'])
    assert.equal(store.records.get('task-a')?.pending.length, 0)
    assert.equal(store.records.get('task-a')?.skippedOldStatusCount, 1)
    await monitor.stop()
  })

  it('retains current-run or unknown-run 409 without a tight loop', async () => {
    for (const runId of ['run-1', undefined]) {
      const store = new MemoryStore()
      const api = new FakeApi()
      const monitor = service(store, api)
      await monitor.taskQueued(queued('run-1'))
      api.updateStatus = async () => { api.calls.push('conflict'); throw new ClientMonitorApiError('conflict', 409) }
      const record = store.records.get('task-a')!
      store.records.set('task-a', { ...record, pending: [{ id: 'status', kind: 'status', payload: { status: 'RUNNING', clientRunId: runId } }] })
      await monitor.resumePending(); await monitor.resumePending()
      assert.equal(api.calls.filter(c => c === 'conflict').length, 1)
      assert.equal(store.records.get('task-a')?.pending.length, 1)
      await monitor.stop()
    }
  })

  it('reconciles only an existing outbox current run and backfills absent records once', async () => {
    const store = new MemoryStore()
    const api = new FakeApi()
    const run = (runId: string, status: 'COMPLETED' | 'FAILED') => ({ runId, subscriptionId: 'sub-a', modelId: 'model', prompt: 'prompt', queuedAt: runId === 'run-1' ? 10 : 20, messages: [{ type: 'user_input' as const, content: 'prompt', occurredAt: 10 }, { type: 'model_output' as const, content: 'answer', occurredAt: 11 }], status: { status, completedAt: new Date(12).toISOString() } })
    const monitor = service(store, api, { history: { read: async () => [{ taskId: 'task-a', title: 'Task', taskType: 'conversation', runs: [run('run-1', 'COMPLETED'), run('run-2', 'FAILED')] }] } })
    await monitor.resumePending()
    assert.deepEqual(api.calls, ['create:task-a:run-1', 'event:1', 'event:2', 'event:3', 'event:4', 'status:COMPLETED', 'event:5', 'create:task-a:run-2', 'event:6', 'event:7', 'event:8', 'event:9', 'status:FAILED', 'event:10'])
    assert.equal(store.records.get('task-a')?.historyBackfilled, true)
    assert.ok(api.creates.every(create => create.protocolVersion === undefined))
    assert.deepEqual(api.creates.map(create => create.queuedAt), [new Date(10).toISOString(), new Date(20).toISOString()])
    assert.ok(api.events.every(event => event.participation === undefined))
    assert.equal(store.records.get('task-a')?.liveRuns, undefined)
    const previous = api.calls.length
    // Simulate a legacy outbox without status fingerprints. Only the current run is reconciled.
    store.records.set('task-a', { ...store.records.get('task-a')!, statusByRun: undefined })
    await monitor.resumePending()
    assert.deepEqual(api.calls.slice(previous), [])
    await monitor.resumePending()
    assert.equal(api.calls.length, previous)
    await monitor.stop()
  })

  it('safely patches only matched pending creates without altering IDs, sequence, retries or protocol', async () => {
    const store = new MemoryStore(); const api = new FakeApi()
    const create = (id: string, runId: string, extra: Partial<CreateClientTaskRequest> = {}, operationRunId: string | undefined = runId) => ({
      id, kind: 'create' as const, clientRunId: operationRunId,
      payload: { clientTaskId: 'task-a', clientRunId: runId, subscriptionId: 'sub-a', title: 'Task', ...extra },
    })
    const original: ClientMonitorRecord = {
      version: 1, clientTaskId: 'task-a', clientRunId: 'run-2', mirrorId: null,
      subscriptionId: 'sub-a', title: 'Task', taskType: 'conversation', modelId: 'model', lastSequence: 37,
      heartbeatActive: false, updatedAt: 50, retryAt: 100000, retryStatusCode: 403,
      pending: [
        create('first', 'run-1'), create('second', 'run-2'),
        create('unknown', 'missing'), create('already-timed', 'run-1', { queuedAt: new Date(9).toISOString() }),
        create('wrong-sub', 'run-1', { subscriptionId: 'other-sub' }), create('wrong-task', 'run-1', { clientTaskId: 'other-task' }),
        create('conflict', 'run-1', {}, 'run-2'), create('unproven', 'run-3'), create('snapshot-only', 'history-task-a'),
        { ...create('legacy-without-envelope-run', 'run-1'), clientRunId: undefined },
        create('v2', 'run-1', { protocolVersion: 2 }),
        { id: 'event', kind: 'event', clientRunId: 'run-1', sequence: 37,
          payload: { clientRunId: 'run-1', sequence: 37, type: 'user_input', message: 'saved input', occurredAt: new Date(10).toISOString() } },
      ],
    }
    store.records.set('task-a', structuredClone(original))
    const history = { read: async () => [{ taskId: 'task-a', title: 'Task', taskType: 'conversation' as const,
      runs: [
        { runId: 'run-1', subscriptionId: 'sub-a', modelId: 'model', prompt: '', messages: [], queuedAt: 10, localRun: true as const },
        { runId: 'run-2', subscriptionId: 'sub-a', modelId: 'model', prompt: '', messages: [], queuedAt: 20, localRun: true as const },
        { runId: 'run-3', subscriptionId: 'sub-a', modelId: 'model', prompt: '', messages: [], localRun: true as const },
        { runId: 'history-task-a', subscriptionId: 'sub-a', modelId: 'unknown', prompt: '', messages: [], queuedAt: 1 },
      ],
    }] }
    const monitor = service(store, api, { history, now: () => 50 })
    await monitor.resumePending()
    const expected = structuredClone(original)
    for (const operation of expected.pending) {
      if (operation.kind === 'create' && ['first', 'second', 'legacy-without-envelope-run', 'v2'].includes(operation.id)) {
        operation.payload.queuedAt = new Date(operation.id === 'second' ? 20 : 10).toISOString()
      }
    }
    // Recovery records its existing backfill flag, but all original operation metadata is retained.
    assert.deepEqual(store.records.get('task-a'), { ...expected, historyBackfilled: false })
    await monitor.resumePending()
    assert.deepEqual(store.records.get('task-a'), { ...expected, historyBackfilled: false })
    assert.deepEqual(api.calls, [])
    await monitor.stop()

    // A task with an uploaded mirror is never retroactively rewritten, even with a pending create.
    store.records.set('task-a', { ...structuredClone(original), mirrorId: 'uploaded-mirror' })
    const uploaded = service(store, api, { history, now: () => 50 })
    await uploaded.resumePending()
    assert.deepEqual(store.records.get('task-a')?.pending, original.pending)
    await uploaded.stop()
  })

  it('uploads a safely patched v1 create once while preserving its original event sequence', async () => {
    const store = new MemoryStore(); const api = new FakeApi()
    store.records.set('task-a', {
      version: 1, clientTaskId: 'task-a', clientRunId: 'run-1', mirrorId: null,
      subscriptionId: 'sub-a', title: 'Task', taskType: 'conversation', modelId: 'model', lastSequence: 8,
      heartbeatActive: false, updatedAt: 10,
      pending: [
        { id: 'create', kind: 'create', payload: { clientTaskId: 'task-a', clientRunId: 'run-1', subscriptionId: 'sub-a', title: 'Task' } },
        { id: 'event', kind: 'event', clientRunId: 'run-1', sequence: 8, payload: { sequence: 8, type: 'user_input', message: 'saved input', occurredAt: new Date(10).toISOString() } },
      ],
    })
    const monitor = service(store, api, { history: { read: async () => [{ taskId: 'task-a', title: 'Task', taskType: 'conversation',
      runs: [{ runId: 'run-1', subscriptionId: 'sub-a', modelId: 'model', prompt: 'saved input', messages: [], queuedAt: 7, localRun: true }],
    }] } })
    await monitor.resumePending(); await monitor.resumePending()
    assert.deepEqual(api.calls, ['create:task-a:run-1', 'event:8'])
    assert.equal(api.creates[0].queuedAt, new Date(7).toISOString())
    assert.equal(api.creates[0].protocolVersion, undefined)
    assert.equal(store.records.get('task-a')?.lastSequence, 8)
    await monitor.stop()
  })

  it('does not restore history when the account changes or logout occurs during its read', async () => {
    for (const action of ['switch', 'logout'] as const) {
      const store = new MemoryStore(); const api = new FakeApi()
      let current: TaskOwnerScope | null = scope
      const monitor = service(store, api, { scopeProvider: () => current, history: { read: async () => {
        if (action === 'switch') current = { enterpriseId: 'other-enterprise', memberId: 'other-member' }
        else { current = null; await monitor.stop() }
        return [{ taskId: 'task-a', title: 'Task', taskType: 'conversation',
          runs: [{ runId: 'run-1', subscriptionId: 'sub-a', modelId: 'model', prompt: '', messages: [], queuedAt: 7 }] }]
      } } })
      await monitor.resumePending()
      assert.equal(store.records.size, 0)
      assert.deepEqual(api.calls, [])
      await monitor.stop()
    }
  })

  it('uses automatic compensation, prevents reentry, stops timers, and restarts on login', async () => {
    const store = new MemoryStore()
    const api = new FakeApi()
    let lists = 0
    const originalList = store.listPending.bind(store)
    store.listPending = async () => { lists++; return originalList() }
    let now = 1_700_000_000_000
    let offline = true
    api.beforeCreate = async () => { if (offline) throw new ClientMonitorApiError('offline', 503) }
    const monitor = service(store, api, { recoveryIntervalMs: 10, maxAttempts: 1, now: () => now })
    await monitor.taskQueued(queued('run-1'))
    await Promise.all([monitor.resumePending(), monitor.resumePending(), monitor.resumePending()])
    offline = false; now += 30_000
    const wait = async (predicate: () => boolean) => {
      const deadline = Date.now() + 1000
      while (!predicate()) { if (Date.now() > deadline) throw new Error('timer did not recover'); await new Promise(resolve => setTimeout(resolve, 5)) }
    }
    await wait(() => store.records.get('task-a')?.pending.length === 0)
    await monitor.stop()
    const stoppedLists = lists
    await new Promise(resolve => setTimeout(resolve, 30))
    assert.equal(lists, stoppedLists)
    await monitor.resumePending()
    await wait(() => lists > stoppedLists + 2)
    await monitor.stop()
  })

  it('retains in-flight work on stop and drains it on relogin without duplicating content', async () => {
    const store = new MemoryStore()
    const api = new FakeApi()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    api.beforeCreate = async () => gate
    const monitor = service(store, api)
    const queuedPromise = monitor.taskQueued(queued('run-1'))
    await new Promise(resolve => setImmediate(resolve))
    const inputPromise = monitor.taskInput({ taskId: 'task-a', runId: 'run-1', content: 'persisted before stop' })
    await new Promise(resolve => setImmediate(resolve))
    await monitor.stop()
    await Promise.all([queuedPromise, inputPromise])
    assert.deepEqual(store.records.get('task-a')?.pending.map(op => op.kind), ['create', 'event', 'event'])
    release(); api.beforeCreate = undefined
    await monitor.resumePending()
    assert.deepEqual(api.events.filter(e => e.type === 'user_input').map(e => e.message), ['persisted before stop'])
    assert.equal(api.events.filter(e => e.type === 'content_manifest').length, 1)
    await monitor.stop()
  })

  it('cannot transmit queued old-scope work after a scope switch during token/send awaits', async () => {
    const store = new MemoryStore()
    const api = new FakeApi()
    let current = scope
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    api.beforeCreate = async () => gate
    const monitor = service(store, api, { scopeProvider: () => current })
    const first = monitor.taskQueued(queued('run-1'))
    await new Promise(resolve => setImmediate(resolve))
    const second = monitor.taskQueued({ ...queued('run-2'), taskId: 'task-b' })
    await new Promise(resolve => setImmediate(resolve))
    current = { enterpriseId: 'other', memberId: 'other' }
    release(); await Promise.all([first, second])
    assert.equal(api.calls.length, 1)
    assert.equal(store.records.get('task-a')?.pending.length, 1)
    assert.equal(store.records.get('task-b')?.pending.length, 1)
    await monitor.stop()
  })

  it('persists and restores the 429 gate across service instances', async () => {
    const store = new MemoryStore()
    const api = new FakeApi()
    let now = 1_700_000_000_000
    api.beforeCreate = async () => { throw new ClientMonitorApiError('rate limit', 429, 60_000) }
    const original = service(store, api, { now: () => now })
    await original.taskQueued(queued('run-1')); await original.stop()
    api.beforeCreate = undefined
    const restarted = service(store, api, { now: () => now })
    await restarted.resumePending()
    await restarted.taskQueued({ ...queued('run-2'), taskId: 'task-b' })
    assert.equal(api.calls.length, 1)
    now += 60_000; await restarted.resumePending()
    assert.equal(api.calls.length, 3)
    await restarted.stop()
  })

  it('has a single bounded retry loop and never immediately retries 400/403', async () => {
    for (const [code, expected] of [[503, 3], [400, 1], [403, 1]] as const) {
      const store = new MemoryStore(); const api = new FakeApi()
      const monitor = service(store, api)
      await monitor.taskQueued(queued('run-1'))
      let sends = 0
      api.sendEvent = async () => { sends++; throw new ClientMonitorApiError('failure', code) }
      await monitor.taskOutput({ taskId: 'task-a', runId: 'run-1', content: 'answer' })
      await monitor.resumePending(); await monitor.resumePending()
      assert.equal(sends, expected)
      assert.equal(store.records.get('task-a')?.pending.length, 2)
      const manifest = store.records.get('task-a')?.pending.at(-1)
      assert.equal(manifest?.kind === 'event' ? manifest.payload.type : undefined, 'content_manifest')
      await monitor.stop()
    }
  })

  it('keeps conversation attribution and actual lifecycle times per live run', async () => {
    const store = new MemoryStore(); const api = new FakeApi(); const monitor = service(store, api)
    const start = 1_700_000_000_000
    const live = (runId: string, subscriptionId: string): QueueInput => ({ ...queued(runId), subscriptionId,
      protocolVersion: 2, queuedAt: start - 100, participation: { executionId: runId, subscriptionId, title: 'Task', modelId: 'model' } })
    await monitor.taskQueued(live('run-1', 'sub-1'))
    await monitor.taskStarted({ taskId: 'task-a', runId: 'run-1', startedAt: start })
    await monitor.taskQueued(live('run-2', 'sub-2'))
    await monitor.taskOutput({ taskId: 'task-a', runId: 'run-1', content: 'late old output' })
    await monitor.taskFinished({ taskId: 'task-a', runId: 'run-1', status: 'FAILED', completedAt: start + 100 })
    await monitor.taskInput({ taskId: 'task-a', runId: 'run-2', content: 'new input' })
    assert.ok(api.creates.every(create => create.protocolVersion === 2 && create.queuedAt === new Date(start - 100).toISOString()))
    const old = api.events.filter(event => event.clientRunId === 'run-1')
    assert.ok(old.every(event => event.participation?.executionId === 'run-1' && event.participation.subscriptionId === 'sub-1'))
    assert.equal(old.at(-1)?.participation?.startedAt, new Date(start).toISOString())
    assert.equal(old.at(-1)?.participation?.completedAt, new Date(start + 100).toISOString())
    assert.equal(api.events.at(-1)?.participation?.subscriptionId, 'sub-2')
    assert.equal(store.records.get('task-a')?.liveRuns?.['run-1'].participation?.status, 'FAILED')
  })

  it('chunks node content with exact attempt metadata without assigning the aggregate', async () => {
    const store = new MemoryStore(); const api = new FakeApi(); const monitor = service(store, api)
    await monitor.taskQueued({ ...queued('parent'), protocolVersion: 2, taskType: 'arrangement' })
    await monitor.taskOutput({ taskId: 'task-a', runId: 'parent', content: 'aggregate' })
    const calls = api.calls.length
    for (const executionId of ['node-attempt-1', 'node-attempt-2']) {
      const participation = { executionId, subscriptionId: 'node-sub', nodeId: 'node', title: 'Node', modelId: 'node-model', status: 'FAILED' as const }
      await monitor.taskEvent({ taskId: 'task-a', runId: 'parent', subscriptionId: 'sub-a', sequence: 0,
        type: 'arrangement_node_failed', occurredAt: 10, data: {} }, participation)
      await monitor.taskOutput({ taskId: 'task-a', runId: 'parent', content: 'x'.repeat(2500), participation, occurredAt: 10 })
    }
    assert.equal(api.events[0].participation, undefined)
    assert.ok(api.calls.slice(calls).every(call => call.startsWith('event:')))
    for (const executionId of ['node-attempt-1', 'node-attempt-2']) {
      const parts = api.events.filter(event => event.type === 'model_output' && event.participation?.executionId === executionId)
      assert.deepEqual(parts.map(part => part.message?.length), [1000, 1000, 500])
      assert.ok(parts.every(part => part.clientRunId === 'parent' && part.participation?.subscriptionId === 'node-sub' && part.occurredAt === new Date(10).toISOString()))
    }
    await monitor.taskOutput({ taskId: 'task-a', runId: 'unknown-history', content: 'unproven', participation: { executionId: 'guessed', subscriptionId: 'node-sub' } })
    assert.equal(api.events.at(-1)?.participation, undefined)
  })

  it('replays persisted v2 participation and retains historic v2 status conflicts', async () => {
    const store = new MemoryStore(); const api = new FakeApi()
    let now = 1_700_000_000_000
    api.beforeCreate = async () => { throw new ClientMonitorApiError('offline', 503) }
    const monitor = service(store, api, { now: () => now, maxAttempts: 1 })
    await monitor.taskQueued({ ...queued('run-1'), protocolVersion: 2, participation: { executionId: 'run-1', subscriptionId: 'sub-a' } })
    await monitor.taskOutput({ taskId: 'task-a', runId: 'run-1', content: 'persisted' })
    await monitor.taskQueued({ ...queued('run-2'), protocolVersion: 2 })
    await monitor.taskFinished({ taskId: 'task-a', runId: 'run-1', status: 'FAILED', completedAt: now })
    await monitor.stop()
    api.beforeCreate = undefined
    api.updateStatus = async () => { throw new ClientMonitorApiError('historic conflict', 409) }
    now += 30_000
    const reopened = service(store, api, { now: () => now })
    await reopened.resumePending()
    assert.equal(api.events.find(event => event.message === 'persisted')?.participation?.executionId, 'run-1')
    assert.equal(store.records.get('task-a')?.pending[0].kind, 'status')
    assert.equal(store.records.get('task-a')?.pending[0].clientRunId, 'run-1')
    assert.equal(store.records.get('task-a')?.skippedOldStatusCount, undefined)
    await reopened.stop()
  })
})
