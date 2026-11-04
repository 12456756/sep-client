import { afterEach, test } from 'node:test'
import * as assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import * as videoFixture from '../../src/shared/fixtures/media-video-v1.json'
import { videoRuntimeSchema } from '../../src/shared/video-media'
import type { VideoReferenceSource } from '../../src/shared/video-host'
import type { MediaAssetView } from '../../src/shared/media'
import { SEP_MEDIA_MOCK_PNG_BASE64 } from '../common/platform/sep-media-gateway-contract'
import { AttachmentStore } from '../data/attachment-store'
import { ArrangementMediaAssets } from '../data/arrangement-media-assets'
import { MediaStore } from '../data/media-store'
import { MockMediaGateway, MOCK_MEDIA_CAPABILITIES, MOCK_MEDIA_PNG } from '../data/mock-media-gateway'
import { MockVideoMediaGateway } from '../data/mock-video-media-gateway'
import { VideoStore } from '../data/video-store'
import { createVideoScopeAdapter } from '../data/video-scope-adapter'
import { TaskManager } from '../runtime/task-manager'
import { TaskRuntime } from '../runtime/task-runtime'
import { TaskRunStore } from '../data/task-run-store'
import { WorkPlanStore } from '../data/work-plan-store'
import { effectivePermissionPolicy } from '../domain/arrangement-plan'
import type { ConversationMediaPort } from '../domain/conversation-media'
import { AttachmentService } from './attachment-service'
import { ConversationMediaService } from './conversation-media-service'
import { MediaService } from './media-service'
import { VideoRunService } from './video-run-service'
import { ConversationVideoRunService } from './conversation-video-run-service'
import type { MockVideoHostOptions } from './mock-video-host-service'

const owner = { memberId: 'member-a', enterpriseId: 'enterprise-a' }
const other = { memberId: 'member-b', enterpriseId: 'enterprise-a' }
const png = Buffer.from(SEP_MEDIA_MOCK_PNG_BASE64, 'base64')
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

async function fixture() {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'sep-chat-media-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const manager = new TaskManager(root)
  await manager.initialize()
  await manager.setCurrentUser(owner.memberId, owner.enterpriseId)
  const task = await manager.createTask('Product video', 'Animate the uploaded product', join(root, 'workspace'), 'subscription-a')
  const scope = { currentScope: () => manager.getCurrentUserScope() }
  const attachments = new AttachmentService(new AttachmentStore(root), () => scope.currentScope())
  const images = new MediaStore(root), videos = new VideoStore(root)
  const assets = new ArrangementMediaAssets(root, images, videos, attachments)
  const videoRuntime = videoRuntimeSchema.parse(videoFixture.runtime)
  const employee = { subscriptionId: 'subscription-a', modelId: 'model-a', gatewayUrl: 'http://unused', media: MOCK_MEDIA_CAPABILITIES, video: videoRuntime }
  const gateway = new MockVideoMediaGateway()
  const uploaded: Uint8Array[] = []
  const videoOptions: MockVideoHostOptions = {
    mock: true, scope, store: videos, authorizationRevision: () => 1,
    getTask: id => manager.getTask(id), authorize: async () => videoRuntime, authorizeRecovery: async () => {},
    gateway: () => ({
      quote: gateway.quote.bind(gateway), submit: gateway.submit.bind(gateway), findReceipt: gateway.findReceipt.bind(gateway),
      getReceipt: gateway.getReceipt.bind(gateway), content: gateway.content.bind(gateway),
      uploadReference: async bytes => {
        uploaded.push(bytes)
        return { mock: true, referenceId: `ref-${uploaded.length}`, mimeType: 'image/png', byteLength: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'), width: 1, height: 1, expiresAt: new Date(Date.now() + 60_000).toISOString() }
      },
    }),
    ...createVideoScopeAdapter(root, images, videos),
    requestApproval: async () => true,
    tracker: { floorMs: 1, maxAttempts: 4, budgetMs: 5000 },
  }
  const video = new VideoRunService(videoOptions)
  const mediaGateway = new MockMediaGateway()
  const media = new MediaService({ scope, store: images, gateway: mediaGateway, getTask: id => manager.getTask(id),
    authorize: async () => employee, requestApproval: async () => true, pollFloorMs: 1, maxAttempts: 4 })
  cleanup.push(() => media.stopAll(), () => video.stopAll())
  const options = { scope, images, assets, media, getTask: (id: string) => manager.getTask(id) }
  const service = new ConversationMediaService(options)
  const runInput = { taskId: task.id, runId: 'run-a', subscriptionId: employee.subscriptionId, employee, requestApproval: async () => true }
  async function attach(bytes = png, displayName = 'product.png') {
    const file = join(root, displayName)
    await writeFile(file, bytes)
    const session = await attachments.beginSession({ kind: 'conversation', taskId: task.id })
    const item = (await attachments.importFiles(session.sessionId, 'import', [file]))[0]!.item!
    const snapshot = await attachments.claimTask(session.sessionId, task.id, [{ attachmentId: item.attachmentId, sha256: item.sha256 }])
    const resolved = await attachments.resolveTaskInputs(owner, task.id, snapshot.attachments)
    return { item, snapshot, resolved }
  }
  async function tools(input: Partial<Parameters<ConversationMediaPort['prepareRun']>[0]> = {}) {
    const host = await video.prepareRun(runInput)
    assert.ok(host)
    return service.prepareRun({ taskId: task.id, runId: runInput.runId, attachments: [], signal: new AbortController().signal, video: host, ...input })
  }
  async function generateImage(taskId = task.id) {
    const host = await media.prepareRun({ ...runInput, taskId })
    assert.ok(host)
    await host.execute('media_generate_image', { creativeBrief: 'A product photograph', parameters: { aspectRatio: '1:1', count: 1, size: 'small', quality: 'standard' } })
    await media.waitForRun(taskId, runInput.runId)
    return (await images.listAssets(owner, taskId)).find(asset => asset.source === 'output')!
  }
  return { root, manager, task, scope, attachments, images, videos, assets, employee, video, videoOptions, media, mediaGateway, service, options, gateway, uploaded, runInput, attach, tools, generateImage }
}

type ReferenceView = { referenceAssets: MediaAssetView[]; referenceSources: VideoReferenceSource[] }
const videoInput = (id: string) => ({ creativeBrief: 'Animate this product', localAssetIds: [id],
  parameters: { ...videoFixture.quoteRequest.parameters, resolution: '720p', outputFormat: 'video/mp4' } })

test('conversation uploads its actual image attachment and saves the generated video through the existing host', async () => {
  const f = await fixture(), attached = await f.attach()
  const tools = await f.tools({ attachments: attached.resolved.attachments })
  const view = await tools.execute('video_get_job', {}) as ReferenceView
  assert.equal(view.referenceAssets.length, 1)
  assert.deepEqual(view.referenceSources, [{ localAssetId: view.referenceAssets[0]!.localAssetId,
    source: 'attachment', attachmentId: attached.item.attachmentId, displayName: 'product.png' }])
  assert.equal(f.uploaded.length, 0, 'Registering and querying references must not upload or submit anything')
  assert.equal(f.gateway.calls.quote, 0)
  const result = await tools.execute('video_from_image', videoInput(view.referenceAssets[0]!.localAssetId)) as { generationStatus: string; saveStatus: string }
  assert.equal(result.generationStatus, 'SUCCEEDED')
  assert.equal(result.saveStatus, 'SAVED')
  assert.deepEqual(Buffer.from(f.uploaded[0]!), png)
  assert.equal(f.gateway.calls.submit, 1)
})

test('each queued turn identifies its own named attachments and retry reuses the same saved reference', async () => {
  const f = await fixture()
  const first = await f.attach(png, 'first.png'), second = await f.attach(MOCK_MEDIA_PNG, 'second.png')
  const firstTools = await f.tools({ attachments: first.resolved.attachments })
  const before = await firstTools.execute('video_get_job', {}) as ReferenceView
  const secondTools = await f.service.prepareRun({ taskId: f.task.id, runId: 'run-b', attachments: second.resolved.attachments,
    signal: new AbortController().signal, video: firstTools })
  const after = await secondTools.execute('video_get_job', {}) as ReferenceView
  assert.equal(after.referenceAssets.length, 2)
  assert.deepEqual(after.referenceSources.map(source => source.source === 'attachment' ? source.displayName : undefined), ['second.png'])
  assert.notEqual(after.referenceSources[0]!.localAssetId, before.referenceSources[0]!.localAssetId)
  const retry = await new ConversationMediaService(f.options).prepareRun({ taskId: f.task.id, runId: 'run-retry', attachments: first.resolved.attachments,
    signal: new AbortController().signal, video: firstTools })
  const retried = await retry.execute('video_get_job', {}) as ReferenceView
  assert.equal(retried.referenceSources[0]!.localAssetId, before.referenceSources[0]!.localAssetId)
  assert.equal((await f.images.listAssets(owner, f.task.id)).length, 2)
})

test('images generated after a conversation starts become traceable video references without regenerating them', async () => {
  const f = await fixture(), tools = await f.tools()
  assert.equal((await tools.execute('video_get_job', {}) as ReferenceView).referenceAssets.length, 0)
  const output = await f.generateImage()
  const view = await tools.execute('video_get_job', {}) as ReferenceView
  assert.equal(view.referenceAssets.length, 1)
  assert.deepEqual(view.referenceSources, [{ localAssetId: view.referenceAssets[0]!.localAssetId, source: 'generated',
    sourceArtifactId: output.localAssetId, jobId: output.jobId, outputId: output.outputId }])
  await tools.execute('video_from_image', videoInput(output.localAssetId))
  assert.deepEqual(Buffer.from(f.uploaded[0]!), MOCK_MEDIA_PNG)
  await tools.execute('video_get_job', {})
  assert.equal((await f.images.listAssets(owner, f.task.id)).filter(asset => asset.source === 'reference').length, 1)
  assert.equal((await f.images.listJobs(owner, f.task.id)).length, 1)
})

test('video reference discovery waits for the current asynchronous image to be saved without polling or resubmitting', async context => {
  const f = await fixture(), tools = await f.tools()
  let entered!: () => void, release!: () => void
  const downloading = new Promise<void>(resolve => { entered = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  const content = f.mediaGateway.content.bind(f.mediaGateway)
  context.mock.method(f.mediaGateway, 'content', async (...args: Parameters<MockMediaGateway['content']>) => { entered(); await gate; return content(...args) })
  const host = await f.media.prepareRun(f.runInput)
  assert.ok(host)
  await host.execute('media_generate_image', { creativeBrief: 'A product photograph', parameters: { aspectRatio: '1:1', count: 1, size: 'small', quality: 'standard' } })
  await downloading
  const query = tools.execute('video_get_job', {}) as Promise<ReferenceView>
  try {
    const result = await Promise.race([query.then(() => 'finished'), new Promise(resolve => setTimeout(() => resolve('waiting'), 30))])
    assert.equal(result, 'waiting', 'Do not tell the model that a pending image has no usable reference')
  } finally { release() }
  const view = await query
  assert.equal(view.referenceSources[0]!.source, 'generated')
  assert.equal(view.referenceAssets.length, 1)
  assert.equal((await f.images.listJobs(owner, f.task.id)).length, 1)
  assert.equal(f.gateway.calls.submit, 0)
})

test('foreign task images and attachments cannot be converted or uploaded by a conversation', async () => {
  const f = await fixture(), attached = await f.attach()
  const foreign = await f.manager.createTask('Other', 'Other', join(f.root, 'other'), 'subscription-a')
  await assert.rejects(f.service.prepareRun({ taskId: foreign.id, runId: 'run-b', attachments: attached.resolved.attachments,
    signal: new AbortController().signal, video: { names: [], execute: async () => assert.fail('must not execute') } }))
  const output = await f.generateImage(foreign.id), tools = await f.tools()
  await assert.rejects(tools.execute('video_from_image', videoInput(output.localAssetId)), { code: 'NOT_FOUND' })
  assert.equal(f.uploaded.length, 0)
  assert.equal(f.gateway.calls.quote, 0)
})

test('cancelled or superseded account runs cannot expose references or start video generation', async () => {
  const f = await fixture(), attached = await f.attach(), controller = new AbortController()
  const tools = await f.tools({ attachments: attached.resolved.attachments, signal: controller.signal })
  const liveTools = await f.service.prepareRun({ taskId: f.task.id, runId: 'run-b', attachments: [], signal: new AbortController().signal, video: tools })
  controller.abort(new Error('Conversation cancelled'))
  await assert.rejects(tools.execute('video_get_job', {}), /Conversation cancelled/)
  await f.manager.setCurrentUser(other.memberId, other.enterpriseId)
  await assert.rejects(liveTools.execute('video_get_job', {}), { code: 'AUTH_REQUIRED' })
  await assert.rejects(f.service.prepareRun({ taskId: f.task.id, runId: 'run-b', attachments: attached.resolved.attachments,
    signal: new AbortController().signal, video: tools }))
  assert.equal(f.uploaded.length, 0)
})

test('cancelling while attachment conversion is pending prevents publication and tool dispatch', async () => {
  const f = await fixture(), attached = await f.attach(), controller = new AbortController()
  let entered!: () => void, release!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  const service = new ConversationMediaService({ ...f.options, assets: { ...f.assets,
    reference: f.assets.reference.bind(f.assets),
    attachmentReference: async (...args) => { entered(); await gate; return f.assets.attachmentReference(...args) },
  } })
  const pending = service.prepareRun({ taskId: f.task.id, runId: 'run-b', attachments: attached.resolved.attachments,
    signal: controller.signal, video: { names: ['video_get_job'], execute: async () => assert.fail('must not execute') } })
  const rejected = assert.rejects(pending, /Conversation cancelled/)
  await started
  controller.abort(new Error('Conversation cancelled'))
  release()
  await rejected
  assert.equal((await f.images.listAssets(owner, f.task.id)).length, 0)
})

for (const kind of ['general', 'employee'] as const) test(`${kind} conversation runtime connects first-turn and follow-up images to the existing video host`, async () => {
  const f = await fixture(), attached = await f.attach(), runs = new TaskRunStore(f.root)
  f.videoOptions.tracker = { ...f.videoOptions.tracker, maxAttempts: 1 }
  const conversationVideo = new ConversationVideoRunService(f.video, f.videoOptions)
  const plans = new WorkPlanStore(f.root)
  await plans.save(owner, { id: f.task.id, schemaVersion: 1, sourceDraftId: 'draft-a', sourceDraftRevision: 1, owner,
    mode: 'conversation', title: f.task.title, goal: f.task.prompt, nodes: [], confirmedInputs: [],
    conversation: { kind, modelId: f.employee.modelId, participants: [{ subscriptionId: f.employee.subscriptionId, modelId: f.employee.modelId }], activeSubscriptionId: f.employee.subscriptionId },
    workspace: { mode: 'shared', path: f.task.workDir }, permissions: effectivePermissionPolicy({ preset: 'full-local', approvalMode: 'auto-approve' }),
    inputSnapshot: attached.snapshot, planHash: 'conversation-a', createdAt: Date.now() })
  let failure: unknown, executed = 0, approvals = 0
  const runtime = new TaskRuntime({ taskManager: f.manager, taskRunStore: runs, workPlanStore: plans, getTaskWorkspaceRoot: () => f.root,
    resolveEmployee: () => f.employee, getRefreshToken: () => 'fixture', onAuthenticationRequired() {},
    authorizeModel: async () => f.employee,
    onEvent() {}, onApprovalRequest(request) { approvals++; runtime.respondToApproval({ requestId: request.requestId, approved: true }) },
    attachmentInputs: f.attachments, conversationMedia: f.service, video: f.video, conversationVideo, media: f.media,
    createWorker: options => ({ async run(prompt) {
      try {
        assert.match(prompt, /parameterSources.*requestedSpec.*实际存在/)
        assert.match(prompt, /不得.*width.*height/)
        assert.match(prompt, /提交状态.*未知.*原任务/)
        const tools = options.context.videoTools!
        if (executed === 2) {
          await options.context.mediaTools!.execute('media_generate_image', { creativeBrief: 'A new product photograph',
            parameters: { aspectRatio: '1:1', count: 1, size: 'small', quality: 'standard' } })
        } else assert.equal(options.context.inputImages?.length, 1)
        const view = await tools.execute('video_get_job', {}) as ReferenceView
        const source = view.referenceSources.find(source => source.source === (executed === 2 ? 'generated' : 'attachment'))
        assert.ok(source)
        if (source.source === 'attachment') assert.equal(source.displayName, executed === 0 ? 'product.png' : 'follow-up.png')
        await tools.execute('video_from_image', videoInput(source.localAssetId))
        assert.ok(options.onResponseSettled)
        await options.onResponseSettled({ text: 'Video delivered.', stopReason: 'stop' })
        await mkdir(options.context.sessionDir, { recursive: true })
        const file = join(options.context.sessionDir, 'session.jsonl')
        await writeFile(file, '{}\n')
        await options.onSessionCreated?.({ sessionId: 'shared-session', sessionFile: file })
        executed++
      } catch (error) { failure = error; throw error }
    }, async abort() {}, async dispose() {} }),
  })
  cleanup.push(() => runtime.stopAll())
  const settle = async () => {
    const deadline = Date.now() + 10_000
    while (runtime.hasConversationRun(f.task.id)) {
      assert.ok(Date.now() < deadline, 'conversation must finish')
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    if (failure) throw failure
  }
  await runtime.executeTask(f.task.id, { conversation: true })
  await settle()
  const followup = await f.attach(MOCK_MEDIA_PNG, 'follow-up.png')
  await runtime.continueConversation(f.task.id, 'Animate the new photo', { attachmentRefs: followup.snapshot.attachments })
  await settle()
  await runtime.continueConversation(f.task.id, 'Generate a new image and animate it')
  await settle()
  assert.equal(executed, 3)
  assert.equal(approvals, 0, 'unrestricted conversation media must not request approval')
  assert.equal(f.gateway.calls.submit, 3)
  assert.equal(f.gateway.calls.quote, 3)
  assert.equal((await f.manager.getTask(f.task.id))?.status, 'completed')
  assert.deepEqual(Buffer.from(f.uploaded[0]!), png)
  assert.deepEqual(Buffer.from(f.uploaded[1]!), MOCK_MEDIA_PNG)
  assert.deepEqual(Buffer.from(f.uploaded[2]!), MOCK_MEDIA_PNG)
})
