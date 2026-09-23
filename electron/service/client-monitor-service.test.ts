import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import type { TaskOwnerScope } from '../data/scope-path'
import type { ClientMonitorRecord, ClientMonitorStore } from '../data/client-monitor-store'
import type { ClientMonitorApiPort, ClientTaskEventRequest, ClientTaskHeartbeatRequest, ClientTaskStatusRequest, CreateClientTaskRequest } from '../common/platform/client-monitor-api'
import { ClientMonitorApiError } from '../common/platform/client-monitor-api'
import { ClientMonitorService } from './client-monitor-service'

const scope: TaskOwnerScope = { memberId: 'member-a', enterpriseId: 'enterprise-a' }

class MemoryStore {
  records = new Map<string, ClientMonitorRecord>()
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
  beforeCreate?: (taskId: string) => Promise<void>
  async createTask(request: CreateClientTaskRequest): Promise<{ id: string }> { this.calls.push(`create:${request.clientTaskId}:${request.clientRunId}`); await this.beforeCreate?.(request.clientTaskId); return { id: 'mirror-1' } }
  async updateStatus(_mirrorId: string, request: ClientTaskStatusRequest): Promise<void> { this.calls.push(`status:${request.status}`) }
  async sendHeartbeat(_mirrorId: string, request: ClientTaskHeartbeatRequest): Promise<void> { this.calls.push(`heartbeat:${request.clientVersion}`) }
  async sendEvent(_mirrorId: string, request: ClientTaskEventRequest): Promise<void> { this.calls.push(`event:${request.sequence}`); this.events.push(request) }
}

type QueueInput = Parameters<ClientMonitorService['taskQueued']>[0]
const queued = (runId: string): QueueInput => ({ taskId: 'task-a', runId, subscriptionId: 'sub-a', title: 'Task', modelId: 'model', taskType: 'conversation', prompt: 'initial prompt' })

function service(store: MemoryStore, api: ClientMonitorApiPort, options: Partial<ConstructorParameters<typeof ClientMonitorService>[0]> = {}): ClientMonitorService {
  return new ClientMonitorService({ store: store as unknown as ClientMonitorStore, api, scopeProvider: () => scope, sleep: async () => undefined, ...options })
}

describe('ClientMonitorService', () => {
  it('only creates mirrors and uploads input/output content', async () => {
    const store = new MemoryStore()
    const api = new FakeApi()
    const monitor = service(store, api)
    await monitor.taskQueued(queued('run-1'))
    await monitor.taskStarted({ taskId: 'task-a', runId: 'run-1', startedAt: Date.now() })
    await monitor.taskInput({ taskId: 'task-a', runId: 'run-1', content: 'hello' })
    await monitor.taskOutput({ taskId: 'task-a', runId: 'run-1', content: 'world' })
    await monitor.taskEvent({ taskId: 'task-a', runId: 'run-1', subscriptionId: 'sub-a', sequence: 1, type: 'tool_execution_start', occurredAt: Date.now(), data: { input: 'secret' } })
    await monitor.taskFinished({ taskId: 'task-a', runId: 'run-1', status: 'COMPLETED', completedAt: Date.now() })
    assert.deepEqual(api.calls, ['create:task-a:run-1', 'event:1', 'event:2', 'status:COMPLETED'])
    assert.deepEqual(api.events.map(event => ({ type: event.type, message: event.message })), [
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

    assert.deepEqual(api.calls, ['create:task-a:run-1', 'event:1', 'status:COMPLETED'])
  })

  it('keeps one queue per task and increments sequence across runs', async () => {
    const store = new MemoryStore()
    const api = new FakeApi()
    const monitor = service(store, api)
    await monitor.taskQueued(queued('run-1'))
    await monitor.taskInput({ taskId: 'task-a', runId: 'run-1', content: 'one' })
    await monitor.taskQueued(queued('run-2'))
    await monitor.taskInput({ taskId: 'task-a', runId: 'run-2', content: 'two' })
    assert.deepEqual(api.calls, ['create:task-a:run-1', 'event:1', 'create:task-a:run-2', 'event:2'])
    assert.deepEqual(api.events.map(item => item.sequence), [1, 2])
  })

  it('drops legacy status, heartbeat, and ordinary event outbox operations', async () => {
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
    assert.deepEqual(api.calls, [])
    assert.equal(store.records.get('task-a')?.pending.length, 0)
  })

  it('does not upload empty content or content longer than the redacted limit', async () => {
    const store = new MemoryStore()
    const api = new FakeApi()
    const monitor = service(store, api)
    await monitor.taskQueued(queued('run-1'))
    await monitor.taskInput({ taskId: 'task-a', runId: 'run-1', content: '   ' })
    await monitor.taskOutput({ taskId: 'task-a', runId: 'run-1', content: `Bearer abc ${'x'.repeat(1200)}` })
    assert.equal(api.events.length, 1)
    assert.ok((api.events[0].message ?? '').length <= 1000)
    assert.equal((api.events[0].message ?? '').includes('Bearer [redacted]'), true)
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
    assert.deepEqual(store.records.get('task-a')?.pending.map(item => item.kind), ['create', 'event'])
  })
})
