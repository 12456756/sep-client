import * as assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConversationQueueStore } from '../data/conversation-queue-store'
import { ConversationQueueService } from './conversation-queue-service'
import type { ClientTask } from '../../src/shared/types'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'conversation-queue-'))
  let scope: { memberId: string; enterpriseId: string } | null = { memberId: 'member', enterpriseId: 'enterprise' }
  const task = { id: 'task', ownerId: 'member', ownerEnterpriseId: 'enterprise', subscriptionId: 'employee', status: 'running', activeRunId: 'initial' } as ClientTask
  const started: string[] = []
  let prepares = 0
  const store = new ConversationQueueStore(root)
  const options = { scope: { currentScope: () => scope }, store,
    getTask: async () => scope?.memberId === task.ownerId ? structuredClone(task) : null,
    start: async (_taskId: string, entry: { id: string; runId: string }, signal: AbortSignal) => {
      signal.throwIfAborted(); started.push(entry.id); task.activeRunId = entry.runId; task.status = 'running'
    },
    retry: async () => { task.activeRunId = 'retry-initial'; task.status = 'running' },
  }
  const service = new ConversationQueueService(options)
  const enqueue = (id: string) => service.enqueue('task', { id, prompt: id }, async () => { prepares++; return {} })
  const finish = async (failed = false) => { const runId = task.activeRunId!; task.lastRunId = runId; task.activeRunId = null; task.status = failed ? 'failed' : 'completed'; await service.settled('task', runId) }
  return { service, store, options, task, started, enqueue, finish, prepares: () => prepares,
    setScope: (next: typeof scope) => { scope = next }, cleanup: () => rm(root, { recursive: true, force: true }) }
}

test('accepts ten waiting messages atomically, deduplicates and rejects overflow before preparing attachments', async () => {
  const f = await fixture()
  try {
    const results = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => f.enqueue(`message-${i}`)))
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 10)
    assert.equal(f.prepares(), 10)
    await f.enqueue('message-0')
    assert.equal(f.prepares(), 10)
    assert.equal((await f.service.view('task')).items.length, 10)
    assert.deepEqual(f.started, [])
  } finally { await f.cleanup() }
})

test('starts one message at a time after cleanup, preserves order, pauses on failure and retries before continuing', async () => {
  const f = await fixture()
  try {
    await f.enqueue('one'); await f.enqueue('two')
    await f.finish()
    assert.deepEqual(f.started, ['one'])
    await f.finish(true)
    assert.deepEqual(f.started, ['one'])
    assert.equal((await f.service.view('task')).paused, true)
    await f.service.resume('task')
    assert.deepEqual(f.started, ['one', 'one'])
    await f.finish()
    assert.deepEqual(f.started, ['one', 'one', 'two'])
    await f.finish()
    assert.equal((await f.service.view('task')).items.length, 0)
    await f.enqueue('one')
    assert.deepEqual(f.started, ['one', 'one', 'two'])
  } finally { await f.cleanup() }
})

test('restores a paused queue, keeps account isolation and cancels pending work on stop', async () => {
  const f = await fixture()
  try {
    await f.enqueue('one')
    f.service.stop()
    f.task.activeRunId = null; f.task.status = 'interrupted'
    const restored = new ConversationQueueService(f.options)
    assert.equal((await restored.view('task')).paused, true)
    assert.deepEqual(f.started, [])
    await restored.cancel('task')
    await restored.resume('task')
    assert.deepEqual(f.started, [])
    f.setScope({ memberId: 'other', enterpriseId: 'enterprise' })
    await assert.rejects(() => restored.view('task'))
  } finally { await f.cleanup() }
})

test('an account change during preparation cannot save or launch an old message', async () => {
  const f = await fixture()
  try {
    await assert.rejects(() => f.service.enqueue('task', { id: 'late', prompt: 'late' }, async () => {
      f.service.stop(); f.setScope(null); return {}
    }))
    f.setScope({ memberId: 'member', enterpriseId: 'enterprise' })
    f.service.start()
    assert.equal((await f.service.view('task')).items.length, 0)
    assert.deepEqual(f.started, [])
  } finally { await f.cleanup() }
})

test('logout prevents late settlements and dispatch until a new login explicitly starts the queue service', async () => {
  const f = await fixture()
  try {
    await f.enqueue('one')
    f.service.stop()
    await f.finish()
    assert.deepEqual(f.started, [])
    await assert.rejects(() => f.enqueue('two'))
    f.service.start()
    assert.equal((await f.service.view('task')).paused, true)
    await f.service.resume('task')
    assert.deepEqual(f.started, ['one'])
  } finally { await f.cleanup() }
})

test('failure retry does not turn ten waiting items into eleven, and worker cleanup blocks early dispatch', async () => {
  const f = await fixture()
  try {
    let busy = true
    const service = new ConversationQueueService({ ...f.options, isBusy: () => busy })
    f.task.status = 'completed'; f.task.activeRunId = null; f.task.lastRunId = 'initial'
    await service.enqueue('task', { id: 'one', prompt: 'one' }, async () => ({}))
    await service.view('task')
    assert.deepEqual(f.started, [])
    busy = false
    await service.settled('task', 'initial')
    assert.deepEqual(f.started, ['one'])
    const failedRun = f.task.activeRunId!
    f.task.lastRunId = failedRun; f.task.activeRunId = null; f.task.status = 'failed'
    await service.settled('task', failedRun)
    for (let i = 0; i < 10; i++) await service.enqueue('task', { id: `next-${i}`, prompt: `next-${i}` }, async () => ({}))
    await service.resume('task')
    assert.equal((await service.view('task')).items.length, 10)
    assert.deepEqual(f.started, ['one', 'one'])
  } finally { await f.cleanup() }
})

test('deduplication includes attachment and knowledge fingerprint, and stopped conversations accept fresh messages', async () => {
  const f = await fixture()
  try {
    const requestKey = 'a'.repeat(64)
    await f.service.enqueue('task', { id: 'same', prompt: 'same', requestKey }, async () => ({}))
    await assert.rejects(() => f.service.enqueue('task', { id: 'same', prompt: 'same', requestKey: 'b'.repeat(64) }, async () => ({})))
    await f.service.cancel('task', async () => { f.task.activeRunId = null; f.task.status = 'paused' })
    await f.enqueue('fresh')
    await f.service.view('task')
    assert.deepEqual(f.started, ['fresh'])
  } finally { await f.cleanup() }
})

test('failed persistence never acknowledges or launches a message; restored completed active entries are not replayed', async () => {
  const f = await fixture()
  try {
    const broken = new ConversationQueueService({ ...f.options, store: {
      get: (...args) => f.store.get(...args), async save() { throw new Error('disk unavailable') },
    } })
    await assert.rejects(() => broken.enqueue('task', { id: 'unsaved', prompt: 'unsaved' }, async () => ({})))
    assert.deepEqual(f.started, [])
    assert.equal(await f.store.get({ memberId: 'member', enterpriseId: 'enterprise' }, 'task'), null)
    await f.enqueue('finished')
    await f.finish()
    const runId = f.task.activeRunId!
    // Simulate a crash between persisting the task's completion and updating the queue.
    f.task.lastRunId = runId; f.task.activeRunId = null; f.task.status = 'completed'
    const restored = new ConversationQueueService(f.options)
    const view = await restored.view('task')
    assert.equal(view.failed, null)
    assert.equal(view.items.length, 0)
    await restored.resume('task')
    assert.deepEqual(f.started, ['finished'])
  } finally { await f.cleanup() }
})
