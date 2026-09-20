import { describe, it, type TestContext } from 'node:test'
import * as assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AuthSessionManager } from '../common/platform/auth-session-manager'
import { ClientTaskApi, type ClientTaskEventPayload } from '../common/platform/client-task-api'
import { AuthApiError } from '../common/platform/platform-api'
import { setLogSink } from '../common/logger'
import { TaskStatus, type ClientTask, type TaskExecutionEvent } from '../../src/shared/types'
import { TaskCloudMirror } from './task-cloud-mirror'

interface SavedState {
  remoteTaskId: string
  sequence: number
  pendingEvents?: ClientTaskEventPayload[]
}

interface MirrorInternals {
  loaded: Promise<void>
  chain: Map<string, Promise<void>>
  persistChain: Promise<void>
  states: Map<string, SavedState & { heartbeat?: ReturnType<typeof setInterval> }>
}

function task(overrides: Partial<ClientTask> = {}): ClientTask {
  return {
    id: 'task-a', title: 'Mirror regression', prompt: 'test', status: TaskStatus.PENDING,
    workDir: null, createdAt: 1, startedAt: null, completedAt: null, error: null,
    files: [], logs: [], ownerId: 'member-a', ownerEnterpriseId: 'enterprise-a',
    subscriptionId: 'subscription-a', activeRunId: 'run-a', ...overrides,
  }
}

function event(type: string): TaskExecutionEvent {
  return { taskId: 'task-a', runId: 'run-a', subscriptionId: 'subscription-a', sequence: 0, type, occurredAt: 1, data: null }
}

function apiError(statusCode = 400): AuthApiError {
  return new AuthApiError({ statusCode, message: 'Simulated mirror failure' }, 'tasks')
}

async function harness(t: TestContext, saved?: object) {
  const directory = await mkdtemp(join(tmpdir(), 'sep-task-cloud-mirror-'))
  const stateFile = join(directory, 'task-cloud-mirror', 'state.json')
  if (saved) {
    await mkdir(join(directory, 'task-cloud-mirror'))
    await writeFile(stateFile, JSON.stringify(saved))
  }
  const restoreLog = setLogSink(() => {})
  // Every API method is mocked: no auth, credentials or network are used.
  const create = t.mock.method(ClientTaskApi.prototype, 'create', async () => ({ id: 'remote-a' }))
  const updateStatus = t.mock.method(ClientTaskApi.prototype, 'updateStatus', async () => ({}))
  const appendEvent = t.mock.method(ClientTaskApi.prototype, 'appendEvent', async () => ({}))
  const heartbeat = t.mock.method(ClientTaskApi.prototype, 'heartbeat', async () => ({}))
  const mirror = new TaskCloudMirror({} as AuthSessionManager, directory)
  const internals = mirror as unknown as MirrorInternals
  await internals.loaded
  t.after(async () => {
    mirror.stop()
    await Promise.all(internals.chain.values())
    await internals.persistChain
    restoreLog()
    await rm(directory, { recursive: true, force: true })
  })
  return {
    mirror, internals, create, updateStatus, appendEvent, heartbeat,
    async sync(value: ClientTask) {
      mirror.observeTask(value)
      await internals.chain.get(value.id)
    },
    async send(value: TaskExecutionEvent) {
      mirror.observeEvent(value)
      await internals.chain.get(value.taskId)
    },
    async saved(): Promise<{ states: Record<string, SavedState>; pendingCreates: Record<string, unknown> }> {
      await internals.persistChain
      return JSON.parse(await readFile(stateFile, 'utf8'))
    },
  }
}

describe('TaskCloudMirror', () => {
  it('waits for admission before creating, then syncs a terminal snapshot with null runId', async t => {
    const h = await harness(t)
    await h.sync(task({ activeRunId: null }))
    assert.equal(h.create.mock.callCount(), 0)
    assert.equal(h.updateStatus.mock.callCount(), 0)

    await h.sync(task())
    assert.equal(h.create.mock.callCount(), 1)
    assert.equal(h.create.mock.calls[0].arguments[0]?.clientRunId, 'run-a')
    assert.equal(h.create.mock.calls[0].arguments[0]?.subscriptionId, 'subscription-a')
    assert.deepEqual(h.updateStatus.mock.calls[0].arguments, ['remote-a', 'QUEUED'])

    await h.sync(task({ status: TaskStatus.COMPLETED, activeRunId: null }))
    assert.equal(h.create.mock.callCount(), 1)
    assert.deepEqual(h.updateStatus.mock.calls[1].arguments, ['remote-a', 'COMPLETED'])
  })

  for (const invalid of [undefined, null, '', '   ']) {
    it(`does not create without a valid subscription (${JSON.stringify(invalid)})`, async t => {
      const h = await harness(t)
      await h.sync(task({ subscriptionId: invalid }))
      assert.equal(h.create.mock.callCount(), 0)
      await h.sync(task())
      assert.equal(h.create.mock.calls[0].arguments[0]?.subscriptionId, 'subscription-a')
    })
  }

  for (const invalid of [null, '', '   ']) {
    it(`does not create without a valid runId (${JSON.stringify(invalid)})`, async t => {
      const h = await harness(t)
      await h.sync(task({ activeRunId: invalid }))
      assert.equal(h.create.mock.callCount(), 0)
    })
  }

  for (const invalid of [{ clientRunId: null }, { subscriptionId: null }, { clientRunId: ' ' }]) {
    it(`refreshes a persisted invalid pending create (${JSON.stringify(invalid)})`, async t => {
      const h = await harness(t, { pendingCreates: { 'task-a': {
        clientTaskId: 'task-a', clientRunId: 'run-a', subscriptionId: 'subscription-a',
        title: 'Old snapshot', status: 'QUEUED', createdAt: new Date(1).toISOString(), ...invalid,
      } } })
      await h.sync(task())
      const payload = h.create.mock.calls[0].arguments[0]
      assert.ok(payload)
      assert.equal(payload.clientRunId, 'run-a')
      assert.equal(payload.subscriptionId, 'subscription-a')
      assert.deepEqual((await h.saved()).pendingCreates, {})
    })
  }

  it('retains a valid pending create for idempotent retries', async t => {
    const payload = {
      clientTaskId: 'task-a', clientRunId: 'run-a', subscriptionId: 'subscription-a',
      title: 'Original snapshot', status: 'QUEUED', createdAt: new Date(1).toISOString(),
    }
    const h = await harness(t, { pendingCreates: { 'task-a': payload } })
    await h.sync(task({ title: 'Updated title' }))
    assert.deepEqual(h.create.mock.calls[0].arguments[0], payload)
  })

  it('allocates unique sequences even when the previous event exhausts retries', async t => {
    const h = await harness(t)
    await h.sync(task())
    h.appendEvent.mock.mockImplementation(async () => { throw apiError(503) })
    await h.send(event('first'))
    assert.equal(h.appendEvent.mock.callCount(), 4)
    const queued = (await h.saved()).states['task-a']
    assert.equal(queued.sequence, 1)
    assert.deepEqual(queued.pendingEvents?.map(item => item.sequence), [1])

    h.appendEvent.mock.mockImplementation(async () => ({}))
    await h.send(event('second'))
    assert.deepEqual(h.appendEvent.mock.calls.slice(4).map(call => call.arguments[1]?.sequence), [1, 2])
    assert.equal((await h.saved()).states['task-a'].sequence, 2)
    assert.equal((await h.saved()).states['task-a'].pendingEvents, undefined)
  })

  it('does not move the allocation cursor backwards after a partial flush', async t => {
    const pending = [1, 2].map(sequence => ({ sequence, type: 'queued', occurredAt: new Date(1).toISOString() }))
    const h = await harness(t, { states: { 'task-a': { remoteTaskId: 'remote-a', sequence: 2, pendingEvents: pending } } })
    h.appendEvent.mock.mockImplementation(async (_id, payload) => {
      if (payload.sequence === 2) throw apiError()
      return {}
    })
    await h.send(event('third'))
    const saved = (await h.saved()).states['task-a']
    assert.equal(saved.sequence, 3)
    assert.deepEqual(saved.pendingEvents?.map(item => item.sequence), [1, 2, 3])
    h.appendEvent.mock.mockImplementation(async () => ({}))
    await h.send(event('fourth'))
    assert.deepEqual(h.appendEvent.mock.calls.slice(2).map(call => call.arguments[1]?.sequence), [2, 3, 4])
    assert.equal((await h.saved()).states['task-a'].sequence, 4)
  })

  it('recovers the allocation high-water mark from legacy pending events', async t => {
    const pending = [1, 2].map(sequence => ({ sequence, type: 'queued', occurredAt: new Date(1).toISOString() }))
    const h = await harness(t, { states: { 'task-a': { remoteTaskId: 'remote-a', sequence: 0, pendingEvents: pending } } })
    await h.send(event('third'))
    assert.deepEqual(h.appendEvent.mock.calls.map(call => call.arguments[1]?.sequence), [1, 2, 3])
    assert.equal((await h.saved()).states['task-a'].sequence, 3)
  })

  for (const status of [TaskStatus.COMPLETED, TaskStatus.FAILED, TaskStatus.INTERRUPTED]) {
    for (const failure of ['status', 'event'] as const) {
      it(`stops and clears heartbeat for ${status} even when ${failure} sync fails`, async t => {
        const h = await harness(t)
        await h.sync(task({ status: TaskStatus.RUNNING }))
        const state = h.internals.states.get('task-a')!
        const handle = state.heartbeat
        assert.ok(handle)
        const clear = t.mock.method(globalThis, 'clearInterval')
        if (failure === 'event') {
          h.appendEvent.mock.mockImplementation(async () => { throw apiError() })
          await h.send(event('pending'))
        } else {
          h.updateStatus.mock.mockImplementation(async () => { throw apiError() })
        }
        await h.sync(task({ status, activeRunId: null }))
        assert.ok(clear.mock.calls.some(call => call.arguments[0] === handle))
        assert.equal(state.heartbeat, undefined)
        assert.equal(h.create.mock.callCount(), 1)
        assert.equal(h.heartbeat.mock.callCount(), 0)
      })
    }
  }

  it('clears the timer before awaiting terminal status and can allocate another timer later', async t => {
    const h = await harness(t)
    await h.sync(task({ status: TaskStatus.RUNNING }))
    const state = h.internals.states.get('task-a')!
    const original = state.heartbeat
    let release!: () => void
    let entered!: () => void
    const requested = new Promise<void>(resolve => { entered = resolve })
    const pending = new Promise<void>(resolve => { release = resolve })
    h.updateStatus.mock.mockImplementation(async () => { entered(); await pending; return {} })
    const syncing = h.sync(task({ status: TaskStatus.COMPLETED, activeRunId: null }))
    await requested
    try {
      assert.equal(state.heartbeat, undefined)
    } finally {
      release()
      await syncing
    }
    h.updateStatus.mock.mockImplementation(async () => ({}))
    await h.sync(task({ status: TaskStatus.RUNNING }))
    assert.ok(state.heartbeat)
    assert.notEqual(state.heartbeat, original)
    h.mirror.stop()
    assert.equal(state.heartbeat, undefined)
  })
})
