import { afterEach, describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ArrangementCheckpointStore } from './arrangement-checkpoint-store'
import { ScopePath } from './scope-path'
import { createArrangementExecutionState } from '../domain/arrangement-execution'

const roots: string[] = []
const scope = { memberId: 'member-a', enterpriseId: 'enterprise-a' }

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('ArrangementCheckpointStore', () => {
  it('accepts old checkpoints and rejects corrupt model request counters', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sep-arrangement-checkpoint-'))
    roots.push(root)
    const store = new ArrangementCheckpointStore(root)
    const state = createArrangementExecutionState([])
    state.nodes = [{ nodeId: 'node', status: 'interrupted', attempt: 1, error: null, output: null }]
    const checkpoint = { version: 1 as const, taskId: 'legacy', owner: scope, planHash: 'plan-a', activeRunId: null, state, updatedAt: 1 }
    await store.save(scope, checkpoint)
    assert.equal((await store.get(scope, 'legacy'))?.state.nodes[0]?.modelRequestProgress, undefined)
    for (const [index, progress] of [
      { executionRounds: -1, requestAttempts: 0, executionRetries: 0, compactionAttempts: 0 },
      { executionRounds: 1.5, requestAttempts: 1.5, executionRetries: 0, compactionAttempts: 0 },
      { executionRounds: 1, requestAttempts: 0, executionRetries: 0, compactionAttempts: 0 },
      { executionRounds: 1, requestAttempts: 1, executionRetries: 0, compactionAttempts: 0, extra: true },
    ].entries()) {
      const taskId = `bad-${index}`
      await store.save(scope, { ...checkpoint, taskId, state: { ...state, nodes: [{ ...state.nodes[0]!, modelRequestProgress: progress }] } })
      assert.equal(await store.get(scope, taskId), null)
    }
  })
  it('persists delivery failures and verified files, and rejects corrupt validation counters', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sep-arrangement-checkpoint-'))
    roots.push(root)
    const store = new ArrangementCheckpointStore(root)
    const state = createArrangementExecutionState([])
    state.nodes = [{ nodeId: 'node', status: 'completed', attempt: 1, error: null, output: 'Findings',
      modelRequestProgress: { executionRounds: 100_000, requestAttempts: 100_003, executionRetries: 2, compactionAttempts: 1 },
      delivery: { validationAttempts: 3, issues: [], summary: 'Findings', finalFiles: [{ id: 'report', path: 'report.txt', format: 'txt', size: 5,
        sha256: 'a'.repeat(64), nodeRunId: 'run-node', validatedAt: 1 }] } }]
    const checkpoint = { version: 1 as const, taskId: 'task-a', owner: scope, planHash: 'plan-a', activeRunId: 'run-a', state, updatedAt: 1 }
    await store.save(scope, checkpoint)
    assert.deepEqual((await store.get(scope, 'task-a'))?.state.nodes[0]?.delivery, state.nodes[0]!.delivery)
    assert.deepEqual((await store.get(scope, 'task-a'))?.state.nodes[0]?.modelRequestProgress, state.nodes[0]!.modelRequestProgress)
    state.nodes[0]!.delivery!.validationAttempts = 6
    await store.save(scope, checkpoint)
    assert.equal((await store.get(scope, 'task-a'))?.state.nodes[0]?.delivery?.validationAttempts, 3)
    await store.save(scope, { ...checkpoint, taskId: 'task-b' })
    assert.equal(await store.get(scope, 'task-b'), null)
  })
  it('persists the recovery counting scope without changing legacy or complete counters', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sep-arrangement-checkpoint-'))
    roots.push(root)
    const store = new ArrangementCheckpointStore(root)
    const state = createArrangementExecutionState([])
    state.nodes = [{ nodeId: 'node', status: 'interrupted', attempt: 2, error: null, output: null,
      modelRequestProgress: { executionRounds: 2, requestAttempts: 3, executionRetries: 0, compactionAttempts: 1, countingScope: 'since-resume' } }]
    await store.save(scope, { version: 1, taskId: 'partial', owner: scope, planHash: 'plan-a', activeRunId: null, state, updatedAt: 1 })
    assert.deepEqual((await store.get(scope, 'partial'))?.state.nodes[0]?.modelRequestProgress, state.nodes[0]!.modelRequestProgress)
  })
  it('rejects an unsafe persisted node session pointer', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sep-arrangement-checkpoint-'))
    roots.push(root)
    const store = new ArrangementCheckpointStore(root)
    await store.save(scope, { version: 1, taskId: 'task-a', owner: scope, planHash: 'plan-a', activeRunId: null,
      state: { ...createArrangementExecutionState([]), nodes: [{ nodeId: 'node', status: 'failed', attempt: 1, error: 'failed', output: null, sessionRunId: '../foreign' }] }, updatedAt: 1 })
    assert.equal(await store.get(scope, 'task-a'), null)
  })

  it('persists checkpoint state under the owner scope', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sep-arrangement-checkpoint-'))
    roots.push(root)
    const store = new ArrangementCheckpointStore(root)
    await store.save(scope, {
      version: 1,
      taskId: 'task-a',
      owner: scope,
      planHash: 'plan-a',
      activeRunId: 'run-a',
      state: createArrangementExecutionState([]),
      updatedAt: 1,
    })
    assert.equal((await store.get(scope, 'task-a'))?.planHash, 'plan-a')
    assert.equal(await store.get({ memberId: 'other', enterpriseId: scope.enterpriseId }, 'task-a'), null)
  })

  it('preserves corrupt primary files while reading backup evidence in read-only mode', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sep-arrangement-checkpoint-'))
    roots.push(root)
    const store = new ArrangementCheckpointStore(root)
    const paths = new ScopePath(root)
    const checkpoint = { version: 1 as const, taskId: 'task-a', owner: scope, planHash: 'plan-a',
      activeRunId: null, lastRunId: 'run-a', state: createArrangementExecutionState([]), updatedAt: 1 }
    await store.save(scope, checkpoint)
    await store.save(scope, { ...checkpoint, updatedAt: 2 })
    const file = paths.arrangementCheckpointFile(scope, 'task-a')
    await writeFile(file, '{broken')
    const backup = await readFile(`${file}.bak`, 'utf8')
    const entries = await readdir(paths.taskDir(scope, 'task-a'))
    assert.equal((await store.get(scope, 'task-a', { readOnly: true }))?.lastRunId, 'run-a')
    assert.equal(await readFile(file, 'utf8'), '{broken')
    assert.equal(await readFile(`${file}.bak`, 'utf8'), backup)
    assert.deepEqual(await readdir(paths.taskDir(scope, 'task-a')), entries)
    await writeFile(`${file}.bak`, '{also-broken')
    assert.equal(await store.get(scope, 'task-a', { readOnly: true }), null)
    assert.deepEqual(await readdir(paths.taskDir(scope, 'task-a')), entries)
  })

  it('validates the persisted parent run binding', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sep-arrangement-checkpoint-'))
    roots.push(root)
    const store = new ArrangementCheckpointStore(root)
    for (const [index, lastRunId] of ['', '../other-run', 123].entries()) {
      const taskId = `bad-parent-${index}`
      await store.save(scope, { version: 1, taskId, owner: scope, planHash: 'plan-a', activeRunId: null,
        lastRunId: lastRunId as string, state: createArrangementExecutionState([]), updatedAt: 1 })
      assert.equal(await store.get(scope, taskId, { readOnly: true }), null)
    }
  })
})

