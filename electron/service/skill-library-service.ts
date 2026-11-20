import { createHash } from 'node:crypto'
import { z } from 'zod'
import { AuthApiError, SkillSubmissionResponseError, type PersonalSkillVersionRequest, type SkillVersion } from '../common/platform/platform-api'
import { skillVersionSchema } from '../../src/shared/platform-supplement-contracts'
import { canUseSkillVersion } from '../common/platform/skill-version-policy'
import { logger } from '../common/logger'
import { AppError } from '../errors/app-error'
import { requireScope, type ScopeSource } from './scope-guard'
import type { TaskOwnerScope } from '../data/scope-path'
import type { SkillVersionStore } from '../data/skill-version-store'
import type { SkillSubmissionStore } from '../data/skill-submission-store'
import type { LocalSkillSubmission, SaveSkillInput, SaveSkillResult, SkillLibraryItem, SkillLibraryQuery, SkillLibrarySnapshot } from '../../src/shared/skill-library'
import { FOLLOW_PLATFORM_SKILL_VERSION, hasPersonalSkillVersionName, SKILL_VERSION_NAME_TAKEN } from '../../src/shared/skill-library'
import { skillRewriteInputSchema, skillRewriteOutputSchema, splitSkillRewriteSource, type SkillRewriteInput, type SkillRewriteResult } from '../../src/shared/skill-rewrite'
import type { SkillRewritePort } from '../domain/skill-rewrite'
import type { AttachmentService } from './attachment-service'

interface SkillPlatform {
  skills(employeeId: string, token: string): Promise<unknown>
  list(input: { capabilityId: string }, token: string, signal?: AbortSignal): Promise<SkillVersion[]>
  preview(versionId: string, token: string): Promise<{ content: string }>
  create(input: PersonalSkillVersionRequest, key: string, token: string): Promise<SkillVersion>
}
interface Options {
  scope: ScopeSource
  token(): Promise<string>
  subscriptions(): Promise<{ subscriptionId: string; employeeId: string }[]>
  versions: SkillVersionStore
  submissions: SkillSubmissionStore
  platform: SkillPlatform
  rewriter?: SkillRewritePort
  attachments?: Pick<AttachmentService, 'referenceMaterials'>
  authorizeRewriteModel?: (modelId: string) => Promise<{ subscriptionId: string } | null>
  now?: () => number
}
const log = logger.child('skill-library')
const CACHE_TTL_MS = 120_000
const MANUAL_REFRESH_INTERVAL_MS = 5_000
const DEFAULT_RETRY_AFTER_MS = 30_000
const libraryIdSchema = z.string().min(1).refine(id => id.trim().length > 0)
const libraryVersionSchema = skillVersionSchema.extend({ id: libraryIdSchema, capabilityId: libraryIdSchema })
const libraryEntrySchema = z.object({
  capability: z.object({ id: libraryIdSchema, name: z.string(), description: z.string(), type: z.string() }),
  currentVersion: libraryVersionSchema.nullable(),
  versions: z.array(libraryVersionSchema),
}).refine(skill => [skill.currentVersion, ...skill.versions].every(version => !version || version.capabilityId === skill.capability.id), {
  path: ['versions'], message: 'Skill version capability mismatch',
})
const libraryCatalogSchema = z.object({ subscriptionId: z.string().min(1), skills: z.array(z.unknown()) })
type Catalog = { subscription: { subscriptionId: string; employeeId: string }; skills: unknown[] }
interface LibrarySession {
  scope: TaskOwnerScope
  snapshot: SkillLibrarySnapshot
  catalogs: Map<string, Catalog>
  pending: Set<string> | null
  blockedUntil: number
  manualAt: Map<string, number>
  inFlight: Map<string, Promise<SkillLibrarySnapshot>>
  queue: Promise<unknown>
  denied: boolean
}

/** Drain current requests before exposing a failure; never keep starting work after one fails. */
async function loadBounded<T, R>(items: T[], load: (item: T) => Promise<R>): Promise<R[]> {
  const result = new Array<R>(items.length)
  let next = 0
  let failure: { error: unknown } | undefined
  await Promise.all(Array.from({ length: Math.min(4, items.length) }, async () => {
    while (!failure && next < items.length) {
      const index = next++
      try { result[index] = await load(items[index]) } catch (error) { failure ??= { error } }
    }
  }))
  if (failure) throw failure.error
  return result
}

export class SkillLibraryService {
  private readonly rewrites = new Map<string, { scope: TaskOwnerScope; controller: AbortController }>()
  private session: LibrarySession | null = null
  constructor(private readonly options: Options) {}

  private now(): number { return this.options.now?.() ?? Date.now() }

  private current(): LibrarySession {
    const scope = requireScope(this.options.scope)
    if (!this.session || this.session.scope.memberId !== scope.memberId || this.session.scope.enterpriseId !== scope.enterpriseId) {
      this.session = { scope: { ...scope }, snapshot: { items: [], skippedCount: 0 }, catalogs: new Map(), pending: null,
        blockedUntil: 0, manualAt: new Map(), inFlight: new Map(), queue: Promise.resolve(), denied: false }
    }
    return this.session
  }

  private checkScope(scope: TaskOwnerScope): void {
    const current = requireScope(this.options.scope)
    if (this.session?.scope !== scope || current.memberId !== scope.memberId || current.enterpriseId !== scope.enterpriseId) throw new AppError('INVALID_STATE', { message: '登录身份已变化，请重新打开技能。' })
  }

  private async request<T>(scope: TaskOwnerScope, action: () => Promise<T>, invalidateAuthorization = true): Promise<T> {
    this.checkScope(scope)
    const session = this.session!
    if (session.blockedUntil > this.now()) throw new AuthApiError({ statusCode: 429, message: 'Skill service cooling down', retryAfterMs: session.blockedUntil - this.now() }, 'skills')
    try {
      const result = await action()
      this.checkScope(scope)
      return result
    } catch (error) {
      this.checkScope(scope)
      if (error instanceof AuthApiError && error.statusCode === 429) {
        const delay = error.error.retryAfterMs
        session.blockedUntil = Math.max(session.blockedUntil, this.now() + (delay && Number.isFinite(delay) && delay > 0 ? delay : DEFAULT_RETRY_AFTER_MS))
      }
      if (invalidateAuthorization && error instanceof AuthApiError && (error.isUnauthorized || error.isForbidden)) {
        session.denied = true
        session.catalogs.clear()
        session.snapshot = { items: [], skippedCount: 0 }
        session.pending = null
      }
      throw error
    }
  }

  cached(): SkillLibrarySnapshot {
    const session = this.current()
    return { ...session.snapshot, ...(session.blockedUntil > this.now() ? { retryAt: session.blockedUntil } : {}) }
  }

  async list(): Promise<SkillLibraryItem[]> {
    return (await this.listWithDiagnostics()).items
  }

  async listWithDiagnostics(query?: SkillLibraryQuery): Promise<SkillLibrarySnapshot> {
    const session = this.current()
    if (query?.mode === 'cache') return this.cached()
    const live = query?.mode === undefined
    const key = (live ? 'live:' : '') + (query?.capabilityId ?? '*')
    const existing = session.inFlight.get(key) ?? (!live ? session.inFlight.get('*') : undefined)
    if (existing) return existing
    const promise = session.queue.catch(() => undefined).then(async () => {
      this.checkScope(session.scope)
      if (session.blockedUntil > this.now()) return this.request(session.scope, async () => session.snapshot)
      const age = this.now() - (session.snapshot.updatedAt ?? -Infinity)
      if (!query?.capabilityId && query?.mode === 'auto' && age < CACHE_TTL_MS && !session.pending) return session.snapshot
      if (query?.mode === 'manual' && this.now() - (session.manualAt.get(key) ?? -Infinity) < MANUAL_REFRESH_INTERVAL_MS && !session.pending) return session.snapshot
      session.denied = false
      try {
        const result = await this.loadLibrary(session.scope, query?.capabilityId)
        if (query?.mode === 'manual') session.manualAt.set(key, this.now())
        return result
      } catch (error) {
        this.checkScope(session.scope)
        // Keep completed catalogs for display and resume only unfinished reads.
        if (session.denied) {
          session.catalogs.clear()
          session.snapshot = { items: [], skippedCount: 0 }
          session.pending = null
        } else {
          const partial = await this.buildLibrary(session.scope, [...session.catalogs.values()])
          this.checkScope(session.scope)
          session.snapshot = { ...partial, updatedAt: session.snapshot.updatedAt }
        }
        throw error
      }
    })
    session.queue = promise
    session.inFlight.set(key, promise)
    try { return await promise } finally { if (session.inFlight.get(key) === promise) session.inFlight.delete(key) }
  }

  private async loadLibrary(scope: TaskOwnerScope, capabilityId?: string): Promise<SkillLibrarySnapshot> {
    this.checkScope(scope)
    const session = this.session!
    const token = await this.options.token()
    const subscriptions = await this.request(scope, () => this.options.subscriptions())
    const active = new Set(subscriptions.map(item => item.subscriptionId))
    for (const [id, catalog] of session.catalogs) if (!active.has(id) || !subscriptions.some(item => item.subscriptionId === id && item.employeeId === catalog.subscription.employeeId)) session.catalogs.delete(id)
    const bindings = capabilityId ? session.snapshot.items.find(item => item.capability.id === capabilityId)?.bindings : undefined
    const targets = capabilityId && bindings ? subscriptions.filter(item => bindings.some(binding => binding.subscriptionId === item.subscriptionId) || !session.catalogs.has(item.subscriptionId)) : subscriptions
    if (!capabilityId) session.pending ??= new Set(subscriptions.map(item => item.subscriptionId))
    for (const item of subscriptions) if (!session.catalogs.has(item.subscriptionId)) session.pending?.add(item.subscriptionId)
    await loadBounded(targets.filter(item => capabilityId || session.pending?.has(item.subscriptionId)), async subscription => {
      const response = libraryCatalogSchema.parse(await this.request(scope, () => this.options.platform.skills(subscription.employeeId, token)))
      if (response.subscriptionId !== subscription.subscriptionId) throw new AppError('INVALID_STATE', { message: '员工技能与订阅不匹配，请刷新技能列表；持续失败请联系平台管理员。' })
      session.catalogs.set(subscription.subscriptionId, { subscription, skills: response.skills })
      session.pending?.delete(subscription.subscriptionId)
    })
    const result = await this.buildLibrary(scope, [...session.catalogs.values()])
    this.checkScope(scope)
    session.snapshot = { ...result, updatedAt: capabilityId ? session.snapshot.updatedAt : this.now() }
    if (!capabilityId) session.pending = null
    return session.snapshot
  }

  private async buildLibrary(scope: TaskOwnerScope, catalogs: Catalog[]): Promise<SkillLibrarySnapshot> {
    this.checkScope(scope)
    const items = new Map<string, SkillLibraryItem>()
    let skippedCount = 0
    for (const { subscription, skills } of catalogs) {
      for (const [index, raw] of skills.entries()) {
        const parsed = libraryEntrySchema.safeParse(raw)
        if (!parsed.success) {
          skippedCount++
          const capability = z.object({ capability: z.object({ id: z.string() }) }).safeParse(raw)
          log.warn('skill library entry skipped', {
            employeeId: subscription.employeeId, subscriptionId: subscription.subscriptionId,
            index, capabilityId: capability.success ? capability.data.capability.id : undefined,
            issuePaths: parsed.error.issues.slice(0, 8).map(issue => issue.path.join('.')),
            issueCodes: parsed.error.issues.slice(0, 8).map(issue => issue.code),
          })
          continue
        }
        const skill = parsed.data
        const previous = items.get(skill.capability.id)
        const selected = await this.options.versions.selected(scope, subscription.subscriptionId, skill.capability.id)
        const local = selected ? await this.options.versions.load(scope, subscription.subscriptionId, skill.capability.id, selected) : null
        const personal = Boolean(local?.localSubmissionId || local?.sourceScope === 'PERSONAL' ||
          [skill.currentVersion, ...skill.versions].some(version => version?.id === local?.baseSkillVersionId && version?.scope === 'PERSONAL'))
        const versions = [...new Map([...(previous?.versions ?? []), ...(skill.currentVersion ? [skill.currentVersion] : []), ...skill.versions].map(version => [version.id, version])).values()]
        items.set(skill.capability.id, {
          capability: skill.capability, versions, usableVersionIds: [], localVersions: [],
          bindings: [...(previous?.bindings ?? []), { ...subscription, currentVersion: skill.currentVersion,
            selectionMode: personal ? 'personal' : 'follow-platform', selectedVersionId: local?.localSubmissionId ?? local?.baseSkillVersionId ?? skill.currentVersion?.id ?? null }],
        })
      }
    }
    const result = await loadBounded([...items.values()], async item => {
      this.checkScope(scope)
      const submissions = await this.options.submissions.list(scope, item.capability.id)
      const versions = [...new Map([...submissions.flatMap(record => record.uploadedVersion ? [record.uploadedVersion] : []), ...item.versions].map(version => [version.id, version])).values()]
      return {
        ...item, versions,
        bindings: item.bindings.map(binding => {
          const selected = versions.find(version => version.id === binding.selectedVersionId)
          const local = submissions.some(record => record.idempotencyKey === binding.selectedVersionId)
          return local || selected?.scope === 'PERSONAL' || binding.selectionMode === 'personal'
            ? { ...binding, selectionMode: 'personal' as const }
            : { ...binding, selectionMode: 'follow-platform' as const, selectedVersionId: binding.currentVersion?.id ?? binding.selectedVersionId }
        }),
        // Selection tracks the actual local source, not a stale upload response.
        usableVersionIds: [
          ...versions.filter(version => canUseSkillVersion(version, scope.memberId)).map(version => version.id),
          ...submissions.map(record => record.idempotencyKey),
        ],
        // A local copy remains selectable even after upload while the remote version is pending/rejected.
        localVersions: submissions,
      }
    })
    this.checkScope(scope)
    return { items: result, skippedCount }
  }

  private async authorized(capabilityId: string): Promise<{ item: SkillLibraryItem; scope: TaskOwnerScope; token: string }> {
    const scope = this.current().scope
    const item = (await this.listWithDiagnostics({ capabilityId })).items.find(value => value.capability.id === capabilityId)
    if (!item) throw new AppError('PERMISSION_DENIED', { message: '没有此技能的有效员工授权。' })
    const token = await this.options.token()
    this.checkScope(scope)
    return { item, scope, token }
  }

  async preview(input: { capabilityId: string; versionId: string }): Promise<string> {
    const owner = this.current().scope
    const local = (await this.options.submissions.list(owner, input.capabilityId)).find(value => value.idempotencyKey === input.versionId || value.uploadedVersion?.id === input.versionId)
    this.checkScope(owner)
    if (local) return local.request.content
    const { scope, token } = await this.authorized(input.capabilityId)
    const versions = await this.request(scope, () => this.options.platform.list({ capabilityId: input.capabilityId }, token))
    if (!versions.some(version => version.id === input.versionId)) throw new AppError('NOT_FOUND', { message: '技能版本不可见或已被移除。' })
    const result = await this.request(scope, () => this.options.platform.preview(input.versionId, token))
    this.checkScope(scope)
    return result.content
  }

  private async authorizeLocalSave(capabilityId: string): Promise<{ scope: TaskOwnerScope; item: SkillLibraryItem }> {
    const session = this.current()
    const scope = session.scope
    // An already-open, authorized immutable source can still be saved locally while offline.
    // This snapshot permits local editing/selection only; task authorization is checked live at execution.
    const items = session.snapshot.updatedAt !== undefined || session.snapshot.items.length
      ? session.snapshot.items : await this.list()
    const item = items.find(value => value.capability.id === capabilityId)
    if (!item) throw new AppError('PERMISSION_DENIED', { message: '没有此技能的有效员工授权。' })
    this.checkScope(scope)
    return { scope, item }
  }

  async rewrite(rawInput: SkillRewriteInput): Promise<SkillRewriteResult> {
    const input = skillRewriteInputSchema.parse(rawInput)
    const scope = this.current().scope
    if (this.rewrites.has(input.requestId)) throw new AppError('INVALID_STATE')
    if ([...this.rewrites.values()].filter(job => job.scope.memberId === scope.memberId && job.scope.enterpriseId === scope.enterpriseId).length >= 2) throw new AppError('RATE_LIMITED')
    const controller = new AbortController()
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)])
    this.rewrites.set(input.requestId, { scope: { ...scope }, controller })
    try {
      const { item } = await this.authorized(input.capabilityId)
      this.checkScope(scope)
      signal.throwIfAborted()
      if (!item.versions.some(version => version.id === input.versionId) &&
          !item.localVersions.some(version => version.idempotencyKey === input.versionId || version.uploadedVersion?.id === input.versionId)) throw new AppError('NOT_FOUND')
      const grant = await this.options.authorizeRewriteModel?.(input.modelId)
      this.checkScope(scope)
      signal.throwIfAborted()
      if (!grant) throw new AppError('MODEL_NOT_ALLOWED')
      if (!this.options.rewriter) throw new AppError('SERVICE_UNAVAILABLE')
      const { referenceFiles, ...request } = input
      if (referenceFiles && !this.options.attachments) throw new AppError('SERVICE_UNAVAILABLE')
      const referenceMaterials = referenceFiles && await this.options.attachments!.referenceMaterials(scope, referenceFiles)
      this.checkScope(scope)
      signal.throwIfAborted()
      const output = skillRewriteOutputSchema.parse(await this.options.rewriter.rewrite({ ...request, subscriptionId: grant.subscriptionId, skillName: item.capability.name, ...(referenceMaterials ? { referenceMaterials } : {}) }, signal))
      this.checkScope(scope)
      signal.throwIfAborted()
      if (splitSkillRewriteSource(output.body).metadata) throw new AppError('SKILL_REWRITE_FAILED')
      const body = output.body.replace(/\r\n?/g, '\n').replace(/\n/g, input.content.includes('\r\n') ? '\r\n' : '\n')
      const content = splitSkillRewriteSource(input.content).metadata + body
      if (content.length > 100_000) throw new AppError('SKILL_REWRITE_FAILED')
      return { requestId: input.requestId, content, summary: output.summary, changes: output.changes }
    } catch (error) {
      if (signal.aborted) throw new AppError('SKILL_REWRITE_CANCELLED')
      throw error
    } finally {
      this.rewrites.delete(input.requestId)
    }
  }

  cancelRewrite(input: { requestId: string }): void {
    const scope = requireScope(this.options.scope)
    const job = this.rewrites.get(input.requestId)
    if (job?.scope.memberId === scope.memberId && job.scope.enterpriseId === scope.enterpriseId) job.controller.abort()
  }

  cancelAllRewrites(): void {
    for (const job of this.rewrites.values()) job.controller.abort()
    this.session = null
  }

  async save(input: SaveSkillInput): Promise<SaveSkillResult> {
    const { scope, item } = await this.authorizeLocalSave(input.request.capabilityId)
    if (!item.versions.some(version => version.id === input.request.parentVersionId)) throw new AppError('INVALID_ARGUMENT', { message: '来源版本不可见或不属于该技能。' })
    this.checkScope(scope)
    const submissions = await this.options.submissions.list(scope, input.request.capabilityId)
    const existing = submissions.find(value => value.idempotencyKey === input.idempotencyKey)
    if (!existing && hasPersonalSkillVersionName({ ...item, localVersions: submissions }, input.request.changeSummary ?? '')) {
      throw new AppError('INVALID_ARGUMENT', { message: SKILL_VERSION_NAME_TAKEN })
    }
    const record: LocalSkillSubmission = { ...existing, ...input, createdAt: existing?.createdAt ?? new Date().toISOString() }
    await this.options.submissions.save(scope, record)
    const result = await this.upload(scope, record)
    this.checkScope(scope)
    await this.applySelection({ capabilityId: input.request.capabilityId, versionId: input.idempotencyKey })
    return { ...result, item: await this.updateLocalSnapshot(scope, input.request.capabilityId) }
  }

  async retry(input: { capabilityId: string; idempotencyKey: string }): Promise<SaveSkillResult> {
    const { scope } = await this.authorizeLocalSave(input.capabilityId)
    const record = (await this.options.submissions.list(scope, input.capabilityId)).find(value => value.idempotencyKey === input.idempotencyKey)
    if (!record) throw new AppError('NOT_FOUND', { message: '本地保存记录不存在。' })
    const result = await this.upload(scope, record)
    return { ...result, item: await this.updateLocalSnapshot(scope, input.capabilityId) }
  }

  private async updateLocalSnapshot(scope: TaskOwnerScope, capabilityId: string): Promise<SkillLibraryItem> {
    this.checkScope(scope)
    const session = this.session!
    const snapshot = await this.buildLibrary(scope, [...session.catalogs.values()])
    this.checkScope(scope)
    session.snapshot = { ...snapshot, updatedAt: session.snapshot.updatedAt }
    const item = snapshot.items.find(value => value.capability.id === capabilityId)
    if (!item) throw new AppError('PERMISSION_DENIED', { message: '没有此技能的有效员工授权。' })
    return item
  }

  private async upload(scope: TaskOwnerScope, record: LocalSkillSubmission): Promise<SaveSkillResult> {
    let version: SkillVersion
    let token: string
    try {
      this.checkScope(scope)
      token = await this.options.token()
      this.checkScope(scope)
      version = await this.request(scope, () => this.options.platform.create(record.request, record.idempotencyKey, token))
    } catch (error) {
      this.checkScope(scope)
      if (error instanceof SkillSubmissionResponseError) throw new AppError('INTERNAL_ERROR', {
        details: { idempotencyKey: record.idempotencyKey, capabilityId: record.request.capabilityId, phase: 'submission-response' },
      })
      if (error instanceof AuthApiError && !error.isNetworkError) throw error
      log.warn('Personal skill upload failed; durable retry retained', { errorType: error instanceof Error ? error.name : 'UnknownError' })
      return { idempotencyKey: record.idempotencyKey, uploaded: false }
    }
    this.checkScope(scope)
    await this.options.submissions.save(scope, { ...record, uploadedVersion: version })
    const session = this.session!
    if (session.scope === scope) {
      session.snapshot = { ...session.snapshot, items: session.snapshot.items.map(item => item.capability.id !== record.request.capabilityId ? item : {
        ...item, versions: [...item.versions.filter(value => value.id !== version.id), version],
      }) }
    }
    // Diagnostic confirmation must not delay the persisted upload result.
    void this.verifyUpload(scope, record, version, token)
    return { idempotencyKey: record.idempotencyKey, uploaded: true, version }
  }

  private async verifyUpload(scope: TaskOwnerScope, record: LocalSkillSubmission, version: SkillVersion, token: string): Promise<void> {
    const fields = {
      idempotencyKey: record.idempotencyKey, versionId: version.id,
      capabilityId: record.request.capabilityId, enterpriseId: scope.enterpriseId,
      phase: 'submission-verification',
    }
    try {
      this.checkScope(scope)
      const versions = await this.request(scope, () => this.options.platform.list({ capabilityId: record.request.capabilityId }, token, AbortSignal.timeout(15_000)), false)
      this.checkScope(scope)
      const submitted = versions.find(item => item.id === version.id && item.capabilityId === record.request.capabilityId)
      const result = { ...fields, found: Boolean(submitted), reviewStatus: submitted?.status ?? null, versionCount: versions.length }
      if (submitted) log.info('personal skill upload verification completed', result)
      else log.warn('personal skill upload verification completed', result)
    } catch (error) {
      log.warn('personal skill upload verification failed', {
        ...fields, statusCode: error instanceof AuthApiError ? error.statusCode : null,
        errorType: error instanceof Error ? error.name : 'UnknownError',
      })
    }
  }

  async select(input: { capabilityId: string; versionId: string }): Promise<SkillLibraryItem> {
    const scope = this.current().scope
    await this.applySelection(input)
    return this.updateLocalSnapshot(scope, input.capabilityId)
  }

  private async applySelection(input: { capabilityId: string; versionId: string }): Promise<void> {
    const owner = this.current().scope
    const local = (await this.options.submissions.list(owner, input.capabilityId)).find(record => record.idempotencyKey === input.versionId || record.uploadedVersion?.id === input.versionId)
    this.checkScope(owner)
    if (local) {
      const { scope, item } = await this.authorizeLocalSave(input.capabilityId)
      if (!local.request.content.trim()) throw new AppError('INVALID_STATE', { message: '技能原文为空，不能启用。' })
      for (const binding of item.bindings) {
        this.checkScope(scope)
        const saved = await this.options.versions.save(scope, {
          subscriptionId: binding.subscriptionId, employeeId: binding.employeeId,
          capabilityId: input.capabilityId, baseSkillVersionId: local.request.parentVersionId,
          localSubmissionId: local.idempotencyKey, sourceScope: 'PERSONAL',
          versionId: `local-${createHash('sha256').update(local.idempotencyKey).digest('hex')}`,
          version: local.request.changeSummary || '个人修改版', content: local.request.content,
        })
        this.checkScope(scope)
        await this.options.versions.select(scope, binding.subscriptionId, input.capabilityId, saved.versionId)
      }
      return
    }
    const { item, scope, token } = await this.authorized(input.capabilityId)
    const previews = new Map<string, Promise<{ content: string }>>()
    const preview = (versionId: string): Promise<{ content: string }> => {
      let result = previews.get(versionId)
      if (!result) { result = this.request(scope, () => this.options.platform.preview(versionId, token)); previews.set(versionId, result) }
      return result
    }
    const followPlatform = async (fallback?: SkillVersion): Promise<void> => {
      const prepared = await loadBounded(item.bindings, async binding => {
        this.checkScope(scope)
        // A bound employee may temporarily have no current release. An explicit
        // approved history selection is still usable in that case; the follow
        // sentinel itself must continue to require a current release.
        const version = binding.currentVersion ?? fallback
        if (!version || !canUseSkillVersion(version, scope.memberId)) throw new AppError('INVALID_STATE', { message: '当前没有可用的发布版本。' })
        const { content } = await preview(version.id)
        if (!content.trim()) throw new AppError('INVALID_STATE', { message: '技能原文为空，不能启用。' })
        this.checkScope(scope)
        const saved = await this.options.versions.savePlatform(scope, { subscriptionId: binding.subscriptionId,
          employeeId: binding.employeeId, capabilityId: input.capabilityId, baseSkillVersionId: version.id,
          sourceScope: version.scope as 'PLATFORM' | 'ENTERPRISE' | 'PERSONAL', version: version.version, content })
        return { binding, saved }
      })
      for (const { binding, saved } of prepared) {
        this.checkScope(scope)
        await this.options.versions.select(scope, binding.subscriptionId, input.capabilityId, saved.versionId, Boolean(binding.currentVersion))
      }
    }
    if (input.versionId === FOLLOW_PLATFORM_SKILL_VERSION) return followPlatform()
    const versions = await this.request(scope, () => this.options.platform.list({ capabilityId: input.capabilityId }, token))
    const version = versions.find(value => value.id === input.versionId)
    if (!version || !canUseSkillVersion(version, scope.memberId)) throw new AppError('PERMISSION_DENIED', { message: '该技能版本尚未审核通过或不允许使用。' })
    if (version.scope !== 'PERSONAL') {
      return followPlatform(version)
    }
    const { content } = await preview(version.id)
    if (!content) throw new AppError('INVALID_STATE', { message: '技能原文为空，不能启用。' })
    this.checkScope(scope)
    // Cache source before switching pointers. A running turn is not modified mid-execution.
    for (const binding of item.bindings) {
      const saved = await this.options.versions.savePlatform(scope, {
        subscriptionId: binding.subscriptionId, employeeId: binding.employeeId,
        capabilityId: input.capabilityId, baseSkillVersionId: version.id, sourceScope: 'PERSONAL', version: version.version, content,
      })
      this.checkScope(scope)
      await this.options.versions.select(scope, binding.subscriptionId, input.capabilityId, saved.versionId)
    }
  }
}
