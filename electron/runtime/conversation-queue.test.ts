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
import { TaskMetadataStore } from '../data/task-metadata-store'
import { TaskService } from '../service/task-service'
import { ConversationService } from '../service/conversation-service'
import type { EmployeeAuthorizer } from '../service/employee-authorizer'
import { ArrangementDiagnosticStore } from '../data/arrangement-diagnostic-store'
import { ArrangementDiagnosticService } from '../service/arrangement-diagnostic-service'
import { ConversationContextStore } from '../domain/conversation-context'

async function waitFor(predicate: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 6000
  while (!await predicate()) {
    if (Date.now() > deadline) assert.fail('queue failed to reach expected state')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

test('task retry with an empty paused queue drains follow-ups only after the recovered worker is disposed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'conversation-empty-retry-'))
  const manager = new TaskManager(root), runs = new TaskRunStore(root), metadata = new TaskMetadataStore(root)
  await manager.initialize(); await manager.setCurrentUser('member', 'enterprise')
  const scope = { currentScope: () => manager.getCurrentUserScope() }
  const diagnosticStore = new ArrangementDiagnosticStore(root)
  const task = await manager.createTask('retry', 'initial', join(root, 'workspace'), 'employee')
  await metadata.save(scope.currentScope()!, { version: 1, taskId: task.id, kind: 'conversation', participantSubscriptionIds: ['employee'], currentSubscriptionId: 'employee', createdAt: 1 })
  const started: string[] = [], disposed: string[] = []
  const gates = new Map<string, () => void>()
  const runtime: TaskRuntime = new TaskRuntime({ taskManager: manager, taskRunStore: runs,
    arrangementDiagnostics: new ArrangementDiagnosticService({ scope, store: diagnosticStore, authorizationRevision: () => 0, clientVersion: '0.5.6' }),
    resolveEmployee: () => ({ subscriptionId: 'employee', modelId: 'model', gatewayUrl: 'http://unused' }),
    getRefreshToken: () => 'fixture', onAuthenticationRequired() {}, onEvent() {}, onApprovalRequest() {},
    onConversationSettled: (id, runId, owner) => queue.settled(id, runId, owner),
    createWorker: options => {
      let release!: () => void
      const gate = new Promise<void>(resolve => { release = resolve })
      gates.set(options.context.runId, release)
      return { async run(prompt) {
        assert.equal(disposed.length, started.length, 'dispose the previous worker before executing a follow-up')
        started.push(prompt.split('\n\n【', 1)[0]!)
        await mkdir(options.context.sessionDir, { recursive: true })
        const file = join(options.context.sessionDir, 'session.jsonl')
        await writeFile(file, '{}\n')
        await options.onSessionCreated?.({ sessionId: 'shared', sessionFile: file })
        if (started.length === 1) {
          await options.context.modelTrace?.({ phase: '', kind: 'status', requestNumber: 1, text: 'PRIVATE_TRACE',
            metrics: { 诊断: '{"httpStatus":504,"code":"gateway_timeout","sepRequestId":"test-request","body":"PRIVATE_BODY"}' } })
          throw new Error('Request timed out.')
        }
        await gate
      }, async abort() { release() }, async dispose() { disposed.push(options.context.runId) } }
    },
  })
  const queue: ConversationQueueService = new ConversationQueueService({ scope, store: new ConversationQueueStore(root),
    getTask: id => manager.getTask(id), isBusy: id => runtime.hasConversationRun(id),
    start: (id, entry, signal) => runtime.continueConversation(id, entry.prompt, { runId: entry.runId, signal }),
    retry: (id, signal) => runtime.retryTask(id, { conversation: true, signal }),
  })
  const employees = { async authorize() { return true } } as unknown as EmployeeAuthorizer
  const tasks = new TaskService({ scope, taskManager: manager, taskRunStore: runs, taskMetadataStore: metadata, employees, execution: async () => runtime, conversationQueue: queue })
  const conversations = new ConversationService({ scope, taskManager: manager, taskMetadataStore: metadata, employees, tasks, execution: async () => runtime, queue })
  try {
    await runtime.executeTask(task.id, { conversation: true })
    await waitFor(async () => (await queue.view(task.id)).paused && !runtime.hasConversationRun(task.id))
    assert.equal((await queue.view(task.id)).items.length, 0)
    const owner = scope.currentScope()!
    const failedRunId = disposed[0]!
    const saved = await diagnosticStore.get(owner, { taskId: task.id, runId: failedRunId })
    assert.equal(saved?.phase, 'model-execution')
    assert.equal(saved?.modelRequest?.requestId, 'test-request')
    assert.equal(saved?.modelHistory?.entries[0]?.diagnostic?.body, 'PRIVATE_BODY')
    assert.equal(saved?.exception?.entries[0]?.message, 'Request timed out.')
    assert.doesNotMatch(JSON.stringify(saved), /PRIVATE_TRACE|initial/)
    const persisted = await runs.events.getTimeline(owner, task.id, failedRunId)
    assert.deepEqual(persisted.find(event => event.type === 'run_failed')?.data,
      { error: '模型请求超时，请稍后重试', diagnosticAvailable: true })
    await tasks.retry(task.id)
    await waitFor(() => started.length === 2)
    const retryRunId = (await manager.getTask(task.id))!.activeRunId!
    assert.notEqual(retryRunId, failedRunId)
    assert.equal(await diagnosticStore.get(owner, { taskId: task.id, runId: retryRunId }), null)
    assert.equal((await queue.view(task.id)).paused, false)
    assert.deepEqual(await conversations.continue({ taskId: task.id, messageId: 'later', prompt: 'follow-up' }), { queued: true })
    gates.get((await manager.getTask(task.id))!.activeRunId!)!()
    await waitFor(() => started.length === 3)
    assert.deepEqual(started, ['initial', 'initial', 'follow-up'])
    gates.get('later')!()
    await waitFor(async () => !runtime.hasConversationRun(task.id) && (await queue.view(task.id)).items.length === 0)
    assert.deepEqual(await conversations.continue({ taskId: task.id, messageId: 'idle', prompt: 'run immediately' }), { queued: false })
    await waitFor(() => started.length === 4)
  } finally { queue.stop(); for (const release of gates.values()) release(); await runtime.stopAll(); await rm(root, { recursive: true, force: true }) }
})

test('a failed conversation setup persists the original turn and a diagnostic without starting a worker', async () => {
  const root = await mkdtemp(join(tmpdir(), 'conversation-setup-diagnostic-'))
  const owner = { memberId: 'member', enterpriseId: 'enterprise' }
  const manager = new TaskManager(root), runs = new TaskRunStore(root), store = new ArrangementDiagnosticStore(root)
  await manager.initialize(); await manager.setCurrentUser(owner.memberId, owner.enterpriseId)
  const task = await manager.createTask('setup', 'initial', join(root, 'workspace'), 'employee')
  let workersCreated = 0
  const runtime = new TaskRuntime({ taskManager: manager, taskRunStore: runs,
    resolveEmployee: () => ({ subscriptionId: 'employee', modelId: 'model', gatewayUrl: 'http://unused' }),
    getRefreshToken: () => 'fixture', onAuthenticationRequired() {}, onEvent() {}, onApprovalRequest() {},
    arrangementDiagnostics: new ArrangementDiagnosticService({ scope: { currentScope: () => manager.getCurrentUserScope() },
      store, authorizationRevision: () => 0, clientVersion: '0.5.6' }),
    attachmentInputs: {
      async describeTaskInputs() { return [] },
      async resolveTaskInputs() { throw new Error('ATTACHMENT_INTEGRITY_MISMATCH') },
      async resolvePlannerMaterials() { return [] },
    },
    createWorker: () => { workersCreated++; throw new Error('Unexpected worker creation') },
  })
  try {
    const sessionFile = join(root, 'previous-session.jsonl')
    await writeFile(sessionFile, '{}\n')
    const context = new ConversationContextStore(runs.getTaskDir(owner, task.id))
    await context.setSharedSession({ sessionId: 'shared', sessionFile, lastRunId: 'previous', updatedAt: 1 })
    await runtime.continueConversation(task.id, 'Check attachment', { attachmentRefs: [{ attachmentId: 'missing', sha256: 'a'.repeat(64) }] })
    await waitFor(async () => (await manager.getTask(task.id))?.status === 'failed' && !runtime.hasConversationRun(task.id))
    assert.equal(workersCreated, 0)
    const [run] = await runs.list(owner, task.id)
    assert.equal(run?.outcome, 'failed')
    const diagnostic = await store.get(owner, { taskId: task.id, runId: run!.id })
    assert.equal(diagnostic?.phase, 'input-read')
    assert.equal(diagnostic?.reason, 'ATTACHMENT_INTEGRITY_MISMATCH')
    const messages = await context.listMessages()
    assert.ok(messages.some(message => message.role === 'user' && message.runId === run?.id))
    const timeline = await runs.events.getTimeline(owner, task.id, run!.id)
    assert.equal((timeline.find(event => event.type === 'run_failed')?.data as { diagnosticAvailable?: boolean })?.diagnosticAvailable, true)
  } finally { await runtime.stopAll(); await rm(root, { recursive: true, force: true }) }
})

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
      async describeTaskInputs() { return [] },
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
        const userPrompt = prompt.split('\n\n【', 1)[0]!
        started.push(userPrompt)
        await mkdir(options.context.sessionDir, { recursive: true })
        const file = join(options.context.sessionDir, 'session.jsonl')
        await writeFile(file, '{}\n')
        await options.onSessionCreated?.({ sessionId: 'shared', sessionFile: file })
        await gate
        if (userPrompt === 'one' && failOne) { failOne = false; throw new Error('Request timed out.') }
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
