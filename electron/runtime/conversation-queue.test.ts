import * as assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TaskManager } from './task-manager'
import { TaskRuntime } from './task-runtime'
import { TaskRunStore } from '../data/task-run-store'
import { ConversationQueueStore } from '../data/conversation-queue-store'
import { ConversationQueueService } from '../service/conversation-queue-service'

async function waitFor(predicate: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 6000
  while (!await predicate()) {
    if (Date.now() > deadline) assert.fail('queue failed to reach expected state')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

test('real conversation runs drain FIFO only after disposal, pause on failure and resume the failed prompt with its knowledge', async () => {
  const root = await mkdtemp(join(tmpdir(), 'conversation-queue-runtime-'))
  const scope = { memberId: 'member', enterpriseId: 'enterprise' }
  const manager = new TaskManager(root), runs = new TaskRunStore(root)
  await manager.initialize(); await manager.setCurrentUser(scope.memberId, scope.enterpriseId)
  const task = await manager.createTask('queue', 'initial', join(root, 'workspace'), 'employee')
  const started: string[] = [], disposed: string[] = []
  const inputRefs: unknown[] = []
  const gates = new Map<string, () => void>()
  let failOne = true
  const runtime: TaskRuntime = new TaskRuntime({ taskManager: manager, taskRunStore: runs,
    resolveEmployee: () => ({ subscriptionId: 'employee', modelId: 'model', gatewayUrl: 'http://unused' }),
    getRefreshToken: () => 'fixture', onAuthenticationRequired() {}, onEvent() {}, onApprovalRequest() {},
    attachmentInputs: {
      async resolveTaskInputs(_scope, _taskId, refs) { inputRefs.push(structuredClone(refs)); return { attachments: [], images: [], digest: '' } },
      async resolvePlannerMaterials() { return [] },
    },
    onConversationSettled: (id, runId) => queue.settled(id, runId),
    createWorker: options => {
      let release!: () => void
      const gate = new Promise<void>(resolve => { release = resolve })
      const id = options.context.runId
      gates.set(id, release)
      return { async run(prompt) {
        if (started.length) assert.equal(disposed.length, started.length, 'previous worker must be disposed before next starts')
        started.push(prompt)
        await mkdir(options.context.sessionDir, { recursive: true })
        const file = join(options.context.sessionDir, 'session.jsonl')
        await writeFile(file, '{}\n')
        await options.onSessionCreated?.({ sessionId: 'shared', sessionFile: file })
        await gate
        if (prompt === 'one' && failOne) { failOne = false; throw new Error('Request timed out.') }
      }, async abort() { release() }, async dispose() { disposed.push(id) } }
    },
  })
  const queue: ConversationQueueService = new ConversationQueueService({ scope: { currentScope: () => manager.getCurrentUserScope() },
    store: new ConversationQueueStore(root), getTask: id => manager.getTask(id),
    isBusy: id => runtime.hasConversationRun(id),
    start: (id, entry, signal) => runtime.continueConversation(id, entry.prompt, { runId: entry.runId, signal, knowledge: entry.knowledge, attachmentRefs: entry.attachmentRefs }),
    retry: (id, signal) => runtime.retryTask(id, { conversation: true, signal }),
  })
  try {
    await runtime.executeTask(task.id, { conversation: true })
    await waitFor(() => started.length === 1)
    const firstRefs = [{ attachmentId: 'attachment-one', sha256: 'a'.repeat(64) }]
    const secondRefs = [{ attachmentId: 'attachment-two', sha256: 'b'.repeat(64) }]
    await queue.enqueue(task.id, { id: 'message-one', prompt: 'one' }, async () => ({ knowledge: { mode: 'none', knowledgeBaseIds: [] }, attachmentRefs: firstRefs }))
    await queue.enqueue(task.id, { id: 'message-two', prompt: 'two' }, async () => ({ attachmentRefs: secondRefs }))
    assert.deepEqual(started, ['initial'])
    assert.equal((await manager.getTask(task.id))?.status, 'running', 'enqueue must never reset the current run state')
    gates.get((await manager.getTask(task.id))!.activeRunId!)!()
    await waitFor(() => started.length === 2)
    gates.get('message-one')!()
    await waitFor(async () => (await queue.view(task.id)).paused)
    assert.deepEqual(started, ['initial', 'one'])
    await queue.resume(task.id)
    await waitFor(() => started.length === 3)
    const retryRun = (await manager.getTask(task.id))!.activeRunId!
    assert.notEqual(retryRun, 'message-one')
    assert.deepEqual((await runs.get(scope, task.id, retryRun))?.knowledge, { mode: 'none', knowledgeBaseIds: [] })
    gates.get(retryRun)!()
    await waitFor(() => started.length === 4)
    assert.deepEqual(started, ['initial', 'one', 'one', 'two'])
    assert.deepEqual(inputRefs, [firstRefs, firstRefs, secondRefs], 'each turn and retry must use its own immutable attachment references')
    await queue.cancel(task.id)
    await runtime.cancelTask(task.id)
    assert.equal((await queue.view(task.id)).items.length, 0)
  } finally { queue.stop(); for (const release of gates.values()) release(); await runtime.stopAll(); await rm(root, { recursive: true, force: true }) }
})

test('logout during initial-turn retry authorization cannot admit a late run', async () => {
  const root = await mkdtemp(join(tmpdir(), 'conversation-queue-retry-'))
  const manager = new TaskManager(root)
  await manager.initialize(); await manager.setCurrentUser('member', 'enterprise')
  const task = await manager.createTask('retry', 'initial', join(root, 'workspace'), 'employee')
  await manager.updateTaskStatus(task.id, 'failed')
  let authorize!: () => void
  const gate = new Promise<void>(resolve => { authorize = resolve })
  let entered = false, started = false
  const runtime = new TaskRuntime({ taskManager: manager,
    resolveEmployee: () => ({ subscriptionId: 'employee', modelId: 'model', gatewayUrl: 'http://unused' }),
    authorizeEmployee: async () => { entered = true; await gate; return { subscriptionId: 'employee', modelId: 'model', gatewayUrl: 'http://unused' } },
    getRefreshToken: () => 'fixture', onAuthenticationRequired() {}, onEvent() {}, onApprovalRequest() {},
    createWorker: () => { started = true; return { async run() {}, async abort() {}, async dispose() {} } },
  })
  const controller = new AbortController()
  try {
    const retry = runtime.retryTask(task.id, { conversation: true, signal: controller.signal })
    const rejected = assert.rejects(retry)
    await waitFor(() => entered)
    controller.abort(); authorize()
    await rejected
    assert.equal((await manager.getTask(task.id))?.activeRunId, null)
    assert.equal(started, false)
  } finally { authorize(); await runtime.stopAll(); await rm(root, { recursive: true, force: true }) }
})
