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
        ? { subscriptionId: SEP_TEST_SUBSCRIPTION.subscriptionId, modelId: SEP_TEST_SUBSCRIPTION.allowedModels[0]!, gatewayUrl: 'https://sep-dev.longdaoSEP.cn/api/gateway/v1', additionalSkillPaths: ['/skills/orders/v1.0.0'] }
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
  it('keeps a conversation task open and reuses its shared session file across turns', async () => {
    const userData = await makeUserDataDir()
    const manager = new TaskManager(userData)
    const runStore = new TaskRunStore(userData)
    await manager.initialize()
    await manager.setCurrentUser('member-a', 'enterprise-a')
    const task = await manager.createTask('chat', 'first', undefined, 'employee-a')
    const employee: EmployeeRuntimeConfig = { subscriptionId: 'employee-a', modelId: 'model-a', gatewayUrl: 'http://gateway' }
    const sessionFiles: string[] = []
    let count = 0
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
          count++
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
    const runtime = new TaskRuntime({
      taskManager: manager, taskRunStore: new TaskRunStore(userData),
      workPlanStore: { get: async () => plan, save: async () => {} },
      getRefreshToken: () => 'fixture', onAuthenticationRequired: () => {}, onEvent: () => {}, onApprovalRequest: () => {},
      resolveEmployee: subscriptionId => ({ subscriptionId, modelId: 'default', gatewayUrl: 'http://gateway' }),
      authorizeEmployee: async (subscriptionId, modelId) => ({ subscriptionId, modelId: modelId ?? 'wrong-default', gatewayUrl: 'http://gateway' }),
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
      assert.equal(context.modelId, 'selected')
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
          await options.onEvent({ ...base, sequence: 5, type: 'agent_settled', data: {} })
        },
        async abort() {},
        async dispose() {},
      }),
    })

    await runtime.executeTask(task.id, { conversation: true })
    await waitFor(async () => (await manager.getTask(task.id))?.activeRunId === null)
    assert.deepEqual(pushed, ['text_delta', 'tool_execution_start', 'tool_execution_end'])
    const runs = await runStore.list({ memberId: 'member-a', enterpriseId: 'enterprise-a' }, task.id)
    const timeline = await runStore.events.getTimeline({ memberId: 'member-a', enterpriseId: 'enterprise-a' }, task.id, runs[0]!.id)
    assert.deepEqual(timeline.map(event => event.type), ['agent_start', 'text_delta', 'tool_execution_start', 'tool_execution_end', 'agent_settled', 'run_completed'])
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
