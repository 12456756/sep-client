import { afterEach, test } from 'node:test'
import * as assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ArrangementMediaService } from './arrangement-media-service'
import { WorkPlanStore } from '../data/work-plan-store'
import { TaskRunStore } from '../data/task-run-store'
import { ArrangementCheckpointStore } from '../data/arrangement-checkpoint-store'
import { ArrangementMediaLinkStore } from '../data/arrangement-media-link-store'
import { MediaStore } from '../data/media-store'
import { MOCK_MEDIA_CAPABILITIES } from '../data/mock-media-gateway'
import type { ArrangementMediaLink } from '../domain/arrangement-media'
import type { WorkPlan } from '../domain/arrangement-plan'
import type { LocalMediaJob } from '../domain/media'
import { ArrangementMediaSubmissionError, type ArrangementMediaAsset } from '../domain/arrangement-media-runtime'

const scope = { memberId: 'member', enterpriseId: 'enterprise' }
const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

async function fixture(materializations: ArrangementMediaLink['materializations'] = []) {
  const root = await mkdtemp(join(tmpdir(), 'sep-media-mapping-'))
  roots.push(root)
  const plans = new WorkPlanStore(root), runs = new TaskRunStore(root), links = new ArrangementMediaLinkStore(root), images = new MediaStore(root)
  const node: WorkPlan['nodes'][number] = { id: 'node', subscriptionId: 'employee', modelId: 'model', title: 'Image', objective: 'Image',
    instruction: 'Create image', expectedOutput: 'Image', dependsOn: [], skillIds: [], requiresUserConfirmation: false,
    deliverables: [{ id: 'picture', name: 'Picture', format: 'png', path: 'deliverables/picture.png',
      contentOutline: ['Image'], acceptanceCriteria: ['Saved image'], artifact: { kind: 'image', source: 'media-output' } }] }
  await plans.save(scope, { id: 'task', owner: scope, schemaVersion: 1, sourceDraftId: 'draft', sourceDraftRevision: 1,
    mode: 'auto', title: 'Images', goal: 'Images', conversation: null, nodes: [node], workspace: { mode: 'shared', path: root },
    confirmedInputs: [], planHash: 'plan', createdAt: 1, permissions: { preset: 'workspace-edit', allowedTools: [], allowedPaths: [],
      deniedPaths: [], requireApprovalFor: [], commandPolicy: 'disabled' } })
  await runs.create(scope, { taskId: 'task', runId: 'node-run', subscriptionId: 'employee', modelId: 'model', runtimeKey: 'runtime',
    workspaceDir: root, prompt: 'Image', arrangementNodeId: 'node', executionKind: 'arrangement' })
  const profile = MOCK_MEDIA_CAPABILITIES.profiles[0]!
  const input = { profileId: profile.profileId, operation: 'generate' as const, creativeBrief: 'Image', localAssetIds: [], parameters: { count: 1, aspectRatio: '1:1' } }
  const job: LocalMediaJob = { version: 1, owner: scope, taskId: 'task', jobId: 'job', runId: 'node-run', subscriptionId: 'employee',
    clientRequestId: 'request', requestHash: 'a'.repeat(64), input, profile,
    request: { clientRequestId: 'request', requestHash: 'a'.repeat(64), quoteId: 'quote', profileId: profile.profileId, configVersion: profile.configVersion,
      operation: 'generate', creativeBrief: 'Image', referenceIds: [], referenceHashes: [], parameters: input.parameters },
    quote: { quoteId: 'quote', requestHash: 'a'.repeat(64), expiresAt: 100, status: 'quoted', amount: '0', currency: 'MOCK',
      authorized: true, budgetAuthorized: true, allowUnknownCost: false }, approval: 'manual', receiptId: 'receipt', submission: 'RECEIPTED',
    generationStatus: 'SUCCEEDED', trackingStatus: 'ACTIVE', saveStatus: 'SAVED', outputs: [], billingStatus: 'UNKNOWN', nextPollAt: 0,
    attempts: 1, error: null, createdAt: 1, updatedAt: 1 }
  await images.saveJob(scope, job)
  const assets: ArrangementMediaAsset[] = [
    { artifactId: 'wrong', kind: 'image', mime: 'image/jpeg', sha256: 'a'.repeat(64), size: 10, status: 'saved' },
    { artifactId: 'correct', kind: 'image', mime: 'image/png', sha256: 'b'.repeat(64), size: 20, status: 'saved' },
    { artifactId: 'another', kind: 'image', mime: 'image/png', sha256: 'c'.repeat(64), size: 30, status: 'saved' },
  ]
  await links.upsert(scope, { version: 1, owner: scope, taskId: 'task', arrangementRunId: 'arrangement', nodeId: 'node', nodeRunId: 'node-run',
    attempt: 1, subscriptionId: 'employee', kind: 'image', operation: 'generate', jobId: 'job', inputs: [],
    outputs: assets.map(asset => ({ artifactId: asset.artifactId, sha256: asset.sha256, status: 'saved' })), materializations, createdAt: 1, updatedAt: 1 })
  let copies = 0
  const service = new ArrangementMediaService({ scope: { currentScope: () => scope }, plans, runs, links, images,
    checkpoints: new ArrangementCheckpointStore(root), media: { prepareRun: async () => undefined, waitForRun: async () => {}, stopTask: async () => {} },
    getTask: async () => ({ subscriptionId: 'employee' }), assets: { outputs: async () => assets,
      reference: async () => { throw new Error('No reference expected') },
      materialize: async (_scope, _task, _workspace, deliverable, _link, artifactId) => {
        copies++
        const asset = assets.find(item => item.artifactId === artifactId)!
        if (asset.mime !== 'image/png') throw new Error('MEDIA_MIME_MISMATCH')
        return { id: deliverable.id, path: deliverable.path, format: deliverable.format, size: asset.size, sha256: asset.sha256,
          sourceArtifact: { kind: 'image', artifactId, sha256: asset.sha256 }, nodeRunId: 'node-run', validatedAt: 1 }
      } } })
  const session = await service.prepareNode({ taskId: 'task', arrangementRunId: 'arrangement', nodeRunId: 'node-run', attempt: 1,
    planHash: 'plan', node, signal: new AbortController().signal })
  const submit = (artifactId: string) => session.materialize({ nodeId: node.id, summary: 'Done', finalDeliverables: [{ id: 'picture', path: 'deliverables/picture.png' }],
    mediaDeliverables: [{ deliverableId: 'picture', artifactId }] })
  return { session, links, submit, copies: () => copies }
}

test('rejects an incompatible candidate before persisting a pending mapping, then accepts the corrected original', async () => {
  const f = await fixture()
  await assert.rejects(f.submit('wrong'), error => error instanceof ArrangementMediaSubmissionError && error.message.includes('image/jpeg'))
  assert.equal(f.copies(), 0)
  assert.deepEqual((await f.links.get(scope, 'task', 'image', 'job'))!.materializations, [])
  assert.equal((await f.submit('correct'))[0]!.sourceArtifact!.artifactId, 'correct')
})

test('allows correcting an old uncommitted mapping without rebinding a verified delivery', async () => {
  const f = await fixture([{ deliverableId: 'picture', path: 'deliverables/picture.png', sourceArtifactId: 'wrong', status: 'pending' }])
  assert.equal((await f.submit('correct'))[0]!.sourceArtifact!.artifactId, 'correct')
  await assert.rejects(f.submit('another'), error => error instanceof ArrangementMediaSubmissionError && error.message.includes('correct'))
  assert.equal((await f.links.get(scope, 'task', 'image', 'job'))!.materializations[0]!.sourceArtifactId, 'correct')
})

test('exposes verified candidate formats and sizes to the correction prompt', async () => {
  const f = await fixture()
  const summary = await f.session.artifactSummary()
  assert.deepEqual(summary[0]!.assets.find(asset => asset.artifactId === 'correct'),
    { artifactId: 'correct', sha256: 'b'.repeat(64), status: 'saved', mime: 'image/png', size: 20 })
})
