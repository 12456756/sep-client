import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { rm } from 'node:fs/promises'
import { isDeepStrictEqual } from 'node:util'
import { videoOutputSchema, videoOutputExtension, type VideoOutput } from '../../src/shared/video-media'
import { assertVideoJobUpdate, localVideoAssetSchema, localVideoJobSchema, videoLocalIdSchema, videoScopeSchema,
  type LocalVideoAsset, type LocalVideoJob, type VideoAssetState, type VideoScope, type VideoStorePort } from '../domain/video-media'
import { encodeTaskScopeSegment, ScopePath } from './scope-path'
import { VideoFiles, VideoIntegrityError, VideoPersistenceError, videoFileMissing, videoSha256, MAX_VIDEO_BYTES } from './video-files'
import { WriteChain } from './write-chain'

const writes = new WriteChain()

/** Isolated from image media; all identifiers are validated before deriving paths. */
export class VideoStore implements VideoStorePort {
  private readonly files: VideoFiles
  private readonly paths: ScopePath
  constructor(userDataDir: string) {
    this.files = new VideoFiles(userDataDir)
    this.paths = new ScopePath(this.files.root)
  }

  private root(scope: VideoScope): string {
    videoScopeSchema.parse(scope)
    return join(this.paths.ownerRoot({ enterpriseId: scope.enterpriseId, memberId: scope.memberId }), 'video', 'v1', encodeTaskScopeSegment(scope.subscriptionId, 'subscriptionId'))
  }
  private task(scope: VideoScope, taskId: string): string {
    videoLocalIdSchema.parse(taskId)
    return join(this.root(scope), 'tasks', taskId)
  }
  private file(scope: VideoScope, taskId: string, kind: 'jobs' | 'assets' | 'files', id: string, suffix = '.json'): string {
    videoLocalIdSchema.parse(id)
    return join(this.task(scope, taskId), kind, `${id}${suffix}`)
  }
  private locked<T>(scope: VideoScope, operation: () => Promise<T>): Promise<T> { return writes.run(this.root(scope), operation) }
  private assertScope(actual: VideoScope, expected: VideoScope): void {
    if (!isDeepStrictEqual(actual, expected)) throw new VideoPersistenceError('Video does not belong to the active scope.')
  }

  private async job(scope: VideoScope, taskId: string, jobId: string): Promise<LocalVideoJob | null> {
    const job = await this.files.json(this.file(scope, taskId, 'jobs', jobId), localVideoJobSchema)
    if (job) {
      this.assertScope(job.scope, scope)
      if (job.jobId !== jobId || job.taskId !== taskId) throw new VideoPersistenceError('Video job identity differs from manifest.')
    }
    return job
  }
  async getJob(scope: VideoScope, taskId: string, jobId: string): Promise<LocalVideoJob | null> {
    return this.locked(scope, () => this.job(scope, taskId, jobId))
  }

  private manifestIds(names: string[], commits = false): string[] {
    const ids = new Set<string>()
    for (const name of names) {
      const match = /^([A-Za-z0-9_-]{1,128})\.json(\.commit)?$/.exec(name)
      if (match && (!match[2] || commits)) { ids.add(match[1]); continue }
      // A crash can leave temporary evidence. Only a published manifest/commit
      // can authorize recovery; never fall back to old backups or drop evidence.
      const temp = /^([A-Za-z0-9_-]{1,128})\.json(?:\.commit)?\.[A-Za-z0-9_-]+\.tmp$/.exec(name)
      if (temp && (names.includes(`${temp[1]}.json`) || (commits && names.includes(`${temp[1]}.json.commit`)))) continue
      throw new VideoPersistenceError('Unexpected or incomplete video manifest evidence.')
    }
    return [...ids].sort()
  }
  private async jobs(scope: VideoScope): Promise<LocalVideoJob[]> {
    const jobs: LocalVideoJob[] = []
    for (const taskId of await this.files.names(join(this.root(scope), 'tasks'))) {
      videoLocalIdSchema.parse(taskId)
      for (const jobId of this.manifestIds(await this.files.names(join(this.task(scope, taskId), 'jobs')))) {
        const job = await this.job(scope, taskId, jobId)
        if (job) jobs.push(job)
      }
    }
    return jobs.sort((a, b) => a.createdAt - b.createdAt || a.jobId.localeCompare(b.jobId))
  }
  async listJobs(scope: VideoScope): Promise<LocalVideoJob[]> { return this.locked(scope, () => this.jobs(scope)) }

  async createJob(scope: VideoScope, value: LocalVideoJob): Promise<void> {
    const job = localVideoJobSchema.parse(value)
    this.assertScope(job.scope, scope)
    if (job.submission !== 'NOT_SENT' || job.saveStatus !== 'PENDING') throw new VideoPersistenceError('New video jobs must be unsubmitted.')
    await this.locked(scope, async () => {
      if (await this.job(scope, job.taskId, job.jobId) || (await this.jobs(scope)).some(previous => previous.request.clientRequestId === job.request.clientRequestId)) {
        throw new VideoPersistenceError('Video job or client request ID already exists.')
      }
      await this.files.writeJson(this.file(scope, job.taskId, 'jobs', job.jobId), job)
    })
  }

  async updateJob(scope: VideoScope, taskId: string, jobId: string, update: (job: LocalVideoJob) => LocalVideoJob): Promise<LocalVideoJob> {
    return this.locked(scope, async () => {
      const previous = await this.job(scope, taskId, jobId)
      if (!previous) throw new VideoPersistenceError('Video job does not exist.')
      const next = localVideoJobSchema.parse(update(structuredClone(previous)))
      assertVideoJobUpdate(previous, next)
      // A persisted SAVED status requires every original output to be verified now.
      if (next.saveStatus === 'SAVED') {
        for (const output of next.receipt!.outputs) {
          const asset = await this.asset(scope, taskId, jobId, output.outputId)
          if (asset?.status !== 'SAVED') throw new VideoPersistenceError('Video job cannot be saved without verified local outputs.')
        }
      }
      await this.files.writeJson(this.file(scope, taskId, 'jobs', jobId), next)
      return structuredClone(next)
    })
  }

  private assetId(jobId: string, outputId: string): string {
    videoLocalIdSchema.parse(jobId); videoLocalIdSchema.parse(outputId)
    return `vout_${videoSha256(JSON.stringify([jobId, outputId]))}`
  }
  private assetFile(scope: VideoScope, asset: Pick<LocalVideoAsset, 'relativePath' | 'localAssetId' | 'output' | 'taskId'>): string {
    if (asset.relativePath !== `files/${asset.localAssetId}.${videoOutputExtension(asset.output.mimeType)}`) throw new VideoPersistenceError('Video asset path differs from identity.')
    return this.file(scope, asset.taskId, 'files', asset.localAssetId, `.${videoOutputExtension(asset.output.mimeType)}`)
  }
  private async record(scope: VideoScope, taskId: string, jobId: string, outputId: string): Promise<LocalVideoAsset | null> {
    const id = this.assetId(jobId, outputId)
    const file = this.file(scope, taskId, 'assets', id)
    const primary = await this.files.json(file, localVideoAssetSchema)
    const commit = await this.files.json(`${file}.commit`, localVideoAssetSchema)
    if (primary && commit && !isDeepStrictEqual(primary, commit)) throw new VideoPersistenceError('Video asset commit and manifest disagree.')
    const asset = primary ?? commit
    if (!asset) return null
    this.assertScope(asset.scope, scope)
    if (asset.localAssetId !== id || asset.taskId !== taskId || asset.jobId !== jobId || asset.output.outputId !== outputId) throw new VideoPersistenceError('Video asset identity differs from manifest.')
    this.assetFile(scope, asset)
    const job = await this.job(scope, taskId, jobId)
    const authorized = job?.receipt?.outputs.find(output => output.outputId === outputId)
    if (!authorized || asset.receiptId !== job?.receipt?.receiptId ||
      !isDeepStrictEqual({ ...authorized, expiresAt: null }, { ...asset.output, expiresAt: null })) throw new VideoPersistenceError('Video output is not authorized by original receipt.')
    return asset
  }
  private async asset(scope: VideoScope, taskId: string, jobId: string, outputId: string): Promise<VideoAssetState | null> {
    const asset = await this.record(scope, taskId, jobId, outputId)
    if (!asset) return null
    try { await this.files.verify(this.assetFile(scope, asset), asset.output) } catch (error) {
      if (videoFileMissing(error)) return { ...asset, status: 'MISSING' }
      throw error
    }
    // Crash after final rename: reconstruct only from the verified durable commit.
    const manifest = this.file(scope, taskId, 'assets', asset.localAssetId)
    if (!await this.files.exists(manifest)) await this.files.writeJson(manifest, asset)
    return asset
  }
  async getAsset(scope: VideoScope, taskId: string, jobId: string, outputId: string): Promise<VideoAssetState | null> {
    return this.locked(scope, () => this.asset(scope, taskId, jobId, outputId))
  }

  /** Explicit retry only. Intact matching manifests authorize quarantine, never a new request. */
  async repairCorruptOutput(scope: VideoScope, taskId: string, jobId: string, outputId: string, signal: AbortSignal): Promise<VideoAssetState> {
    return this.locked(scope, async () => {
      signal.throwIfAborted()
      const asset = await this.record(scope, taskId, jobId, outputId)
      if (!asset) throw new VideoPersistenceError('Video repair requires original manifest and commit evidence.')
      const manifest = this.file(scope, taskId, 'assets', asset.localAssetId)
      const primary = await this.files.json(manifest, localVideoAssetSchema)
      const commit = await this.files.json(`${manifest}.commit`, localVideoAssetSchema)
      if (!primary || !commit || !isDeepStrictEqual(primary, asset) || !isDeepStrictEqual(commit, asset)) {
        throw new VideoPersistenceError('Video repair requires intact matching manifest and commit evidence.')
      }
      const file = this.assetFile(scope, asset)
      try {
        await this.files.verify(file, asset.output)
        return structuredClone(asset)
      } catch (error) {
        if (videoFileMissing(error)) return { ...asset, status: 'MISSING' }
        if (!(error instanceof VideoIntegrityError)) throw error
      }
      const job = (await this.job(scope, taskId, jobId))!
      const receipt = job.receipt!
      const output = receipt.outputs.find(item => item.outputId === outputId)!
      if (!['SUCCEEDED', 'PARTIAL_SUCCEEDED'].includes(receipt.status) || !receipt.recovery.canDownload ||
        (output.expiresAt !== null && Date.parse(output.expiresAt) <= Date.now())) {
        throw new VideoPersistenceError('Original video output is unavailable for repair; corrupt evidence was preserved.')
      }
      const evidence = { manifest: await this.files.bytes(manifest), commit: await this.files.bytes(`${manifest}.commit`) }
      for (const bytes of Object.values(evidence)) {
        if (!isDeepStrictEqual(localVideoAssetSchema.parse(JSON.parse(bytes.toString('utf8')) as unknown), asset)) {
          throw new VideoPersistenceError('Video repair evidence changed.')
        }
      }
      const next = localVideoJobSchema.parse({ ...job, saveStatus: 'MISSING', error: 'VIDEO_LOCAL_OUTPUT_CORRUPT', updatedAt: Math.max(Date.now(), job.updatedAt) })
      assertVideoJobUpdate(job, next)
      signal.throwIfAborted()
      // A crash/failure during quarantine must never leave a persisted SAVED claim.
      await this.files.writeJson(this.file(scope, taskId, 'jobs', jobId), next)
      await this.files.quarantine(file, join(this.task(scope, taskId), 'quarantine', randomUUID()), evidence, signal)
      return { ...asset, status: 'MISSING' }
    })
  }
  async listAssets(scope: VideoScope, taskId: string): Promise<VideoAssetState[]> {
    return this.locked(scope, async () => {
      const assets: VideoAssetState[] = []
      for (const id of this.manifestIds(await this.files.names(join(this.task(scope, taskId), 'assets')), true)) {
        const value = await this.files.json(this.file(scope, taskId, 'assets', id), localVideoAssetSchema) ??
          await this.files.json(`${this.file(scope, taskId, 'assets', id)}.commit`, localVideoAssetSchema)
        if (!value || value.localAssetId !== id) throw new VideoPersistenceError('Invalid video asset manifest identity.')
        const asset = await this.asset(scope, taskId, value.jobId, value.output.outputId)
        if (asset) assets.push(asset)
      }
      return assets
    })
  }
  async readAsset(scope: VideoScope, taskId: string, jobId: string, outputId: string): Promise<Uint8Array> {
    return this.locked(scope, async () => {
      const asset = await this.asset(scope, taskId, jobId, outputId)
      if (asset?.status !== 'SAVED') throw new VideoPersistenceError('Video asset is missing.')
      const bytes = await this.files.bytes(this.assetFile(scope, asset), MAX_VIDEO_BYTES)
      if (bytes.length !== asset.output.byteLength || videoSha256(bytes) !== asset.output.sha256.toLowerCase()) throw new VideoPersistenceError('Video changed during reading.')
      return bytes
    })
  }

  /** Main-process native player only; never return this path over IPC. */
  async verifiedAssetPath(scope: VideoScope, taskId: string, jobId: string, outputId: string): Promise<string> {
    return this.locked(scope, async () => {
      const asset = await this.asset(scope, taskId, jobId, outputId)
      if (asset?.status !== 'SAVED' || asset.output.byteLength > MAX_VIDEO_BYTES) throw new VideoPersistenceError('Video asset is missing or oversized.')
      return this.assetFile(scope, asset)
    })
  }

  async saveOutput(scope: VideoScope, taskId: string, jobId: string, value: VideoOutput, stream: AsyncIterable<Uint8Array>, signal: AbortSignal): Promise<LocalVideoAsset> {
    const output = videoOutputSchema.parse(value)
    const id = this.assetId(jobId, output.outputId)
    return this.locked(scope, async () => {
      signal.throwIfAborted()
      const job = await this.job(scope, taskId, jobId)
      if (!job?.receipt || !job.receipt.outputs.some(item => isDeepStrictEqual(item, output))) throw new VideoPersistenceError('Video output is not authorized by original receipt.')
      const existing = await this.asset(scope, taskId, jobId, output.outputId)
      if (existing?.status === 'SAVED') return existing as LocalVideoAsset
      const file = this.file(scope, taskId, 'files', id, `.${videoOutputExtension(output.mimeType)}`)
      if (!existing && await this.files.exists(file)) throw new VideoPersistenceError('Orphaned video output requires commit evidence.')
      const asset: LocalVideoAsset = existing ? { ...existing, status: 'SAVED' } : {
        version: 1, scope: { ...scope }, taskId, jobId, localAssetId: id, receiptId: job.receipt.receiptId, output,
        relativePath: `files/${id}.${videoOutputExtension(output.mimeType)}`, status: 'SAVED', createdAt: Date.now(),
      }
      const manifest = this.file(scope, taskId, 'assets', id)
      const part = `${file}.${randomUUID()}.part`
      try {
        await this.files.stream(part, stream, output, signal)
        await this.files.verify(part, output)
        signal.throwIfAborted()
        await this.files.writeJson(`${manifest}.commit`, asset)
        signal.throwIfAborted()
        await this.files.publish(part, file)
        await this.files.writeJson(manifest, asset)
        return structuredClone(asset)
      } finally { await rm(part, { force: true }) }
    })
  }
}
