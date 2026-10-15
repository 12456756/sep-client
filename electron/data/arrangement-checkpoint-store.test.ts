import { afterEach, describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ArrangementCheckpointStore } from './arrangement-checkpoint-store'
import { createArrangementExecutionState } from '../domain/arrangement-execution'

const roots: string[] = []
const scope = { memberId: 'member-a', enterpriseId: 'enterprise-a' }

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('ArrangementCheckpointStore', () => {
  it('persists delivery failures and verified files, and rejects corrupt validation counters', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sep-arrangement-checkpoint-'))
    roots.push(root)
    const store = new ArrangementCheckpointStore(root)
    const state = createArrangementExecutionState([])
    state.nodes = [{ nodeId: 'node', status: 'completed', attempt: 1, error: null, output: 'Findings',
      delivery: { validationAttempts: 3, issues: [], summary: 'Findings', finalFiles: [{ id: 'report', path: 'report.txt', format: 'txt', size: 5,
        sha256: 'a'.repeat(64), nodeRunId: 'run-node', validatedAt: 1 }] } }]
    const checkpoint = { version: 1 as const, taskId: 'task-a', owner: scope, planHash: 'plan-a', activeRunId: 'run-a', state, updatedAt: 1 }
    await store.save(scope, checkpoint)
    assert.deepEqual((await store.get(scope, 'task-a'))?.state.nodes[0]?.delivery, state.nodes[0]!.delivery)
    state.nodes[0]!.delivery!.validationAttempts = 6
    await store.save(scope, checkpoint)
    assert.equal((await store.get(scope, 'task-a'))?.state.nodes[0]?.delivery?.validationAttempts, 3)
    await store.save(scope, { ...checkpoint, taskId: 'task-b' })
    assert.equal(await store.get(scope, 'task-b'), null)
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
})

