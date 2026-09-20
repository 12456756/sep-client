import { createHash } from 'node:crypto'
import type { EmployeeSkill, PersonalSkillVersionRequest, SkillVersion } from '../common/platform/platform-api'
import { canUseSkillVersion } from '../common/platform/skill-version-policy'
import { logger } from '../common/logger'
import { requireScope, type ScopeSource } from './scope-guard'
import type { TaskOwnerScope } from '../data/scope-path'
import type { SkillVersionStore } from '../data/skill-version-store'
import type { SkillSubmissionStore } from '../data/skill-submission-store'
import type { LocalSkillSubmission, SaveSkillInput, SaveSkillResult, SkillLibraryItem } from '../../src/shared/skill-library'

interface SkillPlatform {
  skills(employeeId: string, token: string): Promise<{ subscriptionId: string; skills: { capability: EmployeeSkill['capability']; currentVersion: SkillVersion; versions: SkillVersion[] }[] }>
  list(input: { capabilityId: string }, token: string): Promise<SkillVersion[]>
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

export class SkillLibraryService {
  private snapshot: { scope: TaskOwnerScope; items: SkillLibraryItem[] } | null = null
  constructor(private readonly options: Options) {}

  private checkScope(scope: TaskOwnerScope): void {
    const current = requireScope(this.options.scope)
    if (current.memberId !== scope.memberId || current.enterpriseId !== scope.enterpriseId) throw new Error('登录身份已变化，请重新打开技能。')
  }

  async list(): Promise<SkillLibraryItem[]> {
    const scope = requireScope(this.options.scope)
    const token = await this.options.token()
    const subscriptions = await this.options.subscriptions()
    const catalogs = await Promise.all(subscriptions.map(async subscription => {
      const response = await this.options.platform.skills(subscription.employeeId, token)
      if (response.subscriptionId !== subscription.subscriptionId) throw new Error('员工技能与订阅不匹配。')
      return { subscription, skills: response.skills }
    }))
    this.checkScope(scope)
    const items = new Map<string, SkillLibraryItem>()
    for (const { subscription, skills } of catalogs) {
      for (const skill of skills) {
        const previous = items.get(skill.capability.id)
        const selected = await this.options.versions.selected(scope, subscription.subscriptionId, skill.capability.id)
        const local = selected ? await this.options.versions.load(scope, subscription.subscriptionId, skill.capability.id, selected) : null
        const versions = [...new Map([...(previous?.versions ?? []), skill.currentVersion, ...skill.versions].map(version => [version.id, version])).values()]
        items.set(skill.capability.id, {
          capability: skill.capability, versions, usableVersionIds: [], localVersions: [],
          bindings: [...(previous?.bindings ?? []), { ...subscription, currentVersion: skill.currentVersion, selectedVersionId: local?.localSubmissionId ?? local?.baseSkillVersionId ?? skill.currentVersion.id }],
        })
      }
    }
    const result = await Promise.all([...items.values()].map(async item => {
      const versions = await this.options.platform.list({ capabilityId: item.capability.id }, token)
      const submissions = await this.options.submissions.list(scope, item.capability.id)
      return {
        ...item, versions,
        // Selection tracks the actual local source, not a stale upload response.
        usableVersionIds: [
          ...versions.filter(version => canUseSkillVersion(version, scope.memberId)).map(version => version.id),
          ...submissions.map(record => record.idempotencyKey),
        ],
        // A local copy remains selectable even after upload while the remote version is pending/rejected.
        localVersions: submissions,
      }
    }))
    this.checkScope(scope)
    this.snapshot = { scope: { ...scope }, items: result }
    return result
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
    try {
      this.checkScope(scope)
      const token = await this.options.token()
      this.checkScope(scope)
      version = await this.options.platform.create(record.request, record.idempotencyKey, token)
    } catch (error) {
      this.checkScope(scope)
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
    return { idempotencyKey: record.idempotencyKey, uploaded: true, version }
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
          localSubmissionId: local.idempotencyKey,
          versionId: `local-${createHash('sha256').update(local.idempotencyKey).digest('hex')}`,
          version: local.request.changeSummary || '个人修改版', content: local.request.content,
        })
        this.checkScope(scope)
        await this.options.versions.select(scope, binding.subscriptionId, input.capabilityId, saved.versionId)
      }
      return
    }
    const { item, scope, token } = await this.authorized(input.capabilityId)
    const versions = await this.options.platform.list({ capabilityId: input.capabilityId }, token)
    const version = versions.find(value => value.id === input.versionId)
    if (!version || !canUseSkillVersion(version, scope.memberId)) throw new Error('该技能版本尚未审核通过或不允许使用。')
    const { content } = await this.options.platform.preview(version.id, token)
    if (!content) throw new Error('技能原文为空，不能启用。')
    this.checkScope(scope)
    // Cache source before switching pointers. A running turn is not modified mid-execution.
    for (const binding of item.bindings) {
      const saved = await this.options.versions.savePlatform(scope, {
        subscriptionId: binding.subscriptionId, employeeId: binding.employeeId,
        capabilityId: input.capabilityId, baseSkillVersionId: version.id, version: version.version, content,
      })
      this.checkScope(scope)
      await this.options.versions.select(scope, binding.subscriptionId, input.capabilityId, saved.versionId)
    }
  }
}
