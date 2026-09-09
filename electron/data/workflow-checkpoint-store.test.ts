import { afterEach, describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { WorkflowCheckpointStore } from './workflow-checkpoint-store'
import { createWorkflowRunnerState } from '../runtime/workflow-runner'

const roots: string[] = []
const scope = { memberId: 'member-a', enterpriseId: 'enterprise-a' }

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('WorkflowCheckpointStore', () => {
  it('persists checkpoint state under the owner scope', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sep-workflow-checkpoint-'))
    roots.push(root)
    const store = new WorkflowCheckpointStore(root)
    await store.save(scope, {
      version: 1,
      taskId: 'task-a',
      owner: scope,
      planHash: 'plan-a',
      activeRunId: 'run-a',
      state: createWorkflowRunnerState([]),
      updatedAt: 1,
    })
    assert.equal((await store.get(scope, 'task-a'))?.planHash, 'plan-a')
    assert.equal(await store.get({ memberId: 'other', enterpriseId: scope.enterpriseId }, 'task-a'), null)
  })
})
