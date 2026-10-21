import { afterEach, describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ArrangementExecutor } from './arrangement-executor'
import { TaskManager } from './task-manager'
import { createArrangementExecutionState } from '../domain/arrangement-execution'
import type { WorkPlan } from '../domain/arrangement-plan'
import { ArrangementCheckpointStore, type ArrangementCheckpoint } from '../data/arrangement-checkpoint-store'
import { TaskRunStore } from '../data/task-run-store'
import type { PiTaskWorkerOptions } from '../pi/sdk/pi-task-worker'
import type { TaskExecutionEvent } from '../../src/shared/types'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture(onSubmit: (id: string, iteration: number, root: string) => Promise<{ text: string; afterAccept?: () => Promise<void> }>, onAuthorize?: (id: string) => Promise<void>, knowledgeSearch?: NonNullable<ConstructorParameters<typeof ArrangementExecutor>[0]['knowledgeSearch']>) {
  const root = await mkdtemp(join(tmpdir(), 'sep-node-delivery-'))
  roots.push(root)
  await mkdir(join(root, 'deliverables'))
  const plan: WorkPlan = { id: 'task', schemaVersion: 1, sourceDraftId: 'draft', sourceDraftRevision: 1,
    owner: { memberId: 'member', enterpriseId: 'enterprise' }, mode: 'auto', title: 'Plan', goal: 'Research then plan', conversation: null,
    nodes: ['a', 'b'].map((id, index) => ({ id, title: id, subscriptionId: 'employee', modelId: id, knowledgeQuery: `Internal guidance for ${id}`,
      objective: 'Complete '+id, instruction: 'Do '+id, expectedOutput: id+' file', dependsOn: index ? ['a'] : [], skillIds: [], requiresUserConfirmation: false,
      deliverables: [{ id: 'report', name: id+' report', format: 'txt', path: `deliverables/${id}.txt`, contentOutline: ['Findings'], acceptanceCriteria: ['Contains findings'] }] })),
    workspace: { mode: 'shared', path: root }, permissions: { preset: 'workspace-edit', allowedTools: ['read', 'write'], allowedPaths: [], deniedPaths: [], requireApprovalFor: [], commandPolicy: 'disabled' },
    confirmedInputs: [], planHash: 'hash', createdAt: Date.now(),
  }
  const contexts: PiTaskWorkerOptions['context'][] = []
  const prompts: string[] = []
  const events: TaskExecutionEvent[] = []
  let saved: ArrangementCheckpoint | null = null
  const runs = new TaskRunStore(root)
  const checkpoints = new ArrangementCheckpointStore(root)
  const executor = new ArrangementExecutor({ scope: plan.owner, taskManager: new TaskManager(root), taskRunStore: runs,
    checkpointStore: { get: (scope, taskId) => checkpoints.get(scope, taskId), async save(scope, value) {
      await checkpoints.save(scope, value)
      saved = structuredClone(value)
    } }, workspaceRoot: root, arrangementSubscriptionId: 'employee', knowledgeSearch,
    getRefreshToken: () => 'mock', onAuthenticationRequired() {}, async onApprovalRequest() { return true },
    async authorizeEmployee(_id, modelId) { await onAuthorize?.(modelId!); return { subscriptionId: 'employee', modelId: modelId!, gatewayUrl: 'http://invalid', employeeProfile: { name: 'Researcher' }, additionalSkillPaths: [join(root, 'skills')] } },
    async onEvent(event) {
      if (event.type === 'arrangement_node_completed') assert.equal(saved?.state.nodes.find(node => node.nodeId === (event.data as { nodeId: string }).nodeId)?.status, 'completed')
      events.push(event)
    },
    createWorker: options => {
      contexts.push(options.context)
      return { async run(initial) {
        let prompt = initial
        for (let iteration = 1; iteration <= 6; iteration++) {
          prompts.push(prompt)
          const progress = await options.onModelRequest?.('execution')
          assert.equal(saved?.state.nodes.find(node => node.nodeId === options.context.arrangementNodeId)?.modelRequestProgress?.executionRounds, progress?.executionRounds)
          const response = await onSubmit(options.context.modelId, iteration, root)
          const correction = await options.onResponseSettled?.({ text: response.text, stopReason: 'stop' })
          if (!correction) { await response.afterAccept?.(); return }
          prompt = correction.continueWith
        }
        throw new Error('Delivery loop exceeded limit')
      }, async abort() {}, async dispose() {} }
    },
  })
  return { root, plan, executor, contexts, prompts, events, runs, checkpoints, checkpoint: () => saved }
}
function submission(id: string): string { return JSON.stringify({ nodeId: id, summary: 'private summary '+id, finalDeliverables: [{ id: 'report', path: `deliverables/${id}.txt` }] }) }

describe('automatic arrangement final file handover', () => {
  it('searches once per node and reuses each result through delivery corrections', async () => {
    const queries: string[] = []
    const f = await fixture(async (id, iteration, root) => {
      if (id === 'a' && iteration === 1) return { text: 'not-json' }
      await writeFile(join(root, `deliverables/${id}.txt`), `Final findings ${id}`)
      return { text: submission(id) }
    }, undefined, async query => {
      queries.push(query)
      return { status: 'MATCHED', actualStrategy: 'hybrid', degraded: false, partial: false, durationMs: 1,
        results: [{ sourceId: 'source', knowledgeBaseId: 'kb', knowledgeBaseName: 'Internal', documentId: 'doc',
          documentName: 'Guidance', versionId: 'v1', content: `Reference for ${query}`, location: {} }] }
    })
    const result = await f.executor.execute(f.plan, 'task', 'run')
    assert.equal(result.status, 'completed')
    assert.deepEqual(queries, ['Internal guidance for a', 'Internal guidance for b'])
    assert.match(f.contexts[0]?.fixedSystemPrompt ?? '', /Reference for Internal guidance for a/)
    assert.match(f.contexts[1]?.fixedSystemPrompt ?? '', /Reference for Internal guidance for b/)
    assert.equal(f.contexts.length, 2)
  })

  it('retrieves fresh knowledge when a failed node is manually retried', async () => {
    const queries: string[] = []
    let repair = false
    const f = await fixture(async (id, _iteration, root) => {
      if (!repair) return { text: 'not-json' }
      await writeFile(join(root, `deliverables/${id}.txt`), `Final findings ${id}`)
      return { text: submission(id) }
    }, undefined, async query => {
      queries.push(query)
      return { status: 'NO_MATCH', actualStrategy: 'hybrid', degraded: false, partial: false, durationMs: 1, results: [] }
    })
    const failed = await f.executor.execute(f.plan, 'task', 'first-run')
    assert.equal(failed.status, 'failed')
    assert.deepEqual(queries, ['Internal guidance for a'])
    repair = true
    const retried = f.executor.retry(failed.state, f.plan, 'a')
    const result = await f.executor.execute(f.plan, 'task', 'manual-retry', retried)
    assert.equal(result.status, 'completed')
    assert.deepEqual(queries, ['Internal guidance for a', 'Internal guidance for a', 'Internal guidance for b'])
  })

  it('keeps the node and run running during four corrections and accepts the fifth submission', async () => {
    const f = await fixture(async (id, iteration, root) => {
      if (id === 'a') {
        const state = f.checkpoint()!.state
        assert.equal(state.status, 'running')
        assert.equal(state.nodes[0]?.status, 'running')
        assert.equal(state.nodes[1]?.status, 'pending')
        assert.equal(state.nodes[0]?.delivery?.validationAttempts ?? 0, iteration - 1)
        assert.equal(f.contexts.length, 1)
        assert.equal(f.events.filter(event => ['arrangement_node_completed', 'arrangement_node_failed'].includes(event.type)).length, 0)
        const run = await f.runs.get(f.plan.owner, 'task', f.contexts[0]!.runId)
        assert.equal(run?.outcome, 'running')
        if (iteration > 1) {
          assert.match(f.prompts.at(-1)!, new RegExp(`第 ${iteration - 1} 次交付校验失败`))
          assert.match(f.prompts.at(-1)!, /FILE_MISSING/)
        }
      } else {
        assert.equal(f.checkpoint()?.state.nodes[0]?.status, 'completed')
        assert.equal(f.checkpoint()?.state.nodes[0]?.delivery?.validationAttempts, 5)
      }
      if (id === 'b' || iteration === 5) await writeFile(join(root, `deliverables/${id}.txt`), 'Final findings '+id)
      return { text: submission(id) }
    })
    const result = await f.executor.execute(f.plan, 'task', 'run')
    assert.equal(result.status, 'completed')
    assert.deepEqual(result.state.nodes.map(node => node.status), ['completed', 'completed'])
    assert.equal(f.contexts.length, 2)
    assert.equal(f.prompts.length, 6)
    assert.deepEqual(result.state.nodes.map(node => node.modelRequestProgress?.executionRounds), [5, 1])
    assert.equal(f.events.filter(event => event.type === 'arrangement_node_failed').length, 0)
    const checked = f.events.filter(event => event.type === 'arrangement_delivery_checked').map(event => event.data as { nodeId: string; accepted: boolean })
    assert.deepEqual(checked.filter(event => event.nodeId === 'a').map(event => event.accepted), [false, false, false, false, true])
  })
  it('repairs three failures then hands only confirmed paths to the independent next node', async () => {
    const f = await fixture(async (id, iteration, root) => {
      if (id === 'b' || iteration === 4) await writeFile(join(root, `deliverables/${id}.txt`), 'Final findings '+id)
      return { text: submission(id) }
    })
    const result = await f.executor.execute(f.plan, 'task', 'run')
    assert.equal(result.status, 'completed')
    assert.equal(result.state.nodes[0]?.delivery?.validationAttempts, 4)
    assert.equal(result.state.nodes[1]?.delivery?.validationAttempts, 1)
    assert.equal(f.contexts.length, 2)
    assert.equal(f.contexts[0]?.employeeProfile?.name, 'Researcher')
    assert.match(f.contexts[0]?.fixedSystemPrompt ?? '', /skill 是硅基员工能力的主要载体/)
    assert.match(f.contexts[1]?.fixedSystemPrompt ?? '', /deliverables\/a.txt/)
    assert.doesNotMatch(f.contexts[1]?.fixedSystemPrompt ?? '', /private summary a/)
    assert.match(f.prompts[1]!, /第 1 次交付校验失败/)
    assert.equal(f.events.filter(event => event.type === 'arrangement_node_completed').length, 2)
  })
  it('fails on the fifth validation and never starts the dependent node', async () => {
    const f = await fixture(async id => ({ text: submission(id) }))
    const result = await f.executor.execute(f.plan, 'task', 'run')
    assert.equal(result.status, 'failed')
    assert.equal(result.state.nodes[0]?.status, 'failed')
    assert.equal(result.state.nodes[0]?.delivery?.validationAttempts, 5)
    assert.equal(result.state.nodes[1]?.status, 'blocked')
    assert.equal(f.prompts.length, 5)
    assert.equal(f.contexts.length, 1)
    assert.equal(f.events.filter(event => event.type === 'arrangement_node_completed').length, 0)
    assert.equal(f.events.filter(event => event.type === 'arrangement_node_failed').length, 1)
    const states = f.events.filter(event => event.type === 'arrangement_state_changed').map(event => event.data as { status: string })
    assert.ok(states.every(state => state.status !== 'waiting-user' && state.status !== 'completed'))
    assert.equal(states.at(-1)?.status, 'failed')
    assert.ok((await f.runs.list(f.plan.owner, 'task')).every(run => run.outcome === 'failed'))
  })
  it('does not renew the five-validation budget after interruption', async () => {
    const f = await fixture(async id => ({ text: submission(id) }))
    const state = createArrangementExecutionState(f.plan.nodes)
    state.status = 'interrupted'
    state.nodes[0]!.status = 'interrupted'
    state.nodes[0]!.delivery = { validationAttempts: 3, issues: [{ code: 'FILE_MISSING', message: 'missing' }], finalFiles: [] }
    const result = await f.executor.execute(f.plan, 'task', 'resume', state)
    assert.equal(result.status, 'failed')
    assert.equal(f.prompts.length, 2)
    assert.equal(result.state.nodes[0]?.delivery?.validationAttempts, 5)
  })
  it('continues persisted execution counts and never treats high counts as a completion limit', async () => {
    const f = await fixture(async (id, _iteration, root) => {
      await writeFile(join(root, `deliverables/${id}.txt`), 'Final findings '+id)
      return { text: submission(id) }
    })
    const state = createArrangementExecutionState(f.plan.nodes)
    state.status = 'interrupted'
    state.nodes[0]!.status = 'interrupted'
    state.nodes[0]!.modelRequestProgress = { executionRounds: 10_000, requestAttempts: 10_003, executionRetries: 2, compactionAttempts: 1 }
    await f.checkpoints.save(f.plan.owner, { version: 1, taskId: 'task', owner: f.plan.owner, planHash: f.plan.planHash,
      activeRunId: null, state, updatedAt: Date.now() })
    const result = await f.executor.execute(f.plan, 'task', 'resume')
    assert.equal(result.status, 'completed')
    assert.deepEqual(result.state.nodes.map(node => node.modelRequestProgress?.executionRounds), [10_001, 1])
    assert.equal(result.state.nodes[0]?.modelRequestProgress?.requestAttempts, 10_004)
    assert.equal(result.state.nodes[0]?.delivery?.validationAttempts, 1)
    assert.deepEqual((await new ArrangementCheckpointStore(f.root).get(f.plan.owner, 'task'))?.state.nodes.map(node => node.modelRequestProgress?.executionRounds), [10_001, 1])
  })
  it('persists independent counts without losing parallel node updates', async () => {
    const f = await fixture(async (id, iteration, root) => {
      if (iteration === 3) await writeFile(join(root, `deliverables/${id}.txt`), 'Final findings '+id)
      return { text: submission(id) }
    })
    f.plan.nodes[1]!.dependsOn = []
    const result = await f.executor.execute(f.plan, 'task', 'run')
    assert.equal(result.status, 'completed')
    assert.deepEqual(result.state.nodes.map(node => node.modelRequestProgress?.executionRounds), [3, 3])
    assert.deepEqual(f.checkpoint()?.state.nodes.map(node => node.modelRequestProgress?.requestAttempts), [3, 3])
  })
  it('marks missing legacy counts only for recovered sessions and preserves that origin on later resumes', async () => {
    const f = await fixture(async (id, _iteration, root) => {
      await writeFile(join(root, `deliverables/${id}.txt`), 'Final findings '+id)
      return { text: submission(id) }
    })
    const oldRunId = 'old-node-run'
    const paths = f.runs.getPaths(f.plan.owner, 'task', oldRunId)
    await mkdir(paths.sessionDir, { recursive: true })
    const sessionFile = join(paths.sessionDir, 'history.jsonl')
    await writeFile(sessionFile, JSON.stringify({ type: 'session', id: oldRunId })+'\n')
    await f.runs.create(f.plan.owner, { taskId: 'task', runId: oldRunId, subscriptionId: 'employee', modelId: 'a',
      runtimeKey: 'employee:a', workspaceDir: f.root, prompt: 'Earlier work', arrangementNodeId: 'a' })
    await f.runs.setSession(f.plan.owner, 'task', oldRunId, { sessionId: oldRunId, sessionFile })
    const state = createArrangementExecutionState(f.plan.nodes)
    state.status = 'interrupted'
    state.nodes[0] = { ...state.nodes[0]!, status: 'interrupted', attempt: 1, sessionRunId: oldRunId }
    await f.checkpoints.save(f.plan.owner, { version: 1, taskId: 'task', owner: f.plan.owner, planHash: f.plan.planHash,
      activeRunId: null, state, updatedAt: Date.now() })
    const first = await f.executor.execute(f.plan, 'task', 'resume')
    assert.equal(first.status, 'completed')
    assert.deepEqual(first.state.nodes[0]?.modelRequestProgress, {
      executionRounds: 1, requestAttempts: 1, executionRetries: 0, compactionAttempts: 0, countingScope: 'since-resume',
    })
    assert.equal(first.state.nodes[1]?.modelRequestProgress?.countingScope, undefined)
    const resumed = structuredClone(first.state)
    resumed.status = 'interrupted'
    resumed.nodes[0] = { ...resumed.nodes[0]!, status: 'interrupted', delivery: undefined }
    await f.checkpoints.save(f.plan.owner, { version: 1, taskId: 'task', owner: f.plan.owner, planHash: f.plan.planHash,
      activeRunId: null, state: resumed, updatedAt: Date.now() })
    const second = await f.executor.execute(f.plan, 'task', 'resume-again')
    assert.equal(second.status, 'completed')
    assert.equal(second.state.nodes[0]?.modelRequestProgress?.executionRounds, 2)
    assert.equal(second.state.nodes[0]?.modelRequestProgress?.countingScope, 'since-resume')
    assert.equal((await new ArrangementCheckpointStore(f.root).get(f.plan.owner, 'task'))?.state.nodes[0]?.modelRequestProgress?.countingScope, 'since-resume')
  })
  it('does not start a parallel sibling whose authorization finishes after terminal failure', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const f = await fixture(async (id, iteration) => {
      if (id === 'a' && iteration === 5) setTimeout(release, 20)
      return { text: submission(id) }
    }, async id => { if (id === 'b') await gate })
    f.plan.nodes[1]!.dependsOn = []
    assert.equal((await f.executor.execute(f.plan, 'task', 'run')).status, 'failed')
    assert.equal(f.contexts.length, 1)
  })
  it('preserves completed nodes when rejecting an incomplete legacy plan on resume', async () => {
    const f = await fixture(async id => ({ text: submission(id) }))
    f.plan.nodes[1]!.deliverables = undefined
    const state = createArrangementExecutionState(f.plan.nodes)
    state.nodes[0]!.status = 'completed'
    state.nodes[0]!.output = 'completed findings'
    state.nodes[1]!.status = 'ready'
    const result = await f.executor.execute(f.plan, 'task', 'resume', state)
    assert.equal(result.status, 'failed')
    assert.equal(result.state.nodes[0]?.status, 'completed')
    assert.equal(result.state.nodes[0]?.output, 'completed findings')
    assert.equal(f.contexts.length, 0)
  })
  it('honors cancellation during settlement without starting a correction or downstream node', async () => {
    const f = await fixture(async id => {
      await f.executor.abort()
      return { text: submission(id) }
    })
    const result = await f.executor.execute(f.plan, 'task', 'run')
    assert.equal(result.status, 'interrupted')
    assert.equal(f.contexts.length, 1)
    assert.equal(f.prompts.length, 1)
    assert.equal(result.state.nodes[0]?.delivery?.validationAttempts ?? 0, 0)
  })
  it('records accepted delivery recovery without running the employee again or rewriting the original run', async () => {
    const f = await fixture(async (id, _iteration, root) => {
      await writeFile(join(root, `deliverables/${id}.txt`), 'Final findings '+id)
      return { text: submission(id) }
    })
    const first = await f.executor.execute(f.plan, 'task', 'run')
    const originalRunId = first.state.nodes[0]!.delivery!.finalFiles[0]!.nodeRunId
    const original = await f.runs.get(f.plan.owner, 'task', originalRunId)
    const state = structuredClone(first.state)
    state.status = 'interrupted'
    state.nodes[0]!.status = 'interrupted'
    const resumed = await f.executor.execute(f.plan, 'task', 'resume', state)
    assert.equal(resumed.status, 'completed')
    assert.equal(f.contexts.length, 2)
    const completion = f.events.filter(event => event.type === 'arrangement_node_completed').at(-1)!.data as { nodeRunId: string }
    assert.notEqual(completion.nodeRunId, originalRunId)
    const receipt = await f.runs.get(f.plan.owner, 'task', completion.nodeRunId)
    assert.equal(receipt?.resumedFromRunId, originalRunId)
    assert.equal(receipt?.outcome, 'completed')
    assert.deepEqual(await f.runs.get(f.plan.owner, 'task', originalRunId), original)
  })
  it('does not accept prose as completion and repairs invalid JSON automatically', async () => {
    const f = await fixture(async (id, iteration, root) => {
      await writeFile(join(root, `deliverables/${id}.txt`), 'Findings')
      return { text: iteration === 1 ? 'I have completed the work.' : submission(id) }
    })
    assert.equal((await f.executor.execute(f.plan, 'task', 'run')).status, 'completed')
    assert.match(f.prompts[1]!, /INVALID_SUBMISSION/)
  })
  it('refuses mutated predecessor files and legacy automatic plans without contracts', async () => {
    const f = await fixture(async (id, _iteration, root) => {
      await writeFile(join(root, `deliverables/${id}.txt`), 'Original')
      return { text: submission(id), afterAccept: id === 'a' ? () => writeFile(join(root, 'deliverables/a.txt'), 'mutated') : undefined }
    })
    assert.equal((await f.executor.execute(f.plan, 'task', 'run')).status, 'failed')
    assert.equal(f.contexts.length, 1)
    const old = await fixture(async id => ({ text: submission(id) }))
    old.plan.nodes[0]!.deliverables = undefined
    assert.equal((await old.executor.execute(old.plan, 'task', 'run')).status, 'failed')
    assert.equal(old.contexts.length, 0)
  })
})
