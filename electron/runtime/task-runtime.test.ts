import { afterEach, describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { TaskStatus } from '../../src/shared/types'
import { TaskRuntime } from './task-runtime'
import type { EmployeeRuntimeConfig } from './run-types'
import { TaskManager } from './task-manager'
import { TaskRunStore } from '../data/task-run-store'
import { TaskMetadataStore } from '../data/task-metadata-store'
import { TaskService } from '../service/task-service'
import { projectTaskMessages } from '../data/task-messages'
import { effectivePermissionPolicy, type WorkPlan } from '../domain/arrangement-plan'
import type { PiTaskWorkerOptions } from '../pi/sdk/pi-task-worker'
import { SEP_TEST_SUBSCRIPTION } from './sep-platform-fixtures'
import type { MediaHostTools, MediaRunPort } from '../domain/media-tools'
import type { VideoHostTools, VideoRunPort } from '../domain/video-tools'
import type { ToolAuthorizationRequest } from '../../src/shared/types'

const temporaryDirectories: string[] = []

async function makeUserDataDir(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'sep-client-runtime-tests-'))
  temporaryDirectories.push(directory)
  return directory
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for runtime state.')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('TaskRuntime media lifecycle', () => {
  async function fixture() {
    const userData = await makeUserDataDir()
    const manager = new TaskManager(userData)
    await manager.initialize()
    await manager.setCurrentUser('member-media', 'enterprise-media')
    const task = await manager.createTask('image', 'create an image', join(userData, 'workspace'), 'employee-media')
    const employee: EmployeeRuntimeConfig = {
      subscriptionId: 'employee-media', modelId: 'model-media', gatewayUrl: 'http://gateway', systemPrompt: 'Trusted image instructions.',
    }
    return { manager, task, employee }
  }

  it('passes the prompt and facade, binds approvals, and waits for delivery before finalizing', async () => {
    const { manager, task, employee } = await fixture()
    const host: MediaHostTools = { names: ['media_get_job'], execute: async () => null }
    let prepared: Parameters<MediaRunPort['prepareRun']>[0] | undefined
    let context: PiTaskWorkerOptions['context'] | undefined
    let waiting = false
    let deliver!: () => void
    const delivery = new Promise<void>(resolve => { deliver = resolve })
    const requests: ToolAuthorizationRequest[] = []
    const runtime = new TaskRuntime({
      taskManager: manager, getRefreshToken: () => 'refresh-token', onAuthenticationRequired: () => {}, onEvent: () => {},
      onApprovalRequest: request => requests.push(request), resolveEmployee: () => employee,
      media: {
        async prepareRun(input) { prepared = input; return host },
        async waitForRun(taskId, runId) { assert.equal(taskId, task.id); assert.equal(runId, context?.runId); waiting = true; await delivery },
        async stopTask() { deliver() },
      },
      createWorker: options => {
        context = options.context
        assert.equal(context.systemPrompt, employee.systemPrompt)
        assert.equal(context.mediaTools, host)
        return { async run() {}, async abort() {}, async dispose() {} }
      },
    })
    try {
      await runtime.executeTask(task.id)
      await waitFor(() => waiting)
      assert.equal((await manager.getTask(task.id))?.status, TaskStatus.RUNNING)
      assert.equal(prepared?.employee, employee)
      assert.equal(prepared?.runId, context?.runId)
      const input = { taskId: task.id, runId: context!.runId, subscriptionId: employee.subscriptionId, toolName: 'media_generate_image', input: { quote: { amount: '1', currency: 'credits' } } }
      const approved = prepared!.requestApproval(input)
      await waitFor(() => requests.length === 1)
      assert.equal(runtime.respondToApproval({ requestId: requests[0].requestId, approved: true }), true)
      assert.equal(await approved, true)
      const boundRequest = runtime.requestMediaApproval
      const denied = boundRequest(input)
      await waitFor(() => requests.length === 2)
      assert.equal(runtime.respondToApproval({ requestId: requests[1].requestId, approved: false }), true)
      assert.equal(await denied, false)
      deliver()
      await waitFor(async () => (await manager.getTask(task.id))?.activeRunId === null)
      assert.equal((await manager.getTask(task.id))?.status, TaskStatus.COMPLETED)
    } finally { deliver(); await runtime.stopAll() }
  })

  for (const control of ['pause', 'cancel', 'shutdown'] as const) {
    it(`${control} stops local media tracking while delivery is pending`, async () => {
      const { manager, task, employee } = await fixture()
      let waiting = false
      let deliver!: () => void
      const delivery = new Promise<void>(resolve => { deliver = resolve })
      const stopped: string[] = []
      const runtime = new TaskRuntime({
        taskManager: manager, getRefreshToken: () => 'refresh-token', onAuthenticationRequired: () => {}, onEvent: () => {},
        onApprovalRequest: () => {}, resolveEmployee: () => employee,
        media: { async prepareRun() { return undefined }, async waitForRun() { waiting = true; await delivery }, async stopTask(id) { stopped.push(id); deliver() } },
        createWorker: () => ({ async run() {}, async abort() {}, async dispose() {} }),
      })
      try {
        await runtime.executeTask(task.id)
        await waitFor(() => waiting)
        if (control === 'pause') await runtime.pauseTask(task.id)
        else if (control === 'cancel') await runtime.cancelTask(task.id)
        else await runtime.stopAll()
        assert.deepEqual(stopped, [task.id])
        assert.equal((await manager.getTask(task.id))?.status, control === 'shutdown' ? TaskStatus.INTERRUPTED : TaskStatus.PAUSED)
      } finally { deliver(); await runtime.stopAll() }
    })
  }

  it('does not start a worker when pause wins during media preparation', async () => {
    const { manager, task, employee } = await fixture()
    let preparing = false
    let finishPreparation!: (value: MediaHostTools | undefined) => void
    const preparation = new Promise<MediaHostTools | undefined>(resolve => { finishPreparation = resolve })
    let workersCreated = 0
    const runtime = new TaskRuntime({
      taskManager: manager, getRefreshToken: () => 'refresh-token', onAuthenticationRequired: () => {}, onEvent: () => {},
      onApprovalRequest: () => {}, resolveEmployee: () => employee,
      media: { async prepareRun() { preparing = true; return preparation }, async waitForRun() { assert.fail('Paused setup must not wait for delivery.') }, async stopTask() { finishPreparation(undefined) } },
      createWorker: () => { workersCreated++; return { async run() {}, async abort() {}, async dispose() {} } },
    })
    try {
      await runtime.executeTask(task.id)
      await waitFor(() => preparing)
      await runtime.pauseTask(task.id)
      assert.equal(workersCreated, 0)
      assert.equal((await manager.getTask(task.id))?.status, TaskStatus.PAUSED)
      assert.equal((await manager.getTask(task.id))?.activeRunId, null)
    } finally { finishPreparation(undefined); await runtime.stopAll() }
  })

  it('does not mark a run completed when media delivery fails', async () => {
    const { manager, task, employee } = await fixture()
    let stopped = false
    const runtime = new TaskRuntime({
      taskManager: manager, getRefreshToken: () => 'refresh-token', onAuthenticationRequired: () => {}, onEvent: () => {},
      onApprovalRequest: () => {}, resolveEmployee: () => employee,
      media: { async prepareRun() { return undefined }, async waitForRun() { throw new Error('Image delivery is incomplete.') }, async stopTask() { stopped = true } },
      createWorker: () => ({ async run() {}, async abort() {}, async dispose() {} }),
    })
    await runtime.executeTask(task.id)
    await waitFor(async () => (await manager.getTask(task.id))?.activeRunId === null)
    assert.equal((await manager.getTask(task.id))?.status, TaskStatus.FAILED)
    assert.equal(stopped, true)
    await runtime.stopAll()
  })
})

describe('TaskRuntime video lifecycle', () => {
  async function fixture() {
    const userData = await makeUserDataDir()
    const manager = new TaskManager(userData)
    await manager.initialize()
    await manager.setCurrentUser('member-video', 'enterprise-video')
    const task = await manager.createTask('video', 'create an video', join(userData, 'workspace'), 'employee-video')
    const employee: EmployeeRuntimeConfig = {
      subscriptionId: 'employee-video', modelId: 'model-video', gatewayUrl: 'http://gateway', systemPrompt: 'Trusted video instructions.',
    }
    return { manager, task, employee }
  }

  it('passes the prompt and facade, binds approvals, and waits for delivery before finalizing', async () => {
    const { manager, task, employee } = await fixture()
    const host: VideoHostTools = { names: ['video_get_job'], execute: async () => null }
    let prepared: Parameters<VideoRunPort['prepareRun']>[0] | undefined
    let context: PiTaskWorkerOptions['context'] | undefined
    let waiting = false
    let deliver!: () => void
    const delivery = new Promise<void>(resolve => { deliver = resolve })
    const requests: ToolAuthorizationRequest[] = []
    const runtime = new TaskRuntime({
      taskManager: manager, getRefreshToken: () => 'refresh-token', onAuthenticationRequired: () => {}, onEvent: () => {},
      onApprovalRequest: request => requests.push(request), resolveEmployee: () => employee,
      video: {
        async prepareRun(input) { prepared = input; return host },
        async waitForRun(taskId, runId) { assert.equal(taskId, task.id); assert.equal(runId, context?.runId); waiting = true; await delivery },
        async stopTask() { deliver() },
      },
      createWorker: options => {
        context = options.context
        assert.equal(context.systemPrompt, employee.systemPrompt)
        assert.equal(context.videoTools, host)
        return { async run() {}, async abort() {}, async dispose() {} }
      },
    })
    try {
      await runtime.executeTask(task.id)
      await waitFor(() => waiting)
      assert.equal((await manager.getTask(task.id))?.status, TaskStatus.RUNNING)
      assert.equal(prepared?.employee, employee)
      assert.equal(prepared?.runId, context?.runId)
      const input = { taskId: task.id, runId: context!.runId, subscriptionId: employee.subscriptionId, toolName: 'video_from_video', input: { quote: { amount: '1', currency: 'credits' } } }
      const approved = prepared!.requestApproval(input)
      await waitFor(() => requests.length === 1)
      assert.equal(runtime.respondToApproval({ requestId: requests[0].requestId, approved: true }), true)
      assert.equal(await approved, true)
      const boundRequest = runtime.requestMediaApproval
      const denied = boundRequest(input)
      await waitFor(() => requests.length === 2)
      assert.equal(runtime.respondToApproval({ requestId: requests[1].requestId, approved: false }), true)
      assert.equal(await denied, false)
      deliver()
      await waitFor(async () => (await manager.getTask(task.id))?.activeRunId === null)
      assert.equal((await manager.getTask(task.id))?.status, TaskStatus.COMPLETED)
    } finally { deliver(); await runtime.stopAll() }
  })

  for (const control of ['pause', 'cancel', 'shutdown'] as const) {
    it(`${control} stops local video tracking while delivery is pending`, async () => {
      const { manager, task, employee } = await fixture()
      let waiting = false
      let deliver!: () => void
      const delivery = new Promise<void>(resolve => { deliver = resolve })
      const stopped: string[] = []
      const runtime = new TaskRuntime({
        taskManager: manager, getRefreshToken: () => 'refresh-token', onAuthenticationRequired: () => {}, onEvent: () => {},
        onApprovalRequest: () => {}, resolveEmployee: () => employee,
        video: { async prepareRun() { return undefined }, async waitForRun() { waiting = true; await delivery }, async stopTask(id) { stopped.push(id); deliver() } },
        createWorker: () => ({ async run() {}, async abort() {}, async dispose() {} }),
      })
      try {
        await runtime.executeTask(task.id)
        await waitFor(() => waiting)
        if (control === 'pause') await runtime.pauseTask(task.id)
        else if (control === 'cancel') await runtime.cancelTask(task.id)
        else await runtime.stopAll()
        assert.deepEqual(stopped, [task.id])
        assert.equal((await manager.getTask(task.id))?.status, control === 'shutdown' ? TaskStatus.INTERRUPTED : TaskStatus.PAUSED)
      } finally { deliver(); await runtime.stopAll() }
    })
  }

  it('does not start a worker when pause wins during video preparation', async () => {
    const { manager, task, employee } = await fixture()
    let preparing = false
    let finishPreparation!: (value: VideoHostTools | undefined) => void
    const preparation = new Promise<VideoHostTools | undefined>(resolve => { finishPreparation = resolve })
    let workersCreated = 0
    const runtime = new TaskRuntime({
      taskManager: manager, getRefreshToken: () => 'refresh-token', onAuthenticationRequired: () => {}, onEvent: () => {},
      onApprovalRequest: () => {}, resolveEmployee: () => employee,
      video: { async prepareRun() { preparing = true; return preparation }, async waitForRun() { assert.fail('Paused setup must not wait for delivery.') }, async stopTask() { finishPreparation(undefined) } },
      createWorker: () => { workersCreated++; return { async run() {}, async abort() {}, async dispose() {} } },
    })
    try {
      await runtime.executeTask(task.id)
      await waitFor(() => preparing)
      await runtime.pauseTask(task.id)
      assert.equal(workersCreated, 0)
      assert.equal((await manager.getTask(task.id))?.status, TaskStatus.PAUSED)
      assert.equal((await manager.getTask(task.id))?.activeRunId, null)
    } finally { finishPreparation(undefined); await runtime.stopAll() }
  })

  it('does not mark a run completed when video delivery fails', async () => {
    const { manager, task, employee } = await fixture()
    let stopped = false
    const runtime = new TaskRuntime({
      taskManager: manager, getRefreshToken: () => 'refresh-token', onAuthenticationRequired: () => {}, onEvent: () => {},
      onApprovalRequest: () => {}, resolveEmployee: () => employee,
      video: { async prepareRun() { return undefined }, async waitForRun() { throw new Error('Video delivery is incomplete.') }, async stopTask() { stopped = true } },
      createWorker: () => ({ async run() {}, async abort() {}, async dispose() {} }),
    })
    await runtime.executeTask(task.id)
    await waitFor(async () => (await manager.getTask(task.id))?.activeRunId === null)
    assert.equal((await manager.getTask(task.id))?.status, TaskStatus.FAILED)
    assert.equal(stopped, true)
    await runtime.stopAll()
  })
})

describe('TaskRuntime resource boundaries', () => {
  it('runs tasks for the same employee concurrently in disjoint workspaces', async () => {
    const userData = await makeUserDataDir()
    const manager = new TaskManager(userData)
    await manager.initialize()
    await manager.setCurrentUser('member-a', 'enterprise-a')
    const first = await manager.createTask('first', 'one', join(userData, 'workspace-a'), 'employee-a')
    const second = await manager.createTask('second', 'two', join(userData, 'workspace-b'), 'employee-a')
    const started: string[] = []
    const release: Array<() => void> = []
    const employee: EmployeeRuntimeConfig = { subscriptionId: 'employee-a', modelId: 'model-a', gatewayUrl: 'http://gateway' }
    const runtime = new TaskRuntime({
      taskManager: manager,
      getRefreshToken: () => 'refresh-token',
      onAuthenticationRequired: () => {},
      onEvent: () => {},
      onApprovalRequest: () => {},
      resolveEmployee: id => id === employee.subscriptionId ? employee : null,
      createWorker: options => ({
        async run() {
          started.push(options.context.taskId)
          await new Promise<void>(resolve => release.push(resolve))
        },
        async abort() {},
        async dispose() {},
      }),
    })

    await Promise.all([runtime.executeTask(first.id), runtime.executeTask(second.id)])
    await waitFor(() => started.length === 2)
    assert.deepEqual(new Set(started), new Set([first.id, second.id]))
    release.splice(0).forEach(resolve => resolve())
    await waitFor(async () => {
      const tasks = await manager.getAllTasks()
      return tasks.every(task => task.status === TaskStatus.COMPLETED && task.activeRunId === null)
    })
  })

  it('serializes tasks that overlap the same workspace', async () => {
    const userData = await makeUserDataDir()
    const manager = new TaskManager(userData)
    await manager.initialize()
    await manager.setCurrentUser('member-a', 'enterprise-a')
    const workspace = join(userData, 'shared-workspace')
    const first = await manager.createTask('first', 'one', workspace, 'employee-a')
    const second = await manager.createTask('second', 'two', workspace, 'employee-a')
    const started: string[] = []
    const release: Array<() => void> = []
    const employee: EmployeeRuntimeConfig = { subscriptionId: 'employee-a', modelId: 'model-a', gatewayUrl: 'http://gateway' }
    const runtime = new TaskRuntime({
      taskManager: manager,
      getRefreshToken: () => 'refresh-token',
      onAuthenticationRequired: () => {},
      onEvent: () => {},
      onApprovalRequest: () => {},
      resolveEmployee: id => id === employee.subscriptionId ? employee : null,
      createWorker: options => ({
        async run() {
          started.push(options.context.taskId)
          await new Promise<void>(resolve => release.push(resolve))
        },
        async abort() {},
        async dispose() {},
      }),
    })

    await Promise.all([runtime.executeTask(first.id), runtime.executeTask(second.id)])
    await waitFor(() => started.length === 1)
    await new Promise(resolve => setTimeout(resolve, 40))
    assert.equal(started.length, 1)
    release.splice(0).forEach(resolve => resolve())
    await waitFor(() => started.length === 2)
    release.splice(0).forEach(resolve => resolve())
    await waitFor(async () => (await manager.getAllTasks()).every(task => task.status === TaskStatus.COMPLETED && task.activeRunId === null))
  })
})

describe('SEP platform-shaped conversation fixture', () => {
  it('runs a conversation with the platform subscription/model identifiers and real skill context', async () => {
    const userData = await makeUserDataDir()
    const manager = new TaskManager(userData)
    const runStore = new TaskRunStore(userData)
    await manager.initialize()
    await manager.setCurrentUser('member-1', 'enterprise-1')
    const task = await manager.createTask('????', '???????', undefined, SEP_TEST_SUBSCRIPTION.subscriptionId)
    const seen: { subscriptionId: string; modelId: string; skillPaths?: string[] }[] = []
    const runtime = new TaskRuntime({
      taskManager: manager,
      taskRunStore: runStore,
      getRefreshToken: () => 'refresh-token',
      onAuthenticationRequired: () => {},
      onEvent: () => {},
      onApprovalRequest: () => {},
      resolveEmployee: id => id === SEP_TEST_SUBSCRIPTION.subscriptionId
        ? { subscriptionId: SEP_TEST_SUBSCRIPTION.subscriptionId, modelId: SEP_TEST_SUBSCRIPTION.allowedModels[0]!, gatewayUrl: 'https://longdaosep.cn/api/gateway/v1', additionalSkillPaths: ['/skills/orders/v1.0.0'] }
        : null,
      createWorker: options => ({
        async run() {
          seen.push({ subscriptionId: options.context.subscriptionId, modelId: options.context.modelId, skillPaths: options.context.additionalSkillPaths })
          await options.onEvent({ taskId: options.context.taskId, runId: options.context.runId, subscriptionId: options.context.subscriptionId, sequence: 1, type: 'text_delta', occurredAt: Date.now(), data: { text: `??${SEP_TEST_SUBSCRIPTION.name}????` } })
          await options.onEvent({ taskId: options.context.taskId, runId: options.context.runId, subscriptionId: options.context.subscriptionId, sequence: 2, type: 'agent_end', occurredAt: Date.now(), data: {} })
        },
        async abort() {},
        async dispose() {},
      }),
    })
    await runtime.executeTask(task.id, { conversation: true })
    await waitFor(async () => (await manager.getTask(task.id))?.activeRunId === null)
    assert.deepEqual(seen, [{ subscriptionId: 'sub-1', modelId: 'sep-employee', skillPaths: ['/skills/orders/v1.0.0'] }])
    assert.equal((await manager.getTask(task.id))?.status, TaskStatus.COMPLETED)
  })
})

describe('conversation task lifecycle', () => {
  for (const control of ['pause', 'cancel', 'shutdown'] as const) {
    it(`does not start a worker when knowledge retrieval resolves after ${control}`, async () => {
      const userData = await makeUserDataDir()
      const manager = new TaskManager(userData)
      await manager.initialize()
      await manager.setCurrentUser('member-a', 'enterprise-a')
      const task = await manager.createTask('chat', 'question', undefined, 'employee-a')
      let signal: AbortSignal | undefined
      let resolveSearch!: () => void
      const search = new Promise<void>(resolve => { resolveSearch = resolve })
      let started = false
      const runtime = new TaskRuntime({
        taskManager: manager, taskRunStore: new TaskRunStore(userData),
        getRefreshToken: () => 'fixture', onAuthenticationRequired: () => {}, onEvent: () => {}, onApprovalRequest: () => {},
        resolveEmployee: subscriptionId => ({ subscriptionId, modelId: 'model-a', gatewayUrl: 'http://gateway' }),
        knowledgeSearch: async (_query, searchSignal) => {
          signal = searchSignal
          await search
          return { status: 'NO_MATCH', actualStrategy: 'hybrid', degraded: false, partial: false, durationMs: 1, results: [] }
        },
        createWorker: () => ({
          async run() { started = true }, async abort() {}, async dispose() {},
        }),
      })
      await runtime.executeTask(task.id, { conversation: true })
      await waitFor(() => signal !== undefined)
      const stopping = control === 'pause' ? runtime.pauseTask(task.id)
        : control === 'cancel' ? runtime.cancelTask(task.id) : runtime.stopAll()
      await waitFor(() => signal?.aborted === true)
      resolveSearch()
      await stopping
      assert.equal(started, false, 'a late search response must not start the cancelled worker')
      const settled = await manager.getTask(task.id)
      assert.equal(settled?.activeRunId, null)
      assert.equal(settled?.status, control === 'shutdown' ? TaskStatus.INTERRUPTED : TaskStatus.PAUSED)
    })
  }

  it('bounds retrieval queries without truncating a long user message sent to the worker', async () => {
    const userData = await makeUserDataDir()
    const manager = new TaskManager(userData)
    await manager.initialize()
    await manager.setCurrentUser('member-a', 'enterprise-a')
    const prompt = 'a'.repeat(1_500)
    const task = await manager.createTask('chat', prompt, undefined, 'employee-a')
    let query = ''
    let workerPrompt = ''
    const runtime = new TaskRuntime({
      taskManager: manager, taskRunStore: new TaskRunStore(userData),
      getRefreshToken: () => 'fixture', onAuthenticationRequired: () => {}, onEvent: () => {}, onApprovalRequest: () => {},
      resolveEmployee: subscriptionId => ({ subscriptionId, modelId: 'model-a', gatewayUrl: 'http://gateway' }),
      knowledgeSearch: async value => {
        query = value
        assert.ok(value.length <= 1_000)
        return { status: 'NO_MATCH', actualStrategy: 'hybrid', degraded: false, partial: false, durationMs: 1, results: [] }
      },
      createWorker: () => ({
        async run(value) { workerPrompt = value }, async abort() {}, async dispose() {},
      }),
    })
    await runtime.executeTask(task.id, { conversation: true })
    await waitFor(async () => (await manager.getTask(task.id))?.activeRunId === null)
    assert.equal(query, prompt.slice(0, 1_000))
    assert.ok(workerPrompt.startsWith(prompt))
    assert.match(workerPrompt, /没有检索到匹配资料/)
  })

  it('keeps a conversation task open and reuses its shared session file across turns', async () => {
    const userData = await makeUserDataDir()
    const manager = new TaskManager(userData)
    const runStore = new TaskRunStore(userData)
    await manager.initialize()
    await manager.setCurrentUser('member-a', 'enterprise-a')
    const task = await manager.createTask('chat', 'first', undefined, 'employee-a')
    const employee: EmployeeRuntimeConfig = { subscriptionId: 'employee-a', modelId: 'model-a', gatewayUrl: 'http://gateway' }
    const sessionFiles: string[] = []
    const knowledgeQueries: string[] = []
    let count = 0
    const runtime = new TaskRuntime({
      taskManager: manager,
      taskRunStore: runStore,
      getRefreshToken: () => 'refresh-token',
      onAuthenticationRequired: () => {},
      onEvent: () => {},
      onApprovalRequest: () => {},
      knowledgeSearch: async query => {
        knowledgeQueries.push(query)
        return { status: 'MATCHED', actualStrategy: 'hybrid', degraded: false, partial: false, durationMs: 1,
          results: [{ sourceId: 'source', knowledgeBaseId: 'kb', knowledgeBaseName: 'Internal', documentId: 'doc',
            documentName: 'Handbook', versionId: 'v1', content: `Reference for ${query}`, location: {} }] }
      },
      resolveEmployee: id => id === employee.subscriptionId ? employee : null,
      createWorker: options => ({
        async run(prompt) {
          count++
          assert.match(prompt, /Reference for/)
          const file = join(options.context.sessionDir, 'shared-session.jsonl')
          await mkdir(options.context.sessionDir, { recursive: true })
          await writeFile(file, '{}\n', { encoding: 'utf8' })
          sessionFiles.push(options.context.resumeSessionFile ?? file)
          await options.onSessionCreated?.({ sessionId: 'shared-session', sessionFile: file })
          await options.onEvent({ taskId: options.context.taskId, runId: options.context.runId, subscriptionId: options.context.subscriptionId, sequence: 1, type: 'text_delta', occurredAt: Date.now(), data: { text: `answer-${count}` } })
        },
        async abort() {},
        async dispose() {},
      }),
    })

    await runtime.executeTask(task.id, { conversation: true })
    await waitFor(async () => (await manager.getTask(task.id))?.activeRunId === null)
    assert.equal((await manager.getTask(task.id))?.status, TaskStatus.COMPLETED)
    await runtime.continueConversation(task.id, 'second')
    await waitFor(async () => (await manager.getTask(task.id))?.activeRunId === null)
    assert.equal(count, 2)
    assert.deepEqual(knowledgeQueries, ['first', 'second'])
    assert.equal(sessionFiles[1], sessionFiles[0])
    const scope = { memberId: 'member-a', enterpriseId: 'enterprise-a' }
    const messages = await projectTaskMessages({ listRuns: id => runStore.list(scope, id), getTimeline: (id, runId) => runStore.events.getTimeline(scope, id, runId) }, task.id, 'legacy')
    assert.deepEqual(messages.map(message => message.content), ['first', 'answer-1', 'second', 'answer-2'])
  })

  it('preserves the selected model and permission policy on first and subsequent conversation turns', async () => {
    const userData = await makeUserDataDir()
    const manager = new TaskManager(userData)
    await manager.initialize()
    await manager.setCurrentUser('member-a', 'enterprise-a')
    const task = await manager.createTask('configured chat', 'first', undefined, 'employee-a')
    const plan: WorkPlan = {
      schemaVersion: 1, id: task.id, owner: { memberId: 'member-a', enterpriseId: 'enterprise-a' },
      sourceDraftId: 'draft', sourceDraftRevision: 1, planHash: 'hash', createdAt: Date.now(),
      mode: 'conversation', title: 'configured chat', goal: 'first', confirmedInputs: [],
      conversation: { participants: [{ subscriptionId: 'employee-a', modelId: 'selected' }], activeSubscriptionId: 'employee-a' },
      nodes: [], workspace: { mode: 'shared', path: null },
      permissions: effectivePermissionPolicy({ preset: 'workspace-edit', approvalMode: 'auto-approve' }),
    }
    const contexts: PiTaskWorkerOptions['context'][] = []
    const employeeProfile = {
      name: 'Frontend employee', position: 'Frontend Developer',
      functionalCategory: 'Engineering', description: 'Build web interfaces',
    }
    const runtime = new TaskRuntime({
      taskManager: manager, taskRunStore: new TaskRunStore(userData),
      workPlanStore: { get: async () => plan, save: async () => {} },
      getRefreshToken: () => 'fixture', onAuthenticationRequired: () => {}, onEvent: () => {}, onApprovalRequest: () => {},
      resolveEmployee: subscriptionId => ({ subscriptionId, modelId: 'default', gatewayUrl: 'http://gateway' }),
      authorizeEmployee: async (subscriptionId, modelId) => ({ subscriptionId, modelId: modelId ?? 'wrong-default', gatewayUrl: 'http://gateway', employeeProfile }),
      createWorker: options => ({
        async run() {
          contexts.push(options.context)
          await mkdir(options.context.sessionDir, { recursive: true })
          const sessionFile = join(options.context.sessionDir, 'session.jsonl')
          await writeFile(sessionFile, '{}\n', 'utf8')
          await options.onSessionCreated?.({ sessionId: 'session', sessionFile })
        },
        async abort() {}, async dispose() {},
      }),
    })
    await runtime.executeTask(task.id, { conversation: true })
    await waitFor(async () => (await manager.getTask(task.id))?.activeRunId === null)
    await runtime.continueConversation(task.id, 'second')
    await waitFor(async () => (await manager.getTask(task.id))?.activeRunId === null)
    assert.equal(contexts.length, 2)
    for (const context of contexts) {
      assert.deepEqual(context.employeeProfile, employeeProfile)
      assert.equal(context.modelId, 'selected')
      assert.equal(context.toolPolicy?.preset, 'workspace-edit')
      assert.equal(context.toolPolicy?.approvalMode, 'auto-approve')
      assert.ok(context.toolPolicy?.allowedTools.includes('write'))
      assert.ok(!context.toolPolicy?.allowedTools.includes('bash'))
    }
  })

  it('selectively pushes renderer events while persisting the complete run timeline', async () => {
    const userData = await makeUserDataDir()
    const manager = new TaskManager(userData)
    const runStore = new TaskRunStore(userData)
    await manager.initialize()
    await manager.setCurrentUser('member-a', 'enterprise-a')
    const task = await manager.createTask('chat', 'first', undefined, 'employee-a')
    const employee: EmployeeRuntimeConfig = { subscriptionId: 'employee-a', modelId: 'model-a', gatewayUrl: 'http://gateway' }
    const pushed: string[] = []
    const runtime = new TaskRuntime({
      taskManager: manager,
      taskRunStore: runStore,
      getRefreshToken: () => 'refresh-token',
      onAuthenticationRequired: () => {},
      onEvent: event => pushed.push(event.type),
      onApprovalRequest: () => {},
      resolveEmployee: id => id === employee.subscriptionId ? employee : null,
      createWorker: options => ({
        async run() {
          const base = { taskId: options.context.taskId, runId: options.context.runId, subscriptionId: options.context.subscriptionId, occurredAt: Date.now() }
          await options.onEvent({ ...base, sequence: 1, type: 'agent_start', data: {} })
          await options.onEvent({ ...base, sequence: 2, type: 'text_delta', data: { text: 'answer' } })
          await options.onEvent({ ...base, sequence: 3, type: 'tool_execution_start', data: { toolId: 'tool-1', toolName: 'write', input: { path: 'secret.txt' } } })
          await options.onEvent({ ...base, sequence: 4, type: 'tool_execution_end', data: { toolId: 'tool-1', toolName: 'write', success: true } })
          await options.onEvent({ ...base, sequence: 5, type: 'tool_execution_start', data: { toolId: 'tool-2', toolName: 'edit', input: { path: 'failed.txt' } } })
          await options.onEvent({ ...base, sequence: 6, type: 'tool_execution_end', data: { toolId: 'tool-2', toolName: 'edit', success: false } })
          await options.onEvent({ ...base, sequence: 7, type: 'tool_execution_start', data: { toolId: 'tool-3', toolName: 'edit', input: { path: 'updated.md' } } })
          await options.onEvent({ ...base, sequence: 8, type: 'tool_execution_end', data: { toolId: 'tool-3', toolName: 'edit', success: true } })
          await options.onEvent({ ...base, sequence: 9, type: 'agent_settled', data: {} })
        },
        async abort() {},
        async dispose() {},
      }),
    })

    await runtime.executeTask(task.id, { conversation: true })
    await waitFor(async () => (await manager.getTask(task.id))?.activeRunId === null)
    assert.deepEqual((await manager.getTask(task.id))?.files, ['secret.txt', 'updated.md'])
    assert.deepEqual(pushed, ['text_delta', 'tool_execution_start', 'tool_execution_end', 'tool_execution_start', 'tool_execution_end', 'tool_execution_start', 'tool_execution_end'])
    const runs = await runStore.list({ memberId: 'member-a', enterpriseId: 'enterprise-a' }, task.id)
    const timeline = await runStore.events.getTimeline({ memberId: 'member-a', enterpriseId: 'enterprise-a' }, task.id, runs[0]!.id)
    assert.deepEqual(timeline.map(event => event.type), ['agent_start', 'text_delta', 'tool_execution_start', 'tool_execution_end', 'tool_execution_start', 'tool_execution_end', 'tool_execution_start', 'tool_execution_end', 'agent_settled', 'run_completed'])
  })

  it('cancels an active conversation run while preserving its timeline', async () => {
    const userData = await makeUserDataDir()
    const manager = new TaskManager(userData)
    const runStore = new TaskRunStore(userData)
    await manager.initialize()
    await manager.setCurrentUser('member-a', 'enterprise-a')
    const task = await manager.createTask('chat', 'first', undefined, 'employee-a')
    const employee: EmployeeRuntimeConfig = { subscriptionId: 'employee-a', modelId: 'model-a', gatewayUrl: 'http://gateway' }
    let release!: () => void
    const started = new Promise<void>(resolve => { release = resolve })
    const runtime = new TaskRuntime({
      taskManager: manager,
      taskRunStore: runStore,
      getRefreshToken: () => 'refresh-token',
      onAuthenticationRequired: () => {},
      onEvent: () => {},
      onApprovalRequest: () => {},
      resolveEmployee: id => id === employee.subscriptionId ? employee : null,
      createWorker: options => ({
        async run() {
          await options.onEvent({ taskId: options.context.taskId, runId: options.context.runId, subscriptionId: options.context.subscriptionId, sequence: 1, type: 'tool_execution_start', occurredAt: Date.now(), data: { toolId: 'tool-1', toolName: 'write' } })
          await started
        },
        async abort() { release() },
        async dispose() {},
      }),
    })

    await runtime.executeTask(task.id, { conversation: true })
    await waitFor(async () => (await manager.getTask(task.id))?.status === TaskStatus.RUNNING)
    const service = new TaskService({
      scope: { currentScope: () => manager.getCurrentUserScope() },
      taskManager: manager,
      taskRunStore: runStore,
      taskMetadataStore: new TaskMetadataStore(userData),
      get employees(): never { throw new Error('Stopping/deleting must not access the employee directory') },
      execution: async () => runtime,
    })
    await assert.rejects(service.delete(task.id), /任务正在执行/)
    await service.cancel(task.id, '资料需要修正')
    const settled = await manager.getTask(task.id)
    assert.equal(settled?.status, TaskStatus.PAUSED)
    assert.equal(settled?.error, '资料需要修正')
    assert.equal(settled?.activeRunId, null)
    const runs = await runStore.list({ memberId: 'member-a', enterpriseId: 'enterprise-a' }, task.id)
    assert.equal(runs[0]?.outcome, 'cancelled')
    const timeline = await runStore.events.getTimeline({ memberId: 'member-a', enterpriseId: 'enterprise-a' }, task.id, runs[0]!.id)
    assert.ok(timeline.some(event => event.type === 'SIDE_EFFECT_UNKNOWN'))
    await service.delete(task.id)
    assert.equal(await manager.getTask(task.id), null)
    assert.deepEqual(await service.list(), [])
    const reloaded = new TaskManager(userData)
    await reloaded.initialize()
    await reloaded.setCurrentUser('member-a', 'enterprise-a')
    assert.equal(await reloaded.getTask(task.id), null, 'deletion survives application restart')
  })
})

// Public surface regression coverage.
const PUBLIC_SIGNATURES = [
  'async executeTask(taskId: string, options: { conversation?: boolean } = {}): Promise<void> {',
  'async continueConversation(',
  'async switchConversationEmployee(taskId: string, subscriptionId: string): Promise<void> {',
  'async retryTask(taskId: string, options: { conversation?: boolean; nodeId?: string } = {}): Promise<void> {',
  'async pauseTask(taskId: string): Promise<void> {',
  'async cancelTask(taskId: string, reason?: string): Promise<void> {',
  'async stopAll(): Promise<void> {',
  'async stopArrangement(taskId: string, reason?: string): Promise<void> {',
  'respondToApproval(response: { requestId: string; approved: boolean; reason?: string }): boolean {',
]

describe('TaskRuntime public surface', () => {
  it('keeps the documented public methods, with unchanged signatures', async () => {
    const source = await readFile(join(process.cwd(), 'electron', 'runtime', 'task-runtime.ts'), 'utf8')

    for (const signature of PUBLIC_SIGNATURES) {
      assert.ok(source.includes(`  ${signature}`), `missing public method: ${signature}`)
    }

    // Public members are intentionally limited to the documented runtime API.
    const declared = source
      .split(/\r?\n/)
      .flatMap(line => /^ {2}(?:async )?([A-Za-z_$][\w$]*)\(/.exec(line)?.slice(1, 2) ?? [])
      .filter(name => name !== 'constructor')
    assert.deepEqual(
      declared.sort(),
      [
        'cancelTask', 'continueConversation', 'executeTask', 'pauseTask',
        'respondToApproval', 'retryTask', 'stopAll', 'stopArrangement', 'switchConversationEmployee',
      ],
      'public method set changed: runtime must expose only the documented methods',
    )
  })

  it('delegates to the five collaborators instead of owning their state', async () => {
    const source = await readFile(join(process.cwd(), 'electron', 'runtime', 'task-runtime.ts'), 'utf8')

    for (const collaborator of ['RunQueue', 'WorkerRegistry', 'EventPipeline', 'WorkspaceLockManager', 'ToolApprovals']) {
      assert.ok(source.includes(collaborator), `runtime must delegate to ${collaborator}`)
    }

    // These states moved to collaborators and must not be reintroduced here.
    for (const field of ['this.queue', 'this.activeByTask', 'this.eventChains', 'this.responseBuffers', 'this.inFlightSideEffects']) {
      assert.ok(!source.includes(field), `${field} must stay outside the runtime`)
    }
  })
})
