import { afterEach, describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { createHash } from 'node:crypto'
import { inflateSync } from 'node:zlib'
import { readFileSync } from 'node:fs'
import type { MediaGenerationInput } from '../../src/shared/media'
import type { ToolAuthorizationRequest } from '../../src/shared/types'
import { MOCK_MEDIA_CAPABILITIES, MOCK_MEDIA_PNG, MOCK_MEDIA_PNG_SHA256, MockMediaGateway } from '../data/mock-media-gateway'
import { MediaStore } from '../data/media-store'
import { SepRealMediaGateway } from '../data/sep-real-media-gateway'
import { inspectMediaImage } from '../data/media-image'
import type { TaskOwnerScope } from '../data/scope-path'
import { ScopePath } from '../data/scope-path'
import { mediaJobActions } from '../../src/shared/media-view'
import type { LocalMediaJob } from '../domain/media'
import { AppError } from '../errors/app-error'
import { config } from '../common/config'
import { realMediaSemanticHash } from '../common/platform/real-media-semantics'
import { ToolApprovals } from '../runtime/run-approvals'
import type { EmployeeRuntimeConfig, TaskToolPolicy } from '../runtime/run-types'
import { MediaService, type MediaServiceOptions } from './media-service'
import { EmployeeAuthorizer } from './employee-authorizer'
import { EmployeeDirectory } from './employee-directory'

const owner = { memberId: 'member-a', enterpriseId: 'enterprise-a' }
const other = { memberId: 'member-b', enterpriseId: 'enterprise-a' }
const directories: string[] = []
const services: MediaService[] = []
const approvals: ToolApprovals[] = []

afterEach(async () => {
  for (const approval of approvals.splice(0)) approval.denyAll()
  await Promise.all(services.splice(0).map(service => service.stopAll()))
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

function input(overrides: Partial<MediaGenerationInput> = {}): MediaGenerationInput {
  return { profileId: 'mock-image', operation: 'generate', localAssetIds: [], creativeBrief: 'A product photograph',
    parameters: { aspectRatio: '1:1', count: 1 }, ...overrides }
}

function policy(preset: TaskToolPolicy['preset'] = 'full-local', approvalMode: TaskToolPolicy['approvalMode'] = 'auto-approve'): TaskToolPolicy {
  return { preset, approvalMode, allowedTools: [], allowedPaths: [], deniedPaths: [], commandPolicy: 'restricted', workspaceDir: '/unused-mock-workspace' }
}

async function fixture(overrides: Partial<MediaServiceOptions> = {}, gateway = new MockMediaGateway()) {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'sep-media-service-'))
  directories.push(directory)
  const root = join(directory, 'user-data')
  const store = new MediaStore(root)
  let activeScope: TaskOwnerScope | null = owner
  const approvalRequests: Omit<ToolAuthorizationRequest, 'requestId' | 'timestamp'>[] = []
  const employee: EmployeeRuntimeConfig = { subscriptionId: 'subscription-a', modelId: 'model-a', gatewayUrl: 'mock://no-network',
    systemPrompt: 'Product photography employee', media: structuredClone(MOCK_MEDIA_CAPABILITIES) }
  const options: MediaServiceOptions = {
    scope: { currentScope: () => activeScope }, store, gateway,
    getTask: async taskId => ['task-a', 'task-b'].includes(taskId) ? { subscriptionId: employee.subscriptionId } : null,
    authorize: async () => employee,
    requestApproval: async request => { approvalRequests.push(request); return true },
    pollFloorMs: 1, maxAttempts: 3, operationTimeoutMs: 1_000,
    ...overrides,
  }
  const service = new MediaService(options)
  services.push(service)
  return { service, store, gateway, root, directory, employee, options, approvalRequests, setScope: (scope: TaskOwnerScope | null) => { activeScope = scope } }
}

async function waitUntil(check: () => Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!await check()) {
    if (Date.now() >= deadline) assert.fail('Media operation did not settle within the test deadline.')
    await delay(2)
  }
}

function code(expected: string): (error: unknown) => boolean {
  return error => error instanceof AppError && error.code === expected
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

async function pendingJob(f: Awaited<ReturnType<typeof fixture>>, taskId = 'task-a', id = 'pending-job'): Promise<LocalMediaJob> {
  const job = notSentJob()
  job.jobId = id; job.taskId = taskId; job.clientRequestId = `request-${id}`
  job.request.clientRequestId = job.clientRequestId
  const receipt = await f.gateway.submit(job.subscriptionId, job.request, new AbortController().signal)
  job.receiptId = receipt.receiptId; job.submission = 'RECEIPTED'; job.generationStatus = receipt.status
  await f.store.saveJob(owner, job)
  return job
}

async function realFixture(initial: {
  billingStatus?: 'RESERVED' | 'RECONCILING' | 'SETTLED' | 'RELEASED'
  status?: 'SUCCEEDED' | 'PARTIAL_SUCCEEDED' | 'FAILED'
  canQuery?: boolean
  lostSubmit?: boolean
} = {}) {
  const state = { billingStatus: initial.billingStatus ?? 'RECONCILING', status: initial.status ?? 'SUCCEEDED',
    canQuery: initial.canQuery ?? true, queryFailure: 0, clientRequestId: '' }
  const calls: { path: string; method: string; body: Record<string, unknown> | null }[] = []
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
  const receipt = () => ({ mock: false, receiptId: 'real-receipt', clientRequestId: state.clientRequestId,
    profileId: 'image-prod', configVersion: 'cfg-v1', executionMode: 'sync-response', status: state.status, pollAfterMs: 1,
    billingStatus: state.billingStatus, errorCode: null, outputErrors: state.status === 'PARTIAL_SUCCEEDED' ? [{ index: 1, code: 'OUTPUT_FAILED' }] : [],
    recovery: { canQuery: state.canQuery, canCancel: false, canDownload: state.status !== 'FAILED' },
    outputs: state.status === 'FAILED' ? [] : [{ outputId: 'real-output', kind: 'image', mimeType: 'image/png',
      byteLength: MOCK_MEDIA_PNG.length, width: 1, height: 1, sha256: MOCK_MEDIA_PNG_SHA256,
      expiresAt: new Date(Date.now() + 60_000).toISOString() }] })
  const gateway = new SepRealMediaGateway({ baseUrl: 'https://sep.invalid/api', token: async () => 'fixture-token-not-real',
    fetch: async (url, init) => {
      const headers = new Headers(init?.headers)
      assert.equal(headers.get('Origin'), config.SEP_WEB_ORIGIN)
      assert.equal(headers.get('Referer'), `${config.SEP_WEB_ORIGIN}/`)
      const path = new URL(String(url)).pathname.replace('/api/gateway/v1/media/real', '')
      const method = init?.method ?? 'GET'
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : null
      calls.push({ path, method, body })
      if (path === '/quotes' && method === 'POST') return json({ mock: false, quoteId: 'real-quote',
        expiresAt: new Date(Date.now() + 60_000).toISOString(), semanticSha256: realMediaSemanticHash({
          profileId: String(body!.profileId), configVersion: String(body!.configVersion), operation: body!.operation as 'generate',
          referenceHashes: [], creativeBrief: String(body!.creativeBrief), parameters: {
            aspectRatio: ({ '1024x1024': '1:1', '1536x1024': '3:2', '1024x1536': '2:3' } as Record<string, string>)[(body!.parameters as { size: string }).size]!,
            ...(body!.parameters as { size: string; count: number; quality: string }),
          },
        }), pricingStatus: 'quoted',
        amountCny: '0.120000', pricingVersion: 'price-v1', billingStatus: 'NOT_RESERVED',
        funding: { creditCny: '0.120000', memberWalletCny: '0.000000', personalCny: '0.000000' } })
      if (path === '/requests' && method === 'POST') {
        assert.equal(state.clientRequestId, '', 'Generation must never be resubmitted.')
        state.clientRequestId = String(body?.clientRequestId)
        if (initial.lostSubmit) throw new Error('Simulated lost submission response')
        return json(receipt(), 202)
      }
      if (method === 'GET' && (path === '/requests/real-receipt' || path === `/requests/by-client-id/${state.clientRequestId}`)) {
        if (state.queryFailure) return json({}, state.queryFailure)
        return json(receipt())
      }
      if (path === '/requests/real-receipt/outputs/real-output/content' && method === 'GET') {
        return new Response(MOCK_MEDIA_PNG, { headers: { 'Content-Type': 'image/png', 'Content-Length': String(MOCK_MEDIA_PNG.length),
          'X-SHA256': MOCK_MEDIA_PNG_SHA256, 'X-SEP-Media-Mock': 'false' } })
      }
      assert.fail(`Unexpected media request: ${method} ${path}`)
    } })
  const f = await fixture({ gateway })
  f.employee.media = { protocolVersion: 1, executionAvailable: true, defaultProfileId: 'image-prod', tools: ['image_generate'], profiles: [{
    profileId: 'image-prod', kind: 'image', displayName: 'Production image', configVersion: 'cfg-v1', operations: ['generate'], executionMode: 'sync-response',
    capabilities: { supportsReferenceImage: false, maxOutputs: 4, sizes: ['1024x1024', '1536x1024', '1024x1536'], maxWidth: 1536, maxHeight: 1536 },
  }] }
  return { ...f, state, calls, generate: (parameters: MediaGenerationInput['parameters'] = { aspectRatio: '1:1', size: '1024x1024', count: 1 }) =>
    f.service.generateTaskMedia('task-a', input({ profileId: 'image-prod', parameters })) }
}

describe('real media billing recovery and canonical sizes', () => {
  it('rejects mismatched size and ratio before quote, approval or submission', async () => {
    const f = await realFixture({})
    await assert.rejects(f.generate({ aspectRatio: '1:1', size: '1536x1024', count: 1 }), code('INVALID_ARGUMENT'))
    assert.deepEqual(f.calls, [])
    assert.deepEqual(f.approvalRequests, [])
  })

  it('freezes v2 quality defaults into approval, quote, submission and recovery', async () => {
    const f = await realFixture({ billingStatus: 'SETTLED' })
    const runtime = f.employee.media as { protocolVersion: number; profiles: { capabilities: Record<string, unknown> }[] }
    runtime.protocolVersion = 2
    Object.assign(runtime.profiles[0].capabilities, { qualities: ['low', 'medium', 'high'], defaultQuality: 'high', defaultSize: '1536x1024' })
    const first = await f.generate({ aspectRatio: '3:2', count: 1 })
    await f.service.waitForRun('task-a', first.runId)
    const saved = (await f.store.getJob(owner, 'task-a', first.jobId))!
    assert.deepEqual(saved.input.parameters, { aspectRatio: '3:2', size: '1536x1024', count: 1, quality: 'high' })
    assert.deepEqual((f.approvalRequests[0].input as { parameters: unknown }).parameters, saved.input.parameters)
    const quoted = f.calls.find(call => call.path === '/quotes')!.body!
    const submitted = f.calls.find(call => call.path === '/requests')!.body!
    assert.deepEqual(quoted.parameters, { size: '1536x1024', count: 1, quality: 'high' })
    assert.deepEqual(submitted.parameters, quoted.parameters)
    assert.equal(saved.requestHash, realMediaSemanticHash(saved.request))
    Object.assign(runtime.profiles[0].capabilities, { qualities: ['low'], defaultQuality: 'low' })
    const before = f.calls.length
    await f.service.retrySave('task-a', first.jobId)
    const restored = (await f.store.getJob(owner, 'task-a', first.jobId))!
    assert.equal(restored.input.parameters.quality, 'high')
    assert.equal(restored.requestHash, saved.requestHash)
    assert.equal(f.calls.slice(before).filter(call => call.method === 'POST').length, 0)
  })

  it('explains unadvertised quality as an input error without quoting or submitting', async () => {
    const f = await realFixture({})
    await assert.rejects(f.generate({ aspectRatio: '2:3', count: 1, quality: 'high' }), error => {
      assert.ok(error instanceof AppError)
      assert.equal(error.code, 'INVALID_ARGUMENT')
      assert.match(error.userMessage, /media_get_capabilities/)
      assert.match(error.userMessage, /不要传 quality/)
      return true
    })
    assert.deepEqual(f.calls, [])
  })

  for (const [aspectRatio, explicitSize, expectedSize] of [
    ['1:1', undefined, '1024x1024'], ['3:2', undefined, '1536x1024'], ['2:3', undefined, '1024x1536'],
    ['3:2', '1536x1024', '1536x1024'],
  ] as const) {
    it(`uses the same quote and submission hash for ${aspectRatio} ${explicitSize ?? 'default size'}`, async () => {
      const f = await realFixture({ billingStatus: 'SETTLED' })
      const view = await f.generate({ aspectRatio, count: 1, ...(explicitSize ? { size: explicitSize } : {}) })
      await f.service.waitForRun('task-a', view.runId)
      const quoted = f.calls.find(call => call.path === '/quotes')!.body!
      const submitted = f.calls.find(call => call.path === '/requests')!.body!
      assert.deepEqual(quoted.parameters, { size: expectedSize, count: 1, quality: 'medium' })
      assert.deepEqual(submitted.parameters, quoted.parameters)
      const job = (await f.store.getJob(owner, 'task-a', view.jobId))!
      const expectedHash = realMediaSemanticHash({ profileId: 'image-prod', configVersion: 'cfg-v1',
        operation: 'generate', creativeBrief: input().creativeBrief, parameters: { aspectRatio, size: expectedSize, count: 1 }, referenceHashes: [] })
      assert.equal(job.requestHash, expectedHash)
      assert.equal(job.quote.requestHash, expectedHash)
      assert.equal(job.request.requestHash, expectedHash)
      assert.equal(job.approval, 'manual')
      assert.equal(f.approvalRequests.length, 1)
      assert.equal(f.calls.filter(call => call.path === '/requests').length, 1)
    })
  }

  for (const status of ['SUCCEEDED', 'PARTIAL_SUCCEEDED', 'FAILED'] as const) {
    for (const billingStatus of ['RESERVED', 'RECONCILING'] as const) {
      it(`continues original receipt queries after ${status} with ${billingStatus}`, async () => {
        const f = await realFixture({ status, billingStatus })
        const view = await f.generate({ aspectRatio: '1:1', size: '1024x1024', count: status === 'PARTIAL_SUCCEEDED' ? 2 : 1 })
        await waitUntil(async () => f.calls.some(call => call.path === '/requests/real-receipt'))
        const pending = (await f.store.getJob(owner, 'task-a', view.jobId))!
        assert.equal(pending.generationStatus, status)
        assert.equal(pending.trackingStatus, 'ACTIVE')
        assert.equal(pending.billingStatus, billingStatus)
        if (status !== 'FAILED') {
          const assets = await f.store.listAssets(owner, 'task-a')
          assert.equal(assets.length, 1, 'Save outputs before billing settles.')
          assert.equal(assets[0].status, 'SAVED')
        }
        assert.equal((await f.service.getTaskMedia('task-a')).jobs[0].canResumeTracking, true)
        f.state.billingStatus = status === 'FAILED' ? 'RELEASED' : 'SETTLED'
        await waitUntil(async () => (await f.store.getJob(owner, 'task-a', view.jobId))?.trackingStatus === 'STOPPED')
        const settled = (await f.store.getJob(owner, 'task-a', view.jobId))!
        assert.equal(settled.billingStatus, f.state.billingStatus)
        assert.equal((await f.service.getTaskMedia('task-a')).jobs[0].canResumeTracking, false)
        assert.equal(f.calls.filter(call => call.path.endsWith('/content')).length, status === 'FAILED' ? 0 : 1)
        assert.equal(f.calls.filter(call => call.path === '/requests').length, 1)
        assert.equal(f.calls.filter(call => call.path === '/quotes').length, 1)
      })
    }
  }

  it('recovers a lost submission response by original client ID then receipt ID without another POST', async () => {
    const f = await realFixture({ lostSubmit: true })
    const view = await f.generate()
    await waitUntil(async () => f.calls.some(call => call.path === '/requests/real-receipt'))
    assert.equal(f.calls.filter(call => call.path === `/requests/by-client-id/${f.state.clientRequestId}`).length, 1)
    assert.equal((await f.store.listAssets(owner, 'task-a'))[0]?.status, 'SAVED')
    f.state.billingStatus = 'SETTLED'
    await f.service.waitForRun('task-a', view.runId)
    assert.equal(f.calls.filter(call => call.path === '/requests').length, 1)
  })

  it('restores terminal pending billing after restart without redownloading or resubmitting', async () => {
    const f = await realFixture()
    const view = await f.generate()
    await waitUntil(async () => f.calls.some(call => call.path === '/requests/real-receipt'))
    await f.service.stopAll()
    assert.equal((await f.store.getJob(owner, 'task-a', view.jobId))?.trackingStatus, 'INTERRUPTED')
    const queries = f.calls.filter(call => call.path === '/requests/real-receipt').length
    const restarted = new MediaService({ ...f.options, store: new MediaStore(f.root) })
    services.push(restarted)
    f.state.billingStatus = 'SETTLED'
    await restarted.resumePending()
    await restarted.waitForRun('task-a', view.runId)
    await waitUntil(async () => (await f.store.getJob(owner, 'task-a', view.jobId))?.billingStatus === 'SETTLED')
    assert.ok(f.calls.filter(call => call.path === '/requests/real-receipt').length > queries)
    assert.equal(f.calls.filter(call => call.path.endsWith('/content')).length, 1)
    assert.equal(f.calls.filter(call => call.path === '/requests').length, 1)
  })

  for (const failure of [503, 401]) {
    it(`preserves query failure state ${failure} and resumes billing against the original receipt`, async () => {
      const f = await realFixture()
      f.state.queryFailure = failure
      const view = await f.generate()
      const expectedStatus = failure === 401 ? 'AUTH_REQUIRED' : 'STOPPED'
      await waitUntil(async () => (await f.store.getJob(owner, 'task-a', view.jobId))?.trackingStatus === expectedStatus)
      const job = (await f.store.getJob(owner, 'task-a', view.jobId))!
      assert.equal(job.saveStatus, 'SAVED')
      assert.equal(job.billingStatus, 'RECONCILING')
      assert.match(job.error!, failure === 401 ? /授权/ : /重试已达上限/)
      assert.equal(f.calls.filter(call => call.path === '/requests/real-receipt').length, failure === 401 ? 1 : 3)
      f.state.queryFailure = 0
      f.state.billingStatus = 'SETTLED'
      await f.service.resume('task-a', view.jobId)
      await f.service.waitForRun('task-a', view.runId)
      await waitUntil(async () => (await f.store.getJob(owner, 'task-a', view.jobId))?.billingStatus === 'SETTLED')
      assert.equal(f.calls.filter(call => call.path.endsWith('/content')).length, 1)
      assert.equal(f.calls.filter(call => call.path === '/requests').length, 1)
    })
  }

  for (const failure of ['AUTH_REQUIRED', 'PERMISSION_DENIED'] as const) {
    it(`preserves gateway download ${failure} after a query reaches terminal settled billing`, async context => {
      const f = await realFixture({ lostSubmit: true, billingStatus: 'SETTLED' })
      const stub = context.mock.method(f.options.gateway!, 'content', async () => { throw new AppError(failure) })
      const view = await f.generate()
      await waitUntil(async () => (await f.store.getJob(owner, 'task-a', view.jobId))?.trackingStatus === 'AUTH_REQUIRED')
      const job = (await f.store.getJob(owner, 'task-a', view.jobId))!
      assert.equal(job.generationStatus, 'SUCCEEDED')
      assert.equal(job.billingStatus, 'SETTLED')
      assert.match(job.error!, /授权/)
      assert.equal((await f.store.listAssets(owner, 'task-a')).length, 0)
      stub.mock.restore()
      await f.service.resume('task-a', view.jobId)
      await f.service.waitForRun('task-a', view.runId)
      assert.equal((await f.store.listAssets(owner, 'task-a'))[0]?.status, 'SAVED')
      assert.equal(f.calls.filter(call => call.path === '/requests').length, 1)
      assert.equal(f.calls.filter(call => call.path === '/quotes').length, 1)
    })
  }

  it('honors canQuery=false even when terminal billing is unresolved', async () => {
    const f = await realFixture({ canQuery: false })
    const view = await f.generate()
    await f.service.waitForRun('task-a', view.runId)
    assert.equal((await f.store.getJob(owner, 'task-a', view.jobId))?.billingStatus, 'RECONCILING')
    assert.equal((await f.service.getTaskMedia('task-a')).jobs[0].canResumeTracking, false)
    assert.equal(f.calls.filter(call => call.path === '/requests/real-receipt').length, 0)
    assert.equal(f.calls.filter(call => call.path === '/requests').length, 1)
  })

  it('does not automatically revive terminal billing queries explicitly stopped by the user', async () => {
    const f = await realFixture()
    const view = await f.generate()
    await waitUntil(async () => f.calls.some(call => call.path === '/requests/real-receipt'))
    await f.service.stopTask('task-a')
    const queries = f.calls.filter(call => call.path === '/requests/real-receipt').length
    await f.service.stopAll()
    const restarted = new MediaService({ ...f.options, store: new MediaStore(f.root) })
    services.push(restarted)
    await restarted.resumePending()
    assert.equal((await f.store.getJob(owner, 'task-a', view.jobId))?.trackingStatus, 'STOPPED')
    assert.equal(f.calls.filter(call => call.path === '/requests/real-receipt').length, queries)
    assert.equal(f.calls.filter(call => call.path === '/requests').length, 1)
  })
})

it('allows ordinary legacy tasks without an employee binding to bypass media archival', async () => {
  const f = await fixture({ getTask: async () => ({ subscriptionId: null }) })
  assert.equal(await f.service.archiveIfMedia('task-a'), false)
  assert.equal(await f.store.isArchived(owner, 'task-a'), false)
  assert.equal(f.gateway.calls.submit.length, 0)
})

function notSentJob(): LocalMediaJob {
  const requestHash = 'a'.repeat(64)
  const generationInput = input()
  return {
    version: 1, owner, jobId: 'not-sent-job', taskId: 'task-a', runId: 'original-run', subscriptionId: 'subscription-a', clientRequestId: 'original-request', requestHash,
    input: generationInput, profile: structuredClone(MOCK_MEDIA_CAPABILITIES.profiles[0]),
    request: { clientRequestId: 'original-request', requestHash, quoteId: 'quote-a', profileId: 'mock-image', configVersion: 'mock-v1',
      operation: 'generate', referenceIds: [], referenceHashes: [], creativeBrief: generationInput.creativeBrief, parameters: generationInput.parameters },
    quote: { quoteId: 'quote-a', requestHash, expiresAt: Date.now() + 60_000, status: 'quoted', amount: '0', currency: 'MOCK', authorized: true,
      budgetAuthorized: true, allowUnknownCost: false },
    approval: 'manual', receiptId: null, submission: 'NOT_SENT', generationStatus: 'SUBMITTING', trackingStatus: 'ACTIVE', saveStatus: 'PENDING',
    outputs: [], billingStatus: 'UNKNOWN', nextPollAt: 0, attempts: 0, error: null, createdAt: 1, updatedAt: 1,
  }
}

describe('MediaService authorization and request semantics', () => {
  it('edits from a completed task when the runtime default model has been retired', async () => {
    const f = await fixture({ getTask: async () => ({ subscriptionId: 'subscription-a', status: 'completed' }) })
    const directory = new EmployeeDirectory(async () => [{
      id: 'subscription-a', subscriptionId: 'subscription-a', employeeId: 'employee-a', name: 'Designer',
      status: 'ACTIVE', templateVersion: '1', template: { id: 'employee-a', name: 'Designer', avatar: null },
      allowedModels: ['current-model'], department: null, upgradeAvailable: false,
    }])
    const authorizer = new EmployeeAuthorizer({ getValidAccessToken: async () => 'mock-token', getMeta: () => owner }, directory,
      { prepare: async () => ({ skillPaths: [], skills: [] }), invalidate() {} }, 'mock://no-network', {
        getRuntime: async () => ({ manifestVersion: 1, subscriptionId: 'subscription-a', templateVersion: '1',
          employee: { id: 'employee-a', name: 'Designer', version: '1', maxSteps: 10 },
          runtime: { systemPrompt: 'Designer', modelId: 'old-template-model', allowedModels: ['retired-model', 'current-model'],
            media: MOCK_MEDIA_CAPABILITIES, skills: [] } }),
      })
    f.options.authorize = subscriptionId => authorizer.authorizeRuntime(subscriptionId)
    const selected = join(f.directory, 'reference.png')
    await writeFile(selected, MOCK_MEDIA_PNG)
    const [asset] = await f.service.importReferences('task-a', [selected])
    const view = await f.service.generateTaskMedia('task-a', input({ operation: 'edit', localAssetIds: [asset.localAssetId] }))
    await f.service.waitForRun('task-a', view.runId)
    assert.equal(f.gateway.calls.submit.length, 1)
    assert.equal(f.gateway.calls.submit[0].request.operation, 'edit')
    const saved = await f.service.getTaskMedia('task-a')
    assert.equal(saved.jobs[0].generationStatus, 'SUCCEEDED')
    assert.equal(saved.jobs[0].saveStatus, 'SAVED')
    assert.ok(saved.assets.some(output => output.source === 'output' && output.status === 'SAVED'))
  })

  it('offers original download recovery after a saved local image is deleted without generating again', async () => {
    const f = await fixture({}, new MockMediaGateway({ initialStatus: 'SUCCEEDED' }))
    const generated = await f.service.generateTaskMedia('task-a', input())
    await f.service.waitForRun('task-a', generated.runId)
    const [asset] = await f.store.listAssets(owner, 'task-a')
    await rm(join(new ScopePath(f.root).mediaRoot(owner, 'task-a'), asset.relativePath))
    const missing = (await f.service.getTaskMedia('task-a')).jobs[0]
    assert.equal(missing.assets[0].status, 'MISSING')
    assert.equal(missing.saveStatus, 'MISSING')
    assert.equal(mediaJobActions(missing, false).retrySave, true)
    await f.service.retrySave('task-a', generated.jobId)
    await waitUntil(async () => (await f.service.getTaskMedia('task-a')).jobs[0].saveStatus === 'SAVED')
    assert.equal(f.gateway.calls.submit.length, 1)
    assert.equal(f.gateway.calls.quote.length, 1)
    assert.deepEqual(await f.store.readAsset(owner, 'task-a', asset.localAssetId), MOCK_MEDIA_PNG)
  })

  it('rechecks authoritative cancellation permission after waiting for approval', async () => {
    const approval = deferred<boolean>()
    const entered = deferred<void>()
    const f = await fixture({ requestApproval: async () => { entered.resolve(); return approval.promise } })
    const job = await pendingJob(f)
    job.recovery = { canQuery: true, canCancel: true, canDownload: false }
    await f.store.saveJob(owner, job)
    const cancelling = f.service.cancel('task-a', job.jobId, true)
    const rejected = assert.rejects(cancelling, code('INVALID_STATE'))
    await entered.promise
    job.recovery.canCancel = false
    await f.store.saveJob(owner, job)
    approval.resolve(true)
    await rejected
    assert.equal(f.gateway.calls.cancel.length, 0)
  })

  it('preserves the legacy gateway hash including local aspect ratio and quality semantics', async () => {
    const f = await fixture({}, new MockMediaGateway({ initialStatus: 'SUCCEEDED' }))
    const view = await f.service.generateTaskMedia('task-a', input())
    await f.service.waitForRun('task-a', view.runId)
    const quoted = f.gateway.calls.quote[0].request
    assert.equal(quoted.requestHash, createHash('sha256').update(JSON.stringify({ profileId: quoted.profileId,
      configVersion: quoted.configVersion, operation: quoted.operation, referenceHashes: quoted.referenceHashes,
      creativeBrief: quoted.creativeBrief, parameters: quoted.parameters })).digest('hex'))
  })

  it('approves transmission before upload and quotes the uploaded references for SEP', async () => {
    const gateway = new MockMediaGateway({ initialStatus: 'SUCCEEDED' })
    Object.assign(gateway, { quoteRequiresUploadedReferences: true })
    const stages: string[] = []
    const f = await fixture({ requestApproval: async request => {
      stages.push((request.input as { operation: string }).operation === 'upload-references' ? 'upload-approval' : 'generate-approval')
      return true
    } }, gateway)
    const selected = join(f.directory, 'reference.png')
    await writeFile(selected, MOCK_MEDIA_PNG)
    const [asset] = await f.service.importReferences('task-a', [selected])
    const view = await f.service.generateTaskMedia('task-a', input({ operation: 'edit', localAssetIds: [asset.localAssetId] }))
    await f.service.waitForRun('task-a', view.runId)
    assert.deepEqual(stages, ['upload-approval', 'generate-approval'])
    const quoted = gateway.calls.quote[0].request
    assert.equal(quoted.referenceIds.length, 1)
    assert.deepEqual(quoted.referenceIds, gateway.calls.submit[0].request.referenceIds)
    assert.equal(quoted.requestHash, realMediaSemanticHash(quoted))
  })

  it('does not upload or quote when the separate SEP reference transfer approval is denied', async () => {
    const gateway = new MockMediaGateway()
    Object.assign(gateway, { quoteRequiresUploadedReferences: true })
    const f = await fixture({ requestApproval: async () => false }, gateway)
    const selected = join(f.directory, 'reference.png')
    await writeFile(selected, MOCK_MEDIA_PNG)
    const [asset] = await f.service.importReferences('task-a', [selected])
    await assert.rejects(f.service.generateTaskMedia('task-a', input({ operation: 'edit', localAssetIds: [asset.localAssetId] })), code('PERMISSION_DENIED'))
    assert.equal(gateway.calls.uploadReference.length, 0)
    assert.equal(gateway.calls.quote.length, 0)
    assert.equal(gateway.calls.submit.length, 0)
  })

  it('does not submit after uploaded references receive a denied SEP budget', async () => {
    const gateway = new MockMediaGateway({ quote: { budgetAuthorized: false } })
    Object.assign(gateway, { quoteRequiresUploadedReferences: true })
    const f = await fixture({}, gateway)
    const selected = join(f.directory, 'reference.png')
    await writeFile(selected, MOCK_MEDIA_PNG)
    const [asset] = await f.service.importReferences('task-a', [selected])
    await assert.rejects(f.service.generateTaskMedia('task-a', input({ operation: 'edit', localAssetIds: [asset.localAssetId] })), code('PERMISSION_DENIED'))
    assert.equal(gateway.calls.uploadReference.length, 1)
    assert.equal(gateway.calls.quote.length, 1)
    assert.equal(gateway.calls.submit.length, 0)
    assert.deepEqual(await f.store.listJobs(owner), [])
  })

  it('persists authoritative UNKNOWN recovery flags and stops querying without enabling redo', async context => {
    const gateway = new MockMediaGateway()
    const original = gateway.submit.bind(gateway)
    context.mock.method(gateway, 'submit', async (...args: Parameters<typeof gateway.submit>) => ({
      ...await original(...args), status: 'SUBMISSION_UNKNOWN' as const, pollAfterMs: null,
      recovery: { canQuery: false, canCancel: false, canDownload: false }, errorCode: 'SUBMISSION_UNKNOWN', outputErrors: [],
    }))
    const f = await fixture({}, gateway)
    const view = await f.service.generateTaskMedia('task-a', input())
    await waitUntil(async () => (await f.store.getJob(owner, 'task-a', view.jobId))?.trackingStatus === 'STOPPED')
    await f.service.resume('task-a', view.jobId)
    await waitUntil(async () => (await f.store.getJob(owner, 'task-a', view.jobId))?.trackingStatus === 'STOPPED')
    const restored = await new MediaStore(f.root).getJob(owner, 'task-a', view.jobId)
    assert.equal(restored?.generationStatus, 'SUBMISSION_UNKNOWN')
    assert.deepEqual(restored?.recovery, { canQuery: false, canCancel: false, canDownload: false })
    assert.equal(restored?.errorCode, 'SUBMISSION_UNKNOWN')
    assert.equal(gateway.calls.getReceipt.length, 0)
    await assert.rejects(f.service.redo('task-a', view.jobId), code('INVALID_STATE'))
    await assert.rejects(f.service.cancel('task-a', view.jobId, true), code('INVALID_STATE'))
    assert.equal(gateway.calls.submit.length, 1)
  })

  it('identifies a missing production SEP gateway on read without issuing authorization requests', async () => {
    let authorizationCalls = 0
    const f = await fixture({ gateway: undefined, authorize: async () => { authorizationCalls++; return null } })
    const view = await f.service.getTaskMedia('task-a')
    assert.equal(view.capabilities, null)
    assert.match(view.unavailableReason!, /SEP 图片执行接口尚未接通/)
    assert.equal(authorizationCalls, 0)
    assert.equal(f.gateway.calls.submit.length, 0)
  })

  it('keeps configured but disabled SEP runtime non-executable even with a gateway injected', async () => {
    const sepFixtures: { media: unknown }[] = JSON.parse(readFileSync(
      new URL('../common/platform/fixtures/sep-media-runtime-v1.json', import.meta.url), 'utf8',
    ))
    const f = await fixture()
    f.employee.media = sepFixtures[1].media
    assert.equal((await f.service.getTaskMedia('task-a')).capabilities, null)
    await assert.rejects(f.service.generateTaskMedia('task-a', input()), code('SERVICE_UNAVAILABLE'))
    assert.equal(f.gateway.calls.quote.length, 0)
    assert.equal(f.gateway.calls.submit.length, 0)
    assert.equal(f.gateway.calls.uploadReference.length, 0)
  })

  it('uses a deterministic valid PNG fixture with matching chunks, pixels and sha256', () => {
    assert.deepEqual(inspectMediaImage(MOCK_MEDIA_PNG), { mime: 'image/png', width: 1, height: 1, size: MOCK_MEDIA_PNG.length })
    assert.equal(createHash('sha256').update(MOCK_MEDIA_PNG).digest('hex'), MOCK_MEDIA_PNG_SHA256)
    for (let offset = 8; offset < MOCK_MEDIA_PNG.length;) {
      const length = MOCK_MEDIA_PNG.readUInt32BE(offset)
      const chunk = MOCK_MEDIA_PNG.subarray(offset + 4, offset + 8 + length)
      let crc = 0xffffffff
      for (const byte of chunk) {
        crc ^= byte
        for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
      }
      assert.equal(MOCK_MEDIA_PNG.readUInt32BE(offset + 8 + length), (crc ^ 0xffffffff) >>> 0)
      if (chunk.toString('ascii', 0, 4) === 'IDAT') assert.deepEqual(inflateSync(chunk.subarray(4)), Buffer.from([1, 255, 255]))
      offset += 12 + length
    }
  })

  it('returns mock capabilities and degrades cleanly when the employee has no media capability', async () => {
    const f = await fixture()
    assert.deepEqual((await f.service.getTaskMedia('task-a')).capabilities, MOCK_MEDIA_CAPABILITIES)
    f.employee.media = undefined
    await f.service.stopAll()
    const view = await f.service.getTaskMedia('task-a')
    assert.equal(view.capabilities, null)
    assert.ok(view.unavailableReason)
    await assert.rejects(f.service.generateTaskMedia('task-a', input()), code('SERVICE_UNAVAILABLE'))
    assert.equal(f.gateway.calls.submit.length, 0)
  })

  it('blocks auto-approved requests whose quote lacks budget or platform authorization', async () => {
    for (const quote of [{ budgetAuthorized: false }, { authorized: false }, { expiresAt: 1 }, { requestHash: 'b'.repeat(64) },
      { status: 'unavailable' as const, amount: null, currency: null, allowUnknownCost: false }]) {
      const f = await fixture({ policy: async () => policy() }, new MockMediaGateway({ quote }))
      await assert.rejects(f.service.generateTaskMedia('task-a', input()), code('PERMISSION_DENIED'))
      assert.equal(f.gateway.calls.submit.length, 0)
      assert.equal(f.gateway.calls.uploadReference.length, 0)
      assert.equal(f.approvalRequests.length, 0)
      assert.deepEqual(await f.store.listJobs(owner), [])
    }
  })

  for (const mode of ['manual', 'automatic'] as const) {
    const selectedPolicy = policy('full-local', mode === 'manual' ? 'confirm-each' : 'auto-approve')

    it(`blocks unavailable prices in ${mode} mode even when legacy allowUnknownCost is true`, async () => {
      for (const allowUnknownCost of [false, true]) {
        for (const price of [{ amount: null, currency: null }, { amount: '1.25', currency: 'CNY' }]) {
          const f = await fixture({ policy: async () => selectedPolicy }, new MockMediaGateway({
            quote: { status: 'unavailable', ...price, allowUnknownCost },
          }))
          await assert.rejects(f.service.generateTaskMedia('task-a', input()), code('PERMISSION_DENIED'))
          assert.equal(f.gateway.calls.quote.length, 1)
          assert.equal(f.gateway.calls.submit.length, 0)
          assert.equal(f.gateway.calls.uploadReference.length, 0)
          assert.equal(f.approvalRequests.length, 0)
          assert.deepEqual(await f.store.listJobs(owner), [])
        }
      }
    })

    it(`blocks invalid quoted amounts and currencies before ${mode} approval or submission`, async () => {
      for (const price of [
        { amount: null }, { amount: '' }, { amount: '-1' }, { amount: 'NaN' },
        { amount: '1e3' }, { amount: '9'.repeat(101) },
        { currency: null }, { currency: '' }, { currency: ' \t ' },
      ]) {
        const f = await fixture({ policy: async () => selectedPolicy }, new MockMediaGateway({
          quote: { status: 'quoted', allowUnknownCost: true, ...price },
        }))
        await assert.rejects(f.service.generateTaskMedia('task-a', input()))
        assert.equal(f.gateway.calls.quote.length, 1)
        assert.equal(f.gateway.calls.submit.length, 0)
        assert.equal(f.gateway.calls.uploadReference.length, 0)
        assert.equal(f.approvalRequests.length, 0)
        assert.deepEqual(await f.store.listJobs(owner), [])
      }
    })

    it(`submits valid quoted prices in ${mode} mode while retaining legacy quote fields`, async () => {
      for (const amount of ['0', '1.25']) {
        for (const allowUnknownCost of [false, true]) {
          const f = await fixture({ policy: async () => selectedPolicy }, new MockMediaGateway({
            quote: { status: 'quoted', amount, currency: 'CNY', allowUnknownCost },
          }))
          const view = await f.service.generateTaskMedia('task-a', input())
          await f.service.waitForRun('task-a', view.runId)
          assert.equal(f.gateway.calls.quote.length, 1)
          assert.equal(f.gateway.calls.submit.length, 1)
          assert.equal(f.approvalRequests.length, mode === 'manual' ? 1 : 0)
          const job = await f.store.getJob(owner, 'task-a', view.jobId)
          if (mode === 'manual') {
            const approvalInput = f.approvalRequests[0].input
            assert.ok(typeof approvalInput === 'object' && approvalInput !== null && 'quote' in approvalInput)
            assert.deepEqual(approvalInput.quote, {
              status: 'quoted', amount, currency: 'CNY', expiresAt: job?.quote.expiresAt,
            })
          }
          assert.equal(job?.approval, mode)
          assert.equal(job?.generationStatus, 'SUCCEEDED')
          assert.equal(job?.quote.amount, amount)
          assert.equal(job?.quote.currency, 'CNY')
          assert.equal(job?.quote.allowUnknownCost, allowUnknownCost)
        }
      }
    })
  }

  it('requires manual approval unless both full-local and auto-approve are selected', async () => {
    for (const selectedPolicy of [{ ...policy('workspace-edit'), allowedTools: ['media_generate_image'] }, policy('full-local', 'confirm-each')]) {
      const f = await fixture({ policy: async () => selectedPolicy })
      const view = await f.service.generateTaskMedia('task-a', input())
      await f.service.waitForRun('task-a', view.runId)
      assert.equal(f.approvalRequests.length, 1)
      assert.equal((await f.store.getJob(owner, 'task-a', view.jobId))?.approval, 'manual')
    }
    const automatic = await fixture({ policy: async () => policy() })
    const view = await automatic.service.generateTaskMedia('task-a', input())
    await automatic.service.waitForRun('task-a', view.runId)
    assert.equal(automatic.approvalRequests.length, 0)
    assert.equal((await automatic.store.getJob(owner, 'task-a', view.jobId))?.approval, 'automatic')
  })

  it('blocks read-only and tools not included in a restricted policy before quote or approval', async () => {
    for (const selectedPolicy of [policy('read-only'), { ...policy('read-only'), allowedTools: ['media_generate_image'] }, policy('workspace-edit')]) {
      const f = await fixture({ policy: async () => selectedPolicy })
      await assert.rejects(f.service.generateTaskMedia('task-a', input()), code('PERMISSION_DENIED'))
      assert.equal(f.gateway.calls.quote.length, 0)
      assert.equal(f.gateway.calls.submit.length, 0)
      assert.equal(f.approvalRequests.length, 0)
    }
  })

  it('denies timed-out native tool approval without uploading references or submitting', async () => {
    const delivered: ToolAuthorizationRequest[] = []
    const approval = new ToolApprovals({ timeoutMs: 10, onRequest: request => { delivered.push(request) } })
    approvals.push(approval)
    const f = await fixture({ requestApproval: request => approval.request(request) })
    const selected = join(f.directory, 'reference.png')
    await writeFile(selected, MOCK_MEDIA_PNG)
    const [asset] = await f.service.importReferences('task-a', [selected])
    await assert.rejects(f.service.generateTaskMedia('task-a', input({ operation: 'edit', localAssetIds: [asset.localAssetId] })), code('PERMISSION_DENIED'))
    assert.equal(delivered.length, 1)
    assert.equal(approval.size, 0)
    assert.equal(approval.respond({ requestId: delivered[0].requestId, approved: true }), false)
    assert.equal(f.gateway.calls.uploadReference.length, 0)
    assert.equal(f.gateway.calls.submit.length, 0)
  })

  it('bounds a stalled approval operation without performing a submission', async () => {
    const f = await fixture({ operationTimeoutMs: 15, requestApproval: () => new Promise(() => undefined) })
    // AbortSignal.timeout is unref'ed; keep this isolated test alive while awaiting it.
    const timer = setTimeout(() => undefined, 100)
    try { await assert.rejects(f.service.generateTaskMedia('task-a', input())) } finally { clearTimeout(timer) }
    assert.equal(f.gateway.calls.submit.length, 0)
    assert.deepEqual(await f.store.listJobs(owner), [])
  })

  it('hashes semantic parameters, configuration and reference content rather than quote/request/run IDs', async () => {
    const f = await fixture({ policy: async () => policy() }, new MockMediaGateway({ initialStatus: 'SUCCEEDED' }))
    const selected = join(f.directory, 'reference.png')
    await writeFile(selected, MOCK_MEDIA_PNG)
    const [a] = await f.service.importReferences('task-a', [selected])
    const [b] = await f.service.importReferences('task-b', [selected])
    const first = await f.service.generateTaskMedia('task-a', input({ operation: 'edit', localAssetIds: [a.localAssetId] }))
    await f.service.waitForRun('task-a', first.runId)
    const second = await f.service.generateTaskMedia('task-b', input({ parameters: { count: 1, aspectRatio: '1:1' }, operation: 'edit', localAssetIds: [b.localAssetId] }))
    await f.service.waitForRun('task-b', second.runId)
    const [requestA, requestB] = f.gateway.calls.submit.map(call => call.request)
    assert.equal(requestA.requestHash, requestB.requestHash)
    assert.notEqual(requestA.clientRequestId, requestB.clientRequestId)
    assert.notEqual(requestA.quoteId, requestB.quoteId)
    assert.notEqual(first.runId, second.runId)
    assert.deepEqual(requestA.referenceHashes, [MOCK_MEDIA_PNG_SHA256])
    assert.deepEqual(f.gateway.calls.quote[0].request.referenceIds, [])
    const changed = await f.service.generateTaskMedia('task-a', input({ creativeBrief: 'Different product photograph' }))
    await f.service.waitForRun('task-a', changed.runId)
    assert.notEqual(f.gateway.calls.submit[2].request.requestHash, requestA.requestHash)
    const changedCount = await f.service.generateTaskMedia('task-a', input({ parameters: { aspectRatio: '1:1', count: 2 } }))
    await f.service.waitForRun('task-a', changedCount.runId)
    assert.notEqual(f.gateway.calls.submit[3].request.requestHash, f.gateway.calls.submit[2].request.requestHash)
    const changedCapabilities = structuredClone(MOCK_MEDIA_CAPABILITIES)
    changedCapabilities.profiles[0].configVersion = 'mock-v2'
    f.employee.media = changedCapabilities
    const changedConfig = await f.service.generateTaskMedia('task-a', input({ parameters: { aspectRatio: '1:1', count: 2 } }))
    await f.service.waitForRun('task-a', changedConfig.runId)
    assert.notEqual(f.gateway.calls.submit[4].request.requestHash, f.gateway.calls.submit[3].request.requestHash)
  })

  it('rejects unknown fields, cross-task assets, unsupported parameters and duplicate references before quote', async () => {
    const f = await fixture()
    const selected = join(f.directory, 'reference.png')
    await writeFile(selected, MOCK_MEDIA_PNG)
    const [asset] = await f.service.importReferences('task-b', [selected])
    for (const invalid of [input({ profileId: 'unknown' }), input({ operation: 'edit' }), input({ parameters: { aspectRatio: '4:3', count: 1 } }),
      input({ parameters: { aspectRatio: '1:1', count: 5 } }), input({ parameters: { aspectRatio: '1:1', count: 1, quality: 'arbitrary' } }),
      input({ localAssetIds: [asset.localAssetId] }), input({ localAssetIds: [asset.localAssetId, asset.localAssetId] }), { ...input(), upstreamUrl: 'https://untrusted.invalid' }]) {
      await assert.rejects(f.service.generateTaskMedia('task-a', invalid))
    }
    assert.equal(f.gateway.calls.quote.length, 0)
    assert.equal(f.gateway.calls.submit.length, 0)
  })
})

describe('MediaService local delivery and original-request recovery', () => {
  for (const authCode of ['AUTH_REQUIRED', 'PERMISSION_DENIED'] as const) {
    it(`pauses all downloads on ${authCode} and resumes only the original outputs`, async context => {
      const f = await fixture({}, new MockMediaGateway({ initialStatus: 'SUCCEEDED' }))
      const content = f.gateway.content.bind(f.gateway)
      let attempted = 0
      const stub = context.mock.method(f.gateway, 'content', async () => { attempted++; throw new AppError(authCode) })
      const view = await f.service.generateTaskMedia('task-a', input({ parameters: { aspectRatio: '1:1', count: 2 } }))
      await waitUntil(async () => (await f.store.getJob(owner, 'task-a', view.jobId))?.trackingStatus === 'AUTH_REQUIRED')
      assert.equal(attempted, 1)
      const blocked = await f.store.getJob(owner, 'task-a', view.jobId)
      assert.equal(blocked?.saveStatus, 'SAVE_FAILED')
      assert.match(blocked!.error!, /读取授权/)
      stub.mock.restore()
      context.mock.method(f.gateway, 'content', content)
      await f.service.retrySave('task-a', view.jobId)
      await waitUntil(async () => (await f.store.getJob(owner, 'task-a', view.jobId))?.saveStatus === 'SAVED')
      assert.equal(f.gateway.calls.submit.length, 1)
      assert.equal(f.gateway.calls.quote.length, 1)
      assert.equal((await f.store.listAssets(owner, 'task-a')).length, 2)
    })
  }

  it('labels expired unsaved outputs and disables ineffective save/recovery actions without losing successful history', async context => {
    const f = await fixture({}, new MockMediaGateway({ initialStatus: 'SUCCEEDED' }))
    const submit = f.gateway.submit.bind(f.gateway)
    context.mock.method(f.gateway, 'submit', async (...args: Parameters<typeof f.gateway.submit>) => {
      const receipt = await submit(...args)
      return { ...receipt, outputs: receipt.outputs.map(output => ({ ...output, expiresAt: 1 })) }
    })
    const view = await f.service.generateTaskMedia('task-a', input())
    await waitUntil(async () => (await f.store.getJob(owner, 'task-a', view.jobId))?.trackingStatus === 'STOPPED')
    const [restored] = (await f.service.getTaskMedia('task-a')).jobs
    assert.equal(restored.generationStatus, 'SUCCEEDED')
    assert.equal(restored.saveStatus, 'SAVE_FAILED')
    assert.match(restored.error!, /已过期/)
    assert.equal(restored.canRetrySave, false)
    assert.equal(restored.canResumeTracking, false)
    assert.equal(f.gateway.calls.content.length, 0)
  })

  it('persists the complete employee, approved and installed skills, and model configuration for a run', async () => {
    const f = await fixture()
    f.employee.runtimeSnapshot = {
      manifestVersion: 1, subscriptionId: f.employee.subscriptionId, ...owner,
      employeeId: 'employee-a', templateVersion: 'template-1', employeeVersion: 'employee-2', maxSteps: 20,
      systemPrompt: f.employee.systemPrompt!, modelId: 'model-a', allowedModels: ['model-a', 'model-b'],
      approvedSkills: [{ capabilityId: 'product', name: 'Product', description: null, versionId: 'approved-1', version: '1', content: 'Approved contents' }],
      skills: [{ capabilityId: 'product', versionId: 'local-1', baseSkillVersionId: 'approved-1', version: '2', source: 'owner-local',
        name: 'product', description: 'Actual product skill', content: 'Installed contents', path: '/local/skills/product/SKILL.md', sha256: 'c'.repeat(64) }],
    }
    const expected = structuredClone(f.employee.runtimeSnapshot)
    const view = await f.service.generateTaskMedia('task-a', input())
    await f.service.waitForRun('task-a', view.runId)
    const saved = await new MediaStore(f.root).getSnapshot(owner, 'task-a', view.runId)
    assert.deepEqual(saved?.runtimeSnapshot, expected)
    assert.deepEqual(saved?.skills, [{ path: '/local/skills/product/SKILL.md', sha256: 'c'.repeat(64), version: '2' }])
    f.employee.runtimeSnapshot = { ...expected, modelId: 'model-b', skills: [] }
    assert.deepEqual((await f.store.getSnapshot(owner, 'task-a', view.runId))?.runtimeSnapshot, expected)
  })

  it('delivers validated PNG files and returns sanitized views without local paths or request details', async () => {
    const f = await fixture()
    const view = await f.service.generateTaskMedia('task-a', input())
    await f.service.waitForRun('task-a', view.runId)
    const task = await f.service.getTaskMedia('task-a')
    assert.equal(task.jobs[0].generationStatus, 'SUCCEEDED')
    assert.equal(task.jobs[0].saveStatus, 'SAVED')
    assert.equal(task.assets.length, 1)
    assert.equal(task.assets[0].mime, 'image/png')
    assert.equal(f.gateway.calls.submit.length, 1)
    assert.equal(f.gateway.calls.content.length, 1)
    const preview = await f.service.preview('task-a', task.assets[0].localAssetId)
    assert.equal(preview.mime, 'image/png')
    assert.deepEqual(preview.bytes, MOCK_MEDIA_PNG)
    const exported = join(f.directory, 'export.png')
    await f.service.export('task-a', task.assets[0].localAssetId, exported)
    assert.deepEqual(await readFile(exported), MOCK_MEDIA_PNG)
    for (const field of ['relativePath', 'owner', 'requestHash', 'clientRequestId', 'quoteId', 'systemPrompt']) assert.ok(!JSON.stringify(task).includes(`"${field}"`))
    assert.ok(!JSON.stringify(task).includes(f.directory))
    assert.ok(await f.store.getSnapshot(owner, 'task-a', view.runId))
  })

  it('delivers saved images while billing is blocked and retains stable timings after reconciliation', async () => {
    const f = await realFixture({ billingStatus: 'RECONCILING' })
    const queryStarted = deferred<void>()
    const releaseQuery = deferred<void>()
    const gateway = f.options.gateway!
    const getReceipt = gateway.getReceipt.bind(gateway)
    gateway.getReceipt = async (...args) => {
      queryStarted.resolve()
      await releaseQuery.promise
      return getReceipt(...args)
    }
    try {
      const view = await f.generate()
      await Promise.race([queryStarted.promise, delay(1000).then(() => assert.fail('Billing query did not start.'))])
      await Promise.race([f.service.waitForRun('task-a', view.runId), delay(500).then(() => assert.fail('Saved image delivery waited for billing.'))])
      const first = (await f.store.getJob(owner, 'task-a', view.jobId))!
      assert.equal(first.billingStatus, 'RECONCILING')
      assert.equal(first.saveStatus, 'SAVED')
      assert.ok(first.providerWaitMs !== undefined && first.providerWaitMs >= 0)
      assert.ok(first.downloadMs !== undefined && first.downloadMs >= 0)
      f.state.billingStatus = 'SETTLED'
      releaseQuery.resolve()
      await waitUntil(async () => (await f.store.getJob(owner, 'task-a', view.jobId))?.billingStatus === 'SETTLED')
      const settled = (await f.store.getJob(owner, 'task-a', view.jobId))!
      assert.equal(settled.providerWaitMs, first.providerWaitMs)
      assert.equal(settled.downloadMs, first.downloadMs)
      assert.equal(f.calls.filter(call => call.path.endsWith('/content')).length, 1)
      assert.equal(f.calls.filter(call => call.path === '/requests' && call.method === 'POST').length, 1)
    } finally { releaseQuery.resolve() }
  })

  for (const recovered of [false, true]) it(`reports image generation failure before billing settles${recovered ? ' after recovery' : ''}`, async () => {
    const f = await realFixture({ status: 'FAILED', billingStatus: 'RECONCILING' })
    const queryStarted = deferred<void>()
    const releaseQuery = deferred<void>()
    const gateway = f.options.gateway!
    const getReceipt = gateway.getReceipt.bind(gateway)
    gateway.getReceipt = async (...args) => {
      queryStarted.resolve()
      await releaseQuery.promise
      return getReceipt(...args)
    }
    let deadline: ReturnType<typeof setTimeout> | undefined
    try {
      const view = await f.generate()
      await queryStarted.promise
      const runId = recovered ? 'recovered-run' : view.runId
      if (recovered) await f.service.prepareRun({ taskId: 'task-a', runId, subscriptionId: f.employee.subscriptionId,
        employee: f.employee, requestApproval: f.options.requestApproval, recoverJobIds: [view.jobId] })
      await Promise.race([
        assert.rejects(f.service.waitForRun('task-a', runId), code('INVALID_STATE')),
        new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(new Error('Image failure waited for billing.')), 500) }),
      ])
      assert.equal((await f.store.getJob(owner, 'task-a', view.jobId))?.billingStatus, 'RECONCILING')
      f.state.billingStatus = 'RELEASED'
      releaseQuery.resolve()
      await waitUntil(async () => (await f.store.getJob(owner, 'task-a', view.jobId))?.billingStatus === 'RELEASED')
      assert.equal(f.calls.filter(call => call.path === '/requests' && call.method === 'POST').length, 1)
    } finally { clearTimeout(deadline); releaseQuery.resolve() }
  })

  it('finds a lost submit response by its original request ID and never resubmits or changes the run', async () => {
    const f = await fixture({}, new MockMediaGateway({ submitResponseLost: true }))
    const view = await f.service.generateTaskMedia('task-a', input())
    await f.service.waitForRun('task-a', view.runId)
    const job = await f.store.getJob(owner, 'task-a', view.jobId)
    assert.equal(f.gateway.calls.submit.length, 1)
    assert.ok(f.gateway.calls.findReceipt.length > 0)
    assert.ok(f.gateway.calls.findReceipt.every(call => call.clientRequestId === f.gateway.calls.submit[0].request.clientRequestId))
    assert.equal(job?.clientRequestId, f.gateway.calls.submit[0].request.clientRequestId)
    assert.equal(job?.runId, view.runId)
    assert.equal(job?.generationStatus, 'SUCCEEDED')
    assert.equal(job?.saveStatus, 'SAVED')
  })

  it('stops bounded missing-receipt recovery without turning it into a second generation', async () => {
    const f = await fixture({}, new MockMediaGateway({ submitResponseLost: true, missingFinds: 100 }))
    const view = await f.service.generateTaskMedia('task-a', input())
    await assert.rejects(f.service.waitForRun('task-a', view.runId), code('INVALID_STATE'))
    const job = await f.store.getJob(owner, 'task-a', view.jobId)
    assert.equal(job?.generationStatus, 'SUBMISSION_UNKNOWN')
    assert.equal(job?.trackingStatus, 'STOPPED')
    assert.equal(f.gateway.calls.findReceipt.length, 3)
    assert.equal(f.gateway.calls.submit.length, 1)
    await assert.rejects(f.service.redo('task-a', view.jobId), code('INVALID_STATE'))
    await f.service.resume('task-a', view.jobId)
    await assert.rejects(f.service.waitForRun('task-a', view.runId))
    assert.equal(f.gateway.calls.submit.length, 1)
    assert.ok(f.gateway.calls.findReceipt.every(call => call.clientRequestId === job?.clientRequestId))
  })

  it('recovers NOT_SENT jobs as not submitted and never automatically generates them', async () => {
    const f = await fixture()
    await f.store.saveJob(owner, notSentJob())
    await f.service.resumePending()
    await waitUntil(async () => (await f.store.getJob(owner, 'task-a', 'not-sent-job'))?.trackingStatus === 'STOPPED')
    const restored = await f.store.getJob(owner, 'task-a', 'not-sent-job')
    assert.equal(restored?.submission, 'NOT_SENT')
    assert.equal(restored?.clientRequestId, 'original-request')
    assert.equal(restored?.runId, 'original-run')
    assert.match(restored?.error ?? '', /未提交/)
    assert.equal(f.gateway.calls.submit.length, 0)
    assert.equal(f.gateway.calls.findReceipt.length, 0)
    assert.equal(f.gateway.calls.getReceipt.length, 0)
  })

  it('drains every pending original request while limiting recovery to four activities', async () => {
    const f = await fixture({}, new MockMediaGateway({ initialStatus: 'QUEUED', pollStatuses: ['SUCCEEDED'] }))
    let active = 0, maximum = 0
    const original = f.gateway.getReceipt.bind(f.gateway)
    f.gateway.getReceipt = async (...args) => {
      active++; maximum = Math.max(maximum, active)
      try { await delay(15); return await original(...args) } finally { active-- }
    }
    for (let i = 0; i < 7; i++) {
      const job = notSentJob()
      job.jobId = `recovery-${i}`; job.clientRequestId = `original-${i}`
      job.request = { ...job.request, clientRequestId: job.clientRequestId }
      const receipt = await f.gateway.submit(job.subscriptionId, job.request, new AbortController().signal)
      job.receiptId = receipt.receiptId; job.submission = 'RECEIPTED'
      job.generationStatus = 'QUEUED'; job.trackingStatus = 'INTERRUPTED'
      await f.store.saveJob(owner, job)
    }
    await f.service.resumePending()
    await waitUntil(async () => (await f.store.listJobs(owner)).every(job => job.saveStatus === 'SAVED' && job.trackingStatus === 'STOPPED'))
    assert.equal(f.gateway.calls.getReceipt.length, 7)
    assert.equal(f.gateway.calls.submit.length, 7)
    assert.ok(maximum > 1 && maximum <= 4)
  })

  it('retries failed saving of original outputs without generation, approval, quote or receipt mutation', async () => {
    const f = await fixture({}, new MockMediaGateway({ initialStatus: 'SUCCEEDED', contentFailures: 2 }))
    const view = await f.service.generateTaskMedia('task-a', input())
    await assert.rejects(f.service.waitForRun('task-a', view.runId))
    const before = await f.store.getJob(owner, 'task-a', view.jobId)
    assert.equal(before?.generationStatus, 'SUCCEEDED')
    assert.equal(before?.saveStatus, 'SAVE_FAILED')
    const paidCalls = { quote: f.gateway.calls.quote.length, submit: f.gateway.calls.submit.length, approval: f.approvalRequests.length }
    f.gateway.contentFailures = 0
    await f.service.retrySave('task-a', view.jobId)
    await f.service.waitForRun('task-a', view.runId)
    const after = await f.store.getJob(owner, 'task-a', view.jobId)
    assert.equal(after?.saveStatus, 'SAVED')
    assert.equal(after?.clientRequestId, before?.clientRequestId)
    assert.equal(after?.receiptId, before?.receiptId)
    assert.equal(after?.runId, before?.runId)
    assert.equal(after?.requestHash, before?.requestHash)
    assert.deepEqual({ quote: f.gateway.calls.quote.length, submit: f.gateway.calls.submit.length, approval: f.approvalRequests.length }, paidCalls)
    assert.equal((await f.store.listAssets(owner, 'task-a')).length, 1)
  })

  it('retries a failed filesystem save using the same original result', async context => {
    const f = await fixture({}, new MockMediaGateway({ initialStatus: 'SUCCEEDED' }))
    const stub = context.mock.method(f.store, 'saveOutput', async () => { throw new Error('Mock disk full') })
    const view = await f.service.generateTaskMedia('task-a', input())
    await assert.rejects(f.service.waitForRun('task-a', view.runId))
    assert.equal((await f.store.getJob(owner, 'task-a', view.jobId))?.saveStatus, 'SAVE_FAILED')
    stub.mock.restore()
    await f.service.retrySave('task-a', view.jobId)
    await f.service.waitForRun('task-a', view.runId)
    assert.equal(f.gateway.calls.submit.length, 1)
    assert.equal((await f.store.listAssets(owner, 'task-a')).length, 1)
  })

  it('does not downgrade an accepted receipt when persisting that receipt fails', async context => {
    for (const persistedBeforeError of [false, true]) {
      const f = await fixture({}, new MockMediaGateway({ initialStatus: 'SUCCEEDED' }))
      const saveJob = f.store.saveJob.bind(f.store)
      let injected = false
      context.mock.method(f.store, 'saveJob', async (scope: TaskOwnerScope, job: LocalMediaJob) => {
        if (!injected && job.submission === 'RECEIPTED') {
          injected = true
          if (persistedBeforeError) await saveJob(scope, job)
          throw new Error('Mock receipt persistence failure')
        }
        assert.ok(!injected || job.generationStatus !== 'SUBMISSION_UNKNOWN', 'Accepted receipts must not become unknown submissions.')
        await saveJob(scope, job)
      })
      try { await f.service.generateTaskMedia('task-a', input()) } catch { /* Local persistence may reject delivery, but must retain receipt identity. */ }
      const [job] = await f.store.listJobs(owner, 'task-a')
      assert.equal(injected, true)
      assert.equal(job.submission, 'RECEIPTED')
      assert.equal(job.receiptId, 'mock-receipt-1')
      assert.equal(job.generationStatus, 'SUCCEEDED')
      await f.service.resume('task-a', job.jobId)
      await f.service.waitForRun('task-a', job.runId)
      assert.equal(f.gateway.calls.submit.length, 1)
      assert.equal(f.gateway.calls.findReceipt.length, 0)
      assert.equal((await f.store.getJob(owner, 'task-a', job.jobId))?.saveStatus, 'SAVED')
    }
  })

  it('preserves INTERRUPTED original requests across stopAll and resumes them after restart', async () => {
    const states = ['RUNNING'] as ('RUNNING' | 'SUCCEEDED')[]
    const f = await fixture({ pollFloorMs: 50 }, new MockMediaGateway({ pollStatuses: states }))
    const view = await f.service.generateTaskMedia('task-a', input())
    await f.service.stopAll()
    assert.equal((await f.store.getJob(owner, 'task-a', view.jobId))?.trackingStatus, 'INTERRUPTED')
    states.splice(0, 1, 'SUCCEEDED')
    const restarted = new MediaService({ ...f.options, store: new MediaStore(f.root), pollFloorMs: 1 })
    services.push(restarted)
    await restarted.resumePending()
    await restarted.waitForRun('task-a', view.runId)
    assert.equal((await f.store.getJob(owner, 'task-a', view.jobId))?.saveStatus, 'SAVED')
    assert.equal(f.gateway.calls.submit.length, 1)
  })
})

describe('MediaService mock permission changes and recovery failures', () => {
  function reviewedEmployee(employee: EmployeeRuntimeConfig, revision = '1'): void {
    const content = `Approved product image instructions revision ${revision}`
    employee.runtimeSnapshot = {
      manifestVersion: 1, subscriptionId: employee.subscriptionId, ...owner,
      employeeId: 'employee-a', templateVersion: 'template-1', employeeVersion: revision, maxSteps: 20,
      systemPrompt: employee.systemPrompt!, modelId: employee.modelId!, allowedModels: [employee.modelId!],
      approvedSkills: [{ capabilityId: 'product', name: 'Product', description: null,
        versionId: `approved-${revision}`, version: revision, content }],
      skills: [{ capabilityId: 'product', versionId: `platform-approved-${revision}`, baseSkillVersionId: `approved-${revision}`,
        version: revision, source: 'approved', name: 'product', description: 'Product image skill', content,
        path: `/local/skills/approved-${revision}`, sha256: createHash('sha256').update(content).digest('hex') }],
    }
  }
  function identity(job: LocalMediaJob) {
    return { jobId: job.jobId, runId: job.runId, subscriptionId: job.subscriptionId,
      clientRequestId: job.clientRequestId, requestHash: job.requestHash, receiptId: job.receiptId,
      request: job.request, profile: job.profile, quote: job.quote, approval: job.approval }
  }
  function restart(f: Awaited<ReturnType<typeof fixture>>) {
    const service = new MediaService({ ...f.options, store: new MediaStore(f.root) })
    services.push(service)
    return service
  }

  for (const explicitlyStopped of [false, true]) {
    it(`retains ${explicitlyStopped ? 'explicit stop' : 'interrupted recovery'} when shutdown races the next polling boundary`, async context => {
      const f = await fixture({}, new MockMediaGateway({ pollStatuses: ['RUNNING', 'SUCCEEDED'] }))
      const entered = deferred<void>(), release = deferred<void>()
      const saveJob = f.store.saveJob.bind(f.store)
      let blocked = false
      context.mock.method(f.store, 'saveJob', async (...args: Parameters<typeof saveJob>) => {
        await saveJob(...args)
        if (!blocked && args[1].generationStatus === 'RUNNING') {
          blocked = true
          entered.resolve()
          await release.promise
        }
      })
      const original = await f.service.generateTaskMedia('task-a', input())
      await entered.promise
      const stopTask = explicitlyStopped ? f.service.stopTask('task-a') : Promise.resolve()
      const stopping = f.service.stopAll()
      release.resolve()
      await Promise.all([stopTask, stopping])
      const before = (await f.store.getJob(owner, 'task-a', original.jobId))!
      assert.equal(before.trackingStatus, explicitlyStopped ? 'STOPPED' : 'INTERRUPTED')
      const restored = restart(f)
      await restored.resumePending()
      if (explicitlyStopped) {
        assert.equal((await f.store.getJob(owner, 'task-a', original.jobId))?.trackingStatus, 'STOPPED')
        assert.equal(f.gateway.calls.getReceipt.length, 1, 'An explicitly stopped job must not automatically query after restart.')
        await assert.rejects(restored.waitForRun('task-a', original.runId), code('INVALID_STATE'))
        await restored.resume('task-a', original.jobId)
      }
      await restored.waitForRun('task-a', original.runId)
      const after = (await f.store.getJob(owner, 'task-a', original.jobId))!
      assert.equal(after.saveStatus, 'SAVED')
      assert.deepEqual(identity(after), identity(before))
      assert.equal(f.gateway.calls.submit.length, 1)
      assert.equal(f.gateway.calls.quote.length, 1)
    })
  }

  it('keeps the original approved Skill and profile frozen across updates and uses the new version only for a new run', async () => {
    const states = ['RUNNING'] as ('RUNNING' | 'SUCCEEDED')[]
    const f = await fixture({ policy: async () => policy() }, new MockMediaGateway({ pollStatuses: states }))
    reviewedEmployee(f.employee)
    const original = await f.service.generateTaskMedia('task-a', input())
    await waitUntil(async () => {
      const job = await f.store.getJob(owner, 'task-a', original.jobId)
      return !!job?.receiptId && job.generationStatus === 'RUNNING'
    })
    await f.service.stopAll()
    const before = (await f.store.getJob(owner, 'task-a', original.jobId))!
    const snapshot = await f.store.getSnapshot(owner, 'task-a', original.runId)
    assert.ok(before.receiptId)
    assert.equal(snapshot?.runtimeSnapshot?.approvedSkills[0].versionId, 'approved-1')
    reviewedEmployee(f.employee, '2')
    f.employee.media = { ...structuredClone(MOCK_MEDIA_CAPABILITIES), profiles: [
      { ...structuredClone(MOCK_MEDIA_CAPABILITIES.profiles[0]), configVersion: 'mock-v2' },
    ] }
    states.splice(0, 1, 'SUCCEEDED')
    const restored = restart(f)
    await restored.resumePending()
    await restored.waitForRun('task-a', original.runId)
    assert.deepEqual(identity((await f.store.getJob(owner, 'task-a', original.jobId))!), identity(before))
    assert.deepEqual(await f.store.getSnapshot(owner, 'task-a', original.runId), snapshot)
    assert.equal(f.gateway.calls.submit.length, 1)
    assert.equal(f.gateway.calls.quote.length, 1)
    const next = await restored.generateTaskMedia('task-b', input())
    await restored.waitForRun('task-b', next.runId)
    assert.notEqual(next.runId, original.runId)
    assert.equal((await f.store.getJob(owner, 'task-b', next.jobId))?.profile.configVersion, 'mock-v2')
    assert.equal((await f.store.getSnapshot(owner, 'task-b', next.runId))?.runtimeSnapshot?.approvedSkills[0].versionId, 'approved-2')
    assert.deepEqual(await f.store.getSnapshot(owner, 'task-a', original.runId), snapshot)
  })

  for (const authCode of ['AUTH_REQUIRED', 'PERMISSION_DENIED'] as const) {
    for (const stage of ['findReceipt', 'getReceipt', 'content'] as const) {
      it(`persists ${authCode} during ${stage} across restart and recovers only after explicit original-job resume`, async context => {
        const gateway = new MockMediaGateway({ initialStatus: stage === 'content' ? 'SUCCEEDED' : 'QUEUED',
          submitResponseLost: stage === 'findReceipt', pollStatuses: ['SUCCEEDED'] })
        const f = await fixture({ policy: async () => policy() }, gateway)
        reviewedEmployee(f.employee)
        const stub = context.mock.method(gateway, stage, async () => { throw new AppError(authCode) })
        const view = await f.service.generateTaskMedia('task-a', input())
        await waitUntil(async () => (await f.store.getJob(owner, 'task-a', view.jobId))?.trackingStatus === 'AUTH_REQUIRED')
        await assert.rejects(f.service.waitForRun('task-a', view.runId), code('INVALID_STATE'))
        const before = (await f.store.getJob(owner, 'task-a', view.jobId))!
        const snapshot = await f.store.getSnapshot(owner, 'task-a', view.runId)
        assert.match(before.error!, /读取授权/)
        assert.equal((await f.store.listAssets(owner, 'task-a')).length, 0)
        assert.equal(stub.mock.callCount(), 1, 'Authorization failures must stop retries immediately.')
        await f.service.stopAll()
        const restored = restart(f)
        await restored.resumePending()
        assert.equal(stub.mock.callCount(), 1, 'Restart must not silently retry a job paused for authorization.')
        assert.equal((await f.store.getJob(owner, 'task-a', view.jobId))?.trackingStatus, 'AUTH_REQUIRED')
        stub.mock.restore()
        const callsBeforeResume = structuredClone(gateway.calls)
        await restored.resumePending()
        assert.deepEqual(gateway.calls, callsBeforeResume, 'Restoring permission alone must not automatically retry the paused job.')
        assert.equal((await f.store.getJob(owner, 'task-a', view.jobId))?.trackingStatus, 'AUTH_REQUIRED')
        await restored.resume('task-a', view.jobId)
        await restored.waitForRun('task-a', view.runId)
        const after = (await f.store.getJob(owner, 'task-a', view.jobId))!
        assert.equal(after.saveStatus, 'SAVED')
        if (stage === 'findReceipt') {
          assert.equal(before.receiptId, null)
          assert.ok(after.receiptId, 'Lost acknowledgement must acquire its first receipt ID for the original request.')
          assert.deepEqual(identity({ ...after, receiptId: null }), identity(before))
        } else {
          assert.ok(before.receiptId)
          assert.deepEqual(identity(after), identity(before))
        }
        assert.deepEqual(await f.store.getSnapshot(owner, 'task-a', view.runId), snapshot)
        assert.equal(gateway.calls.submit.length, 1)
        assert.equal(gateway.calls.quote.length, 1)
        assert.equal(f.approvalRequests.length, 0)
        assert.equal(after.billingStatus, 'NOT_BILLED_MOCK')
      })
    }
  }

  for (const field of ['receiptId', 'clientRequestId', 'profileId', 'configVersion', 'duplicateOutputs', 'tooManyOutputs'] as const) {
    it(`rejects ${field} in recovered receipts without changing the original identity or downloading results`, async context => {
      const f = await fixture({ policy: async () => policy() }, new MockMediaGateway({ pollStatuses: ['SUCCEEDED'] }))
      reviewedEmployee(f.employee)
      const getReceipt = f.gateway.getReceipt.bind(f.gateway)
      const stub = context.mock.method(f.gateway, 'getReceipt', async (...args: Parameters<typeof getReceipt>) => {
        const receipt = await getReceipt(...args)
        if (field === 'duplicateOutputs') return { ...receipt, outputs: [receipt.outputs[0], receipt.outputs[0]] }
        if (field === 'tooManyOutputs') return { ...receipt, outputs: [receipt.outputs[0], { ...receipt.outputs[0], outputId: 'unexpected-output' }] }
        return { ...receipt, [field]: 'unexpected-identity' }
      })
      const view = await f.service.generateTaskMedia('task-a', input())
      await assert.rejects(f.service.waitForRun('task-a', view.runId), code('INVALID_STATE'))
      const before = (await f.store.getJob(owner, 'task-a', view.jobId))!
      assert.equal(before.trackingStatus, 'STOPPED')
      assert.equal(before.generationStatus, 'QUEUED')
      assert.equal(before.attempts, 3)
      assert.equal(before.outputs.length, 0)
      assert.equal(f.gateway.calls.content.length, 0)
      assert.equal((await f.store.listAssets(owner, 'task-a')).length, 0)
      const snapshot = await f.store.getSnapshot(owner, 'task-a', view.runId)
      await f.service.stopAll()
      stub.mock.restore()
      const restored = restart(f)
      await restored.resume('task-a', view.jobId)
      await restored.waitForRun('task-a', view.runId)
      assert.deepEqual(identity((await f.store.getJob(owner, 'task-a', view.jobId))!), identity(before))
      assert.deepEqual(await f.store.getSnapshot(owner, 'task-a', view.runId), snapshot)
      assert.equal(f.gateway.calls.submit.length, 1)
      assert.equal(f.gateway.calls.quote.length, 1)
      assert.equal(f.gateway.calls.content.length, 1)
    })
  }

  for (const failure of ['truncated', 'wrongHash', 'streamFailure'] as const) {
    it(`preserves a valid sibling image on ${failure} and retries only the missing original output after restart`, async context => {
      const f = await fixture({ policy: async () => policy() }, new MockMediaGateway({ initialStatus: 'SUCCEEDED' }))
      reviewedEmployee(f.employee)
      const content = f.gateway.content.bind(f.gateway)
      const stub = context.mock.method(f.gateway, 'content', async (...args: Parameters<typeof content>) => {
        const original = await content(...args)
        if (!args[2].endsWith('output-2')) return original
        return (async function* () {
          if (failure === 'wrongHash') {
            const bytes = Buffer.from(MOCK_MEDIA_PNG)
            bytes[bytes.length - 1] ^= 1
            yield bytes
          } else {
            yield MOCK_MEDIA_PNG.subarray(0, 16)
            if (failure === 'streamFailure') throw new Error('Injected mock stream failure')
          }
        })()
      })
      const view = await f.service.generateTaskMedia('task-a', input({ parameters: { aspectRatio: '1:1', count: 2 } }))
      await assert.rejects(f.service.waitForRun('task-a', view.runId), code('INVALID_STATE'))
      const before = (await f.store.getJob(owner, 'task-a', view.jobId))!
      const snapshot = await f.store.getSnapshot(owner, 'task-a', view.runId)
      const [saved] = await f.store.listAssets(owner, 'task-a')
      assert.equal(before.generationStatus, 'SUCCEEDED')
      assert.equal(before.saveStatus, 'SAVE_FAILED')
      assert.equal(saved.outputId, before.outputs[0].outputId)
      assert.deepEqual(await f.store.readAsset(owner, 'task-a', saved.localAssetId), MOCK_MEDIA_PNG)
      const files = await readdir(new ScopePath(f.root).mediaRoot(owner, 'task-a'), { recursive: true })
      assert.equal(files.some(file => file.endsWith('.part')), false)
      assert.equal(files.filter(file => file.endsWith('.png')).length, 1)
      await f.service.stopAll()
      stub.mock.restore()
      const restored = restart(f)
      await restored.retrySave('task-a', view.jobId)
      await restored.waitForRun('task-a', view.runId)
      const assets = await f.store.listAssets(owner, 'task-a')
      assert.equal(assets.length, 2)
      assert.ok(assets.some(asset => asset.localAssetId === saved.localAssetId))
      assert.deepEqual(f.gateway.calls.content.map(call => call.outputId), [before.outputs[0].outputId, before.outputs[1].outputId, before.outputs[1].outputId])
      assert.equal(f.gateway.calls.submit.length, 1)
      assert.equal(f.gateway.calls.quote.length, 1)
      assert.deepEqual(identity((await f.store.getJob(owner, 'task-a', view.jobId))!), identity(before))
      assert.deepEqual(await f.store.getSnapshot(owner, 'task-a', view.runId), snapshot)
      for (const asset of assets) assert.deepEqual(await f.store.readAsset(owner, 'task-a', asset.localAssetId), MOCK_MEDIA_PNG)
    })
  }

  it('rejects a quote that expires during human approval before uploading references or persisting a generation job', async context => {
    const f = await fixture()
    const referencePath = join(f.directory, 'reference.png')
    await writeFile(referencePath, MOCK_MEDIA_PNG)
    const [reference] = await f.service.importReferences('task-a', [referencePath])
    const quote = f.gateway.quote.bind(f.gateway)
    let issued = false
    context.mock.method(f.gateway, 'quote', async (...args: Parameters<typeof quote>) => {
      const result = await quote(...args)
      issued = true
      return { ...result, expiresAt: Date.now() + 10_000 }
    })
    f.options.requestApproval = async () => {
      assert.equal(issued, true)
      context.mock.method(Date, 'now', () => 4_000_000_000_000)
      return true
    }
    await assert.rejects(f.service.generateTaskMedia('task-a', input({ operation: 'edit', localAssetIds: [reference.localAssetId] })), code('PERMISSION_DENIED'))
    assert.equal(f.gateway.calls.quote.length, 1)
    assert.equal(f.gateway.calls.uploadReference.length, 0)
    assert.equal(f.gateway.calls.submit.length, 0)
    assert.equal((await f.store.listJobs(owner, 'task-a')).length, 0)
  })
})

describe('MediaService cancellation, scope and archive', () => {
  it('distinguishes local stop from upstream cancellation and rejects premature redo', async () => {
    const f = await fixture({ pollFloorMs: 50 }, new MockMediaGateway({ pollStatuses: ['RUNNING'] }))
    const view = await f.service.generateTaskMedia('task-a', input())
    await assert.rejects(f.service.redo('task-a', view.jobId), code('INVALID_STATE'))
    await f.service.cancel('task-a', view.jobId, false)
    const stopped = await f.store.getJob(owner, 'task-a', view.jobId)
    assert.equal(stopped?.trackingStatus, 'STOPPED')
    assert.notEqual(stopped?.generationStatus, 'CANCELLED')
    assert.equal(f.gateway.calls.cancel.length, 0)
    await f.service.resumePending()
    assert.equal((await f.store.getJob(owner, 'task-a', view.jobId))?.trackingStatus, 'STOPPED')
    await f.service.cancel('task-a', view.jobId, true)
    assert.equal((await f.store.getJob(owner, 'task-a', view.jobId))?.generationStatus, 'CANCELLED')
    assert.equal(f.gateway.calls.cancel.length, 1)
  })

  it('requires a fresh approved request for explicit redo after a completed job', async () => {
    const f = await fixture({}, new MockMediaGateway({ initialStatus: 'SUCCEEDED' }))
    const initial = await f.service.generateTaskMedia('task-a', input())
    await f.service.waitForRun('task-a', initial.runId)
    const repeated = await f.service.redo('task-a', initial.jobId)
    await f.service.waitForRun('task-a', repeated.runId)
    assert.notEqual(repeated.jobId, initial.jobId)
    assert.notEqual(repeated.runId, initial.runId)
    assert.notEqual(f.gateway.calls.submit[0].request.clientRequestId, f.gateway.calls.submit[1].request.clientRequestId)
    assert.equal(f.gateway.calls.submit[0].request.requestHash, f.gateway.calls.submit[1].request.requestHash)
    assert.equal(f.gateway.calls.submit.length, 2)
    assert.equal(f.approvalRequests.length, 2)
    assert.equal((await f.store.listJobs(owner, 'task-a')).length, 2)
    assert.equal((await f.store.listAssets(owner, 'task-a')).length, 2)
  })

  it('keeps archived files readable and jobs trackable while blocking new generation/import', async () => {
    const states = ['RUNNING'] as ('RUNNING' | 'SUCCEEDED')[]
    const f = await fixture({ pollFloorMs: 20 }, new MockMediaGateway({ pollStatuses: states }))
    assert.equal(await f.service.archiveIfMedia('task-a'), false)
    const view = await f.service.generateTaskMedia('task-a', input())
    assert.equal(await f.service.archiveIfMedia('task-a'), true)
    await assert.rejects(f.service.generateTaskMedia('task-a', input()), code('INVALID_STATE'))
    await assert.rejects(f.service.importReferences('task-a', []), code('INVALID_STATE'))
    states.splice(0, 1, 'SUCCEEDED')
    await f.service.waitForRun('task-a', view.runId)
    const task = await f.service.getTaskMedia('task-a')
    assert.equal(task.archived, true)
    assert.equal(task.assets.length, 1)
    assert.deepEqual((await f.service.preview('task-a', task.assets[0].localAssetId)).bytes, MOCK_MEDIA_PNG)
    assert.equal((await f.store.listJobs(owner)).length, 1)
    assert.equal(f.gateway.calls.submit.length, 1)
  })

  it('does not expose another owner or task assets/jobs after scope changes', async () => {
    const f = await fixture({}, new MockMediaGateway({ initialStatus: 'SUCCEEDED' }))
    const view = await f.service.generateTaskMedia('task-a', input())
    await f.service.waitForRun('task-a', view.runId)
    const [asset] = await f.store.listAssets(owner, 'task-a')
    await assert.rejects(f.service.preview('task-b', asset.localAssetId), code('NOT_FOUND'))
    await assert.rejects(f.service.cancel('task-b', view.jobId, false), code('NOT_FOUND'))
    f.setScope(other)
    const task = await f.service.getTaskMedia('task-a')
    assert.deepEqual(task.jobs, [])
    assert.deepEqual(task.assets, [])
    await assert.rejects(f.service.preview('task-a', asset.localAssetId), code('NOT_FOUND'))
    await assert.rejects(f.service.retrySave('task-a', view.jobId), code('NOT_FOUND'))
    f.setScope(null)
    await assert.rejects(f.service.getTaskMedia('task-a'), code('AUTH_REQUIRED'))
  })

  it('invalidates native-dialog selection closures on account change or epoch reset', async () => {
    const f = await fixture()
    const selected = join(f.directory, 'reference.png')
    await writeFile(selected, MOCK_MEDIA_PNG)
    const selection = await f.service.nativeSelection('task-a')
    f.setScope(other)
    await assert.rejects(selection.import([selected]), code('AUTH_REQUIRED'))
    assert.deepEqual(await f.store.listAssets(other, 'task-a'), [])
    f.setScope(owner)
    const second = await f.service.nativeSelection('task-a')
    await f.service.stopAll()
    await assert.rejects(second.import([selected]), code('AUTH_REQUIRED'))
    assert.deepEqual(await f.store.listAssets(owner, 'task-a'), [])
  })

  it('invalidates native import and export selections across same-owner logout and login', async () => {
    const f = await fixture()
    const selected = join(f.directory, 'reference.png')
    await writeFile(selected, MOCK_MEDIA_PNG)
    const [asset] = await f.service.importReferences('task-a', [selected])
    const selection = await f.service.nativeSelection('task-a')
    f.setScope(null)
    await f.service.stopAll()
    f.setScope({ ...owner })
    await assert.rejects(selection.import([selected]), code('AUTH_REQUIRED'))
    const destination = join(f.directory, 'stale-export.png')
    await assert.rejects(selection.export(asset.localAssetId, destination), code('AUTH_REQUIRED'))
    await assert.rejects(readFile(destination), { code: 'ENOENT' })
    const current = await f.service.nativeSelection('task-a')
    await current.export(asset.localAssetId, destination)
    assert.deepEqual(await readFile(destination), MOCK_MEDIA_PNG)
    assert.equal((await f.store.listAssets(owner, 'task-a')).length, 1)
  })

  it('does not bind old employee authorization to a different scope after awaiting policy', async () => {
    const f = await fixture({ policy: async () => { f.setScope(other); return policy() } })
    await assert.rejects(f.service.generateTaskMedia('task-a', input()), code('AUTH_REQUIRED'))
    assert.equal(f.gateway.calls.quote.length, 0)
    assert.equal(f.gateway.calls.submit.length, 0)
    assert.deepEqual(await f.store.listJobs(other), [])
    assert.equal(await f.store.getSnapshot(other, 'task-a'), null)
  })

  it('does not submit when scope changes while approval is pending', async () => {
    let approve: (value: boolean) => void = () => undefined
    let entered = false
    const f = await fixture({ requestApproval: () => new Promise(resolve => { entered = true; approve = resolve }) })
    const pending = f.service.generateTaskMedia('task-a', input())
    const rejection = assert.rejects(pending, code('AUTH_REQUIRED'))
    await waitUntil(async () => entered)
    f.setScope(other)
    approve(true)
    await rejection
    assert.equal(f.gateway.calls.submit.length, 0)
    assert.deepEqual(await f.store.listJobs(owner), [])
    assert.deepEqual(await f.store.listJobs(other), [])
  })
})

describe('MediaService review lifecycle regressions', () => {
  it('uses selected saved references and authorized defaults for brief-only image tool calls', async () => {
    const f = await fixture()
    const referencePath = join(f.directory, 'reference.png')
    await writeFile(referencePath, MOCK_MEDIA_PNG)
    const reference = await f.store.importReference(owner, 'task-a', referencePath)
    await f.service.setReferenceSelection('task-a', [reference.localAssetId])
    await assert.rejects(f.service.setReferenceSelection('task-a', ['missing-reference']), code('INVALID_ARGUMENT'))

    const tools = await f.service.prepareRun({ taskId: 'task-a', runId: 'brief-run', subscriptionId: f.employee.subscriptionId,
      employee: f.employee, requestApproval: f.options.requestApproval })
    const capabilityView = await tools!.execute('media_get_capabilities', {}) as { referenceAssets: { localAssetId: string }[] }
    assert.deepEqual(capabilityView.referenceAssets.map(asset => asset.localAssetId), [reference.localAssetId])

    const result = await tools!.execute('media_generate_image', { creativeBrief: 'Make a clean product photo' }) as { jobId: string }
    await f.service.waitForRun('task-a', 'brief-run')
    const job = await f.store.getJob(owner, 'task-a', result.jobId)
    assert.equal(job?.profile.profileId, 'mock-image')
    assert.equal(job?.input.operation, 'edit')
    assert.deepEqual(job?.input.localAssetIds, [reference.localAssetId])
    assert.deepEqual(job?.input.parameters, { aspectRatio: '1:1', count: 1, size: 'small', quality: 'standard' })
  })

  it('uses selected references for generation when the authorized profile does not support editing', async () => {
    const f = await fixture()
    const capabilities = structuredClone(MOCK_MEDIA_CAPABILITIES)
    capabilities.profiles[0].operations = ['generate']
    f.employee.media = capabilities
    const referencePath = join(f.directory, 'generation-reference.png')
    await writeFile(referencePath, MOCK_MEDIA_PNG)
    const reference = await f.store.importReference(owner, 'task-a', referencePath)
    await f.service.setReferenceSelection('task-a', [reference.localAssetId])

    const tools = await f.service.prepareRun({ taskId: 'task-a', runId: 'generate-with-reference', subscriptionId: f.employee.subscriptionId,
      employee: f.employee, requestApproval: f.options.requestApproval })
    const result = await tools!.execute('media_generate_image', { creativeBrief: 'Create a new image using this visual reference' }) as { jobId: string }
    await f.service.waitForRun('task-a', 'generate-with-reference')
    const job = await f.store.getJob(owner, 'task-a', result.jobId)
    assert.equal(job?.input.operation, 'generate')
    assert.deepEqual(job?.input.localAssetIds, [reference.localAssetId])
  })

  it('releases generation reservations even when initial and error-state persistence both fail', async context => {
    const f = await fixture({ policy: async () => policy() })
    const stub = context.mock.method(f.store, 'saveJob', async () => { throw new Error('Disk full') })
    try {
      for (let index = 0; index < 4; index++) await assert.rejects(f.service.generateTaskMedia('task-a', input()))
      assert.equal(f.gateway.calls.submit.length, 0)
      const stopped = await Promise.race([f.service.stopTask('task-a').then(() => true), delay(150).then(() => false)])
      assert.equal(stopped, true, 'Failed writes must not leave unresolved activity promises.')
      await f.service.stopAll()
      stub.mock.restore()
      const view = await f.service.generateTaskMedia('task-a', input())
      await f.service.waitForRun('task-a', view.runId)
      assert.equal(f.gateway.calls.submit.length, 1)
    } finally {
      stub.mock.restore()
      // A failing pre-fix service has no running I/O, only unresolved reservations.
      services.splice(services.indexOf(f.service), 1)
    }
  })

  it('does not permanently cache a transient capability authorization failure', async () => {
    let calls = 0
    const f = await fixture({ authorize: async () => {
      if (++calls === 1) throw new Error('Transient authorization outage')
      return f.employee
    } })
    assert.equal((await f.service.getTaskMedia('task-a')).capabilities, null)
    assert.deepEqual((await f.service.getTaskMedia('task-a')).capabilities, MOCK_MEDIA_CAPABILITIES)
    assert.equal(calls, 2)
    const unavailable = await fixture({ gateway: undefined, authorize: async () => { assert.fail('No gateway requires no grant lookup.') } })
    await unavailable.service.getTaskMedia('task-a')
    await unavailable.service.getTaskMedia('task-a')
  })

  it('refreshes capabilities when a temporarily unavailable employee becomes available', async () => {
    let calls = 0
    const f = await fixture({ authorize: async () => ++calls === 1 ? null : f.employee })
    assert.equal((await f.service.getTaskMedia('task-a')).capabilities, null)
    assert.deepEqual((await f.service.getTaskMedia('task-a')).capabilities, MOCK_MEDIA_CAPABILITIES)
    assert.equal(calls, 2)
  })

  it('does not submit generation prepared before an explicit task stop', async context => {
    const f = await fixture({ policy: async () => policy() })
    const entered = deferred<void>(), release = deferred<void>()
    context.mock.method(f.store, 'isArchived', async () => { entered.resolve(); await release.promise; return false })
    const generating = f.service.generateTaskMedia('task-a', input())
    const rejected = assert.rejects(generating)
    await entered.promise
    await f.service.stopTask('task-a')
    release.resolve()
    await rejected
    assert.equal(f.gateway.calls.quote.length, 0)
    assert.equal(f.gateway.calls.submit.length, 0)
  })

  it('does not revive a cancelled job from an already running recovery scan', async context => {
    const f = await fixture({ pollFloorMs: 60_000 }, new MockMediaGateway({ pollStatuses: ['RUNNING'] }))
    const job = await pendingJob(f)
    const entered = deferred<void>(), release = deferred<void>()
    const listJobs = f.store.listJobs.bind(f.store)
    context.mock.method(f.store, 'listJobs', async (scope: TaskOwnerScope, taskId?: string) => {
      if (taskId) return listJobs(scope, taskId)
      const snapshot = await listJobs(scope)
      entered.resolve(); await release.promise
      return snapshot
    })
    const recovering = f.service.resumePending()
    await entered.promise
    await f.service.cancel('task-a', job.jobId, false)
    release.resolve()
    await recovering
    assert.equal((await f.store.getJob(owner, 'task-a', job.jobId))?.trackingStatus, 'STOPPED')
    assert.equal(f.gateway.calls.getReceipt.length, 0)
  })

  it('preserves explicit stop when session shutdown races with activity settlement', async () => {
    const f = await fixture({ pollFloorMs: 60_000 }, new MockMediaGateway({ pollStatuses: ['RUNNING'] }))
    const view = await f.service.generateTaskMedia('task-a', input())
    await Promise.all([f.service.stopTask('task-a'), f.service.stopAll()])
    assert.equal((await f.store.getJob(owner, 'task-a', view.jobId))?.trackingStatus, 'STOPPED')
    await f.service.resumePending()
    assert.equal(f.gateway.calls.getReceipt.length, 0)
  })

  it('persists explicit stop during recovery lookup even when shutdown invalidates that lookup', async context => {
    const f = await fixture()
    const job = await pendingJob(f)
    const getJob = f.store.getJob.bind(f.store)
    const entered = deferred<void>(), release = deferred<void>()
    let first = true
    context.mock.method(f.store, 'getJob', async (scope: TaskOwnerScope, taskId: string, jobId: string) => {
      const snapshot = await getJob(scope, taskId, jobId)
      if (first) { first = false; entered.resolve(); await release.promise }
      return snapshot
    })
    const recovering = f.service.resume('task-a', job.jobId)
    const settlement = recovering.catch(() => undefined)
    await entered.promise
    const stopping = f.service.stopTask('task-a'), shutdown = f.service.stopAll()
    release.resolve()
    await Promise.all([settlement, stopping, shutdown])
    assert.equal((await f.store.getJob(owner, 'task-a', job.jobId))?.trackingStatus, 'STOPPED')
    assert.equal(f.gateway.calls.getReceipt.length, 0)
  })

  it('persists an explicitly stopped queued job during simultaneous session shutdown', async () => {
    const f = await fixture({ getTask: async () => ({ subscriptionId: 'subscription-a' }), pollFloorMs: 60_000 }, new MockMediaGateway({ pollStatuses: ['RUNNING'] }))
    for (let index = 0; index < 5; index++) await pendingJob(f, `task-${index}`, `queued-${index}`)
    await f.service.resumePending()
    await Promise.all([f.service.stopTask('task-4'), f.service.stopAll()])
    assert.equal((await f.store.getJob(owner, 'task-4', 'queued-4'))?.trackingStatus, 'STOPPED')
  })

  for (const stage of ['approval', 'gateway'] as const) {
    it(`aborts host cancellation during ${stage} without accepting a late response`, async context => {
      const entered = deferred<void>(), release = deferred<void>()
      const f = await fixture()
      const job = await pendingJob(f)
      if (stage === 'gateway') {
        const cancel = f.gateway.cancel.bind(f.gateway)
        context.mock.method(f.gateway, 'cancel', async (subscriptionId: string, receiptId: string, signal: AbortSignal) => {
          entered.resolve(); await release.promise
          return cancel(subscriptionId, receiptId, signal)
        })
      }
      const tools = await f.service.prepareRun({ taskId: 'task-a', runId: 'cancel-run', subscriptionId: f.employee.subscriptionId,
        employee: f.employee, toolPolicy: policy('full-local', stage === 'approval' ? 'confirm-each' : 'auto-approve'),
        requestApproval: async () => { entered.resolve(); await release.promise; return true } })
      const controller = new AbortController()
      const rejected = assert.rejects(tools!.execute('media_cancel_job', { jobId: job.jobId, cancelUpstream: true }, controller.signal),
        (error: unknown) => error instanceof Error && error.name === 'AbortError')
      await entered.promise
      controller.abort()
      release.resolve()
      await rejected
      assert.equal(f.gateway.calls.cancel.length, 0)
      assert.notEqual((await f.store.getJob(owner, 'task-a', job.jobId))?.generationStatus, 'CANCELLED')
    })
  }

  for (const action of ['stopTask', 'cancel'] as const) {
    it(`keeps recovery stopped when ${action} races with its task lookup`, async context => {
      const f = await fixture({ pollFloorMs: 60_000 }, new MockMediaGateway({ pollStatuses: ['RUNNING'] }))
      const job = await pendingJob(f)
      const listJobs = f.store.listJobs.bind(f.store)
      context.mock.method(f.store, 'listJobs', async (scope: TaskOwnerScope, taskId?: string) => taskId ? listJobs(scope, taskId) : [structuredClone(job)])
      const entered = deferred<void>(), release = deferred<void>(), cancellationRead = deferred<void>()
      let first = true
      const getJob = f.store.getJob.bind(f.store)
      context.mock.method(f.store, 'getJob', async (scope: TaskOwnerScope, taskId: string, jobId: string) => {
        const snapshot = await getJob(scope, taskId, jobId)
        if (first) { first = false; entered.resolve(); await release.promise }
        else cancellationRead.resolve()
        return snapshot
      })
      const recovering = f.service.resumePending()
      await entered.promise
      const stopping = action === 'stopTask' ? f.service.stopTask('task-a') : f.service.cancel('task-a', job.jobId, false)
      try {
        // Cancellation must finish its own lookup before the recovery lookup is released.
        if (action === 'cancel') {
          await cancellationRead.promise
          await new Promise<void>(resolve => setImmediate(resolve))
        }
        release.resolve()
        await Promise.all([recovering, stopping])
        assert.equal((await f.store.getJob(owner, 'task-a', job.jobId))?.trackingStatus, 'STOPPED')
        assert.equal(f.gateway.calls.getReceipt.length, 0)
      } finally { release.resolve(); await Promise.allSettled([recovering, stopping]) }
    })
  }

  it('persists explicit stop of a queued recovery without reviving it after restart', async () => {
    const f = await fixture({ getTask: async () => ({ subscriptionId: 'subscription-a' }), pollFloorMs: 60_000 }, new MockMediaGateway({ pollStatuses: ['RUNNING'] }))
    const jobs: LocalMediaJob[] = []
    for (let index = 0; index < 5; index++) jobs.push(await pendingJob(f, `task-${index}`, `queued-${index}`))
    await f.service.resumePending()
    await f.service.stopTask('task-4')
    assert.equal((await f.store.getJob(owner, 'task-4', jobs[4].jobId))?.trackingStatus, 'STOPPED')
    await f.service.stopAll()
    assert.equal((await f.store.getJob(owner, 'task-0', jobs[0].jobId))?.trackingStatus, 'INTERRUPTED')
    const restarted = new MediaService({ ...f.options, store: new MediaStore(f.root) })
    services.push(restarted)
    await restarted.resumePending()
    assert.ok(!f.gateway.calls.getReceipt.some(call => call.receiptId === jobs[4].receiptId))
    assert.equal(f.gateway.calls.submit.length, 5)
  })

  it('preserves recoverable jobs when runtime task cleanup follows session shutdown', async () => {
    const f = await fixture({ pollFloorMs: 60_000 }, new MockMediaGateway({ pollStatuses: ['RUNNING'] }))
    const view = await f.service.generateTaskMedia('task-a', input())
    await f.service.stopAll()
    await f.service.stopTask('task-a')
    assert.equal((await f.store.getJob(owner, 'task-a', view.jobId))?.trackingStatus, 'INTERRUPTED')
  })

  it('invalidates upstream cancellation across same-owner logout and login during policy lookup', async () => {
    const entered = deferred<void>(), release = deferred<TaskToolPolicy>()
    const f = await fixture({ policy: async () => { entered.resolve(); return release.promise } })
    const job = await pendingJob(f)
    const cancelling = f.service.cancel('task-a', job.jobId, true)
    const rejected = assert.rejects(cancelling, code('AUTH_REQUIRED'))
    await entered.promise
    f.setScope(null)
    await f.service.stopAll()
    f.setScope({ ...owner })
    release.resolve(policy())
    await rejected
    assert.equal(f.gateway.calls.cancel.length, 0)
  })

  it('forwards host tool abort through cancellation lookup before any upstream call', async context => {
    const f = await fixture()
    const job = await pendingJob(f)
    const tools = await f.service.prepareRun({ taskId: 'task-a', runId: 'cancel-run', subscriptionId: f.employee.subscriptionId,
      employee: f.employee, toolPolicy: policy(), requestApproval: f.options.requestApproval })
    const entered = deferred<void>(), release = deferred<void>()
    context.mock.method(f.options, 'getTask', async () => { entered.resolve(); await release.promise; return { subscriptionId: f.employee.subscriptionId } })
    const controller = new AbortController()
    const cancelling = tools!.execute('media_cancel_job', { jobId: job.jobId, cancelUpstream: true }, controller.signal)
    const rejected = assert.rejects(cancelling, (error: unknown) => error instanceof Error && error.name === 'AbortError')
    await entered.promise
    controller.abort()
    await f.service.stopTask('task-a')
    release.resolve()
    await rejected
    assert.equal(f.gateway.calls.cancel.length, 0)
  })

  it('still sends approved upstream cancellation when tracking settlement cannot be saved', async context => {
    const f = await fixture({ policy: async () => policy(), pollFloorMs: 60_000 }, new MockMediaGateway({ pollStatuses: ['RUNNING'] }))
    const view = await f.service.generateTaskMedia('task-a', input())
    const stub = context.mock.method(f.store, 'saveJob', async () => { throw new Error('Disk full during cancellation') })
    try {
      await assert.rejects(f.service.cancel('task-a', view.jobId, true), /Disk full|persist|cancel/i)
      assert.equal(f.gateway.calls.cancel.length, 1, 'Tracking persistence failure must not prevent approved cancellation.')
      stub.mock.restore()
      await f.service.stopTask('task-a')
    } finally { stub.mock.restore() }
  })
})
