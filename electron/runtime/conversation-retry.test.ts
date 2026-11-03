import * as assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { effectivePermissionPolicy, type WorkPlan } from '../domain/arrangement-plan'
import { TaskRunStore } from '../data/task-run-store'
import { TaskManager } from './task-manager'
import { TaskRuntime } from './task-runtime'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

async function waitFor(predicate: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 6000
  while (!await predicate()) {
    if (Date.now() > deadline) assert.fail('conversation did not reach the expected state')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

async function fixture(t: TestContext, withPlan = false, holdDisposal = false) {
  const root = await mkdtemp(join(tmpdir(), 'conversation-retry-'))
  const owner = { memberId: 'member', enterpriseId: 'enterprise' }
  const manager = new TaskManager(root), runs = new TaskRunStore(root)
  await manager.initialize()
  await manager.setCurrentUser(owner.memberId, owner.enterpriseId)
  const task = await manager.createTask('conversation', 'initial prompt', join(root, 'workspace'), 'employee')
  const plan: WorkPlan = {
    schemaVersion: 1, id: task.id, owner, sourceDraftId: 'draft', sourceDraftRevision: 1,
    planHash: 'hash', createdAt: Date.now(), mode: 'conversation', title: task.title, goal: task.prompt,
    confirmedInputs: [], nodes: [], workspace: { mode: 'shared', path: null },
    conversation: { participants: [{ subscriptionId: 'employee', modelId: 'model' }], activeSubscriptionId: 'employee' },
    permissions: effectivePermissionPolicy({ preset: 'workspace-edit', approvalMode: 'auto-approve' }),
  }
  const started: { runId: string; prompt: string }[] = []
  const gates = new Map<string, ReturnType<typeof deferred>>()
  const disposal = deferred()
  const runtime = new TaskRuntime({
    taskManager: manager, taskRunStore: runs,
    ...(withPlan ? { workPlanStore: { get: async () => plan, save: async () => {} } } : {}),
    resolveEmployee: () => ({ subscriptionId: 'employee', modelId: 'model', gatewayUrl: 'http://unused' }),
    getRefreshToken: () => 'fixture', onAuthenticationRequired() {}, onEvent() {}, onApprovalRequest() {},
    createWorker: options => {
      const gate = deferred()
      gates.set(options.context.runId, gate)
      return {
        async run(prompt) {
          await mkdir(options.context.sessionDir, { recursive: true })
          const sessionFile = join(options.context.sessionDir, 'session.jsonl')
          await writeFile(sessionFile, '{}\n')
          await options.onSessionCreated?.({ sessionId: 'shared', sessionFile })
          started.push({ runId: options.context.runId, prompt })
          await gate.promise
        },
        async abort() { gate.resolve() },
        async dispose() { if (holdDisposal) await disposal.promise },
      }
    },
  })
  t.after(async () => {
    disposal.resolve()
    for (const gate of gates.values()) gate.resolve()
    await runtime.stopAll()
    await rm(root, { recursive: true, force: true })
  })
  return { manager, task, runtime, runs, owner, started, gates, disposal }
}

for (const withPlan of [false, true]) {
  test(`a stopped conversation retries once and preserves the cancelled run (${withPlan ? 'confirmed plan' : 'legacy metadata'})`, async t => {
    const f = await fixture(t, withPlan)
    await f.runtime.executeTask(f.task.id, { conversation: true })
    await waitFor(() => f.started.length === 1)
    const oldRunId = f.started[0]!.runId
    await f.runtime.cancelTask(f.task.id)
    await waitFor(() => !f.runtime.hasConversationRun(f.task.id))
    assert.equal((await f.manager.getTask(f.task.id))?.status, 'paused')
    const oldRun = await f.runs.get(f.owner, f.task.id, oldRunId)
    assert.equal(oldRun?.outcome, 'cancelled')

    const options = withPlan ? {} : { conversation: true }
    const retries = await Promise.allSettled([
      f.runtime.retryTask(f.task.id, options), f.runtime.retryTask(f.task.id, options),
    ])
    assert.equal(retries.filter(result => result.status === 'fulfilled').length, 1)
    await waitFor(() => f.started.length === 2)
    const retryRunId = f.started[1]!.runId
    assert.notEqual(retryRunId, oldRunId)
    assert.equal(f.started[1]!.prompt, f.task.prompt)
    assert.equal((await f.manager.getTask(f.task.id))?.activeRunId, retryRunId)
    await assert.rejects(f.runtime.retryTask(f.task.id, options))
    assert.equal(f.started.length, 2)
    assert.deepEqual(await f.runs.get(f.owner, f.task.id, oldRunId), oldRun)

    f.gates.get(retryRunId)!.resolve()
    await waitFor(() => !f.runtime.hasConversationRun(f.task.id))
    assert.equal((await f.manager.getTask(f.task.id))?.status, 'completed')
    assert.equal((await f.runs.get(f.owner, f.task.id, retryRunId))?.outcome, 'completed')
    assert.equal((await f.runs.list(f.owner, f.task.id)).length, 2)
  })
}

test('a paused conversation cannot retry before the old worker is disposed', async t => {
  const f = await fixture(t, false, true)
  await f.runtime.executeTask(f.task.id, { conversation: true })
  await waitFor(() => f.started.length === 1)
  const cancelling = f.runtime.cancelTask(f.task.id)
  try {
    await waitFor(async () => (await f.manager.getTask(f.task.id))?.status === 'paused')
    assert.equal((await f.manager.getTask(f.task.id))?.activeRunId, null)
    assert.equal(f.runtime.hasConversationRun(f.task.id), true)
    await assert.rejects(f.runtime.retryTask(f.task.id, { conversation: true }), { code: 'INVALID_STATE' })
    assert.equal((await f.manager.getTask(f.task.id))?.status, 'paused')
    assert.equal(f.started.length, 1)
  } finally { f.disposal.resolve(); await cancelling }
})

test('a paused conversation with an active run cannot be admitted again', async t => {
  const f = await fixture(t)
  await f.runtime.executeTask(f.task.id, { conversation: true })
  await waitFor(() => f.started.length === 1)
  const runId = (await f.manager.getTask(f.task.id))!.activeRunId
  await f.manager.updateTaskStatus(f.task.id, 'paused')
  await assert.rejects(f.runtime.retryTask(f.task.id, { conversation: true }), { code: 'INVALID_STATE' })
  assert.equal((await f.manager.getTask(f.task.id))?.activeRunId, runId)
  assert.equal((await f.manager.getTask(f.task.id))?.status, 'paused')
  assert.equal(f.started.length, 1)
})

test('retry does not permit paused tasks without conversation metadata', async t => {
  const f = await fixture(t)
  await f.manager.updateTaskStatus(f.task.id, 'paused')
  await assert.rejects(f.runtime.retryTask(f.task.id), /Only terminal or interrupted tasks can be retried/)
  assert.equal((await f.manager.getTask(f.task.id))?.status, 'paused')
  assert.equal(f.started.length, 0)
})
