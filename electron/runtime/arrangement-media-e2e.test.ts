import { afterEach, test } from 'node:test'
import * as assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import type { ExtensionFactory, ToolDefinition } from '@earendil-works/pi-coding-agent'
import * as videoFixture from '../../src/shared/fixtures/media-video-v1.json'
import { videoReceiptSchema, videoRuntimeSchema } from '../../src/shared/video-media'
import { TaskStatus, type ToolAuthorizationRequest } from '../../src/shared/types'
import { ArrangementCheckpointStore } from '../data/arrangement-checkpoint-store'
import { ArrangementMediaAssets } from '../data/arrangement-media-assets'
import { ArrangementMediaLinkStore } from '../data/arrangement-media-link-store'
import { MediaStore } from '../data/media-store'
import { MockMediaGateway, MOCK_MEDIA_CAPABILITIES, MOCK_MEDIA_PNG, type MockMediaGatewayOptions } from '../data/mock-media-gateway'
import { MockVideoMediaGateway, MOCK_VIDEO_BYTES, type MockVideoScenario } from '../data/mock-video-media-gateway'
import { TaskRunStore } from '../data/task-run-store'
import { VideoStore } from '../data/video-store'
import { createVideoScopeAdapter } from '../data/video-scope-adapter'
import { WorkPlanStore } from '../data/work-plan-store'
import { ScopePath } from '../data/scope-path'
import type { ArrangementDraft, WorkPlan } from '../domain/arrangement-plan'
import { parseArrangementPlannerOutput } from '../domain/arrangement-planner'
import { buildExtensions } from '../pi/sdk/pi-coding-agent-adapter'
import type { PiTaskWorkerOptions } from '../pi/sdk/pi-task-worker'
import { ArrangementMediaService } from '../service/arrangement-media-service'
import { MediaService } from '../service/media-service'
import { MockVideoHostService } from '../service/mock-video-host-service'
import { VideoRunService } from '../service/video-run-service'
import { TaskManager } from './task-manager'
import { TaskRuntime } from './task-runtime'
import type { EmployeeRuntimeConfig } from './run-types'

const scope = { memberId: 'media-e2e-member', enterpriseId: 'media-e2e-enterprise' }
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

async function waitFor(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 12_000
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.fail('The media arrangement did not settle.')
}

// Exercise the actual Pi result whitelist as well as the application services.
async function toolsFor(options: PiTaskWorkerOptions) {
  const definitions = new Map<string, ToolDefinition>()
  const api = { registerTool(tool: ToolDefinition) { definitions.set(tool.name, tool) }, on() {}, getActiveTools: () => [...definitions.keys()] }
  for (const factory of buildExtensions({
    ...options.context, getAccessToken: async () => 'local-test', authorizeTool: async () => true,
  }, { tools: [], permissions: new Map(), dispose: async () => {} })) await factory(api as unknown as Parameters<ExtensionFactory>[0])
  return async (name: string, input: unknown): Promise<Record<string, unknown>> => {
    const definition = definitions.get(name)
    assert.ok(definition, `Missing Pi tool ${name}`)
    const result = await definition.execute('local-call', input, new AbortController().signal, undefined, {} as never)
    const content = result.content.find(part => part.type === 'text')
    assert.ok(content?.type === 'text')
    const value = JSON.parse(content.text) as Record<string, unknown>
    assert.ok(typeof value.jobId === 'string' || value.error === undefined, content.text)
    return value
  }
}

interface Scenario {
  plannerShape?: '14:43' | '14:50'
  confirmation?: boolean
  textVideo?: boolean
  imageGateway?: MockMediaGatewayOptions
  videoScenario?: MockVideoScenario
  denyApproval?: boolean
  foreignMapping?: boolean
  missingVideoCapability?: boolean
  holdNode?: 'image' | 'video'
  correctMapping?: boolean
  associationFailure?: boolean
}

async function fixture(scenario: Scenario = {}) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'sep-media-e2e-'))
  cleanups.push(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }))
  const runs = new TaskRunStore(root), plans = new WorkPlanStore(root), checkpoints = new ArrangementCheckpointStore(root)
  const links = new ArrangementMediaLinkStore(root), images = new MediaStore(root), videos = new VideoStore(root)
  const manager = new TaskManager(root, null, undefined, runs, checkpoints)
  await manager.initialize()
  await manager.setCurrentUser(scope.memberId, scope.enterpriseId)
  const task = await manager.createTask('Media workflow', 'Create an image and video', undefined, 'image-employee')
  const workspace = task.workDir!
  await mkdir(workspace, { recursive: true })
  const imageNode: WorkPlan['nodes'][number] = {
    id: 'image', subscriptionId: 'image-employee', modelId: 'image-model', title: 'Image', objective: 'Create image',
    instruction: 'Create a product image', expectedOutput: 'Image', dependsOn: [], skillIds: [], requiresUserConfirmation: !!scenario.confirmation,
    mediaRequirements: [{ id: 'generate-picture', kind: 'image', operation: 'generate' }],
    deliverables: [{ id: 'picture', name: 'Picture', format: 'png', path: 'deliverables/picture.png',
      contentOutline: ['Product'], acceptanceCriteria: ['Saved image'], artifact: { kind: 'image', source: 'media-output' } }],
  }
  const videoNode: WorkPlan['nodes'][number] = {
    id: 'video', subscriptionId: 'video-employee', modelId: 'video-model', title: 'Video', objective: 'Create video',
    instruction: 'Create a product video', expectedOutput: 'Video', dependsOn: scenario.textVideo ? [] : ['image'], skillIds: [], requiresUserConfirmation: false,
    mediaRequirements: [{ id: 'generate-movie', kind: 'video', operation: scenario.textVideo ? 'text-to-video' : 'image-to-video',
      ...(!scenario.textVideo ? { inputFrom: { nodeId: 'image', deliverableId: 'picture' } } : {}) }],
    deliverables: [{ id: 'movie', name: 'Movie', format: 'mp4', path: 'deliverables/movie.mp4',
      contentOutline: ['Product movement'], acceptanceCriteria: ['Saved video'], artifact: { kind: 'video', source: 'media-output' } }],
  }
  const plan: WorkPlan = {
    id: task.id, owner: scope, schemaVersion: 1, sourceDraftId: 'draft', sourceDraftRevision: 1, mode: 'auto',
    title: 'Media workflow', goal: task.prompt, conversation: null, nodes: scenario.textVideo ? [videoNode] : [imageNode, videoNode],
    workspace: { mode: 'shared', path: workspace }, confirmedInputs: [], planHash: 'media-plan-hash', createdAt: Date.now(),
    permissions: { preset: 'workspace-edit', allowedTools: ['read', 'write', 'media_get_capabilities', 'media_generate_image', 'media_get_job', 'video_from_image', 'video_generate', 'video_get_job'],
      allowedPaths: [], deniedPaths: [], requireApprovalFor: [], commandPolicy: 'disabled', approvalMode: 'confirm-each' },
  }
  if (scenario.plannerShape) {
    const planningDraft: ArrangementDraft = {
      id: 'draft', schemaVersion: 1, revision: 1, owner: scope, mode: 'auto', status: 'planning',
      title: plan.title, goal: plan.goal, confirmedInputs: [], sharedSkillIds: [], conversation: null, nodes: [],
      workspace: plan.workspace, permissions: { preset: 'workspace-edit' }, createdAt: 1, updatedAt: 1, lastPlanning: null,
    }
    const output = { title: plan.title, nodes: plan.nodes.map(node => ({
      ...node, knowledgeQuery: 'Product media requirements',
      deliverables: node.deliverables!.map(file => ({ ...file, artifact: scenario.plannerShape === '14:50' ? undefined : {
        ...file.artifact, operation: node.id === 'image' ? 'text-to-image' : 'image-to-video',
      } })),
      mediaRequirements: node.mediaRequirements!.map(requirement => ({
        kind: requirement.kind, operation: node.id === 'image' ? 'text-to-image' : 'image-to-video',
        ...(scenario.plannerShape === '14:43' ? {
          inputFrom: requirement.inputFrom ? [requirement.inputFrom] : undefined,
          inputSelection: requirement.inputFrom ? 'specified' : 'none',
        } : { inputSelection: requirement.inputFrom ? { inputFrom: [requirement.inputFrom] } : {} }),
        preferred: node.id === 'image' ? { style: 'Photography', scene: 'Window light' } : { durationSeconds: 5, cameraMotion: 'Slow push' },
      })),
    })) }
    plan.nodes = parseArrangementPlannerOutput(JSON.stringify(output), planningDraft, [imageNode, videoNode].map(node => ({
      subscriptionId: node.subscriptionId, employeeId: node.subscriptionId, name: node.title, allowedModels: [node.modelId], status: 'ACTIVE',
    }))).nodes
  }
  await plans.save(scope, plan)
  const imageGateway = new MockMediaGateway(scenario.imageGateway), videoGateway = new MockVideoMediaGateway(scenario.videoScenario)
  const started: string[] = [], approvals: ToolAuthorizationRequest[] = [], uploads: string[] = []
  const authorization = { calls: 0, denyAt: 0 }
  let held = false, holdUsed = false
  let releaseHold: () => void = () => {}
  const runtimeVideo = videoRuntimeSchema.parse(scenario.textVideo ? {
    ...videoFixture.runtime, tools: ['video_generate', 'video_get_job'], profiles: videoFixture.runtime.profiles.map(profile => ({
      ...profile, operations: ['text-to-video'], capabilities: { ...profile.capabilities, supportsTextToVideo: true, supportsImageToVideo: false },
    })),
  } : videoFixture.runtime)
  const employee = (id: string, modelId?: string): EmployeeRuntimeConfig => ({
    subscriptionId: id, modelId: modelId ?? 'image-model', gatewayUrl: 'mock://no-network',
    ...(id === 'image-employee' ? { media: MOCK_MEDIA_CAPABILITIES } : !scenario.missingVideoCapability ? { video: runtimeVideo } : {}),
  })
  async function compose(currentManager: TaskManager) {
    const getTask = (id: string) => currentManager.getTask(id)
    const owner = { currentScope: () => currentManager.getCurrentUserScope() }
    const media = new MediaService({ scope: owner, store: new MediaStore(root), gateway: imageGateway, getTask,
      authorize: async id => employee(id), requestApproval: async () => !scenario.denyApproval,
      pollFloorMs: 1, maxAttempts: 2, operationTimeoutMs: 2000 })
    const adapter = createVideoScopeAdapter(root, images, videos)
    const video = new VideoRunService({ mock: true, scope: owner, store: new VideoStore(root), getTask,
      authorizationRevision: () => 0, authorize: async () => runtimeVideo, authorizeRecovery: async () => {},
      ...adapter, requestApproval: async () => !scenario.denyApproval, tracker: { floorMs: 1, maxAttempts: 5, budgetMs: 5000 },
      gateway: () => ({ quote: videoGateway.quote.bind(videoGateway), submit: videoGateway.submit.bind(videoGateway),
        findReceipt: videoGateway.findReceipt.bind(videoGateway), getReceipt: videoGateway.getReceipt.bind(videoGateway), content: videoGateway.content.bind(videoGateway),
        ...(scenario.textVideo ? {
          quote: async () => ({ quoteId: 'text-quote', requestHash: 'a'.repeat(64), expiresAt: Date.now() + 60_000, status: 'quoted' as const, amount: '0.000000', currency: 'MOCK' }),
          submit: async (request: { clientRequestId: string; operation: string }) => videoReceiptSchema.parse({ ...videoFixture.receipt,
            clientRequestId: request.clientRequestId, operation: request.operation, status: 'SUCCEEDED', pollAfterMs: null,
            recovery: { canQuery: false, canCancel: false, canDownload: true }, outputs: [{ ...videoFixture.output, expiresAt: null }] }),
          content: async () => (async function* () { yield MOCK_VIDEO_BYTES })(),
        } : {}),
        uploadReference: async bytes => { uploads.push(hash(bytes)); return { mock: true, referenceId: 'reference', mimeType: 'image/png',
          byteLength: bytes.length, sha256: hash(bytes), width: 1, height: 1, expiresAt: new Date(Date.now() + 60_000).toISOString() } },
      }),
    })
    const arrangementMedia = new ArrangementMediaService({ scope: owner, plans: new WorkPlanStore(root), checkpoints: new ArrangementCheckpointStore(root),
      runs: new TaskRunStore(root), links: scenario.associationFailure ? {
        list: (...args) => links.list(...args), get: (...args) => links.get(...args), upsert: async () => { throw new Error('Association storage unavailable') },
      } : new ArrangementMediaLinkStore(root), images: new MediaStore(root), videos: new VideoStore(root),
      assets: new ArrangementMediaAssets(root, new MediaStore(root), new VideoStore(root)), media, getTask })
    const runtime = new TaskRuntime({ taskManager: currentManager, userDataDir: root, taskRunStore: new TaskRunStore(root), workPlanStore: new WorkPlanStore(root),
      arrangementCheckpointStore: new ArrangementCheckpointStore(root), arrangementMedia, media, video,
      getRefreshToken: () => 'local-only', onAuthenticationRequired() {}, onEvent() {}, resolveEmployee: employee,
      authorizeEmployee: async (id, modelId) => { authorization.calls++; return authorization.calls === authorization.denyAt ? null : employee(id, modelId) },
      onApprovalRequest(request) { approvals.push(request); runtime.respondToApproval({ requestId: request.requestId, approved: !scenario.denyApproval }) },
      createWorker: options => {
        let aborted = false
        return { async run() {
        const node = options.context.arrangementNodeId!
        if (scenario.plannerShape) {
          assert.match(options.context.fixedSystemPrompt!, /【本节点媒体要求】/)
          assert.ok(options.context.fixedSystemPrompt!.includes(node === 'image' ? 'Photography' : 'Slow push'))
          assert.match(options.context.fixedSystemPrompt!, /MEDIA_ARTIFACT_ID/)
        }
        started.push(node)
        const execute = await toolsFor(options)
        if (node === 'image') await assert.rejects(options.context.mediaTools!.execute('media_get_job', { jobId: 'foreign-job' }))
        else await assert.rejects(options.context.videoTools!.execute('video_get_job', { jobId: 'foreign-job' }))
        const job = await execute(node === 'image' ? 'media_generate_image' : scenario.textVideo ? 'video_generate' : 'video_from_image', {
          creativeBrief: 'Product on a plain background', ...(node === 'video' && !scenario.textVideo ? {
            localAssetIds: [JSON.parse(options.context.fixedSystemPrompt!.split('【已授权媒体输入与原任务】\n')[1]!.split('\n')[0]!).referenceAssets[0].localAssetId],
          } : {}),
        })
        if (scenario.holdNode === node && !holdUsed) {
          holdUsed = true
          await new Promise<void>(resolve => { releaseHold = resolve; held = true })
          if (aborted) throw new Error('Worker interrupted after original media submission')
        }
        if (node === 'image') await media.waitForRun(task.id, options.context.runId)
        else await video.waitForRun(task.id, options.context.runId)
        const current = await execute(node === 'image' ? 'media_get_job' : 'video_get_job', { jobId: job.jobId })
        const artifactId = node === 'image'
          ? (current.assets as Array<{ localAssetId: string }>)[0]!.localAssetId
          : (current.artifacts as Array<{ artifactId: string }>)[0]!.artifactId
        const deliverable = plan.nodes.find(item => item.id === node)!.deliverables![0]!
        const manifest = { nodeId: node, summary: 'Saved output',
          finalDeliverables: [{ id: deliverable.id, path: deliverable.path }],
          mediaDeliverables: [{ deliverableId: deliverable.id, artifactId: scenario.foreignMapping ? 'out_' + 'f'.repeat(64) : artifactId }],
        }
        let response = await options.onResponseSettled!({ stopReason: 'stop', text: JSON.stringify(manifest) })
        if (scenario.correctMapping && response) {
          manifest.mediaDeliverables[0]!.artifactId = artifactId
          response = await options.onResponseSettled!({ stopReason: 'stop', text: JSON.stringify(manifest) })
        }
        assert.equal(response, undefined, 'The real delivery validator must accept the media output')
      }, async abort() { aborted = true; releaseHold() }, async dispose() {} }
      },
    })
    cleanups.push(async () => { await runtime.stopAll(); await media.stopAll(); await video.stopAll() })
    return { runtime, manager: currentManager, media, video, arrangementMedia }
  }
  const active = await compose(manager)
  const settled = async (current = active) => {
    await waitFor(async () => { const value = await current.manager.getTask(task.id); return !!value && !value.activeRunId && value.status !== TaskStatus.PENDING })
    return current.manager.getTask(task.id)
  }
  async function restart() {
    await active.runtime.stopAll(); await active.media.stopAll(); await active.video.stopAll()
    const restored = new TaskManager(root)
    await restored.setCurrentUser(scope.memberId, scope.enterpriseId)
    return compose(restored)
  }
  return { ...active, root, workspace, task, plan, plans, runs, checkpoints, links, images, videos,
    imageGateway, videoGateway, started, approvals, uploads, authorization, settled, restart, held: () => held }
}

for (const plannerShape of ['14:43', '14:50'] as const) test(`backend E2E: ${plannerShape} planner shape reaches actual image and video delivery`, async () => {
  const f = await fixture({ plannerShape })
  await f.runtime.executeTask(f.task.id)
  const task = await f.settled()
  assert.equal(task?.status, TaskStatus.COMPLETED, task?.error ?? undefined)
  assert.deepEqual(f.started, ['image', 'video'])
  assert.deepEqual(await readFile(join(f.workspace, 'deliverables/picture.png')), MOCK_MEDIA_PNG)
  assert.deepEqual(await readFile(join(f.workspace, 'deliverables/movie.mp4')), MOCK_VIDEO_BYTES)
  assert.deepEqual(f.uploads, [hash(MOCK_MEDIA_PNG)])
  assert.equal(f.imageGateway.calls.submit.length, 1)
  assert.equal(f.videoGateway.calls.submit, 1)
})

test('backend E2E: image to video crosses employees, preserves hashes and automatically publishes frozen files', async () => {
  const f = await fixture()
  await f.runtime.executeTask(f.task.id)
  const task = await f.settled()
  assert.equal(task?.status, TaskStatus.COMPLETED, task?.error ?? undefined)
  assert.deepEqual(f.started, ['image', 'video'])
  assert.deepEqual(await readFile(join(f.workspace, 'deliverables/picture.png')), MOCK_MEDIA_PNG)
  assert.deepEqual(await readFile(join(f.workspace, 'deliverables/movie.mp4')), MOCK_VIDEO_BYTES)
  assert.deepEqual(f.uploads, [hash(MOCK_MEDIA_PNG)])
  const records = await f.links.list(scope, f.task.id)
  const image = records.find(link => link.kind === 'image')!, video = records.find(link => link.kind === 'video')!
  assert.equal(image.subscriptionId, 'image-employee'); assert.equal(video.subscriptionId, 'video-employee')
  assert.deepEqual(video.inputs, [{ artifactId: image.outputs[0]!.artifactId, sha256: hash(MOCK_MEDIA_PNG), sourceNodeId: 'image' }])
  const checkpoint = await f.checkpoints.get(scope, f.task.id)
  for (const node of checkpoint!.state.nodes) for (const file of node.delivery!.finalFiles) {
    assert.equal(file.sha256, file.sourceArtifact!.sha256)
    assert.equal(file.snapshot!.sha256, file.sha256)
  }
  assert.equal(f.approvals.length, 1, 'video upload and quote approvals are covered by the arrangement media authorization')
  assert.equal(f.imageGateway.calls.submit.length, 1); assert.equal(f.videoGateway.calls.submit, 1)

  // Recreate the shared IPC host: its task is owned by the image employee,
  // while the saved video belongs to the second node's employee.
  const exportDir = await mkdtemp(join(await realpath(tmpdir()), 'sep-media-export-'))
  cleanups.push(() => rm(exportDir, { recursive: true, force: true }))
  const sharedHost = new MockVideoHostService({
    mock: true, scope: { currentScope: () => f.manager.getCurrentUserScope() }, store: f.videos,
    arrangementMediaLinks: f.links, getTask: id => f.manager.getTask(id), authorizationRevision: () => 0,
    authorize: async () => { assert.fail('Saved video preview must not authorize generation') },
    gateway: () => { assert.fail('Saved video preview must not construct an online gateway') },
    requestApproval: async () => { assert.fail('Saved video preview must not request tool approval') },
    ...createVideoScopeAdapter(f.root, f.images, f.videos),
  })
  cleanups.push(() => sharedHost.stopAll())
  const videoJob = (await f.videos.getJob({ ...scope, subscriptionId: video.subscriptionId }, f.task.id, video.jobId))!
  const outputId = videoJob.receipt!.outputs[0].outputId
  const preview = await sharedHost.preview(f.task.id, video.jobId, outputId)
  assert.deepEqual(preview.bytes, MOCK_VIDEO_BYTES)
  const selectedPath = join(exportDir, 'saved-video.mp4')
  await (await sharedHost.nativeSelection(f.task.id)).export(video.jobId, outputId, selectedPath)
  assert.deepEqual(await readFile(selectedPath), MOCK_VIDEO_BYTES)
  assert.equal(f.imageGateway.calls.submit.length, 1); assert.equal(f.videoGateway.calls.submit, 1)
})

for (const node of ['image', 'video'] as const) test(`backend E2E: interruption after ${node} submission resumes the original job after reconstruction`, async () => {
  const f = await fixture({ holdNode: node })
  await f.runtime.executeTask(f.task.id)
  await waitFor(async () => f.held())
  await f.runtime.pauseTask(f.task.id)
  assert.equal((await f.settled())?.status, TaskStatus.PAUSED)
  const original = (await f.links.list(scope, f.task.id)).find(link => link.kind === node)!
  const restored = await f.restart()
  await restored.runtime.retryTask(f.task.id)
  const task = await f.settled(restored)
  assert.equal(task?.status, TaskStatus.COMPLETED, task?.error ?? undefined)
  assert.equal((await f.links.list(scope, f.task.id)).find(link => link.kind === node)!.jobId, original.jobId)
  assert.equal(f.imageGateway.calls.submit.length, 1); assert.equal(f.videoGateway.calls.submit, 1)
  assert.equal(f.imageGateway.calls.quote.length, 1); assert.equal(f.videoGateway.calls.quote, 1)
  assert.deepEqual(await readFile(join(f.workspace, 'deliverables/movie.mp4')), MOCK_VIDEO_BYTES)
})

test('backend E2E: text-to-video requires no reference image', async () => {
  const f = await fixture({ textVideo: true })
  await f.runtime.executeTask(f.task.id)
  const task = await f.settled()
  assert.equal(task?.status, TaskStatus.COMPLETED, task?.error ?? undefined)
  assert.deepEqual(f.started, ['video']); assert.deepEqual(f.uploads, [])
  assert.deepEqual(await readFile(join(f.workspace, 'deliverables/movie.mp4')), MOCK_VIDEO_BYTES)
})

test('backend E2E: workspace conflict keeps the existing file and publishes a suffixed media file', async () => {
  const f = await fixture()
  await mkdir(join(f.workspace, 'deliverables'), { recursive: true })
  await writeFile(join(f.workspace, 'deliverables/movie.mp4'), 'Existing user file')
  await f.runtime.executeTask(f.task.id)
  assert.equal((await f.settled())?.status, TaskStatus.COMPLETED)
  const checkpoint = (await f.checkpoints.get(scope, f.task.id))!
  assert.equal(checkpoint.state.nodes[0]!.status, 'completed')
  assert.equal(checkpoint.state.nodes[1]!.status, 'completed')
  assert.equal(await readFile(join(f.workspace, 'deliverables/movie.mp4'), 'utf8'), 'Existing user file')
  assert.deepEqual(await readFile(join(f.workspace, 'deliverables/movie-2.mp4')), MOCK_VIDEO_BYTES)
  assert.deepEqual(f.started, ['image', 'video'])
  assert.equal(f.imageGateway.calls.submit.length, 1); assert.equal(f.videoGateway.calls.submit, 1)
  assert.equal(f.imageGateway.calls.quote.length, 1); assert.equal(f.videoGateway.calls.quote, 1)
})

test('backend E2E: lost image submission response is recovered using its original request', async () => {
  const f = await fixture({ imageGateway: { submitResponseLost: true } })
  await f.runtime.executeTask(f.task.id)
  const task = await f.settled()
  assert.equal(task?.status, TaskStatus.COMPLETED, task?.error ?? undefined)
  assert.equal(f.imageGateway.calls.submit.length, 1)
  assert.ok(f.imageGateway.calls.findReceipt.length > 0)
})

test('backend E2E: lost video submission response queries the original frozen request', async () => {
  const f = await fixture({ videoScenario: 'submission-unknown' })
  await f.runtime.executeTask(f.task.id)
  const task = await f.settled()
  assert.equal(task?.status, TaskStatus.COMPLETED, task?.error ?? undefined)
  assert.equal(f.videoGateway.calls.submit, 1); assert.equal(f.videoGateway.calls.quote, 1)
  assert.ok(f.videoGateway.calls.findReceipt > 0)
})

for (const videoScenario of ['corrupt-download', 'expired', 'failed'] as const) test(`backend E2E: ${videoScenario} cannot mark the video node as delivered`, async () => {
  const f = await fixture({ videoScenario })
  await f.runtime.executeTask(f.task.id)
  assert.equal((await f.settled())?.status, TaskStatus.PAUSED)
  const checkpoint = (await f.checkpoints.get(scope, f.task.id))!
  assert.equal(checkpoint.state.nodes[0]!.status, 'completed')
  assert.equal(checkpoint.state.nodes[1]!.status, 'failed')
  assert.equal(checkpoint.state.nodes[1]!.delivery?.finalFiles.length ?? 0, 0)
  await assert.rejects(readFile(join(f.workspace, 'deliverables/movie.mp4')), { code: 'ENOENT' })
  assert.equal(f.videoGateway.calls.submit, 1)
})

test('backend E2E: an explicit reference belonging to another task is rejected before any media request', async () => {
  const f = await fixture()
  const otherTask = await f.manager.createTask('Other task', 'Other goal', undefined, 'image-employee')
  const path = join(f.root, 'foreign-reference.png')
  await writeFile(path, MOCK_MEDIA_PNG)
  const asset = await f.images.importReference(scope, otherTask.id, path)
  const node = f.plan.nodes[1]!
  node.dependsOn = []; node.mediaRequirements![0]!.inputFrom = { artifactId: asset.localAssetId }
  f.plan.nodes = [node]
  await f.plans.save(scope, f.plan)
  await f.runtime.executeTask(f.task.id)
  assert.equal((await f.settled())?.status, TaskStatus.PAUSED)
  assert.deepEqual(f.started, [])
  assert.equal(f.imageGateway.calls.quote.length, 0); assert.equal(f.videoGateway.calls.quote, 0)
  assert.deepEqual(f.uploads, [])
})

test('backend E2E: foreign output mapping never publishes an unrelated artifact', async () => {
  const f = await fixture({ foreignMapping: true })
  await f.runtime.executeTask(f.task.id)
  assert.equal((await f.settled())?.status, TaskStatus.PAUSED)
  await assert.rejects(readFile(join(f.workspace, 'deliverables/picture.png')), { code: 'ENOENT' })
  assert.equal(f.videoGateway.calls.submit, 0)
})

test('backend E2E: model corrects an invalid mapping using the existing generated outputs', async () => {
  const f = await fixture({ foreignMapping: true, correctMapping: true })
  await f.runtime.executeTask(f.task.id)
  const task = await f.settled()
  assert.equal(task?.status, TaskStatus.COMPLETED, task?.error ?? undefined)
  assert.deepEqual(f.started, ['image', 'video'])
  assert.equal(f.imageGateway.calls.submit.length, 1); assert.equal(f.videoGateway.calls.submit, 1)
  assert.deepEqual((await f.checkpoints.get(scope, f.task.id))!.state.nodes.map(node => node.delivery!.validationAttempts), [2, 2])
})

test('backend E2E: rejected approval never submits generation', async () => {
  const f = await fixture({ denyApproval: true })
  await f.runtime.executeTask(f.task.id)
  assert.equal((await f.settled())?.status, TaskStatus.PAUSED)
  assert.equal(f.imageGateway.calls.submit.length, 0); assert.equal(f.videoGateway.calls.submit, 0)
})

test('backend E2E: association persistence failure prevents dispatch even after approval', async () => {
  const f = await fixture({ associationFailure: true })
  await f.runtime.executeTask(f.task.id)
  assert.equal((await f.settled())?.status, TaskStatus.PAUSED)
  assert.ok(f.approvals.length > 0)
  assert.equal(f.imageGateway.calls.submit.length, 0)
  assert.equal((await f.images.listJobs(scope, f.task.id))[0]!.submission, 'NOT_SENT')
})

test('backend E2E: a missing association cannot cause an accepted image request to be generated again', async () => {
  const f = await fixture({ holdNode: 'image' })
  await f.runtime.executeTask(f.task.id)
  await waitFor(async () => f.held())
  await f.runtime.pauseTask(f.task.id)
  await writeFile(new ScopePath(f.root).arrangementMediaLinksFile(scope, f.task.id), '[]')
  const restored = await f.restart()
  await restored.runtime.retryTask(f.task.id)
  assert.equal((await f.settled(restored))?.status, TaskStatus.PAUSED)
  assert.deepEqual(f.started, ['image'])
  assert.equal(f.imageGateway.calls.submit.length, 1)
  assert.equal(f.imageGateway.calls.quote.length, 1)
  assert.equal(f.videoGateway.calls.submit, 0)
})

test('backend E2E: missing video capability stops before a video quote or upload', async () => {
  const f = await fixture({ missingVideoCapability: true })
  await f.runtime.executeTask(f.task.id)
  assert.equal((await f.settled())?.status, TaskStatus.PAUSED)
  assert.deepEqual(f.started, ['image'])
  assert.equal(f.videoGateway.calls.quote, 0); assert.deepEqual(f.uploads, [])
})

test('backend E2E: explicit confirmation blocks video until confirmed and cannot be bypassed with retry', async () => {
  const f = await fixture({ confirmation: true })
  await f.runtime.executeTask(f.task.id)
  assert.equal((await f.settled())?.status, TaskStatus.PAUSED)
  assert.deepEqual(f.started, ['image']); assert.equal(f.videoGateway.calls.submit, 0)
  const checkpoint = (await f.checkpoints.get(scope, f.task.id))!
  assert.equal(checkpoint.state.nodes[0]!.pendingConfirmation, true)
  await assert.rejects(f.runtime.retryTask(f.task.id))
  await assert.rejects(f.runtime.confirmArrangementNodes(f.task.id, ['image', 'missing']))
  assert.equal((await f.checkpoints.get(scope, f.task.id))!.state.nodes[0]!.pendingConfirmation, true)
  const confirmations = await Promise.allSettled([
    f.runtime.confirmArrangementNodes(f.task.id, ['image']), f.runtime.confirmArrangementNodes(f.task.id, ['image']),
  ])
  assert.equal(confirmations.filter(result => result.status === 'fulfilled').length, 1)
  const task = await f.settled()
  assert.equal(task?.status, TaskStatus.COMPLETED, task?.error ?? undefined)
  assert.deepEqual(f.started, ['image', 'video'])
  assert.equal(f.imageGateway.calls.submit.length, 1); assert.equal(f.videoGateway.calls.submit, 1)
  await assert.rejects(f.runtime.confirmArrangementNodes(f.task.id, ['image']))
})

test('backend E2E: final confirmation settles the task without running another worker', async () => {
  const f = await fixture({ textVideo: true })
  f.plan.nodes[0]!.requiresUserConfirmation = true
  await f.plans.save(scope, f.plan)
  await f.runtime.executeTask(f.task.id)
  assert.equal((await f.settled())?.status, TaskStatus.PAUSED)
  await f.runtime.confirmArrangementNodes(f.task.id, ['video'])
  const task = await f.settled()
  assert.equal(task?.status, TaskStatus.COMPLETED, task?.error ?? undefined)
  assert.deepEqual(f.started, ['video'])
})

for (const failDuring of ['authorization', 'admission'] as const) test(`backend E2E: confirmation ${failDuring} failure preserves the pending checkpoint`, async () => {
  const f = await fixture({ confirmation: true })
  await f.runtime.executeTask(f.task.id)
  assert.equal((await f.settled())?.status, TaskStatus.PAUSED)
  const original = (await f.checkpoints.get(scope, f.task.id))!
  f.authorization.denyAt = f.authorization.calls + (failDuring === 'authorization' ? 1 : 2)
  await assert.rejects(f.runtime.confirmArrangementNodes(f.task.id, ['image']))
  assert.deepEqual(await f.checkpoints.get(scope, f.task.id), original)
  assert.equal((await f.manager.getTask(f.task.id))!.status, TaskStatus.PAUSED)
  assert.equal(f.videoGateway.calls.submit, 0)
  f.authorization.denyAt = 0
  await f.runtime.confirmArrangementNodes(f.task.id, ['image'])
  const final = await f.settled()
  assert.equal(final?.status, TaskStatus.COMPLETED, final?.error ?? undefined)
  assert.equal(f.imageGateway.calls.submit.length, 1); assert.equal(f.videoGateway.calls.submit, 1)
})
