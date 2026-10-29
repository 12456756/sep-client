import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, rename, rm } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { employeeRuntimeSnapshotSchema } from '../common/platform/employee-runtime-contract'
import { imageMimeSchema, mediaCapabilitiesSchema, mediaGenerationInputSchema, mediaId, mediaOutputErrorsSchema, mediaOutputSchema, mediaParametersSchema, mediaProfileSchema, mediaQuoteSchema, mediaRecoverySchema } from '../common/platform/media-contract'
import { imageRequestedSpecSchema, mediaParameterSourcesSchema } from '../../src/shared/media-spec-contract'
import type { LocalMediaAsset, LocalMediaJob, MediaOutput, MediaRunSnapshot, MediaStorePort } from '../domain/media'
import { writeJsonAtomic } from './atomic-file'
import { inspectMediaImage, MAX_MEDIA_BYTES, MAX_MEDIA_DIMENSION, MAX_MEDIA_PIXELS } from './media-image'
import { isSafeId, ScopePath, TaskScopeError, type TaskOwnerScope } from './scope-path'
import { WriteChain } from './write-chain'

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/)
const timestamp = z.number().int().nonnegative()
const opaqueId = z.string().min(1).max(256)
const ownerSchema = z.object({ memberId: z.string().min(1).max(256), enterpriseId: z.string().min(1).max(256) }).strict()
const generationSchema = z.enum(['SUBMITTING', 'QUEUED', 'RUNNING', 'SUBMISSION_UNKNOWN', 'SUCCEEDED', 'PARTIAL_SUCCEEDED', 'FAILED', 'CANCELLED', 'RESULT_EXPIRED'])
const saveSchema = z.enum(['PENDING', 'SAVING', 'SAVED', 'SAVE_FAILED', 'MISSING'])
const requestSchema = z.object({
  clientRequestId: mediaId, requestHash: hashSchema, quoteId: opaqueId, profileId: opaqueId, configVersion: opaqueId,
  operation: z.enum(['generate', 'edit']), referenceIds: z.array(opaqueId).max(16), referenceHashes: z.array(hashSchema).max(16),
  creativeBrief: z.string().min(1).max(20_000), parameters: z.union([mediaParametersSchema, imageRequestedSpecSchema]),
  protocolVersion: z.literal(3).optional(), requestedSpec: imageRequestedSpecSchema.optional(),
  parameterSources: mediaParameterSourcesSchema.optional(), specRevision: z.number().int().positive().optional(),
}).strict()
const jobSchema = z.object({
  version: z.literal(1), owner: ownerSchema, jobId: mediaId, taskId: mediaId, runId: mediaId, subscriptionId: opaqueId,
  clientRequestId: mediaId, requestHash: hashSchema, input: mediaGenerationInputSchema, profile: mediaProfileSchema,
  request: requestSchema, quote: mediaQuoteSchema, approval: z.enum(['manual', 'automatic']), receiptId: opaqueId.nullable(),
  submission: z.enum(['NOT_SENT', 'MAYBE_SENT', 'RECEIPTED']), generationStatus: generationSchema,
  trackingStatus: z.enum(['ACTIVE', 'INTERRUPTED', 'AUTH_REQUIRED', 'STOPPED']), saveStatus: saveSchema,
  outputs: z.array(mediaOutputSchema), actualSpec: imageRequestedSpecSchema.optional(), billingStatus: z.string().min(1).max(64), nextPollAt: timestamp,
  lastQueriedAt: timestamp.optional(),
  providerWaitMs: timestamp.optional(), downloadMs: timestamp.optional(),
  recovery: mediaRecoverySchema.optional(), errorCode: mediaId.nullable().optional(), outputErrors: mediaOutputErrorsSchema.optional(),
  attempts: z.number().int().nonnegative(), error: z.string().max(20_000).nullable(), createdAt: timestamp, updatedAt: timestamp,
}).strict().superRefine((job, context) => {
  const { request, input, profile, quote } = job
  if (request.clientRequestId !== job.clientRequestId || request.requestHash !== job.requestHash || quote.requestHash !== job.requestHash ||
    request.quoteId !== quote.quoteId || request.profileId !== profile.profileId || input.profileId !== profile.profileId ||
    request.configVersion !== profile.configVersion || request.operation !== input.operation || request.creativeBrief !== input.creativeBrief ||
    !isDeepStrictEqual(request.parameters, input.parameters) || request.referenceIds.length !== request.referenceHashes.length ||
    request.protocolVersion !== input.protocolVersion || request.specRevision !== input.specRevision ||
    !isDeepStrictEqual(request.requestedSpec, input.requestedSpec) || !isDeepStrictEqual(request.parameterSources, input.parameterSources) ||
    request.referenceIds.length !== input.localAssetIds.length || !profile.operations.includes(input.operation) ||
    job.updatedAt < job.createdAt || (job.submission === 'RECEIPTED') !== (job.receiptId !== null) ||
    new Set(job.outputs.map(output => output.outputId)).size !== job.outputs.length) {
    context.addIssue({ code: 'custom', message: 'Inconsistent media job identity or state.' })
  }
})
const assetSchema = z.object({
  version: z.literal(1), owner: ownerSchema, localAssetId: mediaId, taskId: mediaId, jobId: mediaId.nullable(),
  outputId: opaqueId.nullable(), source: z.enum(['reference', 'output']), mime: imageMimeSchema,
  size: z.number().int().positive().max(MAX_MEDIA_BYTES), width: z.number().int().positive().max(MAX_MEDIA_DIMENSION),
  height: z.number().int().positive().max(MAX_MEDIA_DIMENSION), status: z.literal('SAVED'), relativePath: z.string().min(1).max(256),
  sha256: hashSchema, createdAt: timestamp,
  derivedFrom: z.object({ localAssetId: mediaId, jobId: mediaId, outputId: opaqueId, sha256: hashSchema }).strict().optional(),
}).strict().refine(asset => asset.width * asset.height <= MAX_MEDIA_PIXELS &&
  (asset.source === 'output' ? asset.jobId !== null && asset.outputId !== null && !asset.derivedFrom : asset.jobId === null && asset.outputId === null) &&
  (!asset.derivedFrom || (asset.derivedFrom.sha256 === asset.sha256 &&
    asset.derivedFrom.localAssetId === assetId('output', JSON.stringify([asset.derivedFrom.jobId, asset.derivedFrom.outputId])))), 'Invalid asset identity, derivation or dimensions.')
const snapshotSchema = z.object({
  version: z.literal(1), owner: ownerSchema, taskId: mediaId, runId: mediaId, subscriptionId: opaqueId,
  systemPrompt: z.string().max(2_000_000), skills: z.array(z.object({ path: z.string().min(1).max(4096), sha256: hashSchema, version: opaqueId }).strict()).max(256),
  capabilities: mediaCapabilitiesSchema.nullable(), createdAt: timestamp,
  runtimeSnapshot: employeeRuntimeSnapshotSchema.optional(),
}).strict().refine(snapshot => !snapshot.runtimeSnapshot || (
  snapshot.runtimeSnapshot.subscriptionId === snapshot.subscriptionId && snapshot.runtimeSnapshot.enterpriseId === snapshot.owner.enterpriseId &&
  (snapshot.runtimeSnapshot.memberId === undefined || snapshot.runtimeSnapshot.memberId === snapshot.owner.memberId) &&
  snapshot.runtimeSnapshot.systemPrompt === snapshot.systemPrompt && isDeepStrictEqual(snapshot.skills,
    snapshot.runtimeSnapshot.skills.map(skill => ({ path: skill.path, sha256: skill.sha256, version: skill.version })))
), 'Employee runtime snapshot does not match its run owner or installed skill metadata.')
const archiveSchema = z.object({ version: z.literal(1), owner: ownerSchema, taskId: mediaId, archivedAt: timestamp }).strict()
const writes = new WriteChain()
const publications = new Map<string, Set<Promise<void>>>()
let publicationRevision = 0
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024
const extensions = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' } as const

function missing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

export class MediaPersistenceError extends Error {
  constructor(message = 'Media persistence is unavailable; existing evidence has been preserved.') {
    super(message)
    this.name = 'MediaPersistenceError'
  }
}

function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function assetId(source: 'reference' | 'output', identity: string): string {
  return `${source === 'output' ? 'out' : 'ref'}_${sha256(identity)}`
}

function assertOwner(owner: TaskOwnerScope, scope: TaskOwnerScope): void {
  if (owner.memberId !== scope.memberId || owner.enterpriseId !== scope.enterpriseId) throw new TaskScopeError('Media does not belong to the active owner.')
}

/** File paths and native-dialog destinations are confined to this adapter, never services. */
export class MediaStore implements MediaStorePort {
  private readonly paths: ScopePath
  private readonly root: string

  constructor(userDataDir: string) {
    this.root = resolve(userDataDir)
    this.paths = new ScopePath(this.root)
  }

  private key(scope: TaskOwnerScope, taskId: string): string {
    mediaId.parse(taskId)
    return `${this.root}:${this.paths.scopeKey(scope)}:media`
  }

  private file(scope: TaskOwnerScope, taskId: string, kind: 'jobs' | 'assets' | 'snapshots' | 'files', id: string, suffix = '.json'): string {
    mediaId.parse(id)
    return join(this.paths.mediaRoot(scope, taskId), kind, `${id}${suffix}`)
  }

  private async assertPath(file: string, external = false): Promise<void> {
    const target = resolve(file)
    const root = external ? resolve(target, sep) : this.root
    const path = relative(root, target)
    if (path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) throw new TaskScopeError('Media path escaped its owner scope.')
    let current = root
    for (const segment of ['', ...path.split(sep).filter(Boolean)]) {
      if (segment) current = join(current, segment)
      try {
        const stat = await lstat(current)
        if (stat.isSymbolicLink() || (current !== target && !stat.isDirectory())) throw new MediaPersistenceError('Media path contains a symbolic link or invalid directory.')
      } catch (error) {
        if (!missing(error)) throw error
        break
      }
    }
  }

  private async bytes(file: string, external = false, maxBytes = MAX_MEDIA_BYTES): Promise<Buffer> {
    await this.assertPath(file, external)
    const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      const stat = await handle.stat()
      // Atomic replacement can unlink an already opened inode; its descriptor still owns valid bytes.
      if (!stat.isFile() || stat.size === 0 || stat.size > maxBytes || (!external && stat.nlink > 1)) throw new MediaPersistenceError('Invalid media file size or type.')
      const result = Buffer.alloc(stat.size)
      let offset = 0
      while (offset < result.length) {
        const { bytesRead } = await handle.read(result, offset, result.length - offset, offset)
        if (bytesRead === 0) throw new MediaPersistenceError('Media file changed during reading.')
        offset += bytesRead
      }
      const extra = Buffer.alloc(1)
      if ((await handle.read(extra, 0, 1, offset)).bytesRead !== 0) throw new MediaPersistenceError('Media file changed during reading.')
      return result
    } finally {
      await handle.close()
    }
  }

  private async publishing<T>(directory: string, operation: () => Promise<T>): Promise<T> {
    let finish!: () => void
    const settled = new Promise<void>(resolve => { finish = resolve })
    const active = publications.get(directory) ?? new Set<Promise<void>>()
    publications.set(directory, active)
    active.add(settled)
    publicationRevision++
    try { return await operation() } finally {
      active.delete(settled)
      if (active.size === 0) publications.delete(directory)
      finish()
    }
  }

  private async waitForPublication(directory: string): Promise<void> {
    for (;;) {
      const active = publications.get(directory)
      if (!active) return
      await Promise.all(active)
    }
  }

  private async names(directory: string): Promise<string[]> {
    for (;;) {
      await this.waitForPublication(directory)
      const revision = publicationRevision
      await this.assertPath(directory)
      let names: string[]
      try { names = (await readdir(directory)).sort() } catch (error) {
        if (!missing(error)) throw error
        names = []
      }
      // A writer may have started during readdir; discard that transient directory snapshot.
      if (!publications.has(directory) && revision === publicationRevision) return names
    }
  }

  private async json<T>(file: string, schema: z.ZodType<T>): Promise<T | null> {
    await this.waitForPublication(dirname(file))
    let bytes: Buffer
    try { bytes = await this.bytes(file, false, MAX_MANIFEST_BYTES) } catch (error) {
      if (!missing(error)) throw error
      const name = relative(dirname(file), file)
      const names = await this.names(dirname(file))
      if (names.includes(name)) return this.json(file, schema)
      const evidence = names.some(entry => entry === `${name}.bak` || entry.startsWith(`${name}.corrupt-`) ||
        (entry.startsWith(`${name}.`) && entry.endsWith('.tmp')))
      if (evidence) throw new MediaPersistenceError()
      return null
    }
    try { return schema.parse(JSON.parse(bytes.toString('utf8')) as unknown) } catch {
      throw new MediaPersistenceError('Invalid media manifest; existing evidence has been preserved.')
    }
  }

  private async write(file: string, value: unknown, beforePublish?: () => void): Promise<void> {
    if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_MANIFEST_BYTES) throw new MediaPersistenceError('Media manifest exceeds the supported size.')
    // Only publication is tracked, not the WriteChain operation: writers read before publishing.
    await this.publishing(dirname(file), async () => {
      await this.assertPath(file)
      await mkdir(dirname(file), { recursive: true, mode: 0o700 })
      await this.assertPath(file)
      // No stale backup rollback: a MAYBE_SENT request must never reappear as NOT_SENT.
      if (!beforePublish) {
        await writeJsonAtomic(file, value, { backup: false })
        return
      }
      const part = `${file}.${randomUUID()}.tmp`
      let created = false
      try {
        await this.assertPath(part)
        const handle = await open(part, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
        created = true
        try { await handle.writeFile(JSON.stringify(value), 'utf8'); await handle.sync() } finally { await handle.close() }
        await this.assertPath(file)
        // Authorization must be checked after staging, with no await before publication.
        beforePublish()
        await rename(part, file)
        created = false
      } finally { if (created) await rm(part, { force: true }) }
    })
  }

  async getJob(scope: TaskOwnerScope, taskId: string, jobId: string): Promise<LocalMediaJob | null> {
    const job = await this.json(this.file(scope, taskId, 'jobs', jobId), jobSchema)
    if (job) {
      assertOwner(job.owner, scope)
      if (job.taskId !== taskId || job.jobId !== jobId) throw new MediaPersistenceError('Media job identity does not match its manifest.')
    }
    return job
  }

  async listJobs(scope: TaskOwnerScope, taskId?: string): Promise<LocalMediaJob[]> {
    const taskIds = taskId === undefined ? await this.names(this.paths.tasksRoot(scope)) : [taskId]
    const jobs: LocalMediaJob[] = []
    for (const id of taskIds) {
      if (!isSafeId(id)) throw new MediaPersistenceError('Invalid task directory identity.')
      for (const name of await this.names(join(this.paths.mediaRoot(scope, id), 'jobs'))) {
        const jobId = this.manifestId(name)
        if (jobId === null) continue
        const job = await this.getJob(scope, id, jobId)
        if (job) jobs.push(job)
      }
    }
    return jobs.sort((a, b) => a.createdAt - b.createdAt || a.jobId.localeCompare(b.jobId))
  }

  private manifestId(name: string): string | null {
    if (name.endsWith('.tmp')) {
      if (/^([A-Za-z0-9_-]{1,128})\.json\.[A-Za-z0-9_-]+\.tmp$/.test(name)) throw new MediaPersistenceError()
      if (/\.json\.commit\.[A-Za-z0-9_-]+\.tmp$/.test(name)) throw new MediaPersistenceError('Incomplete media commit evidence requires recovery.')
      throw new MediaPersistenceError('Unexpected media temporary manifest evidence.')
    }
    const id = name.replace(/\.json(?:\.bak|\.corrupt-.*)?$/, '')
    if (!isSafeId(id) || id === name) throw new MediaPersistenceError('Unexpected media manifest evidence.')
    return id
  }

  async saveJob(scope: TaskOwnerScope, value: LocalMediaJob): Promise<void> {
    const job = jobSchema.parse(value)
    assertOwner(job.owner, scope)
    const file = this.file(scope, job.taskId, 'jobs', job.jobId)
    await writes.run(this.key(scope, job.taskId), async () => {
      const previous = await this.getJob(scope, job.taskId, job.jobId)
      if (previous) {
        const stable = ['owner', 'jobId', 'taskId', 'runId', 'subscriptionId', 'clientRequestId', 'requestHash', 'input', 'profile', 'request', 'quote', 'approval', 'createdAt'] as const
        if (stable.some(key => !isDeepStrictEqual(previous[key], job[key])) || job.updatedAt < previous.updatedAt ||
          ['NOT_SENT', 'MAYBE_SENT', 'RECEIPTED'].indexOf(job.submission) < ['NOT_SENT', 'MAYBE_SENT', 'RECEIPTED'].indexOf(previous.submission) ||
          (previous.receiptId !== null && previous.receiptId !== job.receiptId)) throw new MediaPersistenceError('Stable media request identity or submission state cannot change.')
        const terminal = ['SUCCEEDED', 'PARTIAL_SUCCEEDED', 'FAILED', 'CANCELLED', 'RESULT_EXPIRED']
        if (terminal.includes(previous.generationStatus) && job.generationStatus !== previous.generationStatus &&
          !(job.generationStatus === 'RESULT_EXPIRED' && ['SUCCEEDED', 'PARTIAL_SUCCEEDED'].includes(previous.generationStatus))) {
          throw new MediaPersistenceError('Terminal media generation state cannot regress.')
        }
        if ((previous.generationStatus === 'RUNNING' && ['QUEUED', 'SUBMITTING', 'SUBMISSION_UNKNOWN'].includes(job.generationStatus)) ||
          (previous.generationStatus === 'QUEUED' && ['SUBMITTING', 'SUBMISSION_UNKNOWN'].includes(job.generationStatus))) throw new MediaPersistenceError('Media generation state cannot regress.')
        for (const output of previous.outputs) {
          const next = job.outputs.find(item => item.outputId === output.outputId)
          if (!next || output.mime !== next.mime || ['sha256', 'size', 'width', 'height'].some(key => {
            const field = key as 'sha256' | 'size' | 'width' | 'height'
            return output[field] != null && output[field] !== next[field]
          })) throw new MediaPersistenceError('Existing media output identity cannot change.')
        }
      } else {
        if ((await this.listJobs(scope)).some(item => item.clientRequestId === job.clientRequestId)) throw new MediaPersistenceError('Media request ID is already assigned.')
      }
      await this.write(file, job)
    })
  }

  private assetFile(scope: TaskOwnerScope, asset: LocalMediaAsset): string {
    const expected = `files/${asset.localAssetId}.${extensions[asset.mime]}`
    if (asset.relativePath !== expected) throw new MediaPersistenceError('Media asset path does not match its identity.')
    return this.file(scope, asset.taskId, 'files', asset.localAssetId, `.${extensions[asset.mime]}`)
  }

  private async assetRecord(scope: TaskOwnerScope, taskId: string, id: string): Promise<LocalMediaAsset | null> {
    const file = this.file(scope, taskId, 'assets', id)
    const primary = await this.json(file, assetSchema)
    const commit = await this.json(`${file}.commit`, assetSchema)
    if (primary && commit && !isDeepStrictEqual(primary, commit)) throw new MediaPersistenceError('Media asset commit and manifest disagree.')
    const asset = primary ?? commit
    if (asset) {
      assertOwner(asset.owner, scope)
      if (asset.taskId !== taskId || asset.localAssetId !== id || id !== (asset.source === 'output'
        ? assetId('output', JSON.stringify([asset.jobId, asset.outputId])) : assetId('reference', asset.sha256))) throw new MediaPersistenceError('Media asset identity does not match its manifest.')
      this.assetFile(scope, asset)
    }
    return asset
  }

  private async verifiedBytes(scope: TaskOwnerScope, asset: LocalMediaAsset): Promise<Buffer> {
    const bytes = await this.bytes(this.assetFile(scope, asset))
    const image = inspectMediaImage(bytes)
    if (sha256(bytes) !== asset.sha256 || image.mime !== asset.mime || image.size !== asset.size || image.width !== asset.width || image.height !== asset.height) {
      throw new MediaPersistenceError('Media asset content no longer matches its manifest.')
    }
    return bytes
  }

  async getAsset(scope: TaskOwnerScope, taskId: string, id: string): Promise<LocalMediaAsset | null> {
    const asset = await this.assetRecord(scope, taskId, id)
    if (!asset) return null
    try { await this.verifiedBytes(scope, asset) } catch (error) {
      if (missing(error)) return { ...asset, status: 'MISSING' }
      throw error
    }
    return asset
  }

  async listAssets(scope: TaskOwnerScope, taskId: string): Promise<LocalMediaAsset[]> {
    const ids = new Set<string>()
    for (const name of await this.names(join(this.paths.mediaRoot(scope, taskId), 'assets'))) {
      const id = this.manifestId(name.endsWith('.commit') ? name.slice(0, -7) : name)
      if (id) ids.add(id)
    }
    const assets: LocalMediaAsset[] = []
    for (const id of ids) {
      const asset = await this.getAsset(scope, taskId, id)
      if (asset) assets.push(asset)
    }
    return assets.sort((a, b) => a.createdAt - b.createdAt || a.localAssetId.localeCompare(b.localAssetId))
  }

  async readAsset(scope: TaskOwnerScope, taskId: string, id: string): Promise<Uint8Array> {
    const asset = await this.assetRecord(scope, taskId, id)
    if (!asset) throw new MediaPersistenceError('Media asset does not exist.')
    return this.verifiedBytes(scope, asset)
  }

  async importReference(scope: TaskOwnerScope, taskId: string, selectedPath: string, signal: AbortSignal = new AbortController().signal, validate?: () => void): Promise<LocalMediaAsset> {
    signal.throwIfAborted()
    validate?.()
    this.paths.mediaRoot(scope, taskId)
    if (!isAbsolute(selectedPath)) throw new MediaPersistenceError('A native absolute selection path is required.')
    const bytes = await this.bytes(selectedPath, true)
    signal.throwIfAborted()
    validate?.()
    return this.saveReference(scope, taskId, bytes, signal, validate)
  }

  async deriveReferenceFromOutput(scope: TaskOwnerScope, taskId: string, id: string, signal: AbortSignal, validate?: () => void): Promise<LocalMediaAsset> {
    signal.throwIfAborted()
    validate?.()
    const source = await this.assetRecord(scope, taskId, id)
    if (!source || source.source !== 'output' || !source.jobId || !source.outputId) {
      throw new MediaPersistenceError('A saved task-owned image output is required.')
    }
    const bytes = await this.verifiedBytes(scope, source)
    const job = await this.getJob(scope, taskId, source.jobId)
    const output = job?.outputs.find(item => item.outputId === source.outputId)
    if (!output) throw new MediaPersistenceError('Source output is not authorized by its original media job.')
    this.validateOutput(output, source)
    signal.throwIfAborted()
    validate?.()
    return this.saveReference(scope, taskId, bytes, signal, validate, {
      localAssetId: source.localAssetId, jobId: source.jobId, outputId: source.outputId, sha256: source.sha256,
    })
  }

  private async saveReference(scope: TaskOwnerScope, taskId: string, bytes: Buffer, signal: AbortSignal, validate?: () => void, derivedFrom?: LocalMediaAsset['derivedFrom']): Promise<LocalMediaAsset> {
    const image = inspectMediaImage(bytes)
    const hash = sha256(bytes)
    const id = assetId('reference', hash)
    return writes.run(this.key(scope, taskId), async () => {
      signal.throwIfAborted()
      validate?.()
      const existing = await this.assetRecord(scope, taskId, id)
      if (existing) {
        if (!isDeepStrictEqual(existing, { ...existing, ...image, sha256: hash })) {
          throw new MediaPersistenceError('Recovered reference differs from its original commit.')
        }
        try { await this.verifiedBytes(scope, existing) } catch (error) {
          if (!missing(error)) throw error
          return this.persistAsset(scope, existing, (async function* () { yield bytes })(), signal, validate)
        }
        signal.throwIfAborted()
        validate?.()
        await this.write(this.file(scope, taskId, 'assets', id), existing, () => { signal.throwIfAborted(); validate?.(); signal.throwIfAborted() })
        return existing
      }
      const file = this.file(scope, taskId, 'files', id, `.${extensions[image.mime]}`)
      try { await this.bytes(file); throw new MediaPersistenceError('Orphaned media reference requires its commit evidence.') } catch (error) { if (!missing(error)) throw error }
      const asset: LocalMediaAsset = { ...image, version: 1, owner: { ...scope }, taskId, localAssetId: id, jobId: null, outputId: null,
        source: 'reference', status: 'SAVED', sha256: hash, relativePath: `files/${id}.${extensions[image.mime]}`, createdAt: Date.now() }
      if (derivedFrom) asset.derivedFrom = derivedFrom
      return this.persistAsset(scope, asset, (async function* () { yield bytes })(), signal, validate)
    })
  }

  async saveOutput(scope: TaskOwnerScope, taskId: string, jobId: string, value: MediaOutput, stream: AsyncIterable<Uint8Array>, signal: AbortSignal): Promise<LocalMediaAsset> {
    const output = mediaOutputSchema.parse(value)
    const id = assetId('output', JSON.stringify([jobId, output.outputId]))
    this.file(scope, taskId, 'jobs', jobId)
    return writes.run(this.key(scope, taskId), async () => {
      signal.throwIfAborted()
      const job = await this.getJob(scope, taskId, jobId)
      if (!job || !job.outputs.some(item => isDeepStrictEqual(item, output))) throw new MediaPersistenceError('Output is not authorized by the stored media job.')
      const existing = await this.assetRecord(scope, taskId, id)
      if (existing) {
        this.validateOutput(output, existing)
        try {
          await this.verifiedBytes(scope, existing)
          await this.write(this.file(scope, taskId, 'assets', id), existing)
          return existing
        } catch (error) { if (!missing(error)) throw error }
      }
      const file = this.file(scope, taskId, 'files', id, `.${extensions[output.mime]}`)
      // Even loss of both metadata files must not overwrite an orphaned final image.
      if (!existing) {
        try { await this.bytes(file); throw new MediaPersistenceError('Orphaned media output requires its commit evidence.') } catch (error) { if (!missing(error)) throw error }
      }
      const part = `${file}.${randomUUID()}.part`
      let asset: LocalMediaAsset
      try {
        const hash = await this.streamPart(part, stream, signal)
        const bytes = await this.bytes(part)
        if (sha256(bytes) !== hash) throw new MediaPersistenceError('Media output changed during saving.')
        const image = inspectMediaImage(bytes)
        asset = { ...image, version: 1, owner: { ...scope }, taskId, localAssetId: id, jobId, outputId: output.outputId,
          source: 'output', status: 'SAVED', sha256: hash, relativePath: `files/${id}.${extensions[image.mime]}`, createdAt: existing?.createdAt ?? Date.now() }
        this.validateOutput(output, asset)
        if (existing && !isDeepStrictEqual(existing, asset)) throw new MediaPersistenceError('Recovered output differs from its original commit.')
        signal.throwIfAborted()
        const manifest = this.file(scope, taskId, 'assets', id)
        await this.publishing(dirname(manifest), async () => {
          await this.write(`${manifest}.commit`, asset)
          signal.throwIfAborted()
          await this.assertPath(file)
          await rename(part, file)
          await this.write(manifest, asset)
        })
        return asset
      } finally { await rm(part, { force: true }) }
    })
  }

  private validateOutput(output: MediaOutput, asset: LocalMediaAsset): void {
    if (output.mime !== asset.mime || (output.sha256 !== undefined && output.sha256 !== asset.sha256) ||
      (output.size !== null && output.size !== asset.size) || (output.width !== null && output.width !== asset.width) ||
      (output.height !== null && output.height !== asset.height)) throw new MediaPersistenceError('Media output hash, type, size or dimensions do not match the receipt.')
  }

  private async streamPart(part: string, stream: AsyncIterable<Uint8Array>, signal: AbortSignal): Promise<string> {
    await this.assertPath(part)
    await mkdir(dirname(part), { recursive: true, mode: 0o700 })
    await this.assertPath(part)
    const handle = await open(part, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
    const hash = createHash('sha256')
    let size = 0
    const iterator = stream[Symbol.asyncIterator]()
    let complete = false
    try {
      while (true) {
        signal.throwIfAborted()
        const next = await this.abortable(iterator.next(), signal)
        if (next.done) { complete = true; break }
        const chunk = next.value
        signal.throwIfAborted()
        if (!(chunk instanceof Uint8Array)) throw new MediaPersistenceError('Invalid media stream chunk.')
        size += chunk.byteLength
        if (size > MAX_MEDIA_BYTES) throw new MediaPersistenceError('Media stream exceeds the 32 MB limit.')
        // Snapshot chunks: producer-owned buffers must not change between hashing and writing.
        const bytes = Buffer.from(chunk)
        hash.update(bytes)
        let offset = 0
        while (offset < bytes.length) {
          const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset)
          if (!bytesWritten) throw new MediaPersistenceError('Media output write made no progress.')
          offset += bytesWritten
        }
      }
      signal.throwIfAborted()
      await handle.sync()
      return hash.digest('hex')
    } finally {
      await handle.close()
      if (!complete && iterator.return) void iterator.return().catch(() => undefined)
    }
  }

  private async abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
    let onAbort = (): void => undefined
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(signal.reason ?? new Error('Media transfer aborted.'))
      signal.addEventListener('abort', onAbort, { once: true })
      if (signal.aborted) onAbort()
    })
    try { return await Promise.race([operation, aborted]) } finally { signal.removeEventListener('abort', onAbort) }
  }

  private async persistAsset(scope: TaskOwnerScope, asset: LocalMediaAsset, stream: AsyncIterable<Uint8Array>, signal: AbortSignal, validate?: () => void): Promise<LocalMediaAsset> {
    const file = this.assetFile(scope, asset)
    const part = `${file}.${randomUUID()}.part`
    const beforePublish = (): void => { signal.throwIfAborted(); validate?.(); signal.throwIfAborted() }
    try {
      const hash = await this.streamPart(part, stream, signal)
      if (hash !== asset.sha256) throw new MediaPersistenceError('Reference image changed during copying.')
      const manifest = this.file(scope, asset.taskId, 'assets', asset.localAssetId)
      const commit = await this.json(`${manifest}.commit`, assetSchema)
      if (commit && !isDeepStrictEqual(commit, asset)) throw new MediaPersistenceError('Recovered reference differs from its original commit.')
      await this.publishing(dirname(manifest), async () => {
        signal.throwIfAborted()
        validate?.()
        if (!commit) await this.write(`${manifest}.commit`, asset, beforePublish)
        await this.assertPath(file)
        signal.throwIfAborted()
        validate?.()
        await rename(part, file)
        await this.write(manifest, asset, beforePublish)
      })
      return asset
    } finally { await rm(part, { force: true }) }
  }

  async exportAsset(scope: TaskOwnerScope, taskId: string, id: string, selectedPath: string): Promise<void> {
    if (!isAbsolute(selectedPath)) throw new MediaPersistenceError('A native absolute save path is required.')
    const bytes = await this.readAsset(scope, taskId, id)
    await this.assertPath(selectedPath, true)
    const destination = resolve(selectedPath)
    const relativeDestination = relative(this.root, destination)
    if (relativeDestination === '' || (!relativeDestination.startsWith(`..${sep}`) && relativeDestination !== '..' && !isAbsolute(relativeDestination))) {
      throw new MediaPersistenceError('Media exports must not overwrite application persistence.')
    }
    const part = `${destination}.${randomUUID()}.part`
    try {
      await this.assertPath(part, true)
      const handle = await open(part, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
      try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
      await this.assertPath(destination, true)
      await rename(part, destination)
    } finally { await rm(part, { force: true }) }
  }

  async saveSnapshot(scope: TaskOwnerScope, value: MediaRunSnapshot): Promise<void> {
    const snapshot = snapshotSchema.parse(value)
    if (snapshot.runtimeSnapshot === undefined) delete snapshot.runtimeSnapshot
    assertOwner(snapshot.owner, scope)
    const file = this.file(scope, snapshot.taskId, 'snapshots', snapshot.runId)
    await writes.run(this.key(scope, snapshot.taskId), async () => {
      const existing = await this.getSnapshot(scope, snapshot.taskId, snapshot.runId)
      if (existing && !isDeepStrictEqual(existing, snapshot)) throw new MediaPersistenceError('Media run snapshots are immutable.')
      if (!existing) await this.write(file, snapshot)
    })
  }

  async getSnapshot(scope: TaskOwnerScope, taskId: string, runId?: string): Promise<MediaRunSnapshot | null> {
    if (runId === undefined) {
      const snapshots: MediaRunSnapshot[] = []
      for (const name of await this.names(join(this.paths.mediaRoot(scope, taskId), 'snapshots'))) {
        const id = this.manifestId(name)
        if (id) {
          const snapshot = await this.getSnapshot(scope, taskId, id)
          if (snapshot) snapshots.push(snapshot)
        }
      }
      return snapshots.sort((a, b) => b.createdAt - a.createdAt || b.runId.localeCompare(a.runId))[0] ?? null
    }
    const snapshot = await this.json(this.file(scope, taskId, 'snapshots', runId), snapshotSchema)
    if (snapshot) {
      assertOwner(snapshot.owner, scope)
      if (snapshot.taskId !== taskId || snapshot.runId !== runId) throw new MediaPersistenceError('Media snapshot identity does not match its manifest.')
    }
    return snapshot
  }

  async archive(scope: TaskOwnerScope, taskId: string): Promise<void> {
    const file = join(this.paths.mediaRoot(scope, taskId), 'archive.json')
    await writes.run(this.key(scope, taskId), async () => {
      if (!await this.isArchived(scope, taskId)) await this.write(file, { version: 1, owner: { ...scope }, taskId, archivedAt: Date.now() })
    })
  }

  async isArchived(scope: TaskOwnerScope, taskId: string): Promise<boolean> {
    const archive = await this.json(join(this.paths.mediaRoot(scope, taskId), 'archive.json'), archiveSchema)
    if (!archive) return false
    assertOwner(archive.owner, scope)
    if (archive.taskId !== taskId) throw new MediaPersistenceError('Media archive identity does not match its manifest.')
    return true
  }
}
