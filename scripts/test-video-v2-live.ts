/** Paid acceptance entry point. Importing this module never starts a request. */
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, realpath, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { employeeRuntimeManifestSchema } from '../electron/common/platform/employee-runtime-contract'
import { SepRealVideoGateway } from '../electron/data/sep-video-media-gateway'
import { inspectMediaImage } from '../electron/data/media-image'
import { VideoFiles } from '../electron/data/video-files'
import { VideoStore } from '../electron/data/video-store'
import { MockVideoHostService } from '../electron/service/mock-video-host-service'
import { videoLocalIdSchema } from '../electron/domain/video-media'
import { videoBillingPending, videoOperationSchema, videoParametersSchema, videoRuntimeSchema } from '../src/shared/video-media'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const forbiddenRoots = [repo, resolve(repo, '../SEP')]
const token = z.string().min(1).max(16_384).regex(/^[A-Za-z0-9._~+/-]+=*$/)
const cny = z.string().max(32).regex(/^\d+(?:\.\d{1,6})?$/)
export const liveVideoConfigSchema = z.object({
  baseUrl: z.string().url(), accessToken: token, employmentToken: token,
  kind: z.string().min(1).max(80).optional(), accessTokenExpiresIn: z.number().int().positive().optional(),
  runtimeUrl: z.string().url().optional(), cacheDirectory: z.string().optional(),
  configVersion: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).optional(),
  subscriptionId: videoLocalIdSchema, enterpriseId: videoLocalIdSchema, memberId: videoLocalIdSchema,
  profileId: videoLocalIdSchema, modelId: z.literal('minimax-h3').default('minimax-h3'),
  operation: videoOperationSchema, pngPath: z.string().optional(), outputRoot: z.string().optional(),
  taskId: videoLocalIdSchema.default('video-v2-live'), paid: z.literal(true),
  capCny: cny.pipe(z.string().refine(value => cnyMicros(value) > 0n)),
  creativeBrief: z.string().trim().min(1).max(4000), parameters: videoParametersSchema.optional(),
  budgetMs: z.number().int().min(1000).max(15 * 60_000).default(15 * 60_000),
}).strict().superRefine((value, context) => {
  if ((value.operation === 'image-to-video') !== !!value.pngPath) context.addIssue({ code: 'custom', message: 'PNG selection does not match operation.' })
  if (!value.outputRoot && !value.cacheDirectory) context.addIssue({ code: 'custom', message: 'Stable private evidence root required.' })
  if (value.outputRoot && value.cacheDirectory && resolve(value.outputRoot) !== resolve(value.cacheDirectory)) context.addIssue({ code: 'custom', message: 'Evidence root and cache directory must agree.' })
}).transform(value => ({ ...value, outputRoot: (value.outputRoot ?? value.cacheDirectory)! }))
export type LiveVideoConfig = z.infer<typeof liveVideoConfigSchema>

class LiveVideoError extends Error {
  constructor(readonly stage: string) { super(`Live video acceptance stopped (${stage}); original evidence retained.`) }
}
function requireLive(condition: unknown, stage: string): asserts condition {
  if (!condition) throw new LiveVideoError(stage)
}
export function cnyMicros(value: string): bigint {
  if (!/^\d+(?:\.\d{1,6})?$/.test(value) || value.length > 128) throw new LiveVideoError('invalid-cny')
  const [whole, fraction = ''] = value.split('.')
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'))
}
export function validateLiveBase(value: string): URL {
  const base = new URL(value)
  requireLive(base.protocol === 'http:' && base.hostname === '127.0.0.1' && !!base.port &&
    base.pathname === '/api' && !base.username && !base.password && !base.search && !base.hash, 'loopback-base-required')
  return base
}
function outsideRepositories(path: string): void {
  requireLive(isAbsolute(path), 'absolute-private-path-required')
  for (const root of forbiddenRoots) {
    const rel = relative(root, resolve(path))
    requireLive(rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel), 'private-path-inside-repository')
  }
}
async function privatePath(path: string): Promise<void> {
  outsideRepositories(path)
  const canonical = await realpath(path)
  outsideRepositories(canonical)
  requireLive(canonical === resolve(path), 'symlinked-private-path')
  const stat = await lstat(path)
  requireLive((stat.mode & 0o077) === 0 && (process.getuid === undefined || stat.uid === process.getuid()), 'private-path-permissions')
}
async function privateBytes(path: string, max: number): Promise<Buffer> {
  await privatePath(path)
  const files = new VideoFiles(dirname(path))
  return files.bytes(path, max)
}
export async function loadLiveVideoConfig(path: string, env: NodeJS.ProcessEnv = {}): Promise<LiveVideoConfig> {
  const input: unknown = JSON.parse((await privateBytes(path, 64 * 1024)).toString('utf8'))
  requireLive(typeof input === 'object' && input !== null && !Array.isArray(input), 'invalid-private-config')
  const config = liveVideoConfigSchema.parse({ ...input,
    ...(env.SEP_VIDEO_V2_LIVE_PAID !== undefined ? { paid: env.SEP_VIDEO_V2_LIVE_PAID === 'true' } : {}),
    ...(env.SEP_VIDEO_V2_LIVE_CAP_CNY !== undefined ? { capCny: env.SEP_VIDEO_V2_LIVE_CAP_CNY } : {}),
    ...(env.SEP_VIDEO_V2_LIVE_OPERATION !== undefined ? { operation: env.SEP_VIDEO_V2_LIVE_OPERATION } : {}),
    ...(env.SEP_VIDEO_V2_LIVE_OUTPUT_ROOT !== undefined ? { outputRoot: env.SEP_VIDEO_V2_LIVE_OUTPUT_ROOT } : {}),
    ...(env.SEP_VIDEO_V2_LIVE_PNG_PATH !== undefined ? { pngPath: env.SEP_VIDEO_V2_LIVE_PNG_PATH } : {}),
    ...(env.SEP_VIDEO_V2_LIVE_CREATIVE_BRIEF !== undefined ? { creativeBrief: env.SEP_VIDEO_V2_LIVE_CREATIVE_BRIEF } : {}),
  })
  validateLiveBase(config.baseUrl)
  liveRuntimeUrl(config)
  outsideRepositories(config.outputRoot)
  if (config.pngPath) outsideRepositories(config.pngPath)
  return config
}

function liveRuntimeUrl(config: LiveVideoConfig): URL {
  const base = validateLiveBase(config.baseUrl)
  const path = `/api/client/subscriptions/${encodeURIComponent(config.subscriptionId)}/runtime`
  const url = new URL(config.runtimeUrl ?? `${base.origin}${path}?mediaProtocolVersion=1&skillArtifactProtocolVersion=1&videoProtocolVersion=1`)
  requireLive(url.origin === base.origin && url.pathname === path && !url.username && !url.password && !url.hash &&
    url.searchParams.get('videoProtocolVersion') === '1' &&
    [...url.searchParams.keys()].every(key => ['videoProtocolVersion', 'mediaProtocolVersion', 'skillArtifactProtocolVersion'].includes(key) &&
      url.searchParams.getAll(key).length === 1 && url.searchParams.get(key) === '1'), 'invalid-runtime-url')
  return url
}

export function approveLiveVideo(input: unknown, config: LiveVideoConfig, uploadApproved: boolean): 'upload' | 'quote' {
  const upload = z.object({ operation: z.literal('upload-references'), referenceCount: z.literal(1), mock: z.literal(false) }).strict().safeParse(input)
  if (upload.success) {
    requireLive(config.paid && config.operation === 'image-to-video' && !uploadApproved, 'unexpected-upload-approval')
    return 'upload'
  }
  const request = z.object({ mock: z.literal(false), parameters: videoParametersSchema,
    creativeBrief: z.literal(config.creativeBrief),
    quote: z.object({ currency: z.literal('CNY'), amount: cny, expiresAt: z.number().finite(),
      amountUsd: z.string().regex(/^\d+(?:\.\d{1,12})?$/), pricingVersion: z.string().min(1),
      funding: z.object({ creditCny: cny, memberWalletCny: cny, personalCny: cny }).strict(),
    }),
  }).safeParse(input)
  requireLive(config.paid && request.success, 'invalid-paid-approval')
  requireLive(config.operation !== 'image-to-video' || uploadApproved, 'upload-approval-required')
  if (config.parameters) requireLive(isDeepStrictEqual(request.data.parameters, config.parameters), 'approval-parameters-changed')
  requireLive(request.data.quote.expiresAt > Date.now() && cnyMicros(request.data.quote.amount) > 0n &&
    cnyMicros(request.data.quote.amount) <= cnyMicros(config.capCny), 'quote-over-cap-or-expired')
  return 'quote'
}

async function runtimeJson(response: Response): Promise<unknown> {
  requireLive(response.ok, `runtime-http-${response.status}`)
  requireLive(response.headers.get('content-type')?.split(';')[0].trim() === 'application/json', 'runtime-content-type')
  const reader = response.body?.getReader()
  requireLive(reader, 'runtime-empty')
  let size = 0
  const chunks: Uint8Array[] = []
  try {
    for (;;) {
      const item = await reader.read()
      if (item.done) break
      size += item.value.byteLength
      requireLive(size <= 1024 * 1024, 'runtime-size')
      chunks.push(item.value)
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock() }
}

export async function runVideoV2Live(configPath: string, env: NodeJS.ProcessEnv = {}): Promise<Record<string, unknown>> {
  const config = await loadLiveVideoConfig(configPath, env)
  const base = validateLiveBase(config.baseUrl)
  const runtimeUrl = liveRuntimeUrl(config)
  await mkdir(config.outputRoot, { recursive: true, mode: 0o700 })
  await privatePath(config.outputRoot)
  const files = new VideoFiles(config.outputRoot)
  const lockPath = join(config.outputRoot, 'live-runner.lock')
  // Fail closed on a stale lock after SIGKILL; never guess that a paid writer is dead.
  const lock = await open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
  const hosts: MockVideoHostService[] = []
  const signal = AbortSignal.timeout(config.budgetMs)
  const counts = { runtime: 0, profiles: 0, references: 0, quotes: 0, submits: 0, queries: 0, downloads: 0, uploadApprovals: 0, quoteApprovals: 0, previews: 0 }
  const scope = { enterpriseId: config.enterpriseId, memberId: config.memberId, subscriptionId: config.subscriptionId }
  const gatewayPath = '/api/gateway/v1/media/video-real/'
  let uploadApproved = false, quoteApproved = false, referenceSha256: string | undefined
  let expectedParameters = config.parameters
  let canGenerate = false
  const transport: typeof fetch = async (input, init) => {
    signal.throwIfAborted()
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    requireLive(url.origin === base.origin && !url.username && !url.password && !url.hash, 'forbidden-origin')
    const isRuntime = url.href === runtimeUrl.href
    const headers = new Headers(init?.headers)
    requireLive(headers.get('Authorization') === `Bearer ${isRuntime ? config.accessToken : config.employmentToken}`, 'incorrect-authentication')
    const method = init?.method ?? 'GET'
    if (isRuntime) { requireLive(method === 'GET', 'runtime-method'); counts.runtime++ }
    else {
      requireLive(url.pathname.startsWith(gatewayPath) && !url.search, 'forbidden-route')
      const path = url.pathname.slice(gatewayPath.length)
      if (path === 'profiles' && method === 'GET') counts.profiles++
      else if (path === 'references' && method === 'POST') {
        requireLive(canGenerate && uploadApproved && counts.references === 0, 'unapproved-reference-upload'); counts.references++
      } else if (path === 'quotes' && method === 'POST') {
        requireLive(canGenerate && counts.quotes === 0, 'repeated-quote'); counts.quotes++
      } else if (path === 'requests' && method === 'POST') {
        requireLive(canGenerate && quoteApproved && counts.submits === 0, 'repeated-or-unapproved-submit'); counts.submits++
      } else if (/^requests\/(?:by-client-id\/)?[A-Za-z0-9_-]+$/.test(path) && method === 'GET') counts.queries++
      else if (/^requests\/[A-Za-z0-9_-]+\/outputs\/[A-Za-z0-9_-]+\/content$/.test(path) && method === 'GET') counts.downloads++
      else throw new LiveVideoError('forbidden-method-or-route')
    }
    return fetch(url, { ...init, redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer',
      signal: AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])]) })
  }
  const gateway = new SepRealVideoGateway({ mock: false, baseUrl: base.href, subscriptionId: scope.subscriptionId,
    token: async () => config.employmentToken, fetch: transport })
  const makeHost = () => {
    const store = new VideoStore(config.outputRoot)
    const host = new MockVideoHostService({ mock: false, store, scope: { currentScope: () => scope },
      operationTimeoutMs: config.budgetMs, authorizationRevision: () => 0,
      getTask: async id => id === config.taskId ? { subscriptionId: scope.subscriptionId } : null,
      authorize: async (subscriptionId, bounded) => {
        requireLive(subscriptionId === scope.subscriptionId, 'runtime-scope')
        const response = await transport(runtimeUrl, {
          headers: { Authorization: `Bearer ${config.accessToken}`, Accept: 'application/json' }, signal: bounded,
        })
        const manifest = employeeRuntimeManifestSchema.parse(await runtimeJson(response))
        requireLive(manifest.subscriptionId === scope.subscriptionId, 'runtime-subscription')
        return videoRuntimeSchema.parse(manifest.runtime.video)
      },
      gateway: actual => { requireLive(isDeepStrictEqual(actual, scope), 'gateway-scope'); return gateway },
      readReference: async (actual, taskId, localId) => {
        requireLive(uploadApproved && config.pngPath && isDeepStrictEqual(actual, scope) && taskId === config.taskId && localId === 'live-png', 'reference-scope-or-approval')
        const bytes = await privateBytes(config.pngPath, 10 * 1024 * 1024)
        const info = inspectMediaImage(bytes)
        requireLive(info.mime === 'image/png' && info.width <= 4096 && info.height <= 4096, 'invalid-png')
        referenceSha256 = createHash('sha256').update(bytes).digest('hex')
        return { bytes, sha256: referenceSha256 }
      },
      requestApproval: async approval => {
        requireLive(canGenerate && approval.taskId === config.taskId && approval.subscriptionId === scope.subscriptionId &&
          approval.toolName === (config.operation === 'image-to-video' ? 'video_from_image' : 'video_generate'), 'approval-scope')
        const kind = approveLiveVideo(approval.input, config, uploadApproved)
        if (kind === 'upload') { uploadApproved = true; counts.uploadApprovals++ }
        else {
          requireLive(!quoteApproved && isDeepStrictEqual((approval.input as { parameters: unknown }).parameters, expectedParameters), 'repeated-or-changed-cost-approval')
          quoteApproved = true; counts.quoteApprovals++
        }
        return true
      },
      openOutput: async (actual, taskId, jobId, outputId, bounded, validate) => {
        bounded.throwIfAborted(); validate()
        requireLive(isDeepStrictEqual(actual, scope) && taskId === config.taskId, 'preview-scope')
        const path = await store.verifiedAssetPath(actual, taskId, jobId, outputId)
        requireLive(relative(config.outputRoot, path).split(sep)[0] !== '..' && isAbsolute(path), 'preview-path')
        bounded.throwIfAborted(); validate(); counts.previews++
      },
    })
    hosts.push(host)
    return { host, store }
  }
  try {
    await lock.writeFile(`${process.pid}\n`); await lock.sync()
    let current = makeHost()
    const journalPath = join(config.outputRoot, 'live-attempt.json')
    const identity = { version: 1, baseUrl: base.href, scope, taskId: config.taskId, profileId: config.profileId,
      modelId: config.modelId, configVersion: config.configVersion ?? null, runtimeUrl: runtimeUrl.href,
      operation: config.operation, parameters: config.parameters ?? null,
      creativeBrief: config.creativeBrief, pngPath: config.pngPath ?? null, capCny: config.capCny }
    const journal = await files.json(journalPath, z.unknown())
    const existingJobs = await current.store.listJobs(scope)
    requireLive(existingJobs.length <= 1, 'ambiguous-local-jobs')
    const existed = journal !== null
    if (existed) requireLive(isDeepStrictEqual(journal, identity), 'changed-attempt-identity')
    else {
      requireLive(existingJobs.length === 0, 'missing-attempt-identity')
      requireLive((await files.names(config.outputRoot)).every(name => name === 'live-runner.lock'), 'unexpected-output-evidence')
      // Durable fail-closed marker also covers crashes before prepare() publishes a job.
      await files.writeJson(journalPath, identity)
      canGenerate = true
    }
    if (existed) requireLive(existingJobs.length === 1, 'attempt-without-job-no-resubmit')
    const runtime = (await current.host.getTaskVideo(config.taskId)).runtime
    requireLive(runtime.executionMode === 'real' && runtime.executionAvailable, 'real-runtime-unavailable')
    const profile = runtime.profiles.find(item => item.profileId === config.profileId)
    requireLive(profile && profile.operations.includes(config.operation), 'requested-profile-unavailable')
    if (config.configVersion) requireLive(profile.configVersion === config.configVersion, 'requested-config-version-unavailable')
    const profiles = await gateway.profiles(signal)
    // The client runtime intentionally omits provider model IDs; configVersion is
    // the server-owned frozen identity exposed at this contract boundary.
    requireLive(!profiles.mock && profiles.profiles.some(item => item.profileId === profile.profileId &&
      item.configVersion === profile.configVersion), 'profile-contract-mismatch')
    if (!existed) {
      const cap = profile.capabilities
      const parameters = config.parameters ?? { durationSeconds: cap.durationsSeconds[0], aspectRatio: cap.aspectRatios[0],
        resolution: cap.resolutions[0], frameRate: cap.frameRates[0], audio: cap.supportsAudio, outputFormat: cap.outputFormats[0] }
      expectedParameters = parameters
      await current.host.generate(config.taskId, { profileId: config.profileId, operation: config.operation,
        localAssetIds: config.operation === 'image-to-video' ? ['live-png'] : [], creativeBrief: config.creativeBrief, parameters }, signal)
      requireLive(counts.quoteApprovals === 1 && counts.uploadApprovals === (config.operation === 'image-to-video' ? 1 : 0), 'missing-approvals')
    }
    canGenerate = false
    let [job] = await current.store.listJobs(scope)
    requireLive(job && job.taskId === config.taskId && job.executionMode === 'real' && job.request.profileId === config.profileId &&
      job.request.operation === config.operation && job.submission !== 'NOT_SENT', 'original-job-not-submitted')
    const original = { jobId: job.jobId, clientRequestId: job.request.clientRequestId, receiptId: job.receipt?.receiptId }
    await current.host.stopAll()
    current = makeHost()
    while (!signal.aborted) {
      job = (await current.store.getJob(scope, config.taskId, original.jobId))!
      requireLive(job && job.request.clientRequestId === original.clientRequestId &&
        (!original.receiptId || job.receipt?.receiptId === original.receiptId), 'original-receipt-changed')
      requireLive(job.trackingStatus !== 'AUTH_REQUIRED', 'authorization-paused')
      const receipt = job.receipt
      if (receipt && ['SUCCEEDED', 'PARTIAL_SUCCEEDED', 'FAILED', 'CANCELLED', 'RESULT_EXPIRED'].includes(receipt.status) &&
        !videoBillingPending(receipt.billingStatus) && (!receipt.recovery.canDownload || job.saveStatus === 'SAVED')) break
      if (receipt?.recovery.canDownload && ['SAVE_FAILED', 'MISSING'].includes(job.saveStatus)) await current.host.retrySave(config.taskId, original.jobId)
      else await current.host.resume(config.taskId, original.jobId, signal)
      const updated = await current.store.getJob(scope, config.taskId, original.jobId)
      if (updated?.saveStatus === 'SAVED' && updated.receipt && !videoBillingPending(updated.receipt.billingStatus)) continue
      const wait = Math.max(1000, updated?.receipt?.pollAfterMs ?? 5000)
      await delay(wait, undefined, { signal })
    }
    signal.throwIfAborted()
    requireLive(job.receipt && !job.receipt.mock, 'missing-real-receipt')
    const receipt = job.receipt
    requireLive(receipt.status === 'SUCCEEDED' && receipt.billingStatus === 'SETTLED' && job.saveStatus === 'SAVED', 'generation-or-billing-incomplete')
    for (const amount of [job.quote.amount, receipt.amountCny, receipt.actualCostCny]) if (amount !== undefined && amount !== null) requireLive(cnyMicros(amount) <= cnyMicros(config.capCny), 'actual-cost-over-cap')
    const outputs = []
    for (const output of receipt.outputs) {
      const bytes = await current.store.readAsset(scope, config.taskId, job.jobId, output.outputId)
      requireLive(bytes.byteLength === output.byteLength && createHash('sha256').update(bytes).digest('hex') === output.sha256.toLowerCase(), 'saved-output-integrity')
      outputs.push({ outputId: output.outputId, sha256: output.sha256, byteLength: output.byteLength,
        width: output.width, height: output.height, durationSeconds: output.durationSeconds, frameRate: output.frameRate })
    }
    await current.host.stopAll()
    current = makeHost()
    const restored = await current.store.getJob(scope, config.taskId, original.jobId)
    requireLive(restored?.receipt?.receiptId === receipt.receiptId && restored.request.clientRequestId === original.clientRequestId, 'restart-identity')
    const before = { downloads: counts.downloads, submits: counts.submits, queries: counts.queries }
    for (const output of receipt.outputs) {
      const preview = await current.host.preview(config.taskId, original.jobId, output.outputId)
      requireLive(preview.opened === true && !('bytes' in preview), 'preview-validation')
    }
    requireLive(isDeepStrictEqual(before, { downloads: counts.downloads, submits: counts.submits, queries: counts.queries }), 'preview-network-side-effect')
    return { mock: false, operation: config.operation, expectedModelId: config.modelId, profileId: config.profileId,
      taskId: config.taskId, jobId: job.jobId, clientRequestId: original.clientRequestId, receiptId: receipt.receiptId,
      resumed: existed, saveStatus: job.saveStatus, billingStatus: receipt.billingStatus, amountCny: receipt.amountCny ?? job.quote.amount,
      actualCostCny: receipt.actualCostCny, capCny: config.capCny, referenceSha256, originalReceiptRestored: true,
      previewPathVerified: true, outputs, counts }
  } finally {
    try { await Promise.all(hosts.map(host => host.stopAll())) } finally { await lock.close(); await rm(lockPath) }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const configPath = process.env.SEP_VIDEO_V2_LIVE_CONFIG
  void (configPath ? runVideoV2Live(configPath, process.env) : Promise.reject(new LiveVideoError('private-config-required')))
    .then(result => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch(error => {
      process.stderr.write(error instanceof LiveVideoError ? `${error.message}\n` : 'Live video acceptance stopped; original evidence retained.\n')
      process.exitCode = 1
    })
}
