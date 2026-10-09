import { after, describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { WorkPlanStore } from './work-plan-store'
import type { WorkPlan } from '../domain/arrangement-plan'
import { ScopePath } from './scope-path'

const scope = { memberId: 'member-a', enterpriseId: 'enterprise-a' }
const roots: string[] = []

after(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function plan(): WorkPlan {
  return {
    id: 'task-plan-a', schemaVersion: 1, sourceDraftId: 'draft-a', sourceDraftRevision: 2,
    owner: scope, mode: 'manual', title: 'Report', goal: 'Build report', conversation: null,
    nodes: [{ id: 'n1', subscriptionId: 'sub-a', modelId: 'model-a', title: 'Collect', instruction: 'Collect', expectedOutput: 'data', dependsOn: [], skillIds: [], requiresUserConfirmation: false }],
    workspace: { mode: 'shared', path: null },
    permissions: { preset: 'read-only', allowedTools: ['read', 'grep', 'find', 'ls'], allowedPaths: [], deniedPaths: [], requireApprovalFor: ['write', 'edit', 'bash'], commandPolicy: 'disabled' },
    confirmedInputs: [], planHash: 'hash-a', createdAt: Date.now(),
  }
}

describe('WorkPlanStore', () => {
  it('diagnoses valid backup, conversation mode, corruption and scope independently', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sep-work-plan-diagnostic-'))
    roots.push(root)
    const store = new WorkPlanStore(root)
    const conversation = { ...plan(), mode: 'conversation' as const }
    await store.save(scope, conversation)
    await store.save(scope, plan())
    const file = new ScopePath(root).workPlanFile(scope, conversation.id)
    await writeFile(file, 'broken')
    assert.deepEqual(await store.diagnose(scope, conversation.id), { state: 'found', value: conversation })
    assert.deepEqual(await store.diagnose({ ...scope, enterpriseId: 'other' }, conversation.id), { state: 'missing' })
    await rm(`${file}.bak`)
    for (let i = 0; i < 2; i += 1) assert.deepEqual(await store.diagnose(scope, conversation.id), { state: 'unavailable' })
    assert.equal(await store.get(scope, conversation.id), null)
    assert.deepEqual(await store.diagnose(scope, conversation.id), { state: 'unavailable' })
  })
  it('persists an immutable plan under the owner scope', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sep-work-plan-'))
    roots.push(root)
    const store = new WorkPlanStore(root)
    await store.save(scope, plan())
    const loaded = await new WorkPlanStore(root).get(scope, 'task-plan-a')
    assert.equal(loaded?.planHash, 'hash-a')
    assert.equal(await store.get({ memberId: 'other', enterpriseId: scope.enterpriseId }, 'task-plan-a'), null)
  })
})

