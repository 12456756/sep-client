import * as assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConversationQueueStore } from '../data/conversation-queue-store'
import { ConversationQueueService } from './conversation-queue-service'
import type { ClientTask } from '../../src/shared/types'
import { ConversationRecoveryError } from '../runtime/conversation-recovery-error'
import { conversationQueueInputSchema } from '../../src/shared/conversation-queue'

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

test('initial preparation returns immediately, deduplicates starts and keeps follow-ups behind the initial run', async () => {
  const f = await fixture()
  let release!: () => void
  let starts = 0
  const ready = new Promise<void>(resolve => { release = resolve })
  const service = new ConversationQueueService({ ...f.options, startInitial: async (_id, signal) => {
    starts++
    await ready
    signal.throwIfAborted()
    f.task.activeRunId = 'initial'
    f.task.status = 'running'
  } })
  try {
    f.task.activeRunId = null; f.task.status = 'pending'
    service.scheduleInitial('task')
    service.scheduleInitial('task')
    assert.equal((await service.view('task')).preparing, true)
    await service.enqueue('task', { id: 'later', prompt: 'later' }, async () => ({}))
    await service.view('task')
    assert.deepEqual(f.started, [])
    assert.equal(starts, 1)
    release()
    await new Promise(resolve => setTimeout(resolve, 10))
    f.task.lastRunId = 'initial'; f.task.activeRunId = null; f.task.status = 'completed'
    await service.settled('task', 'initial')
    assert.equal((await service.view('task')).preparing, false)
    assert.deepEqual(f.started, ['later'])
  } finally { release(); service.stop(); await f.cleanup() }
})

test('cancelling initial preparation prevents a late launch and does not report a startup error', async () => {
  const f = await fixture()
  let release!: () => void
  let admitted = false
  let failed = false
  const ready = new Promise<void>(resolve => { release = resolve })
  const service = new ConversationQueueService({ ...f.options, startInitial: async (_id, signal) => {
    await ready; signal.throwIfAborted(); admitted = true
  }, onInitialFailure: async () => { failed = true } })
  try {
    f.task.activeRunId = null; f.task.status = 'pending'
    service.scheduleInitial('task')
    await service.cancel('task', async () => { f.task.status = 'paused' })
    release()
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(admitted, false)
    assert.equal(failed, false)
    assert.equal((await service.view('task')).paused, true)
  } finally { release(); service.stop(); await f.cleanup() }
})

test('a detached initial failure pauses pending messages and records the failure in the current account only', async () => {
  const f = await fixture()
  let release!: () => void
  let failure: unknown
  const ready = new Promise<void>(resolve => { release = resolve })
  const service = new ConversationQueueService({ ...f.options, startInitial: async () => {
    await ready; throw new Error('Request timed out.')
  }, onInitialFailure: async (_id, error) => { failure = error; f.task.executionHealth = 'start-failed' } })
  try {
    f.task.activeRunId = null; f.task.status = 'pending'
    service.scheduleInitial('task')
    await service.enqueue('task', { id: 'later', prompt: 'later' }, async () => ({}))
    release()
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal((failure as Error)?.message, 'Request timed out.')
    assert.equal((await service.view('task')).paused, true)
    assert.deepEqual(f.started, [])
  } finally { release(); service.stop(); await f.cleanup() }
})

test('logout fences initial preparation even after signing into the same account again', async () => {
  const f = await fixture()
  let release!: () => void
  let admitted = false
  let failed = false
  const ready = new Promise<void>(resolve => { release = resolve })
  const service = new ConversationQueueService({ ...f.options, startInitial: async (_id, signal) => {
    await ready; signal.throwIfAborted(); admitted = true
  }, onInitialFailure: async () => { failed = true } })
  try {
    f.task.activeRunId = null; f.task.status = 'pending'
    service.scheduleInitial('task')
    service.stop(); service.start()
    release()
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(admitted, false)
    assert.equal(failed, false)
  } finally { release(); service.stop(); await f.cleanup() }
})

test('a restored unstarted task runs its original request before queued follow-ups on explicit resume', async () => {
  const f = await fixture()
  let starts = 0
  const service = new ConversationQueueService({ ...f.options, startInitial: async () => {
    starts++; f.task.activeRunId = 'initial'; f.task.status = 'running'
  } })
  try {
    f.task.activeRunId = null; f.task.status = 'pending'
    assert.equal((await service.view('task')).preparing, false)
    await service.enqueue('task', { id: 'later', prompt: 'later' }, async () => ({}))
    await service.view('task')
    assert.equal(starts, 0)
    assert.deepEqual(f.started, [])
    await service.resume('task')
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(starts, 1)
    assert.deepEqual(f.started, [])
    f.task.lastRunId = 'initial'; f.task.activeRunId = null; f.task.status = 'completed'
    await service.settled('task', 'initial')
    assert.deepEqual(f.started, ['later'])
  } finally { service.stop(); await f.cleanup() }
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

test('prioritizes a waiting message, interrupts outside the queue lock, and preserves the remaining order', async () => {
  const f = await fixture()
  const service = new ConversationQueueService({ ...f.options, interruptCurrent: async taskId => {
    assert.equal(taskId, 'task')
    f.task.activeRunId = null
    f.task.lastRunId = 'initial'
    f.task.status = 'interrupted'
    await service.settled(taskId, 'initial')
  } })
  try {
    await f.enqueue('message-a')
    await f.enqueue('message-b')
    await f.enqueue('message-c')
    assert.deepEqual(f.started, [])

    await service.prioritize('task', 'message-b')

    assert.deepEqual(f.started, ['message-b'])
    assert.deepEqual((await service.view('task')).items.map(item => item.id), ['message-a', 'message-c'])
  } finally { service.stop(); await f.cleanup() }
})

test('allows a second priority request when the previous run settles after its replacement starts', async () => {
  const f = await fixture()
  const interruptedRuns: string[] = []
  const service = new ConversationQueueService({ ...f.options, interruptCurrent: async (_taskId, runId) => {
    interruptedRuns.push(runId)
    f.task.activeRunId = null
    f.task.lastRunId = runId
    f.task.status = 'interrupted'
  } })
  try {
    await f.enqueue('message-a')
    await f.enqueue('message-b')
    await f.enqueue('message-c')
    await f.enqueue('message-d')

    await service.prioritize('task', 'message-a')
    assert.equal(f.task.activeRunId, 'message-a')

    // The old marker still exists until its asynchronous settlement callback arrives.
    await service.prioritize('task', 'message-b')
    assert.equal(f.task.activeRunId, 'message-b')

    await service.settled('task', 'initial')
    await service.prioritize('task', 'message-c')
    assert.equal(f.task.activeRunId, 'message-c')

    // A stale settlement must not clear the marker for the currently interrupted run.
    await service.settled('task', 'message-a')
    await service.settled('task', 'message-b')
    await service.prioritize('task', 'message-d')

    assert.deepEqual(interruptedRuns, ['initial', 'message-a', 'message-b', 'message-c'])
    assert.equal(f.task.activeRunId, 'message-d')
    assert.deepEqual((await service.view('task')).items, [])
  } finally { service.stop(); await f.cleanup() }
})

for (const outcome of ['completed', 'failed', 'cancelled', 'logout'] as const) {
  test(`an empty-queue retry clears the old pause and handles ${outcome} without losing follow-ups`, async () => {
    const f = await fixture()
    let retries = 0
    const service = new ConversationQueueService({ ...f.options, retry: async () => {
      retries++; await f.options.retry()
    } })
    try {
      f.task.lastRunId = 'initial'; f.task.activeRunId = null; f.task.status = 'failed'
      await service.settled('task', 'initial')
      assert.equal((await service.view('task')).paused, true)
      await Promise.all([service.resume('task', { retryOriginal: true }), service.resume('task', { retryOriginal: true })])
      assert.equal(retries, 1)
      assert.equal((await service.view('task')).paused, false)
      await service.enqueue('task', { id: 'later', prompt: 'later' }, async () => ({}))
      await service.enqueue('task', { id: 'last', prompt: 'last' }, async () => ({}))
      assert.deepEqual(f.started, [])
      if (outcome === 'cancelled') await service.cancel('task')
      if (outcome === 'logout') service.stop()
      f.task.lastRunId = 'retry-initial'; f.task.activeRunId = null
      f.task.status = outcome === 'failed' ? 'failed' : 'completed'
      await service.settled('task', 'retry-initial')
      assert.deepEqual(f.started, outcome === 'completed' ? ['later'] : [])
      if (outcome === 'failed') assert.equal((await service.view('task')).paused, true)
      if (outcome === 'completed') {
        f.task.lastRunId = 'later'; f.task.activeRunId = null
        await service.settled('task', 'later')
        assert.deepEqual(f.started, ['later', 'last'])
      }
    } finally { service.stop(); await f.cleanup() }
  })
}

test('empty-queue retry admission failure restores the pause and preserves the error', async () => {
  const f = await fixture()
  const failure = new Error('worker unavailable')
  const service = new ConversationQueueService({ ...f.options, retry: async () => { throw failure } })
  try {
    f.task.status = 'failed'; f.task.activeRunId = null; f.task.lastRunId = 'initial'
    await assert.rejects(service.resume('task', { retryOriginal: true }), error => error === failure)
    assert.equal((await service.view('task')).paused, true)
    await service.enqueue('task', { id: 'later', prompt: 'later' }, async () => ({}))
    await service.view('task')
    assert.deepEqual(f.started, [])
  } finally { service.stop(); await f.cleanup() }
})

test('submission distinguishes an idle send from a running task with an empty queue', async () => {
  const f = await fixture()
  try {
    f.task.status = 'completed'; f.task.activeRunId = null; f.task.lastRunId = 'initial'
    assert.equal((await f.enqueue('immediate')).queued, false)
    await f.service.view('task')
    assert.deepEqual(f.started, ['immediate'])
    assert.equal((await f.enqueue('waiting')).queued, true)
    assert.equal((await f.enqueue('last')).queued, true)
    await f.service.view('task')
    assert.deepEqual(f.started, ['immediate'])
  } finally { f.service.stop(); await f.cleanup() }
})

test('worker cleanup still requires waiting even after the active run id is cleared', async () => {
  const f = await fixture()
  const service = new ConversationQueueService({ ...f.options, isBusy: () => true })
  try {
    f.task.status = 'completed'; f.task.activeRunId = null; f.task.lastRunId = 'initial'
    assert.equal((await service.enqueue('task', { id: 'later', prompt: 'later' }, async () => ({}))).queued, true)
    await service.view('task')
    assert.deepEqual(f.started, [])
  } finally { service.stop(); await f.cleanup() }
})

test('an existing waiting message reports queuing even when no run is active', async () => {
  const f = await fixture()
  try {
    f.task.status = 'failed'; f.task.activeRunId = null
    await f.enqueue('waiting')
    assert.equal((await f.enqueue('later')).queued, true)
    assert.deepEqual(f.started, [])
  } finally { f.service.stop(); await f.cleanup() }
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

test('damaged session recovery requires confirmation for the failed message and preserves FIFO inputs after restart', async () => {
  const f = await fixture()
  const attempts: Array<{ id: string; confirmed?: boolean; attachmentRefs?: unknown; knowledge?: unknown }> = []
  const refs = [{ attachmentId: 'image', sha256: 'a'.repeat(64) }]
  const knowledge = { mode: 'none' as const, knowledgeBaseIds: [] }
  const options = { ...f.options, start: async (_id: string, entry: import('../data/conversation-queue-store').ConversationQueueEntry, signal: AbortSignal) => {
    attempts.push({ id: entry.id, confirmed: entry.confirmed, attachmentRefs: entry.attachmentRefs, knowledge: entry.knowledge })
    if (!entry.confirmed) throw new ConversationRecoveryError('RECOVERY_CONFIRMATION_REQUIRED', 'damaged session')
    await f.options.start(_id, entry, signal)
  } }
  const service = new ConversationQueueService(options)
  try {
    await service.enqueue('task', { id: 'one', prompt: 'one' }, async () => ({ attachmentRefs: refs, knowledge }))
    await service.enqueue('task', { id: 'two', prompt: 'two' }, async () => ({ confirmed: true }))
    f.task.lastRunId = 'initial'; f.task.activeRunId = null; f.task.status = 'completed'
    await service.settled('task', 'initial')
    assert.equal((await service.view('task')).failed?.recoveryConfirmationRequired, true)
    service.stop()
    const restored = new ConversationQueueService(options)
    assert.equal((await restored.view('task')).failed?.recoveryConfirmationRequired, true)
    await assert.rejects(() => restored.resume('task'), { code: 'RECOVERY_CONFIRMATION_REQUIRED' })
    await assert.rejects(() => restored.resume('task', { messageId: 'two', confirmed: true }), { code: 'INVALID_STATE' })
    assert.equal(attempts.length, 1)
    await restored.resume('task', { messageId: 'one', confirmed: true })
    assert.equal((await restored.view('task')).failed, null)
    assert.deepEqual(attempts[1], { id: 'one', confirmed: true, attachmentRefs: refs, knowledge })
    assert.deepEqual(f.started, ['one'])
    const runId = f.task.activeRunId!
    f.task.lastRunId = runId; f.task.activeRunId = null; f.task.status = 'completed'
    await restored.settled('task', runId)
    assert.deepEqual(f.started, ['one', 'two'])
    restored.stop()
  } finally { service.stop(); await f.cleanup() }
})

test('queue recovery IPC requires explicit confirmation and a concrete failed message identity', () => {
  assert.equal(conversationQueueInputSchema.safeParse({ taskId: 'task', action: 'recover', messageId: 'one', confirmRecovery: true }).success, true)
  for (const invalid of [
    { taskId: 'task', action: 'recover', messageId: 'one' },
    { taskId: 'task', action: 'recover', messageId: 'one', confirmRecovery: false },
    { taskId: 'task', action: 'recover', confirmRecovery: true },
    { taskId: 'task', action: 'resume', confirmRecovery: true },
  ]) assert.equal(conversationQueueInputSchema.safeParse(invalid).success, false)
})
