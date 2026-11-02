import { afterEach, test } from 'node:test'
import * as assert from 'node:assert/strict'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import * as fixture from '../../src/shared/fixtures/media-video-v1.json'
import { videoReceiptSchema, videoRuntimeSchema, type VideoReceipt } from '../../src/shared/video-media'
import type { VideoGenerationInput } from '../../src/shared/video-host'
import { VideoStore } from '../data/video-store'
import { MockVideoMediaGateway, type MockVideoScenario } from '../data/mock-video-media-gateway'
import type { VideoRunPort } from '../domain/video-tools'
import type { VideoScope } from '../domain/video-media'
import { AppError } from '../errors/app-error'
import { MockVideoHostService, type MockVideoHostOptions } from './mock-video-host-service'
import { VideoRunService } from './video-run-service'
import { EmployeeAuthorizer } from './employee-authorizer'
import { EmployeeDirectory } from './employee-directory'
import { SepRealVideoGateway } from '../data/sep-video-media-gateway'
import { PiCodingAgentAdapter } from '../pi/sdk/pi-coding-agent-adapter'
import { PiTaskWorker } from '../pi/sdk/pi-task-worker'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
const scope: VideoScope = { enterpriseId: 'enterprise-a', memberId: 'member-a', subscriptionId: 'subscription-a' }
const bytes = Buffer.from('mock reference')
const input = (): VideoGenerationInput => ({
  profileId: 'mock-video-from-image', operation: 'image-to-video', localAssetIds: ['asset-a'], creativeBrief: 'Slow product movement',
  parameters: { ...fixture.quoteRequest.parameters, resolution: '720p', outputFormat: 'video/mp4' },
})
async function setup(scenario: MockVideoScenario = 'success') {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'sep-video-run-'))
  directories.push(root)
  const store = new VideoStore(root), gateway = new MockVideoMediaGateway(scenario)
  const state = { revision: 0, runtime: videoRuntimeSchema.parse(fixture.runtime), granted: true, subscriptionId: scope.subscriptionId,
    policy: undefined as Parameters<VideoRunPort['prepareRun']>[0]['toolPolicy'], uploads: 0, authorizations: 0 }
  const approvals: Parameters<MockVideoHostOptions['requestApproval']>[0][] = []
  const options: MockVideoHostOptions = {
    mock: true, scope: { currentScope: () => ({ enterpriseId: scope.enterpriseId, memberId: scope.memberId }) }, store,
    authorizationRevision: () => state.revision,
    getTask: async () => ({ subscriptionId: state.subscriptionId }),
    authorize: async () => { state.authorizations++; if (!state.granted) throw new AppError('PERMISSION_DENIED'); return state.runtime },
    authorizeRecovery: async () => { if (!state.granted) throw new AppError('PERMISSION_DENIED') },
    policy: async () => state.policy,
    gateway: owner => { assert.equal(owner.subscriptionId, scope.subscriptionId); return {
      quote: gateway.quote.bind(gateway), submit: gateway.submit.bind(gateway), findReceipt: gateway.findReceipt.bind(gateway),
      getReceipt: gateway.getReceipt.bind(gateway), content: gateway.content.bind(gateway),
      uploadReference: async value => { state.uploads++; return { mock: true, referenceId: 'ref-a', mimeType: 'image/png', byteLength: value.length,
        sha256: createHash('sha256').update(value).digest('hex'), width: 1, height: 1, expiresAt: new Date(Date.now() + 60_000).toISOString() } },
    } },
    readReference: async (_owner, taskId, id) => { assert.equal(taskId, 'task-a'); assert.equal(id, 'asset-a'); return { bytes, sha256: createHash('sha256').update(bytes).digest('hex') } },
    requestApproval: async request => { approvals.push(request); return true }, tracker: { floorMs: 1, maxAttempts: 4, budgetMs: 5000 },
  }
  const runInput: Parameters<VideoRunPort['prepareRun']>[0] = {
    taskId: 'task-a', runId: 'run-a', subscriptionId: scope.subscriptionId,
    employee: { subscriptionId: scope.subscriptionId, modelId: 'model-a', gatewayUrl: 'http://mock', video: state.runtime },
    requestApproval: options.requestApproval,
  }
  return { root, options, state, store, gateway, approvals, runInput, service: new VideoRunService(options) }
}

test('arrangement automatically retries the original video download without a second quote or submission', async () => {
  const f = await setup()
  const original = f.options.gateway
  let downloads = 0, submits = 0, quotes = 0
  f.options.gateway = owner => {
    const gateway = original(owner)
    return { ...gateway,
      quote: async (...args) => { quotes++; return gateway.quote(...args) },
      submit: async (...args) => { submits++; return gateway.submit(...args) },
      content: async (...args) => {
        if (++downloads <= 2) throw new AppError('NETWORK_ERROR')
        return gateway.content(...args)
      },
    }
  }
  const service = new VideoRunService(f.options)
  try {
    const tools = await service.prepareRun(f.runInput)
    assert.ok(tools)
    await tools.execute('video_from_image', input())
    await service.waitForRun('task-a', 'run-a', { recoverOriginal: true })
    assert.equal(downloads, 3)
    assert.equal(submits, 1)
    assert.equal(quotes, 1)
    assert.equal((await f.store.listJobs(scope))[0]?.saveStatus, 'SAVED')
  } finally { await service.stopAll() }
})

test('run delivery cancellation interrupts a stalled video state read', { timeout: 5_000 }, async context => {
  const f = await setup()
  let entered!: () => void, release!: () => void
  const reading = new Promise<void>(resolve => { entered = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  const controller = new AbortController()
  try {
    const tools = await f.service.prepareRun(f.runInput)
    assert.ok(tools)
    await tools.execute('video_from_image', input())
    const getTaskVideo = MockVideoHostService.prototype.getTaskVideo
    context.mock.method(MockVideoHostService.prototype, 'getTaskVideo', async function (this: MockVideoHostService, taskId: string) {
      entered()
      await gate
      return getTaskVideo.call(this, taskId)
    })
    const waiting = f.service.waitForRun('task-a', 'run-a', { signal: controller.signal })
    const rejected = assert.rejects(waiting, { message: 'Delivery cancelled.' })
    await reading
    controller.abort(new Error('Delivery cancelled.'))
    await rejected
    assert.equal(f.gateway.calls.submit, 1)
  } finally { release(); await f.service.stopAll() }
})

test('real SDK handoff and finishRun preserve pending video output saving without another submission', { timeout: 20_000 }, async context => {
  const f = await setup()
  let entered!: () => void, release!: () => void
  const downloading = new Promise<void>(resolve => { entered = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  let downloadSignal: AbortSignal | undefined
  const content = f.gateway.content.bind(f.gateway)
  context.mock.method(f.gateway, 'content', async (...args: Parameters<typeof content>) => {
    downloadSignal = args[2]
    entered(); await gate
    return content(...args)
  })
  let requests = 0
  const server = createServer((request, response) => {
    request.resume()
    request.on('end', () => {
      requests++
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const chunk = (delta: unknown, finishReason: string | null = null) => response.write(`data: ${JSON.stringify({
        id: 'video-handoff', object: 'chat.completion.chunk', created: 1, model: 'model-a',
        choices: [{ index: 0, delta, finish_reason: finishReason }],
      })}\n\n`)
      chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'generate-video', type: 'function',
        function: { name: 'video_from_image', arguments: JSON.stringify({ creativeBrief: 'Product movement', localAssetIds: ['asset-a'], parameters: input().parameters }) } }] })
      chunk({}, 'tool_calls')
      response.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const tools = await f.service.prepareRun(f.runInput)
  assert.ok(tools)
  let toolSignal: AbortSignal | undefined
  const worker = new PiTaskWorker({
    context: { taskId: 'task-a', runId: 'run-a', subscriptionId: scope.subscriptionId, modelId: 'model-a',
      gatewayUrl: `http://127.0.0.1:${address.port}/v1`, workspaceDir: f.root,
      agentDir: join(f.root, 'agent'), sessionDir: join(f.root, 'sessions'),
      toolPolicy: { preset: 'full-local', approvalMode: 'auto-approve', allowedTools: [], allowedPaths: [], deniedPaths: [], commandPolicy: 'restricted', workspaceDir: f.root },
      videoTools: { names: tools.names, execute: async (name, raw, signal) => {
        toolSignal = signal
        return tools.execute(name, raw, signal)
      } } },
    runtime: { createSession: config => new PiCodingAgentAdapter().createSession({ ...config, mcpServers: [] }) },
    createTokenManager: () => ({ async initialize() {}, async getValidToken() { return 'local-fixture' }, stop() {} }),
    getRefreshToken: () => 'local-fixture', onAuthenticationRequired() {}, onApprovalRequest: async () => true, onEvent() {},
    shouldYieldAfterToolTurn: () => f.gateway.calls.submit > 0,
  })
  try {
    let runSettled = false
    const running = worker.run('Generate a product video and wait until its saved result is available.')
      .finally(() => { runSettled = true })
    await downloading
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(runSettled, false, 'the assistant turn must remain open while the generated video is saving')
    assert.equal(toolSignal?.aborted, false)
    assert.equal(downloadSignal?.aborted, false)
    release()
    await running
    assert.equal(toolSignal?.aborted, true)
    assert.equal((await f.store.listJobs(scope))[0].saveStatus, 'SAVED')
    assert.equal(f.gateway.calls.quote, 1)
    assert.equal(f.gateway.calls.submit, 1)
    assert.equal(f.gateway.calls.content, 1)
    assert.equal(requests, 1)
  } finally {
    release()
    await worker.dispose()
    await f.service.stopAll()
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})

test('run facade binds two host approvals to real run and awaits original output save', async () => {
  const f = await setup(), tools = await f.service.prepareRun(f.runInput)
  assert.ok(tools)
  const job = await tools.execute('video_from_image', input()) as { jobId: string }
  assert.equal(f.approvals.length, 2)
  assert.ok(f.approvals.every(request => request.runId === 'run-a' && request.subscriptionId === scope.subscriptionId))
  await f.service.waitForRun('task-a', 'run-a')
  assert.equal((await f.store.getJob(scope, 'task-a', job.jobId))?.saveStatus, 'SAVED')
  assert.equal(f.gateway.calls.submit, 1)
  assert.equal(f.gateway.calls.quote, 1)
  assert.equal(f.state.uploads, 1)
  await f.service.finishRun('task-a', 'run-a')
  await assert.rejects(tools.execute('video_from_image', input()))
})

test('generation tool waits for terminal video status and local save before returning to the model', { timeout: 10_000 }, async context => {
  const f = await setup()
  let entered!: () => void, release!: () => void
  const downloading = new Promise<void>(resolve => { entered = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  const content = f.gateway.content.bind(f.gateway)
  context.mock.method(f.gateway, 'content', async (...args: Parameters<typeof content>) => {
    entered()
    await gate
    return content(...args)
  })
  const tools = await f.service.prepareRun(f.runInput)
  assert.ok(tools)
  let settled = false
  const generating = tools.execute('video_from_image', input()).then(value => { settled = true; return value })
  try {
    await downloading
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(settled, false, 'the model must not continue while output bytes are still saving')
    release()
    const result = await generating as { generationStatus: string; saveStatus: string }
    assert.equal(result.generationStatus, 'SUCCEEDED')
    assert.equal(result.saveStatus, 'SAVED')
    assert.equal(f.gateway.calls.submit, 1)
  } finally {
    release()
    await f.service.finishRun('task-a', 'run-a')
  }
})

test('arrangement media mode auto-approves upload and quote without approval requests', async () => {
  const f = await setup(), tools = await f.service.prepareRun({ ...f.runInput, autoApproveMedia: true })
  assert.ok(tools)
  const job = await tools.execute('video_from_image', input()) as { jobId: string }
  assert.equal(typeof job.jobId, 'string')
  assert.equal(f.approvals.length, 0)
  await f.service.waitForRun('task-a', 'run-a')
  assert.equal(f.gateway.calls.submit, 1)
  await f.service.finishRun('task-a', 'run-a')
})

test('run resolves the authorized profile while requiring explicit model-supplied specifications', async () => {
  const f = await setup(), tools = await f.service.prepareRun(f.runInput)
  assert.ok(tools)
  try {
    await assert.rejects(tools.execute('video_from_image', { creativeBrief: input().creativeBrief, localAssetIds: ['asset-a'] }), { code: 'MISSING_SPEC' })
    const job = await tools.execute('video_from_image', { creativeBrief: input().creativeBrief, localAssetIds: ['asset-a'], parameters: input().parameters }) as { jobId: string }
    const stored = await f.store.getJob(scope, 'task-a', job.jobId)
    assert.equal(stored?.request.profileId, f.state.runtime.defaultProfileId)
    assert.deepEqual(stored?.request.parameters, input().parameters)
    assert.equal(f.approvals.length, 2)
    await f.service.waitForRun('task-a', 'run-a')
    assert.equal(f.gateway.calls.submit, 1)
    assert.equal(f.state.authorizations, 3, 'Missing-spec preflight and successful quote preparation each refresh runtime, then approval refreshes it again')
  } finally { await f.service.finishRun('task-a', 'run-a') }
})

test('unsupported explicit specifications fail before quoting, approval or upload', async () => {
  const f = await setup(), tools = await f.service.prepareRun(f.runInput)
  assert.ok(tools)
  try {
    await assert.rejects(tools.execute('video_from_image', { creativeBrief: 'Product video', localAssetIds: ['asset-a'], parameters: { durationSeconds: 12 } }), { code: 'MISSING_SPEC' })
    await assert.rejects(tools.execute('video_from_image', { creativeBrief: 'Product video', localAssetIds: ['asset-a'], parameters: { durationSeconds: 'invalid' } }), { code: 'INVALID_ARGUMENT' })
    assert.equal(f.gateway.calls.quote, 0)
    assert.equal(f.state.uploads, 0)
    assert.equal(f.approvals.length, 0)
  } finally { await f.service.finishRun('task-a', 'run-a') }
})

test('an empty video status query returns current video profiles and task-local references', async () => {
  const f = await setup()
  f.options.references = { list: async () => [{ localAssetId: 'asset-a', taskId: 'task-a', jobId: null, outputId: null,
    source: 'reference', mime: 'image/png', size: 30, width: 1, height: 1, status: 'SAVED' }], import: async () => [] }
  const service = new VideoRunService(f.options)
  const tools = await service.prepareRun(f.runInput)
  assert.ok(tools)
  f.state.granted = false
  try {
    const result = await tools.execute('video_get_job', {}) as { runtime: unknown; jobs: unknown[]; referenceAssets: { localAssetId: string }[] }
    assert.deepEqual(result.runtime, f.state.runtime)
    assert.deepEqual(result.jobs, [])
    assert.equal(result.referenceAssets[0].localAssetId, 'asset-a')
    assert.equal(f.gateway.calls.submit, 0)
    assert.equal(f.state.authorizations, 0, 'Local queries work without online authorization')
  } finally { await service.finishRun('task-a', 'run-a') }
})

test('text-to-video uses lightweight runtime authorization twice and never prepares skills', async () => {
  const f = await setup()
  f.state.runtime = videoRuntimeSchema.parse({ ...f.state.runtime, tools: ['video_generate', 'video_get_job'],
    profiles: f.state.runtime.profiles.map(profile => ({ ...profile, operations: ['text-to-video'],
      capabilities: { ...profile.capabilities, supportsTextToVideo: true, supportsImageToVideo: false } })) })
  f.runInput.employee.video = f.state.runtime
  const directory = new EmployeeDirectory(async () => [{
    id: scope.subscriptionId, subscriptionId: scope.subscriptionId, employeeId: 'employee-a', name: 'Creator', status: 'ACTIVE',
    templateVersion: '1', template: { id: 'employee-a', name: 'Creator', avatar: null },
    allowedModels: [], department: null, upgradeAvailable: false,
  }])
  const authorizer = new EmployeeAuthorizer({ getValidAccessToken: async () => 'mock-token', getMeta: () => scope }, directory, {
    prepare: async () => { assert.fail('Video execution must not download skills') }, invalidate() {},
  }, 'mock://no-network', {
    getRuntime: async () => ({ manifestVersion: 1, subscriptionId: scope.subscriptionId, templateVersion: '1',
      employee: { id: 'employee-a', name: 'Creator', version: '1', maxSteps: 10 },
      runtime: { modelId: 'retired-chat-model', allowedModels: [], systemPrompt: '', skills: [], video: f.state.runtime } }),
  })
  let quotes = 0, submissions = 0
  const service = new VideoRunService({ ...f.options,
    authorize: async id => { f.state.authorizations++; return (await authorizer.authorizeRuntime(id))?.video },
    gateway: () => ({ ...f.options.gateway(scope),
      quote: async request => {
        quotes++
        assert.equal(request.operation, 'text-to-video')
        assert.deepEqual(request.referenceIds, [])
        assert.deepEqual(request.parameters, input().parameters)
        return { quoteId: 'text-quote', requestHash: 'a'.repeat(64), expiresAt: Date.now() + 60_000, status: 'quoted', amount: '0.000000', currency: 'MOCK' }
      },
      submit: async request => {
        submissions++
        assert.equal(f.state.authorizations, 2)
        assert.equal((await f.store.listJobs(scope))[0].submission, 'MAYBE_SENT')
        return videoReceiptSchema.parse({ ...fixture.receipt, clientRequestId: request.clientRequestId, operation: request.operation,
          status: 'SUCCEEDED', pollAfterMs: null, recovery: { canQuery: false, canCancel: false, canDownload: true },
          outputs: [{ ...fixture.output, expiresAt: new Date(Date.now() + 60_000).toISOString() }] })
      },
      content: async () => (async function* () { yield Buffer.from(fixture.mediaFixture.base64, 'base64') })(),
    }),
  })
  try {
    const tools = await service.prepareRun(f.runInput)
    assert.ok(tools)
    const result = await tools.execute('video_generate', { creativeBrief: 'A product video', parameters: input().parameters }) as { jobId: string }
    await service.waitForRun('task-a', 'run-a')
    assert.equal(f.state.authorizations, 2)
    assert.equal(quotes, 1)
    assert.equal(submissions, 1)
    assert.equal(f.state.uploads, 0)
    assert.equal((await f.store.getJob(scope, 'task-a', result.jobId))?.saveStatus, 'SAVED')
  } finally { await service.stopAll() }
})

test('held billing keeps one tracker and does not block delivery or the next run', { timeout: 15_000 }, async () => {
  const f = await setup()
  f.state.runtime = videoRuntimeSchema.parse({ ...f.state.runtime, protocolVersion: 2, executionMode: 'real',
    profiles: f.state.runtime.profiles.map(profile => ({ ...profile, capabilities: { ...profile.capabilities,
      audioModes: [false], defaultAudio: false, defaults: fixture.quoteRequest.parameters } })) })
  f.runInput.employee.video = f.state.runtime
  let settled = false
  let terminalSeen = false
  let heldReceiptId: string | undefined
  const queries = new Map<string, number>()
  let queryStarted!: () => void
  const queryActive = new Promise<void>(resolve => { queryStarted = resolve })
  let releaseQuery!: () => void
  const queryGate = new Promise<void>(resolve => { releaseQuery = resolve })
  const source = f.options.gateway(scope)
  const real = (receipt: VideoReceipt): VideoReceipt => {
    const reconciled = receipt.receiptId !== heldReceiptId || settled
    return { ...receipt, mock: false,
      billingStatus: receipt.status === 'SUCCEEDED' ? reconciled ? 'SETTLED' : 'RECONCILING' : 'RESERVED',
      recovery: { ...receipt.recovery, canQuery: receipt.status !== 'SUCCEEDED' || !reconciled }, amountCny: '0.900000' }
  }
  const options: MockVideoHostOptions = { ...f.options, mock: false, tracker: { floorMs: 1, maxAttempts: 100, budgetMs: 10_000 }, gateway: () => ({
    quote: async (value, signal) => ({ ...await source.quote(value, signal), currency: 'CNY', amount: '0.900000' }),
    submit: async (value, signal) => {
      const receipt = await source.submit(value, signal)
      heldReceiptId ??= receipt.receiptId
      return real(receipt)
    },
    findReceipt: async (id, signal) => { const receipt = await source.findReceipt(id, signal); return receipt ? real(receipt) : null },
    getReceipt: async (id, signal) => {
      queries.set(id, (queries.get(id) ?? 0) + 1)
      const receipt = await source.getReceipt(id, signal)
      if (id === heldReceiptId) {
        if (terminalSeen) { queryStarted(); await queryGate }
        terminalSeen = terminalSeen || ['SUCCEEDED', 'PARTIAL_SUCCEEDED', 'FAILED', 'CANCELLED', 'RESULT_EXPIRED'].includes(receipt.status)
      }
      return real(receipt)
    }, content: source.content.bind(source),
    uploadReference: async (bytes, signal) => ({ ...await source.uploadReference(bytes, signal), mock: false }),
  }) }
  const service = new VideoRunService(options)
  const recoveryHost = new MockVideoHostService(options)
  let deadline: ReturnType<typeof setTimeout> | undefined
  const tools = await service.prepareRun(f.runInput)
  assert.ok(tools)
  const job = await tools.execute('video_from_image', input()) as { jobId: string }
  try {
    await service.waitForRun('task-a', 'run-a')
    const pending = await f.store.getJob(scope, 'task-a', job.jobId)
    assert.equal(pending?.saveStatus, 'SAVED'); assert.equal(pending?.receipt?.billingStatus, 'RECONCILING')
    await queryActive
    await service.finishRun('task-a', 'run-a')
    assert.equal((await f.store.getJob(scope, 'task-a', job.jobId))?.receipt?.billingStatus, 'RECONCILING')
    const oldQueries = queries.get(heldReceiptId!)
    const recovery = recoveryHost.track('task-a')
    void recovery.catch(() => undefined)
    await Promise.race([
      (async () => {
        const next = await service.prepareRun({ ...f.runInput, runId: 'run-b' })
        assert.ok(next)
        const generated = await next.execute('video_from_image', input()) as { jobId: string }
        await service.waitForRun('task-a', 'run-b')
        assert.equal((await f.store.getJob(scope, 'task-a', generated.jobId))?.saveStatus, 'SAVED')
        await service.finishRun('task-a', 'run-b')
      })(),
      new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(new Error('Next run blocked by previous billing.')), 2000) }),
    ])
    clearTimeout(deadline)
    assert.equal(queries.get(heldReceiptId!), oldQueries)
    settled = true
    releaseQuery()
    for (let attempt = 0; attempt < 20; attempt++) {
      if ((await f.store.getJob(scope, 'task-a', job.jobId))?.receipt?.billingStatus === 'SETTLED') break
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    const result = await f.store.getJob(scope, 'task-a', job.jobId)
    assert.equal(result?.receipt?.billingStatus, 'SETTLED'); assert.equal(result?.trackingStatus, 'STOPPED')
    assert.equal(queries.get(heldReceiptId!), oldQueries)
    assert.equal(f.gateway.calls.submit, 2); assert.equal(f.gateway.calls.quote, 2); assert.equal(f.gateway.calls.content, 2)
  } finally {
    clearTimeout(deadline)
    releaseQuery()
    await Promise.all([service.stopAll(), recoveryHost.stopAll()])
  }
})

test('rereads a video snapshot captured before its tracker finishes', { timeout: 10_000 }, async context => {
  const f = await setup()
  let queryStarted!: () => void, releaseQuery!: () => void
  const queryActive = new Promise<void>(resolve => { queryStarted = resolve })
  const queryGate = new Promise<void>(resolve => { releaseQuery = resolve })
  const source = f.options.gateway(scope)
  const service = new VideoRunService({ ...f.options, gateway: () => ({ ...source,
    getReceipt: async (id, signal) => { queryStarted(); await queryGate; return source.getReceipt(id, signal) },
  }) })
  let releaseSnapshot!: () => void, snapshotStarted!: () => void
  const snapshotGate = new Promise<void>(resolve => { releaseSnapshot = resolve })
  const snapshotActive = new Promise<void>(resolve => { snapshotStarted = resolve })
  try {
    const tools = await service.prepareRun(f.runInput)
    assert.ok(tools)
    const generation = tools.execute('video_from_image', input()) as Promise<{ jobId: string }>
    await queryActive
    const listJobs = f.store.listJobs.bind(f.store)
    const submitted = (await listJobs(scope))[0]!
    let holdSnapshot = true
    context.mock.method(f.store, 'listJobs', async (...args: Parameters<typeof listJobs>) => {
      const jobs = await listJobs(...args)
      if (holdSnapshot) { holdSnapshot = false; snapshotStarted(); await snapshotGate }
      return jobs
    })
    await new Promise(resolve => setTimeout(resolve, 10))
    await snapshotActive
    releaseQuery()
    for (let attempt = 0; attempt < 100; attempt++) {
      if ((await f.store.getJob(scope, 'task-a', submitted.jobId))?.saveStatus === 'SAVED') break
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    const saved = await f.store.listJobs(scope)
    const job = saved[0]
    assert.equal(job?.saveStatus, 'SAVED')
    // Let the terminal save settle its tracker while the earlier read stays held.
    await new Promise(resolve => setTimeout(resolve, 20))
    releaseSnapshot()
    const generated = await generation
    assert.equal(generated.jobId, job?.jobId)
    await service.waitForRun('task-a', 'run-a')
    assert.equal(f.gateway.calls.submit, 1)
  } finally { releaseQuery(); releaseSnapshot(); await service.stopAll() }
})

test('recovered run observes the existing tracker until its terminal video is saved', { timeout: 10_000 }, async context => {
  const f = await setup()
  let contentStarted!: () => void, releaseContent!: () => void
  const contentActive = new Promise<void>(resolve => { contentStarted = resolve })
  const contentGate = new Promise<void>(resolve => { releaseContent = resolve })
  let releaseSnapshot!: () => void, snapshotStarted!: () => void
  const snapshotGate = new Promise<void>(resolve => { releaseSnapshot = resolve })
  const snapshotActive = new Promise<void>(resolve => { snapshotStarted = resolve })
  const saveOutput = f.store.saveOutput.bind(f.store)
  context.mock.method(f.store, 'saveOutput', async (...args: Parameters<typeof saveOutput>) => {
    contentStarted(); await contentGate
    return saveOutput(...args)
  })
  const options = f.options
  const owner = new MockVideoHostService(options)
  const service = new VideoRunService(options)
  try {
    const job = await owner.generate('task-a', input())
    const tracking = owner.track('task-a')
    void tracking.catch(() => undefined)
    await contentActive
    assert.equal((await f.store.getJob(scope, 'task-a', job.jobId))?.saveStatus, 'SAVING')
    assert.ok(await service.prepareRun({ ...f.runInput, recoverJobIds: [job.jobId] }))
    let settled = false
    const delivery = service.waitForRun('task-a', 'run-a').finally(() => { settled = true })
    void delivery.catch(() => undefined)
    await new Promise(resolve => setTimeout(resolve, 150))
    assert.equal(settled, false, 'A passive tracker must not fail while the owner is saving')
    const listJobs = f.store.listJobs.bind(f.store)
    let holdSnapshot = true
    context.mock.method(f.store, 'listJobs', async (...args: Parameters<typeof listJobs>) => {
      const jobs = await listJobs(...args)
      if (holdSnapshot) { holdSnapshot = false; snapshotStarted(); await snapshotGate }
      return jobs
    })
    await snapshotActive
    releaseContent()
    await tracking
    releaseSnapshot()
    await delivery
    assert.equal((await f.store.getJob(scope, 'task-a', job.jobId))?.saveStatus, 'SAVED')
    assert.equal(f.gateway.calls.submit, 1)
    assert.equal(f.gateway.calls.content, 1)
  } finally { releaseContent(); releaseSnapshot(); await Promise.all([service.stopAll(), owner.stopAll()]) }
})

test('reports video save failure while its billing query is blocked', { timeout: 10_000 }, async () => {
  const f = await setup('corrupt-download')
  f.state.runtime = videoRuntimeSchema.parse({ ...f.state.runtime, protocolVersion: 2, executionMode: 'real',
    profiles: f.state.runtime.profiles.map(profile => ({ ...profile, capabilities: { ...profile.capabilities,
      audioModes: [false], defaultAudio: false, defaults: fixture.quoteRequest.parameters } })) })
  f.runInput.employee.video = f.state.runtime
  let terminalSeen = false, settled = false
  let queryStarted!: () => void
  const queryActive = new Promise<void>(resolve => { queryStarted = resolve })
  let releaseQuery!: () => void
  const queryGate = new Promise<void>(resolve => { releaseQuery = resolve })
  const source = f.options.gateway(scope)
  const real = (receipt: VideoReceipt): VideoReceipt => ({ ...receipt, mock: false,
    billingStatus: receipt.status === 'SUCCEEDED' ? settled ? 'SETTLED' : 'RECONCILING' : 'RESERVED',
    recovery: { ...receipt.recovery, canQuery: !settled }, amountCny: '0.900000' })
  const service = new VideoRunService({ ...f.options, mock: false, gateway: () => ({
    quote: async (value, signal) => ({ ...await source.quote(value, signal), currency: 'CNY', amount: '0.900000' }),
    submit: async (value, signal) => real(await source.submit(value, signal)),
    findReceipt: async (id, signal) => { const receipt = await source.findReceipt(id, signal); return receipt ? real(receipt) : null },
    getReceipt: async (id, signal) => {
      const receipt = await source.getReceipt(id, signal)
      if (terminalSeen) { queryStarted(); await queryGate }
      terminalSeen = terminalSeen || receipt.status === 'SUCCEEDED'
      return real(receipt)
    }, content: source.content.bind(source),
    uploadReference: async (bytes, signal) => ({ ...await source.uploadReference(bytes, signal), mock: false }),
  }) })
  let deadline: ReturnType<typeof setTimeout> | undefined
  try {
    const tools = await service.prepareRun(f.runInput)
    assert.ok(tools)
    const job = await tools.execute('video_from_image', input()) as { jobId: string }
    await queryActive
    assert.equal((await f.store.getJob(scope, 'task-a', job.jobId))?.saveStatus, 'SAVE_FAILED')
    await Promise.race([
      assert.rejects(service.waitForRun('task-a', 'run-a'), { code: 'INVALID_STATE' }),
      new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(new Error('Video save failure waited for billing.')), 500) }),
    ])
    assert.equal((await f.store.getJob(scope, 'task-a', job.jobId))?.receipt?.billingStatus, 'RECONCILING')
    settled = true
    releaseQuery()
    assert.equal(f.gateway.calls.submit, 1)
  } finally { clearTimeout(deadline); releaseQuery(); await service.stopAll() }
})

test('missing, malformed, disabled and empty-tools video cannot expose or execute tools', async () => {
  const f = await setup()
  for (const video of [undefined, {}, { ...f.state.runtime, protocolVersion: 2 }, { ...f.state.runtime, executionAvailable: false, tools: [] }, { ...f.state.runtime, tools: [] }]) {
    const employee = { ...f.runInput.employee, video } as unknown as typeof f.runInput.employee
    assert.equal(await f.service.prepareRun({ ...f.runInput, employee }), undefined)
  }
  const tools = await f.service.prepareRun(f.runInput)
  f.state.runtime = { ...f.state.runtime, tools: [] }
  await assert.rejects(tools!.execute('video_from_image', input()), { code: 'PERMISSION_DENIED' })
  assert.equal(f.gateway.calls.quote, 0)
  await f.service.stopAll()
})

test('new run restores uncertain original receipt without another submission', async () => {
  const f = await setup('submission-unknown')
  const original = await new MockVideoHostService(f.options).generate('task-a', input())
  assert.equal(original.generationStatus, 'SUBMISSION_UNKNOWN')
  const tools = await f.service.prepareRun(f.runInput)
  assert.ok(tools)
  await f.service.waitForRun('task-a', 'run-a')
  assert.equal((await f.store.getJob(scope, 'task-a', original.jobId))?.saveStatus, 'SAVED')
  assert.equal(f.gateway.calls.submit, 1)
  assert.equal(f.gateway.calls.quote, 1)
  assert.equal(f.gateway.calls.findReceipt, 1)
  await f.service.stopAll()
})

test('real rejection keeps its business code at run completion and does not poison the next explicit run', async () => {
  const f = await setup()
  f.state.runtime = videoRuntimeSchema.parse({ ...f.state.runtime, protocolVersion: 2, executionMode: 'real',
    profiles: f.state.runtime.profiles.map(profile => ({ ...profile, capabilities: { ...profile.capabilities,
      audioModes: [false], defaultAudio: false, defaults: fixture.quoteRequest.parameters } })) })
  f.runInput.employee.video = f.state.runtime
  const source = f.options.gateway(scope)
  let reject = true, deniedSubmissions = 0
  const denied = new SepRealVideoGateway({ mock: false, baseUrl: 'https://sep.invalid/api', subscriptionId: scope.subscriptionId,
    token: async () => 'test-token', fetch: async () => {
      deniedSubmissions++
      return new Response(JSON.stringify({ error: { code: 'INSUFFICIENT_FUNDS', source: 'platform', requestId: 'req-rejected-1' } }),
        { status: 402, headers: { 'Content-Type': 'application/json' } })
    } })
  const real = (receipt: VideoReceipt): VideoReceipt => ({ ...receipt, mock: false,
    billingStatus: receipt.status === 'SUCCEEDED' ? 'SETTLED' : 'RESERVED', amountCny: '28.800000' })
  const service = new VideoRunService({ ...f.options, mock: false, gateway: () => ({
    quote: async (value, signal) => ({ ...await source.quote(value, signal), currency: 'CNY', amount: '28.800000' }),
    submit: async (value, signal) => reject ? denied.submit(value, signal) : real(await source.submit(value, signal)),
    findReceipt: async (id, signal) => { const receipt = await source.findReceipt(id, signal); return receipt && real(receipt) },
    getReceipt: async (id, signal) => real(await source.getReceipt(id, signal)), content: source.content.bind(source),
    uploadReference: async (bytes, signal) => ({ ...await source.uploadReference(bytes, signal), mock: false }),
  }) })
  try {
    const failures: unknown[] = []
    const tools = await service.prepareRun({ ...f.runInput, onTerminalFailure: error => { failures.push(error) } })
    assert.ok(tools)
    const failed = await tools.execute('video_from_image', input()) as { error: string; generationStatus: string }
    assert.equal(failed.error, 'INSUFFICIENT_FUNDS')
    assert.equal(failed.generationStatus, 'FAILED')
    await assert.rejects(service.waitForRun('task-a', 'run-a'), { code: 'INSUFFICIENT_FUNDS' })
    await assert.rejects(service.waitForRun('task-a', 'run-a'), { code: 'INSUFFICIENT_FUNDS' })
    assert.equal(failures.length, 1)
    assert.equal((failures[0] as AppError).code, 'INSUFFICIENT_FUNDS')
    assert.equal(f.gateway.calls.findReceipt, 0)
    await service.finishRun('task-a', 'run-a')
    reject = false
    const next = await service.prepareRun({ ...f.runInput, runId: 'run-b' })
    assert.ok(next)
    await next.execute('video_from_image', input())
    await service.waitForRun('task-a', 'run-b')
    assert.equal(deniedSubmissions, 1)
    assert.equal(f.gateway.calls.submit, 1)
    assert.equal(f.gateway.calls.quote, 2)
    assert.equal(f.approvals.length, 4)
  } finally { await service.stopAll() }
})

test('new run cannot quote or submit again while an original MAYBE_SENT is unresolved', async context => {
  const f = await setup('submission-unknown')
  const original = await new MockVideoHostService(f.options).generate('task-a', input())
  assert.equal(original.generationStatus, 'SUBMISSION_UNKNOWN')
  context.mock.method(f.gateway, 'findReceipt', async () => null)
  const tools = await f.service.prepareRun(f.runInput)
  assert.ok(tools)
  try {
    await assert.rejects(tools.execute('video_from_image', input()), { code: 'CONFLICT' })
    assert.equal(f.gateway.calls.quote, 1)
    assert.equal(f.gateway.calls.submit, 1)
    assert.equal(f.state.uploads, 1)
    assert.equal(f.approvals.length, 2)
  } finally { await f.service.stopAll() }
})

test('receipt SUBMISSION_UNKNOWN also blocks generation until explicit original recovery clarifies it', async context => {
  const f = await setup('submission-unknown'), ipc = new MockVideoHostService(f.options)
  const original = await ipc.generate('task-a', input())
  await ipc.resume('task-a', original.jobId)
  const receipt = (await f.store.getJob(scope, 'task-a', original.jobId))!.receipt!
  assert.equal(receipt.status, 'SUBMISSION_UNKNOWN')
  const stalled = context.mock.method(f.gateway, 'getReceipt', async () => receipt)
  const tools = await f.service.prepareRun(f.runInput)
  try {
    await assert.rejects(tools!.execute('video_from_image', input()), { code: 'CONFLICT' })
    assert.equal(f.gateway.calls.quote, 1)
    assert.equal(f.gateway.calls.submit, 1)
    assert.equal(f.state.uploads, 1)
  } finally { await f.service.stopAll() }
  stalled.mock.restore()
  await ipc.resume('task-a', original.jobId)
  await ipc.resume('task-a', original.jobId)
  assert.equal((await f.store.getJob(scope, 'task-a', original.jobId))!.saveStatus, 'SAVED')
  await ipc.stopAll()
})

test('actual run facade and IPC host share the in-flight submission gate', async () => {
  const f = await setup(), ipc = new MockVideoHostService(f.options)
  let entered!: () => void, release!: () => void
  const waiting = new Promise<void>(resolve => { entered = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  const tools = await f.service.prepareRun({ ...f.runInput, requestApproval: async () => { entered(); await gate; return true } })
  const pending = tools!.execute('video_from_image', input())
  await waiting
  try {
    await assert.rejects(ipc.generate('task-a', input()), { code: 'CONFLICT' })
  } finally { release(); await pending; await f.service.stopAll(); await ipc.stopAll() }
  assert.equal(f.gateway.calls.quote, 1)
  assert.equal(f.gateway.calls.submit, 1)
})

test('revocation revision after approval prevents upload and submit', async () => {
  const f = await setup()
  const tools = await f.service.prepareRun({ ...f.runInput, requestApproval: async () => { f.state.revision++; return true } })
  await assert.rejects(tools!.execute('video_from_image', input()), { code: 'AUTH_REQUIRED' })
  assert.equal(f.state.uploads, 0)
  assert.equal(f.gateway.calls.submit, 0)
  await f.service.stopAll()
})

test('policy change after quote blocks submission even after approval', async () => {
  const f = await setup()
  let approvals = 0
  const tools = await f.service.prepareRun({ ...f.runInput, requestApproval: async () => {
    if (++approvals === 2) f.state.policy = { preset: 'read-only', allowedTools: [], allowedPaths: [], deniedPaths: [], workspaceDir: '/unused', commandPolicy: 'disabled', approvalMode: 'confirm-each' }
    return true
  } })
  await assert.rejects(tools!.execute('video_from_image', input()), { code: 'PERMISSION_DENIED' })
  assert.equal(f.gateway.calls.submit, 0)
  await f.service.stopAll()
})

test('stopTask interrupts an unresponsive approval and invalidates captured facade', async () => {
  const f = await setup()
  let entered!: () => void
  const waiting = new Promise<void>(resolve => { entered = resolve })
  const tools = await f.service.prepareRun({ ...f.runInput, requestApproval: async () => { entered(); return new Promise<boolean>(() => undefined) } })
  const rejected = assert.rejects(tools!.execute('video_from_image', input()))
  await waiting
  await f.service.stopTask('task-a')
  await rejected
  await assert.rejects(tools!.execute('video_from_image', input()))
  assert.equal(f.gateway.calls.submit, 0)
})

test('stopped run waits for interrupted content to settle and never reports completion', async context => {
  const f = await setup()
  let entered!: () => void
  const waiting = new Promise<void>(resolve => { entered = resolve })
  context.mock.method(f.gateway, 'content', async () => { entered(); return new Promise<AsyncIterable<Uint8Array>>(() => undefined) })
  const tools = await f.service.prepareRun(f.runInput)
  await tools!.execute('video_from_image', input())
  const rejected = assert.rejects(f.service.waitForRun('task-a', 'run-a'))
  await waiting
  await f.service.stopTask('task-a')
  await rejected
  assert.equal((await f.store.listJobs(scope))[0].saveStatus, 'SAVE_FAILED')
  assert.equal(f.gateway.calls.submit, 1)
})

test('node employee owns authorization even when task primary subscription differs', async () => {
  const f = await setup()
  f.state.subscriptionId = 'task-primary-subscription'
  const tools = await f.service.prepareRun(f.runInput)
  await tools!.execute('video_from_image', input())
  assert.ok(f.approvals.every(request => request.subscriptionId === scope.subscriptionId))
  f.state.subscriptionId = 'new-task-primary'
  await assert.rejects(f.service.waitForRun('task-a', 'run-a'), { code: 'AUTH_REQUIRED' })
  assert.equal(f.gateway.calls.submit, 1)
  await f.service.stopAll()
})

for (const scenario of ['failed', 'corrupt-download'] as const) {
  test(`${scenario} does not mark video run delivered`, async () => {
    const f = await setup(scenario), tools = await f.service.prepareRun(f.runInput)
    await tools!.execute('video_from_image', input())
    await assert.rejects(f.service.waitForRun('task-a', 'run-a'), { code: 'INVALID_STATE' })
    assert.equal(f.gateway.calls.submit, 1)
    await f.service.stopAll()
  })
}

test('stopTask aborts preparation before a delayed task binding can publish a facade', async () => {
  const f = await setup()
  let entered!: () => void
  const waiting = new Promise<void>(resolve => { entered = resolve })
  const service = new VideoRunService({ ...f.options, getTask: async () => { entered(); return new Promise<null>(() => undefined) } })
  const rejected = assert.rejects(service.prepareRun(f.runInput))
  await waiting
  await service.stopTask('task-a')
  await rejected
  assert.equal(f.gateway.calls.submit, 0)
})

test('runtime stopTask also interrupts direct IPC host generation', async () => {
  const f = await setup()
  let entered!: () => void
  const waiting = new Promise<void>(resolve => { entered = resolve })
  const ipcHost = new MockVideoHostService({ ...f.options, requestApproval: async () => { entered(); return new Promise<boolean>(() => undefined) } })
  const service = new VideoRunService(f.options, ipcHost)
  const rejected = assert.rejects(ipcHost.generate('task-a', input()))
  await waiting
  await service.stopTask('task-a')
  await rejected
  assert.equal(f.gateway.calls.submit, 0)
})
