import { afterEach, describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ArrangementExecutor, type ArrangementExecutionOptions } from './arrangement-executor'
import { TaskManager } from './task-manager'
import { createArrangementExecutionState } from '../domain/arrangement-execution'
import type { WorkPlan } from '../domain/arrangement-plan'
import { ArrangementCheckpointStore, type ArrangementCheckpoint } from '../data/arrangement-checkpoint-store'
import { TaskRunStore } from '../data/task-run-store'
import type { PiTaskWorkerOptions } from '../pi/sdk/pi-task-worker'
import type { TaskExecutionEvent } from '../../src/shared/types'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture(onSubmit: (id: string, iteration: number, root: string) => Promise<{ text: string; stopReason?: string; afterAccept?: () => Promise<void> }>, onAuthorize?: (id: string) => Promise<void>, media?: ArrangementExecutionOptions['media'], onEvent?: (event: TaskExecutionEvent) => void) {
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
    } }, workspaceRoot: root, arrangementSubscriptionId: 'employee',
    getRefreshToken: () => 'mock', onAuthenticationRequired() {}, async onApprovalRequest() { return true }, media,
    async authorizeEmployee(_id, modelId) { await onAuthorize?.(modelId!); return { subscriptionId: 'employee', modelId: modelId!, gatewayUrl: 'http://invalid', employeeProfile: { name: 'Researcher' }, additionalSkillPaths: [join(root, 'skills')] } },
    async onEvent(event) {
      if (event.type === 'arrangement_node_completed') assert.equal(saved?.state.nodes.find(node => node.nodeId === (event.data as { nodeId: string }).nodeId)?.status, 'completed')
      events.push(event)
      onEvent?.(event)
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
          const correction = await options.onResponseSettled?.({ text: response.text, stopReason: response.stopReason ?? 'stop' })
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
  it('restates only the current node work in initial and correction user messages', async () => {
    const efficiencyPrompt = `【执行效率要求】
完整完成本节点工作，不得省略必要操作、技能读取、安全审批和交付验收。

1. 确定可行方案后立即执行，不再反复比较；只有失败或发现实质问题时才调整。
2. 相关读取、修改和检查合并完成；无依赖且安全的操作并行执行。
3. 已成功且结果仍有效的操作不得重复，只修复失败项、复查受影响内容。
4. 只处理本节点任务，不扫描无关目录，不修改前置最终文件，不增加额外交付物。
5. 全部验收条件通过后立即提交最终 JSON，不再美化、扩展或重复检查。

不得假装操作、编造结果或用文字代替实际文件。`
    const f = await fixture(async (id, iteration, root) => {
      const prompt = f.prompts.at(-1)!
      const node = f.plan.nodes.find(item => item.id === id)!
      for (const value of [node.objective!, node.instruction, node.expectedOutput, JSON.stringify(node.deliverables, null, 2)]) {
        assert.ok(prompt.includes(value), `User message must contain ${value}`)
      }
      assert.ok(prompt.includes(`当前节点：${node.title}（${id}）`))
      assert.ok(prompt.includes(efficiencyPrompt))
      assert.ok(prompt.indexOf('【当前工作】') < prompt.indexOf('【执行效率要求】'))
      assert.ok(prompt.indexOf('【执行效率要求】') < prompt.indexOf('【员工能力与 skill】'))
      assert.match(prompt, /先核对历史操作是否属于当前节点/)
      if (id === 'b') {
        assert.match(prompt, /deliverables\/a.txt/)
        assert.match(prompt, /不得覆盖前置节点的最终交付文件/)
        assert.doesNotMatch(prompt, /节点执行指令：Do a|private summary a/)
      }
      if (iteration > 1) assert.match(prompt, /INVALID_SUBMISSION/)
      if (iteration === 1) return { text: '' }
      await writeFile(join(root, `deliverables/${id}.txt`), 'Final findings '+id)
      return { text: submission(id) }
    })
    const result = await f.executor.execute(f.plan, 'task', 'run')
    assert.equal(result.status, 'completed')
    assert.equal(f.prompts.length, 4)
    assert.ok(f.contexts.every(context => context.fixedSystemPrompt?.includes(efficiencyPrompt)))
  })

  it('accepts a complete long final reply and hands its validated file to the next node', async () => {
    const summary = 'Detailed findings. '.repeat(200).trim()
    const f = await fixture(async (id, _iteration, root) => {
      const files = f.plan.nodes.find(node => node.id === id)!.deliverables!
      for (const file of files) await writeFile(join(root, file.path), 'Final findings '+id)
      const text = JSON.stringify({ nodeId: id, summary, finalDeliverables: files.map(({ id, path }) => ({ id, path })) })
      assert.ok(text.length > 8192)
      return { text }
    })
    for (const node of f.plan.nodes) node.deliverables = Array.from({ length: 24 }, (_, index) => ({
      ...node.deliverables![0]!, id: `report-${index}`, path: `deliverables/${node.id}-${index}-${'p'.repeat(160)}.txt`,
    }))
    const result = await f.executor.execute(f.plan, 'task', 'run')
    assert.equal(result.status, 'completed')
    assert.deepEqual(result.state.nodes.map(node => node.delivery?.validationAttempts), [1, 1])
    assert.equal(result.state.nodes[0]?.delivery?.summary, summary)
    assert.ok(f.contexts[1]?.fixedSystemPrompt?.includes(f.plan.nodes[0]!.deliverables![0]!.path))
  })

  for (const scenario of [
    { text: '', stopReason: 'stop', issue: 'INVALID_SUBMISSION' },
    { text: '', stopReason: 'length', issue: 'OUTPUT_TRUNCATED' },
    { text: submission('a'), stopReason: 'length', issue: 'OUTPUT_TRUNCATED' },
  ]) {
    it(`rejects ${scenario.stopReason} with ${scenario.text ? 'valid JSON' : 'empty body'} even when files exist`, async () => {
      const f = await fixture(async (id, _iteration, root) => {
        await writeFile(join(root, `deliverables/${id}.txt`), 'Existing findings')
        return scenario
      })
      const result = await f.executor.execute(f.plan, 'task', 'run')
      assert.equal(result.status, 'failed')
      assert.equal(result.state.nodes[0]?.delivery?.issues[0]?.code, scenario.issue)
      assert.equal(result.state.nodes[0]?.delivery?.validationAttempts, 5)
      assert.equal(result.state.nodes[1]?.status, 'blocked')
      assert.equal(f.events.some(event => event.type === 'arrangement_node_completed'), false)
    })
  }

  it('waits for pending media outputs before validating final delivery', async () => {
    const nodesByRun = new Map<string, string>()
    const savedRuns = new Set<string>()
    const mediaTools = { names: ['media_get_capabilities'] as const, async execute() { return {} } }
    let stops = 0
    const f = await fixture(async id => ({ text: submission(id) }), undefined, {
      async prepareRun(input) {
        nodesByRun.set(input.runId, input.employee.modelId)
        return mediaTools
      },
      async waitForRun(taskId, runId) {
        assert.equal(taskId, 'task')
        if (savedRuns.has(runId)) return
        const nodeId = nodesByRun.get(runId)!
        const progress = f.checkpoint()!.state.nodes.find(node => node.nodeId === nodeId)!
        assert.equal(progress.status, 'running')
        assert.equal(progress.delivery?.validationAttempts ?? 0, 0)
        await writeFile(join(f.root, `deliverables/${nodeId}.txt`), 'Saved media output '+nodeId)
        savedRuns.add(runId)
      },
      async stopTask() { stops++ },
    })
    const result = await f.executor.execute(f.plan, 'task', 'run')
    assert.equal(result.status, 'completed')
    assert.equal(savedRuns.size, 2)
    assert.equal(stops, 0)
    assert.deepEqual(result.state.nodes.map(node => node.delivery?.validationAttempts), [1, 1])
    assert.ok(f.contexts.every(context => context.mediaTools === mediaTools))
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
  it('lets an independent sibling finish after another node exhausts delivery validation', { timeout: 5_000 }, async () => {
    let release!: () => void
    let terminalFailureObserved = false
    const gate = new Promise<void>(resolve => { release = resolve })
    const f = await fixture(async (id, _iteration, root) => {
      if (id === 'b') await writeFile(join(root, 'deliverables/b.txt'), 'Independent final result')
      return { text: submission(id) }
    }, async id => {
      if (id === 'b') {
        await gate
        assert.ok(terminalFailureObserved)
      }
    }, undefined, event => {
      if (event.type === 'arrangement_node_failed' && (event.data as { nodeId?: string }).nodeId === 'a') {
        terminalFailureObserved = true
        release()
      }
    })
    f.plan.nodes[1]!.dependsOn = []
    const result = await f.executor.execute(f.plan, 'task', 'run')
    assert.equal(result.status, 'failed')
    assert.ok(terminalFailureObserved)
    assert.equal(f.contexts.length, 2)
    assert.deepEqual(result.state.nodes.map(node => node.status), ['failed', 'completed'])
    assert.equal(result.state.nodes[1]?.delivery?.validationAttempts, 1)
    assert.equal(result.state.nodes[1]?.delivery?.finalFiles.length, 1)
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
  it('hands over the frozen predecessor even if a later tool overwrites the workspace original', async () => {
    const f = await fixture(async (id, _iteration, root) => {
      await writeFile(join(root, `deliverables/${id}.txt`), 'Original')
      return { text: submission(id), afterAccept: id === 'a' ? () => writeFile(join(root, 'deliverables/a.txt'), 'mutated') : undefined }
    })
    const result = await f.executor.execute(f.plan, 'task', 'run')
    assert.equal(result.status, 'completed')
    assert.equal(f.contexts.length, 2)
    const prompt = f.contexts[1]!.fixedSystemPrompt!
    const path = prompt.match(/读取快照：([^\n]+)/)?.[1]
    assert.ok(path)
    assert.equal(await readFile(path, 'utf8'), 'Original')
    assert.equal(await readFile(join(f.root, 'deliverables/a.txt'), 'utf8'), 'mutated')
    assert.match(prompt, /需要补充公式、缓存值、格式或其他内容时，先复制到本节点自己的文件路径/)
  })

  it('recovers an updated legacy predecessor without rerunning its completed node and persists the recovery version', async () => {
    const f = await fixture(async (id, _iteration, root) => {
      assert.equal(id, 'b')
      await writeFile(join(root, 'deliverables/b.txt'), 'B findings')
      return { text: submission(id) }
    })
    const { createHash } = await import('node:crypto')
    const state = createArrangementExecutionState(f.plan.nodes)
    state.nodes[0] = { ...state.nodes[0]!, status: 'completed', output: 'Original summary', delivery: {
      validationAttempts: 1, issues: [], finalFiles: [{ id: 'report', path: 'deliverables/a.txt', format: 'txt',
        size: 8, sha256: createHash('sha256').update('Original').digest('hex'), nodeRunId: 'old-a', validatedAt: Date.now() }],
    } }
    state.nodes[1]!.status = 'ready'
    await writeFile(join(f.root, 'deliverables/a.txt'), 'Current valid findings')
    const result = await f.executor.execute(f.plan, 'task', 'resume', state)
    assert.equal(result.status, 'completed')
    assert.deepEqual(f.contexts.map(context => context.modelId), ['b'])
    assert.equal(result.state.nodes[0]?.output, 'Original summary')
    assert.equal(result.state.nodes[0]?.delivery?.finalFiles[0]?.snapshot?.source, 'workspace-recovery')
    assert.equal(f.checkpoint()?.state.nodes[0]?.delivery?.finalFiles[0]?.snapshot?.source, 'workspace-recovery')
    assert.match(f.contexts[0]!.fixedSystemPrompt!, /历史任务恢复版本/)
  })

  it('still refuses legacy automatic plans without delivery contracts', async () => {
    const old = await fixture(async id => ({ text: submission(id) }))
    old.plan.nodes[0]!.deliverables = undefined
    assert.equal((await old.executor.execute(old.plan, 'task', 'run')).status, 'failed')
    assert.equal(old.contexts.length, 0)
  })
})
