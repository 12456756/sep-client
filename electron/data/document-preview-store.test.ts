import * as assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { DocumentPreviewStore } from './document-preview-store'
import { WorkPlanStore } from './work-plan-store'
import { ArrangementCheckpointStore, type ArrangementCheckpoint } from './arrangement-checkpoint-store'
import type { WorkPlan } from '../domain/arrangement-plan'

test('preview joins owner-local planned deliveries with node completion, independent of the parent task status', async t => {
  const root = await mkdtemp(join(tmpdir(), 'sep-preview-plan-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const owner = { memberId: 'member', enterpriseId: 'enterprise' }
  const plans = new WorkPlanStore(root), checkpoints = new ArrangementCheckpointStore(root)
  const store = new DocumentPreviewStore(root, plans, checkpoints)
  const plan: WorkPlan = { id: 'task', schemaVersion: 1, sourceDraftId: 'draft', sourceDraftRevision: 1,
    owner, mode: 'auto', title: 'Report', goal: 'Report', conversation: null,
    nodes: [{ id: 'node', subscriptionId: 'sub', modelId: 'model', title: 'Report', instruction: 'Write', expectedOutput: 'Report',
      dependsOn: [], skillIds: [], requiresUserConfirmation: false,
      deliverables: [{ id: 'report', name: 'Report', path: 'report.md', format: 'md', contentOutline: ['Report'], acceptanceCriteria: ['Report'] }] }],
    workspace: { mode: 'shared', path: root }, permissions: { preset: 'workspace-edit', allowedTools: [], allowedPaths: [], deniedPaths: [], requireApprovalFor: [], commandPolicy: 'disabled' },
    confirmedInputs: [], planHash: 'hash', createdAt: 1 }
  const checkpoint: ArrangementCheckpoint = { version: 1, taskId: 'task', owner, planHash: 'hash', activeRunId: 'run', updatedAt: 1,
    state: { status: 'running', failureNodeIds: [], interruptionReason: null,
      nodes: [{ nodeId: 'node', status: 'completed', attempt: 1, error: null, output: null,
        delivery: { validationAttempts: 1, issues: [], finalFiles: [{ id: 'report', path: 'report.md', format: 'md', size: 5, sha256: 'a'.repeat(64), nodeRunId: 'node-run', validatedAt: 1 }] } },
      { nodeId: 'peer', status: 'running', attempt: 1, error: null, output: null }] } }
  await plans.save(owner, plan); await checkpoints.save(owner, checkpoint)
  assert.equal((await store.getDelivery(owner, 'task', 'node', 'report'))?.status, 'completed')
  assert.equal(await store.getDelivery({ ...owner, memberId: 'other' }, 'task', 'node', 'report'), null)
  assert.equal(await store.getDelivery(owner, 'task', 'peer', 'report'), null)
  assert.equal(await store.getDelivery(owner, 'task', 'node', 'forged'), null)
  await checkpoints.save(owner, { ...checkpoint, planHash: 'different-plan' })
  assert.equal(await store.getDelivery(owner, 'task', 'node', 'report'), null)
})
