import { after, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { TaskRunStore } from '../data/task-run-store'
import { ArrangementCheckpointStore } from '../data/arrangement-checkpoint-store'
import { TaskManager } from './task-manager'
import { TaskRuntime } from './task-runtime'
import { TaskStatus } from '../../src/shared/types'
import type { WorkPlan } from '../domain/arrangement-plan'
import { ArrangementExecutor } from './arrangement-executor'

const scope = { memberId: 'resume-member', enterpriseId: 'resume-enterprise' }
const directories: string[] = []
after(async () => { await Promise.all(directories.map(dir => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }))) })

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'sep-arrangement-resume-'))
  directories.push(root)
  const runs = new TaskRunStore(root)
  const manager = new TaskManager(root, null, undefined, runs)
  await manager.initialize()
  await manager.setCurrentUser(scope.memberId, scope.enterpriseId)
  const task = await manager.createTask('resume', 'goal', undefined, 'employee')
  const plan: WorkPlan = {
    id: task.id, owner: scope, schemaVersion: 1, sourceDraftId: 'draft', sourceDraftRevision: 1,
    mode: 'manual', title: 'resume', goal: 'original goal', conversation: null,
    nodes: ['a', 'b'].map((id, index) => ({ id, subscriptionId: 'employee', modelId: id, title: id,
      instruction: 'do '+id, expectedOutput: 'output', dependsOn: index ? ['a'] : [], skillIds: [], requiresUserConfirmation: false })),
    workspace: { mode: 'shared', path: task.workDir },
    permissions: { preset: 'read-only', allowedTools: ['read'], allowedPaths: [], deniedPaths: [], requireApprovalFor: [], commandPolicy: 'disabled' },
    confirmedInputs: [], planHash: 'hash', createdAt: Date.now(),
  }
  return { root, runs, manager, task, plan, checkpoints: new ArrangementCheckpointStore(root) }
}
async function fsWriteCorrupt(file: string) { await writeFile(file, '{truncated json') }
async function waitFor(predicate: () => Promise<boolean>) {
  const until = Date.now() + 4000
  while (Date.now() < until) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)) }
  throw new Error('state did not settle')
}

async function crashedFixture() {
  const f = await fixture()
  await f.runs.create(scope, { taskId: f.task.id, runId: 'parent-run', subscriptionId: 'employee',
    modelId: 'a', runtimeKey: 'employee:a', workspaceDir: f.task.workDir!, prompt: f.plan.goal })
  await f.manager.admitTask(f.task.id, 'parent-run')
  await f.manager.updateTaskStatus(f.task.id, TaskStatus.RUNNING)
  const nodeRun = await f.runs.create(scope, { taskId: f.task.id, runId: 'node-b-run', subscriptionId: 'employee',
    modelId: 'b', runtimeKey: 'employee:b', workspaceDir: f.task.workDir!, prompt: 'do b', arrangementNodeId: 'b' })
  const paths = f.runs.getPaths(scope, f.task.id, nodeRun.id)
  await mkdir(paths.sessionDir, { recursive: true })
  const sessionFile = join(paths.sessionDir, 'session.jsonl')
  await writeFile(sessionFile, JSON.stringify({ type: 'session', id: 'crashed-b', version: 3 })+'\n')
  await f.runs.setSession(scope, f.task.id, nodeRun.id, { sessionId: 'crashed-b', sessionFile })
  await f.checkpoints.save(scope, { version: 1, taskId: f.task.id, owner: scope, planHash: f.plan.planHash,
    activeRunId: 'parent-run', updatedAt: Date.now(), state: { status: 'running', failureNodeIds: [], interruptionReason: null,
      nodes: [{ nodeId: 'a', status: 'completed', attempt: 1, error: null, output: 'A completed' },
        { nodeId: 'b', status: 'running', attempt: 1, sessionRunId: nodeRun.id, error: null, output: null }] } })
  return { ...f, sessionFile }
}

it('recovers a crashed arrangement on startup and resumes only its unfinished node with the saved session', async () => {
  const f = await crashedFixture()
  const manager = new TaskManager(f.root)
  await manager.setCurrentUser(scope.memberId, scope.enterpriseId)
  assert.equal((await manager.getTask(f.task.id))!.status, TaskStatus.INTERRUPTED)
  assert.equal((await manager.getTask(f.task.id))!.activeRunId, null)
  const recovered = (await f.checkpoints.get(scope, f.task.id))!
  assert.equal(recovered.activeRunId, null)
  assert.equal(recovered.state.status, 'interrupted')
  assert.equal(recovered.state.interruptionReason, 'client-crash')
  assert.deepEqual(recovered.state.nodes.map(node => node.status), ['completed', 'interrupted'])
  assert.equal(recovered.state.nodes[1]!.sessionRunId, 'node-b-run')
  assert.equal((await f.runs.get(scope, f.task.id, 'node-b-run'))!.outcome, 'interrupted')
  const attempts: string[] = []
  const runtime = new TaskRuntime({ taskManager: manager, taskRunStore: f.runs,
    workPlanStore: { async get() { return f.plan }, async save() {} }, arrangementCheckpointStore: f.checkpoints,
    getRefreshToken: () => 'mock', onAuthenticationRequired() {}, onEvent() {}, onApprovalRequest() {},
    resolveEmployee: () => ({ subscriptionId: 'employee', modelId: 'a', gatewayUrl: 'http://invalid' }),
    authorizeEmployee: async (_subscriptionId, modelId) => ({ subscriptionId: 'employee', modelId: modelId ?? 'a', gatewayUrl: 'http://invalid' }),
    createWorker: options => ({ async run() {
      attempts.push(options.context.modelId)
      assert.equal(options.context.resumeSessionFile, f.sessionFile)
      await options.onSessionCreated?.({ sessionId: 'crashed-b', sessionFile: f.sessionFile })
    }, async abort() {}, async dispose() {} }),
  })
  await assert.rejects(runtime.executeTask(f.task.id), /Resume it explicitly/)
  await runtime.retryTask(f.task.id)
  await waitFor(async () => (await manager.getTask(f.task.id))?.status === TaskStatus.COMPLETED)
  assert.deepEqual(attempts, ['b'])
  assert.equal((await f.checkpoints.get(scope, f.task.id))!.state.nodes[0]!.output, 'A completed')
})

for (const nodeStatus of ['ready', 'running'] as const) {
  it(`recovers a failed task with an inactive running checkpoint and a ${nodeStatus} node`, async () => {
    const f = await crashedFixture()
    await f.runs.finish(scope, f.task.id, 'parent-run', 'failed', 'EPERM')
    await f.runs.finish(scope, f.task.id, 'node-b-run', 'failed', 'previous model failure')
    await f.manager.settleTaskRun(f.task.id, 'parent-run', TaskStatus.FAILED, 'EPERM')
    const checkpoint = (await f.checkpoints.get(scope, f.task.id))!
    checkpoint.activeRunId = null
    checkpoint.state.nodes[1]!.status = nodeStatus
    await f.checkpoints.save(scope, checkpoint)
    const attempts: string[] = []
    const runtime = new TaskRuntime({ taskManager: f.manager, taskRunStore: f.runs,
      workPlanStore: { async get() { return f.plan }, async save() {} }, arrangementCheckpointStore: f.checkpoints,
      getRefreshToken: () => 'mock', onAuthenticationRequired() {}, onEvent() {}, onApprovalRequest() {},
      resolveEmployee: () => ({ subscriptionId: 'employee', modelId: 'a', gatewayUrl: 'http://invalid' }),
      authorizeEmployee: async (_id, modelId) => ({ subscriptionId: 'employee', modelId: modelId ?? 'a', gatewayUrl: 'http://invalid' }),
      createWorker: options => ({ async run() {
        attempts.push(options.context.modelId)
        assert.equal(options.context.resumeSessionFile, f.sessionFile)
        await options.onSessionCreated?.({ sessionId: 'crashed-b', sessionFile: f.sessionFile })
      }, async abort() {}, async dispose() {} }),
    })
    await runtime.retryTask(f.task.id)
    await waitFor(async () => (await f.manager.getTask(f.task.id))?.status === TaskStatus.COMPLETED)
    assert.deepEqual(attempts, ['b'])
    assert.equal((await f.checkpoints.get(scope, f.task.id))!.state.nodes[0]!.output, 'A completed')
  })
}

it('marks an arrangement interrupted after its checkpoint write fails outside a worker', async () => {
  const f = await fixture()
  let rejected = false
  const runtime = new TaskRuntime({ taskManager: f.manager, taskRunStore: f.runs,
    workPlanStore: { async get() { return f.plan }, async save() {} },
    arrangementCheckpointStore: {
      get: (owner, taskId) => f.checkpoints.get(owner, taskId),
      async save(owner, checkpoint) {
        if (!rejected && checkpoint.state.nodes.some(node => node.status === 'running')) {
          rejected = true
          throw Object.assign(new Error('checkpoint locked'), { code: 'EPERM' })
        }
        await f.checkpoints.save(owner, checkpoint)
      },
    },
    getRefreshToken: () => 'mock', onAuthenticationRequired() {}, onEvent() {}, onApprovalRequest() {},
    resolveEmployee: () => ({ subscriptionId: 'employee', modelId: 'a', gatewayUrl: 'http://invalid' }),
    authorizeEmployee: async () => ({ subscriptionId: 'employee', modelId: 'a', gatewayUrl: 'http://invalid' }),
    createWorker: () => { throw new Error('worker must not start before checkpoint is saved') },
  })
  await runtime.executeTask(f.task.id)
  await waitFor(async () => (await f.manager.getTask(f.task.id))?.status === TaskStatus.FAILED)
  const checkpoint = (await f.checkpoints.get(scope, f.task.id))!
  assert.equal(checkpoint.activeRunId, null)
  assert.equal(checkpoint.state.status, 'interrupted')
  assert.equal(checkpoint.state.interruptionReason, 'runtime-error')
})

it('blocks admission when checkpoint recovery fails and repairs it on the next recovery attempt', async () => {
  const f = await crashedFixture()
  const original = (await f.checkpoints.get(scope, f.task.id))!
  let rejectSave = true
  const manager = new TaskManager(f.root, null, undefined, f.runs, {
    get: (owner, taskId) => f.checkpoints.get(owner, taskId),
    save: async (owner, checkpoint) => {
      if (rejectSave) throw new Error('checkpoint disk unavailable')
      await f.checkpoints.save(owner, checkpoint)
    },
  })
  await manager.setCurrentUser(scope.memberId, scope.enterpriseId)
  assert.equal(manager.isPersistenceDegraded(), true)
  assert.deepEqual(await f.checkpoints.get(scope, f.task.id), original)
  await assert.rejects(manager.admitTask(f.task.id, 'new-run'), /needs recovery/)
  rejectSave = false
  await manager.recoverPersistence()
  assert.equal(manager.isPersistenceDegraded(), false)
  assert.equal((await f.checkpoints.get(scope, f.task.id))!.state.status, 'interrupted')
})

it('does not overwrite a checkpoint that belongs to another parent run', async () => {
  const f = await crashedFixture()
  const checkpoint = (await f.checkpoints.get(scope, f.task.id))!
  checkpoint.activeRunId = 'another-parent'
  await f.checkpoints.save(scope, checkpoint)
  const manager = new TaskManager(f.root)
  await manager.setCurrentUser(scope.memberId, scope.enterpriseId)
  assert.equal(manager.isPersistenceDegraded(), true)
  assert.deepEqual(await f.checkpoints.get(scope, f.task.id), checkpoint)
})

for (const status of ['completed', 'stopped'] as const) {
  it(`settles a ${status} checkpoint saved before the task finished on startup`, async () => {
    const f = await crashedFixture()
    const checkpoint = (await f.checkpoints.get(scope, f.task.id))!
    checkpoint.state.status = status
    checkpoint.state.nodes[1]!.status = status
    await f.checkpoints.save(scope, checkpoint)
    const manager = new TaskManager(f.root)
    await manager.setCurrentUser(scope.memberId, scope.enterpriseId)
    const task = (await manager.getTask(f.task.id))!
    assert.equal(task.status, status === 'completed' ? TaskStatus.COMPLETED : TaskStatus.PAUSED)
    assert.equal(task.activeRunId, null)
    assert.equal(task.completedAt, status === 'completed' ? checkpoint.updatedAt : null)
    assert.equal((await f.runs.get(scope, f.task.id, 'parent-run'))!.outcome, status)
    assert.equal((await f.checkpoints.get(scope, f.task.id))!.state.status, status)
    assert.equal((await f.checkpoints.get(scope, f.task.id))!.activeRunId, null)
    await manager.recoverPersistence()
    assert.equal((await manager.getTask(f.task.id))!.status, task.status)
    assert.equal(manager.isPersistenceDegraded(), false)
  })
}

it('interrupts orphaned running nodes instead of spinning with no active workers', async () => {
  const f = await crashedFixture()
  const checkpoint = (await f.checkpoints.get(scope, f.task.id))!
  const executor = new ArrangementExecutor({ workspaceRoot: f.task.workDir!, scope, checkpointStore: f.checkpoints,
    taskManager: f.manager, taskRunStore: f.runs, arrangementSubscriptionId: 'employee',
    authorizeEmployee: async () => { throw new Error('must not authorize') },
    getRefreshToken: () => 'mock', onAuthenticationRequired() {}, onEvent: async () => {},
    onApprovalRequest: async () => false, createWorker: () => { throw new Error('must not create a worker') },
  })
  const result = await executor.execute(f.plan, f.task.id, 'new-run', checkpoint.state)
  assert.equal(result.status, 'interrupted')
  assert.equal(result.state.interruptionReason, 'runtime-error')
  assert.deepEqual(result.state.nodes.map(node => node.status), ['completed', 'interrupted'])
})

for (const scenario of ['resume', 'legacy', 'missing', 'corrupt', 'foreign-session', 'uncertain-side-effect', 'admission-failed', 'queue-failed'] as const) {
  it('preserves serial node progress when '+scenario, async () => {
    const f = await fixture()
    const attempts: string[] = []
    const resumed: Array<string | undefined> = []
    let savedSession: string | undefined
    let rejectAuthorization = false
    const runtime = new TaskRuntime({ taskManager: f.manager, taskRunStore: f.runs,
      workPlanStore: { async get() { return f.plan }, async save() {} }, arrangementCheckpointStore: f.checkpoints,
      getRefreshToken: () => 'mock', onAuthenticationRequired() {}, onEvent() {}, onApprovalRequest() {},
      resolveEmployee: () => ({ subscriptionId: 'employee', modelId: 'a', gatewayUrl: 'http://invalid' }),
      authorizeEmployee: async () => {
        if (rejectAuthorization) throw new Error('authorization rejected')
        return { subscriptionId: 'employee', modelId: 'a', gatewayUrl: 'http://invalid' }
      },
      createWorker: options => ({ async run(prompt) {
        const { context } = options
        attempts.push(context.modelId)
        if (context.modelId === 'a') {
          await options.onEvent({ taskId: f.task.id, runId: context.runId, subscriptionId: 'employee', sequence: 0,
            type: 'text_delta', occurredAt: Date.now(), data: { text: 'A completed' } })
          return
        }
        resumed.push(context.resumeSessionFile)
        if (resumed.length === 1) {
          savedSession = join(context.sessionDir, 'session.jsonl')
          await mkdir(context.sessionDir, { recursive: true })
          await writeFile(savedSession, [JSON.stringify({ type: 'session', id: 'logical-b', version: 3 }),
            JSON.stringify({ type: 'message', id: 'user', parentId: null, message: { role: 'user', content: prompt } }),
            JSON.stringify({ type: 'message', id: 'result', parentId: 'user', message: { role: 'toolResult', toolCallId: 'read-a', content: [{ type: 'text', text: 'saved result' }] } })].join('\n')+'\n')
        } else {
          assert.equal(context.resumeSessionFile, savedSession)
          const content = await readFile(context.resumeSessionFile!, 'utf8')
          assert.match(content, /original goal/)
          assert.equal(content.match(/saved result/g)?.length, 1)
          assert.doesNotMatch(prompt, /original goal/)
        }
        await options.onSessionCreated?.({ sessionId: 'logical-b', sessionFile: savedSession! })
        if (scenario === 'uncertain-side-effect' && resumed.length === 1) {
          await options.onEvent({ taskId: f.task.id, runId: context.runId, subscriptionId: 'employee', sequence: 0,
            type: 'tool_execution_start', occurredAt: Date.now(), data: { toolId: 'uncertain-write', toolName: 'write' } })
        }
        if (resumed.length < 3) throw new Error('Stream ended without finish_reason')
      }, async abort() {}, async dispose() {} }),
    })
    await runtime.executeTask(f.task.id)
    await waitFor(async () => (await f.manager.getTask(f.task.id))?.status === TaskStatus.PAUSED)
    const checkpoint = (await f.checkpoints.get(scope, f.task.id))!
    if (scenario === 'legacy') {
      for (const node of checkpoint.state.nodes) delete (node as unknown as { sessionRunId?: string }).sessionRunId
      await f.checkpoints.save(scope, checkpoint)
    }
    if (['missing', 'corrupt', 'foreign-session', 'uncertain-side-effect'].includes(scenario)) {
      if (scenario === 'missing') await rm(savedSession!)
      if (scenario === 'corrupt') await fsWriteCorrupt(savedSession!)
      if (scenario === 'foreign-session') {
        const foreign = join(f.root, 'foreign.jsonl')
        await writeFile(foreign, await readFile(savedSession!))
        const id = (checkpoint.state.nodes[1] as unknown as { sessionRunId: string }).sessionRunId
        await f.runs.setSession(scope, f.task.id, id, { sessionId: 'logical-b', sessionFile: foreign })
      }
      await runtime.retryTask(f.task.id)
      await waitFor(async () => (await f.manager.getTask(f.task.id))?.status === TaskStatus.PAUSED)
      assert.deepEqual(attempts, ['a', 'b'])
      assert.match((await f.manager.getTask(f.task.id))!.error!, /会话|核实/)
      return
    }
    if (scenario === 'admission-failed') {
      rejectAuthorization = true
      await assert.rejects(runtime.retryTask(f.task.id), /authorization rejected/)
      assert.deepEqual((await f.checkpoints.get(scope, f.task.id))!.state, checkpoint.state)
      rejectAuthorization = false
    }
    if (scenario === 'queue-failed') {
      const admit = f.manager.admitTask.bind(f.manager)
      f.manager.admitTask = async () => { throw new Error('admission rejected') }
      await assert.rejects(runtime.retryTask(f.task.id), /admission rejected/)
      assert.deepEqual((await f.checkpoints.get(scope, f.task.id))!.state, checkpoint.state)
      assert.equal((await f.manager.getTask(f.task.id))!.status, TaskStatus.PAUSED)
      f.manager.admitTask = admit
    }
    await runtime.retryTask(f.task.id)
    await waitFor(async () => resumed.length === 2 && (await f.manager.getTask(f.task.id))?.status === TaskStatus.PAUSED)
    await runtime.retryTask(f.task.id)
    await waitFor(async () => (await f.manager.getTask(f.task.id))?.status === TaskStatus.COMPLETED)
    assert.deepEqual(attempts, ['a', 'b', 'b', 'b'])
    assert.deepEqual(resumed, [undefined, savedSession, savedSession])
    const final = (await f.checkpoints.get(scope, f.task.id))!
    assert.equal(final.state.nodes[0]!.output, 'A completed')
  })
}
