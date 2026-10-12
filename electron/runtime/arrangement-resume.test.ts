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
    mode: 'auto', title: 'resume', goal: 'original goal', conversation: null,
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
