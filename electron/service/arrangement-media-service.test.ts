import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import { ArrangementMediaService, type ArrangementMediaServiceOptions } from './arrangement-media-service'
import type { ArrangementNode } from '../domain/arrangement-plan'
import type { ArrangementMediaLink } from '../domain/arrangement-media'
import * as videoFixture from '../../src/shared/fixtures/media-video-v1.json'
import { videoReceiptSchema, videoRequestWithIdentitySchema } from '../../src/shared/video-media'

test('video-to-video arrangement uses video references in order and cannot fall back to text or image generation', async () => {
  const scope = { enterpriseId: 'enterprise', memberId: 'member' }
  const node: ArrangementNode = { id: 'node', subscriptionId: 'employee', modelId: 'model', title: 'Edit', instruction: 'Edit video', expectedOutput: 'Video', dependsOn: [], skillIds: [],
    mediaRequirements: [{ id: 'video', kind: 'video', operation: 'video-to-video', specRevision: 1, requiredSpec: { durationSeconds: 5 }, generationMethod: 'ai-generated' }] }
  const assets = ['video-a', 'video-b'].map(localAssetId => ({ localAssetId, taskId: 'task', name: `${localAssetId}.mp4`, mime: 'video/mp4', size: 32, sha256: 'a'.repeat(64), status: 'SAVED' }))
  const options = { scope: { currentScope: () => scope }, getTask: async () => ({ subscriptionId: 'employee' }),
    plans: { get: async () => ({ planHash: 'hash', nodes: [node], workspace: { path: '/workspace' } }) },
    checkpoints: { get: async () => null }, runs: { list: async () => [] }, links: { list: async () => [] },
    images: { listJobs: async () => [] }, assets: {}, media: {}, videoReferences: { list: async () => assets },
  } as unknown as ArrangementMediaServiceOptions
  const session = await new ArrangementMediaService(options).prepareNode({ taskId: 'task', arrangementRunId: 'arrangement', nodeRunId: 'run', attempt: 1, planHash: 'hash', node, signal: new AbortController().signal })
  const calls: unknown[] = []
  const tools = session.bind(undefined, { names: ['video_from_video', 'video_get_job'], execute: async (name, input) => {
    calls.push({ name, input }); return { jobId: 'new-video' }
  } }).video!
  await tools.execute('video_from_video', { creativeBrief: 'Edit', localVideoAssetIds: ['video-b', 'video-a'] })
  assert.equal((calls[0] as { name: string }).name, 'video_from_video')
  const input = (calls[0] as { input: { localVideoAssetIds: string[]; localAssetIds: string[]; requestedSpec: { durationSeconds: number } } }).input
  assert.deepEqual(input.localVideoAssetIds, ['video-b', 'video-a']); assert.deepEqual(input.localAssetIds, [])
  assert.equal(input.requestedSpec.durationSeconds, 5)
  await assert.rejects(tools.execute('video_from_video', { creativeBrief: 'Edit', localVideoAssetIds: ['foreign'] }), { code: 'PERMISSION_DENIED' })
  await assert.rejects(tools.execute('video_from_video', { creativeBrief: 'Edit', localVideoAssetIds: ['video-a'], localAssetIds: ['image-a'] }), { code: 'INVALID_ARGUMENT' })
  assert.equal(calls.length, 1)
})

async function imageFixture(operation: 'generate' | 'edit', count = 1, source = false) {
  const owner = { memberId: 'member', enterpriseId: 'enterprise' }
  const node: ArrangementNode = { id: 'node', subscriptionId: 'employee', modelId: 'model', title: 'Image', instruction: 'Image',
    expectedOutput: 'Image', dependsOn: [], skillIds: [],
    inputRefs: Array.from({ length: count }, (_, index) => ({ kind: 'attachment' as const, purpose: 'media-source' as const,
      required: true, attachment: { attachmentId: `attachment-${index}`, sha256: 'a'.repeat(64) } })),
    mediaRequirements: [{ id: 'image', kind: 'image', operation, ...(source ? { inputFrom: { artifactId: 'output-a' } } : {}) }] }
  const options = {
    scope: { currentScope: () => owner }, getTask: async () => ({ subscriptionId: 'employee' }),
    plans: { get: async () => ({ planHash: 'hash', nodes: [node], workspace: { path: '/workspace' } }) },
    checkpoints: { get: async () => null }, runs: { list: async () => [] }, links: { list: async () => [] },
    images: { listJobs: async () => [], getAsset: async (_scope: unknown, _taskId: string, id: string) => ({ localAssetId: id,
      taskId: 'task', source: 'reference', mime: 'image/png', status: 'SAVED', width: 1, height: 1, size: 1 }) },
    assets: { attachmentReference: async (_scope: unknown, _taskId: string, ref: { attachmentId: string }) =>
      ({ artifactId: 'ref-' + ref.attachmentId, sha256: 'a'.repeat(64) }),
    reference: async () => ({ artifactId: 'ref-output', sha256: 'a'.repeat(64) }) }, media: {},
  } as unknown as ArrangementMediaServiceOptions
  const session = await new ArrangementMediaService(options).prepareNode({ taskId: 'task', arrangementRunId: 'arrangement', nodeRunId: 'run',
    attempt: 1, planHash: 'hash', node, signal: new AbortController().signal })
  const calls: Array<Record<string, unknown>> = []
  const tools = (capabilities = MOCK_MEDIA_CAPABILITIES) => session.bind({ names: ['media_get_capabilities', 'media_generate_image'],
    execute: async (name, raw) => {
      if (name === 'media_get_capabilities') return { capabilities, referenceAssets: [] }
      calls.push(raw as Record<string, unknown>); return { jobId: 'job' }
    } }).media!
  return { session, calls, tools }
}

test('image arrangement does not infer edit or pass references merely because attachments exist', async () => {
  const f = await imageFixture('generate', 2)
  await f.tools().execute('media_generate_image', { creativeBrief: 'A new image' })
  assert.equal(f.calls[0]!.operation, 'generate')
  assert.deepEqual(f.calls[0]!.localAssetIds, [])
})

test('image arrangement requires a single explicit candidate when multiple references are bound', async () => {
  const f = await imageFixture('edit', 2), tools = f.tools()
  await assert.rejects(tools.execute('media_generate_image', { creativeBrief: 'Edit product' }), { code: 'INVALID_ARGUMENT' })
  assert.equal(f.calls.length, 0)
  await tools.execute('media_generate_image', { creativeBrief: 'Edit product', localAssetIds: ['ref-attachment-1'] })
  assert.equal(f.calls[0]!.operation, 'edit')
  assert.deepEqual(f.calls[0]!.localAssetIds, ['ref-attachment-1'])
  await assert.rejects(tools.execute('media_generate_image', { creativeBrief: 'Edit', localAssetIds: ['foreign'] }), { code: 'PERMISSION_DENIED' })
})

test('image arrangement chooses the requirement input rather than all bound references', async () => {
  const f = await imageFixture('edit', 2, true)
  await f.tools().execute('media_generate_image', { creativeBrief: 'Edit previous output' })
  assert.deepEqual(f.calls[0]!.localAssetIds, ['ref-output'])
})

test('image arrangement checks edit operation authorization before dispatching generation', async () => {
  const f = await imageFixture('edit')
  const tools = f.tools({ ...MOCK_MEDIA_CAPABILITIES,
    profiles: MOCK_MEDIA_CAPABILITIES.profiles.map(profile => ({ ...profile, operations: ['generate'] })) })
  await assert.rejects(tools.execute('media_generate_image', { creativeBrief: 'Edit product' }), { code: 'PERMISSION_DENIED' })
  assert.equal(f.calls.length, 0)
})

test('image arrangement keeps a unique planned reference and rejects missing, conflicting or substituted inputs', async () => {
  const f = await imageFixture('edit'), tools = f.tools()
  await tools.execute('media_generate_image', { creativeBrief: 'Edit the only bound image' })
  assert.deepEqual(f.calls[0]!.localAssetIds, ['ref-attachment-0'])
  await assert.rejects(tools.execute('media_generate_image', { creativeBrief: 'Wrong operation', operation: 'generate' }), { code: 'SPEC_CONFLICT' })
  await assert.rejects(tools.execute('media_generate_image', { creativeBrief: 'Wrong requirement', requirementId: 'unknown' }), { code: 'SPEC_CONFLICT' })
  const empty = await imageFixture('edit', 0)
  await assert.rejects(empty.tools().execute('media_generate_image', { creativeBrief: 'No source' }), { code: 'INVALID_ARGUMENT' })
  const bound = await imageFixture('edit', 1, true)
  await assert.rejects(bound.tools().execute('media_generate_image', { creativeBrief: 'Substituted source', localAssetIds: ['ref-attachment-0'] }), { code: 'SPEC_CONFLICT' })
  const generated = await imageFixture('generate')
  await assert.rejects(generated.tools().execute('media_generate_image', { creativeBrief: 'New image', localAssetIds: ['ref-attachment-0'] }), { code: 'INVALID_ARGUMENT' })
  assert.equal(empty.calls.length + bound.calls.length + generated.calls.length, 0)
})

async function fixture(specRevisions?: Record<string, number>, existing: ArrangementMediaLink[] = [], multiple = false, replacement = false) {
  const owner = { memberId: 'member', enterpriseId: 'enterprise' }
  const node: ArrangementNode = { id: 'node', subscriptionId: 'employee', modelId: 'model', title: 'Video', instruction: 'Generate video',
    expectedOutput: 'AI video', dependsOn: [], skillIds: [], mediaRequirements: [{ id: 'video', kind: 'video', operation: 'text-to-video',
      specRevision: 2, requiredSpec: { durationSeconds: 8, aspectRatio: '9:16', audio: false }, proposedSpec: { resolution: '8k', frameRate: 29.97 }, generationMethod: 'ai-generated' }] }
  if (multiple) {
    node.mediaRequirements!.push({ ...node.mediaRequirements![0]!, id: 'video-b' })
    node.deliverables = [{ id: 'result', path: 'result.mp4', name: 'Result', contentOutline: [], acceptanceCriteria: [],
      format: 'mp4', artifact: { kind: 'video', source: 'media-output', operation: 'text-to-video' } }]
  }
  if (replacement) node.subscriptionId = 'replacement'
  const saved: ArrangementMediaLink[] = [...existing]
  const options = {
    scope: { currentScope: () => owner }, getTask: async () => ({ subscriptionId: 'employee' }),
    plans: { get: async () => ({ planHash: 'hash', nodes: [node], workspace: { path: '/workspace' } }) },
    checkpoints: { get: async () => specRevisions || replacement ? { planHash: 'hash', state: { nodes: [{ nodeId: node.id, mediaSpecRevisions: specRevisions,
      ...(replacement ? { employeeReplacement: { nodeId: node.id, status: 'replaced', originalSubscriptionId: 'employee', replacementSubscriptionId: 'replacement' } } : {}) }] } } : null }, runs: { list: async () => [], get: async () => ({ arrangementNodeId: 'node', subscriptionId: 'employee' }) },
    links: { list: async () => saved, upsert: async (_scope: unknown, link: ArrangementMediaLink) => { saved.push(link); return link } },
    images: { listJobs: async () => [] }, videos: { listJobs: async () => [], getJob: async (_scope: unknown, _taskId: string, jobId: string) => ({ runId: saved.find(link => link.jobId === jobId)?.nodeRunId ?? 'run' }) },
    assets: { outputs: async () => replacement ? existing.flatMap(link => link.outputs.map(output => ({ ...output, kind: link.kind, size: 1, mime: 'video/mp4' }))) : [] }, media: {},
  } as unknown as ArrangementMediaServiceOptions
  const service = new ArrangementMediaService(options)
  const session = await service.prepareNode({ taskId: 'task', arrangementRunId: 'arrangement', nodeRunId: 'run', attempt: 1, planHash: 'hash', node, signal: new AbortController().signal, ...(specRevisions ? { specRevisions } : {}) })
  return { session, saved, node }
}

test('a replacement reuses the original employee saved media without a new paid tool call', async () => {
  const link: ArrangementMediaLink = { version: 1, owner: { memberId: 'member', enterpriseId: 'enterprise' }, taskId: 'task',
    arrangementRunId: 'parent', nodeId: 'node', nodeRunId: 'prior-run', attempt: 1, subscriptionId: 'employee', kind: 'video', operation: 'text-to-video',
    jobId: 'original-job', requirementId: 'video', specRevision: 2, inputs: [],
    outputs: [{ artifactId: 'saved-artifact', sha256: 'a'.repeat(64), status: 'saved' }], materializations: [], createdAt: 1, updatedAt: 1 }
  const f = await fixture(undefined, [link], false, true)
  const tools = f.session.bind(undefined, { names: ['video_generate'], execute: async () => { assert.fail('must reuse original media locally') } }).video!
  const result = await tools.execute('video_generate', { requirementId: 'video', creativeBrief: 'Original video' }, new AbortController().signal) as { jobId: string; artifacts: Array<{ artifactId: string }> }
  assert.equal(result.jobId, 'original-job')
  assert.equal(result.artifacts[0]?.artifactId, 'saved-artifact')
})

test('arrangement bridge carries exact user requirements, model suggestions and durable requirement identity', async () => {
  const f = await fixture()
  let captured: unknown
  const tools = f.session.bind(undefined, { names: ['video_generate'], execute: async (_name, input) => {
    captured = input
    await f.session.onJobCreated({ kind: 'video', operation: 'text-to-video', jobId: 'job', localAssetIds: [] })
    return { jobId: 'job' }
  } }).video!
  await tools.execute('video_generate', { creativeBrief: 'Product on a plain background' }, new AbortController().signal)
  assert.deepEqual(captured, { creativeBrief: 'Product on a plain background', protocolVersion: 3, specRevision: 2,
    requestedSpec: { durationSeconds: 8, aspectRatio: '9:16', audio: false, resolution: '8k', frameRate: 29.97 },
    parameterSources: { durationSeconds: 'user', aspectRatio: 'user', audio: 'user', resolution: 'model', frameRate: 'model' }, localAssetIds: [] })
  assert.equal(f.saved[0]!.requirementId, 'video')
  assert.equal(f.saved[0]!.specRevision, 2)
})

test('arrangement bridge rejects changed user specs before calling the host and clears failed submissions', async () => {
  const f = await fixture()
  let calls = 0
  const tools = f.session.bind(undefined, { names: ['video_generate'], execute: async () => { calls++; throw new Error('Unavailable upstream') } }).video!
  await assert.rejects(tools.execute('video_generate', { creativeBrief: 'Product', requestedSpec: { durationSeconds: 4 } }, new AbortController().signal), /规格/)
  assert.equal(calls, 0)
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(tools.execute('video_generate', { creativeBrief: 'Product' }, new AbortController().signal), /Unavailable upstream/)
  }
  assert.equal(calls, 2)
})

test('a persisted reply revision applies to new jobs without mutating the frozen plan', async () => {
  const f = await fixture({ video: 3 })
  let revision: unknown
  const tools = f.session.bind(undefined, { names: ['video_generate'], execute: async (_name, input) => {
    revision = (input as { specRevision: number }).specRevision
    await f.session.onJobCreated({ kind: 'video', operation: 'text-to-video', jobId: 'new-job', localAssetIds: [] })
  } }).video!
  await tools.execute('video_generate', { creativeBrief: 'Product' }, new AbortController().signal)
  assert.equal(revision, 3)
  assert.equal(f.saved[0]!.specRevision, 3)
  assert.equal(f.node.mediaRequirements![0]!.specRevision, 2)
})

for (const kind of ['image', 'video'] as const) test(`${kind} output spec mismatch handling`, async () => {
  const owner = { memberId: 'member', enterpriseId: 'enterprise' }
  const operation = kind === 'image' ? 'generate' : 'text-to-video'
  const node: ArrangementNode = { id: 'node', subscriptionId: 'employee', modelId: 'model', title: 'Media', instruction: 'Generate media',
    expectedOutput: 'Media', dependsOn: [], skillIds: [], deliverables: [{ id: 'result', path: kind === 'image' ? 'result.png' : 'result.mp4',
      name: 'Result', contentOutline: [], acceptanceCriteria: [], format: kind === 'image' ? 'png' : 'mp4', artifact: { kind, source: 'media-output', operation } }] }
  const link: ArrangementMediaLink = { version: 1, owner, taskId: 'task', arrangementRunId: 'arrangement', nodeId: 'node', nodeRunId: 'run',
    attempt: 1, subscriptionId: 'employee', kind, operation, jobId: 'job', requirementId: 'video', specRevision: 2, inputs: [], outputs: [{ artifactId: 'artifact', sha256: 'a'.repeat(64), status: 'saved' }],
    materializations: [], createdAt: 1, updatedAt: 1 }
  const imageJob = { runId: 'run', subscriptionId: 'employee', error: null, errorCode: 'OUTPUT_SPEC_MISMATCH' }
  const videoJob = { runId: 'run', request: videoRequestWithIdentitySchema.parse({ ...videoFixture.request, protocolVersion: 3, specRevision: 1,
    parameters: { width: videoFixture.output.width + 1 }, requestedSpec: { width: videoFixture.output.width + 1 }, parameterSources: {} }),
    receipt: videoReceiptSchema.parse({ ...videoFixture.receipts.succeeded, acceptance: 'mismatched', deliveryStatus: 'mismatched', outputs: [videoFixture.output] }) }
  const before = structuredClone(kind === 'image' ? imageJob : videoJob)
  let materialized = 0
  const options = {
    scope: { currentScope: () => owner }, getTask: async () => ({ subscriptionId: 'employee' }),
    plans: { get: async () => ({ planHash: 'hash', nodes: [node], workspace: { path: '/workspace' } }) },
    checkpoints: { get: async () => null }, runs: { list: async () => [], get: async () => ({ arrangementNodeId: 'node', subscriptionId: 'employee' }) },
    links: { list: async () => [link], upsert: async (_scope: unknown, value: ArrangementMediaLink) => value },
    images: { listJobs: async () => [], getJob: async () => imageJob }, videos: { listJobs: async () => [], getJob: async () => videoJob },
    assets: { outputs: async () => [{ artifactId: 'artifact', kind, sha256: 'a'.repeat(64), size: 1, mime: kind === 'image' ? 'image/png' : 'video/mp4', status: 'saved' }],
      materialize: async () => { materialized++; return { id: 'result', path: 'result.mp4', format: 'mp4', size: 1,
        sha256: 'a'.repeat(64), sourceArtifact: { kind: 'video', artifactId: 'artifact', sha256: 'a'.repeat(64) }, nodeRunId: 'run', validatedAt: 1 } } }, media: {},
  } as unknown as ArrangementMediaServiceOptions
  const session = await new ArrangementMediaService(options).prepareNode({ taskId: 'task', arrangementRunId: 'arrangement', nodeRunId: 'run', attempt: 1, planHash: 'hash', node, signal: new AbortController().signal })
  if (kind === 'image') {
    await assert.rejects(session.automaticSubmission(), /规格不符/)
    await assert.rejects(session.materialize({ nodeId: 'node', summary: 'Done', finalDeliverables: [{ id: 'result', path: node.deliverables![0]!.path }],
      mediaDeliverables: [{ deliverableId: 'result', artifactId: 'artifact' }] }), /规格不符/)
    assert.equal(materialized, 0)
  } else {
    const submission = await session.automaticSubmission()
    assert.ok(submission)
    assert.deepEqual(submission.mediaDeliverables, [{ deliverableId: 'result', artifactId: 'artifact' }])
    const files = await session.materialize(submission)
    assert.equal(files[0]?.sourceArtifact?.artifactId, 'artifact')
    assert.equal(materialized, 1)
  }
  assert.deepEqual(kind === 'image' ? imageJob : videoJob, before)
  assert.deepEqual(link.materializations, [])
})


test('a resumed node generates only unsubmitted requirements and recovers the requested original job', async () => {
  const original: ArrangementMediaLink = { version: 1, owner: { memberId: 'member', enterpriseId: 'enterprise' },
    taskId: 'task', arrangementRunId: 'arrangement', nodeId: 'node', nodeRunId: 'prior-run', attempt: 1,
    subscriptionId: 'employee', kind: 'video', operation: 'text-to-video', jobId: 'first-job', requirementId: 'video', specRevision: 2,
    inputs: [], outputs: [], materializations: [], createdAt: 1, updatedAt: 1 }
  const f = await fixture(undefined, [original], true)
  assert.equal(f.session.readyForTracking(), false)
  const calls: Array<{ name: string; input: unknown }> = []
  const tools = f.session.bind(undefined, { names: ['video_generate'], execute: async (name, input) => {
    calls.push({ name, input })
    if (name === 'video_generate') {
      assert.equal('requirementId' in (input as object), false)
      await f.session.onJobCreated({ kind: 'video', operation: 'text-to-video', jobId: 'second-job', localAssetIds: [] })
      return { jobId: 'second-job' }
    }
    return { jobId: (input as { jobId: string }).jobId }
  } }).video!
  const signal = new AbortController().signal
  const recovered = await tools.execute('video_generate', { creativeBrief: 'Existing', requirementId: 'video' }, signal)
  assert.equal((recovered as { jobId: string }).jobId, 'first-job')
  const generated = await tools.execute('video_generate', { creativeBrief: 'Remaining', requirementId: 'video-b' }, signal)
  assert.equal((generated as { jobId: string }).jobId, 'second-job')
  assert.equal(f.saved.find(link => link.jobId === 'second-job')!.requirementId, 'video-b')
  assert.equal(f.session.readyForTracking(), true)
  const retried = await tools.execute('video_generate', { creativeBrief: 'Already submitted', requirementId: 'video-b' }, signal)
  assert.equal((retried as { jobId: string }).jobId, 'second-job')
  assert.deepEqual(calls.map(call => call.name), ['video_get_job', 'video_generate', 'video_get_job'])
  await assert.rejects(tools.execute('video_generate', { creativeBrief: 'Unknown', requirementId: 'unplanned' }, signal), /需求/)
  assert.equal(calls.length, 3)
})

test('multiple identical specifications require an explicit requirement before any paid submission', async () => {
  const f = await fixture(undefined, [], true)
  let calls = 0
  const tools = f.session.bind(undefined, { names: ['video_generate'], execute: async () => { calls++ } }).video!
  await assert.rejects(tools.execute('video_generate', { creativeBrief: 'Ambiguous' }, new AbortController().signal), /需求/)
  assert.equal(calls, 0)
})


test('an optional request cannot satisfy an unsubmitted mandatory requirement of the same operation', async () => {
  const f = await fixture(undefined, [], true)
  f.node.mediaRequirements![0]!.required = false
  const tools = f.session.bind(undefined, { names: ['video_generate'], execute: async () => {
    await f.session.onJobCreated({ kind: 'video', operation: 'text-to-video', jobId: 'optional-job', localAssetIds: [] })
    return { jobId: 'optional-job' }
  } }).video!
  await tools.execute('video_generate', { creativeBrief: 'Optional', requirementId: 'video' }, new AbortController().signal)
  assert.equal(f.session.readyForTracking(), false)
  assert.equal(await f.session.automaticSubmission(), undefined)
  await assert.rejects(f.session.materialize({ nodeId: 'node', summary: 'Done', finalDeliverables: [{ id: 'result', path: 'result.mp4' }], mediaDeliverables: [] }), /需求/)
})

import { afterEach } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkPlanStore } from '../data/work-plan-store'
import { TaskRunStore } from '../data/task-run-store'
import { ArrangementCheckpointStore } from '../data/arrangement-checkpoint-store'
import { ArrangementMediaLinkStore } from '../data/arrangement-media-link-store'
import { MediaStore } from '../data/media-store'
import { MOCK_MEDIA_CAPABILITIES } from '../data/mock-media-gateway'
import type { WorkPlan } from '../domain/arrangement-plan'
import type { LocalMediaJob } from '../domain/media'
import { ArrangementMediaSubmissionError, type ArrangementMediaAsset } from '../domain/arrangement-media-runtime'

const scope = { memberId: 'member', enterpriseId: 'enterprise' }
const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

async function mappingFixture(materializations: ArrangementMediaLink['materializations'] = []) {
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
  const f = await mappingFixture()
  await assert.rejects(f.submit('wrong'), error => error instanceof ArrangementMediaSubmissionError && error.message.includes('image/jpeg'))
  assert.equal(f.copies(), 0)
  assert.deepEqual((await f.links.get(scope, 'task', 'image', 'job'))!.materializations, [])
  assert.equal((await f.submit('correct'))[0]!.sourceArtifact!.artifactId, 'correct')
})

test('allows correcting an old uncommitted mapping without rebinding a verified delivery', async () => {
  const f = await mappingFixture([{ deliverableId: 'picture', path: 'deliverables/picture.png', sourceArtifactId: 'wrong', status: 'pending' }])
  assert.equal((await f.submit('correct'))[0]!.sourceArtifact!.artifactId, 'correct')
  await assert.rejects(f.submit('another'), error => error instanceof ArrangementMediaSubmissionError && error.message.includes('correct'))
  assert.equal((await f.links.get(scope, 'task', 'image', 'job'))!.materializations[0]!.sourceArtifactId, 'correct')
})

test('exposes verified candidate formats and sizes to the correction prompt', async () => {
  const f = await mappingFixture()
  const summary = await f.session.artifactSummary()
  assert.deepEqual(summary[0]!.assets.find(asset => asset.artifactId === 'correct'),
    { artifactId: 'correct', sha256: 'b'.repeat(64), status: 'saved', mime: 'image/png', size: 20 })
})
