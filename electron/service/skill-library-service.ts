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
import type { LocalSkillSubmission, SaveSkillInput, SaveSkillResult, SkillLibraryItem } from '../../src/shared/skill-library'
import { FOLLOW_PLATFORM_SKILL_VERSION } from '../../src/shared/skill-library'

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
}
const log = logger.child('skill-library')
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
  private snapshot: { scope: TaskOwnerScope; items: SkillLibraryItem[] } | null = null
  private inFlight: { scope: TaskOwnerScope; promise: Promise<{ items: SkillLibraryItem[]; skippedCount: number }> } | null = null
  constructor(private readonly options: Options) {}

  private checkScope(scope: TaskOwnerScope): void {
    const current = requireScope(this.options.scope)
    if (current.memberId !== scope.memberId || current.enterpriseId !== scope.enterpriseId) throw new Error('登录身份已变化，请重新打开技能。')
  }

  async list(): Promise<SkillLibraryItem[]> {
    return (await this.listWithDiagnostics()).items
  }

  async listWithDiagnostics(): Promise<{ items: SkillLibraryItem[]; skippedCount: number }> {
    const scope = requireScope(this.options.scope)
    if (this.inFlight?.scope.memberId === scope.memberId && this.inFlight.scope.enterpriseId === scope.enterpriseId) return this.inFlight.promise
    const promise = this.loadLibrary(scope)
    this.inFlight = { scope: { ...scope }, promise }
    try { return await promise } finally { if (this.inFlight?.promise === promise) this.inFlight = null }
  }

  private async loadLibrary(scope: TaskOwnerScope): Promise<{ items: SkillLibraryItem[]; skippedCount: number }> {
    const token = await this.options.token()
    const subscriptions = await this.options.subscriptions()
    const catalogs = await loadBounded(subscriptions, async subscription => {
      this.checkScope(scope)
      const response = libraryCatalogSchema.parse(await this.options.platform.skills(subscription.employeeId, token))
      if (response.subscriptionId !== subscription.subscriptionId) throw new Error('员工技能与订阅不匹配。')
      return { subscription, skills: response.skills }
    })
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
      const versions = await this.options.platform.list({ capabilityId: item.capability.id }, token)
      const submissions = await this.options.submissions.list(scope, item.capability.id)
      return {
        ...item, versions,
        bindings: item.bindings.map(binding => {
          const selected = versions.find(version => version.id === binding.selectedVersionId)
          const local = submissions.some(record => record.idempotencyKey === binding.selectedVersionId)
          return local || selected?.scope === 'PERSONAL' || binding.selectionMode === 'personal'
            ? { ...binding, selectionMode: 'personal' as const }
            : { ...binding, selectionMode: 'follow-platform' as const, selectedVersionId: binding.currentVersion?.id ?? null }
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
    this.snapshot = { scope: { ...scope }, items: result }
    return { items: result, skippedCount }
  }

  private async authorized(capabilityId: string): Promise<{ item: SkillLibraryItem; scope: TaskOwnerScope; token: string }> {
    const scope = requireScope(this.options.scope)
    const item = (await this.list()).find(value => value.capability.id === capabilityId)
    if (!item) throw new Error('没有此技能的有效员工授权。')
    const token = await this.options.token()
    this.checkScope(scope)
    return { item, scope, token }
  }

  async preview(input: { capabilityId: string; versionId: string }): Promise<string> {
    const owner = requireScope(this.options.scope)
    const local = (await this.options.submissions.list(owner, input.capabilityId)).find(value => value.idempotencyKey === input.versionId || value.uploadedVersion?.id === input.versionId)
    this.checkScope(owner)
    if (local) return local.request.content
    const { scope, token } = await this.authorized(input.capabilityId)
    const versions = await this.options.platform.list({ capabilityId: input.capabilityId }, token)
    if (!versions.some(version => version.id === input.versionId)) throw new Error('技能版本不可见或已被移除。')
    const result = await this.options.platform.preview(input.versionId, token)
    this.checkScope(scope)
    return result.content
  }

  private async authorizeLocalSave(capabilityId: string): Promise<{ scope: TaskOwnerScope; item: SkillLibraryItem }> {
    const scope = requireScope(this.options.scope)
    // An already-open, authorized immutable source can still be saved locally while offline.
    // This snapshot permits local editing/selection only; task authorization is checked live at execution.
    const snapshot = this.snapshot
    const items = snapshot && snapshot.scope.memberId === scope.memberId && snapshot.scope.enterpriseId === scope.enterpriseId
      ? snapshot.items : await this.list()
    const item = items.find(value => value.capability.id === capabilityId)
    if (!item) throw new Error('没有此技能的有效员工授权。')
    this.checkScope(scope)
    return { scope, item }
  }

  async save(input: SaveSkillInput): Promise<SaveSkillResult> {
    const { scope, item } = await this.authorizeLocalSave(input.request.capabilityId)
    if (!item.versions.some(version => version.id === input.request.parentVersionId)) throw new Error('来源版本不可见或不属于该技能。')
    this.checkScope(scope)
    const existing = (await this.options.submissions.list(scope, input.request.capabilityId)).find(value => value.idempotencyKey === input.idempotencyKey)
    const record: LocalSkillSubmission = { ...existing, ...input, createdAt: existing?.createdAt ?? new Date().toISOString() }
    await this.options.submissions.save(scope, record)
    return this.upload(scope, record)
  }

  async retry(input: { capabilityId: string; idempotencyKey: string }): Promise<SaveSkillResult> {
    const { scope } = await this.authorizeLocalSave(input.capabilityId)
    const record = (await this.options.submissions.list(scope, input.capabilityId)).find(value => value.idempotencyKey === input.idempotencyKey)
    if (!record) throw new Error('本地保存记录不存在。')
    return this.upload(scope, record)
  }

  private async upload(scope: TaskOwnerScope, record: LocalSkillSubmission): Promise<SaveSkillResult> {
    let version: SkillVersion
    let token: string
    try {
      this.checkScope(scope)
      token = await this.options.token()
      this.checkScope(scope)
      version = await this.options.platform.create(record.request, record.idempotencyKey, token)
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
    if (this.snapshot?.scope.memberId === scope.memberId && this.snapshot.scope.enterpriseId === scope.enterpriseId) {
      this.snapshot = { ...this.snapshot, items: this.snapshot.items.map(item => item.capability.id !== record.request.capabilityId ? item : {
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
      const versions = await this.options.platform.list({ capabilityId: record.request.capabilityId }, token, AbortSignal.timeout(15_000))
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

  async select(input: { capabilityId: string; versionId: string }): Promise<void> {
    const owner = requireScope(this.options.scope)
    const local = (await this.options.submissions.list(owner, input.capabilityId)).find(record => record.idempotencyKey === input.versionId || record.uploadedVersion?.id === input.versionId)
    this.checkScope(owner)
    if (local) {
      const { scope, item } = await this.authorizeLocalSave(input.capabilityId)
      if (!local.request.content.trim()) throw new Error('技能原文为空，不能启用。')
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
    const followPlatform = async (): Promise<void> => {
      const prepared = await loadBounded(item.bindings, async binding => {
        this.checkScope(scope)
        const version = binding.currentVersion
        if (!version || !canUseSkillVersion(version, scope.memberId)) throw new Error('当前没有可用的发布版本。')
        const { content } = await this.options.platform.preview(version.id, token)
        if (!content.trim()) throw new Error('技能原文为空，不能启用。')
        this.checkScope(scope)
        const saved = await this.options.versions.savePlatform(scope, { subscriptionId: binding.subscriptionId,
          employeeId: binding.employeeId, capabilityId: input.capabilityId, baseSkillVersionId: version.id,
          sourceScope: version.scope as 'PLATFORM' | 'ENTERPRISE' | 'PERSONAL', version: version.version, content })
        return { binding, saved }
      })
      for (const { binding, saved } of prepared) {
        this.checkScope(scope)
        await this.options.versions.select(scope, binding.subscriptionId, input.capabilityId, saved.versionId, true)
      }
    }
    if (input.versionId === FOLLOW_PLATFORM_SKILL_VERSION) return followPlatform()
    const versions = await this.options.platform.list({ capabilityId: input.capabilityId }, token)
    const version = versions.find(value => value.id === input.versionId)
    if (!version || !canUseSkillVersion(version, scope.memberId)) throw new Error('该技能版本尚未审核通过或不允许使用。')
    if (version.scope !== 'PERSONAL') {
      return followPlatform()
    }
    const { content } = await this.options.platform.preview(version.id, token)
    if (!content) throw new Error('技能原文为空，不能启用。')
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
