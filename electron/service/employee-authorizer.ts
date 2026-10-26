/**
 * electron/service/employee-authorizer.ts — 员工授权
 *
 * 两件事分开：
 *   - `resolveEmployeeRuntime()` 是**纯函数**：目录快照入参、运行配置出参、零 IO、零全局。
 *     调度循环（`pump`）走的就是它——一次网络请求会让所有任务的准入全部停摆（C4）。
 *   - `EmployeeAuthorizer` 做入队前的一次性授权：刷目录 + 备技能，
 *     结果随队列条目携带，调度循环内不再重算。
 *
 * B2：本文件不 import `pi/`。技能准备经 `SkillProvisioner` 端口注入，
 * 实现是 `pi/sdk/pi-skill-packages.ts` 的 `SkillStore`。
 */
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { AuthApiError, type Subscription } from '../common/platform/platform-api'
import { AuthenticationRequiredError } from '../common/platform/authentication-required-error'
import { AppError } from '../errors/app-error'
import { employeeRuntimeSnapshotSchema, parseEmployeeRuntimeManifest, preparedEmployeeSkillSchema, type EmployeeRuntimeSkill, type PreparedEmployeeSkill } from '../common/platform/employee-runtime-contract'
import type { SkillArtifactAvailable } from '../common/platform/skill-artifact-contract'
// import type 会被编译擦除，所以不构成对 runtime/ 的运行时依赖；
// EmployeeRuntimeConfig 是运行时的入参契约。定义点在 runtime/run-types.ts——
// 那是个零依赖的类型模块，import 它不会把 pi SDK 拉进服务层（B2）。
import type { EmployeeRuntimeConfig } from '../runtime/run-types'

function videoAuthorizationFingerprint(video: EmployeeRuntimeConfig['video']): string {
  // Video arrays enumerate sets of tools, profiles, operations and supported parameters.
  // Ignore response key/list ordering and duplicate capabilities, after strict parsing.
  function normalize(value: unknown): string {
    if (Array.isArray(value)) return `[${[...new Set(value.map(normalize))].sort().join(',')}]`
    if (value !== null && typeof value === 'object') {
      return `{${Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, child]) => `${JSON.stringify(key)}:${normalize(child)}`).join(',')}}`
    }
    return JSON.stringify(value) ?? 'null'
  }
  return createHash('sha256').update(normalize(video ?? null)).digest('hex')
}

/** 只用会话的这两件事，按最小需要声明，测试才好替。 */
export interface SessionTokens {
  getValidAccessToken(): Promise<string>
  getMeta(): { enterpriseId: string; memberId?: string } | null
}

/** 只用平台目录的这四件事。实现是 service/employee-directory.ts。 */
export interface EmployeeDirectoryPort {
  list(accessToken: string): Promise<Subscription[]>
  refresh(accessToken: string): Promise<Subscription[]>
  /** 最近一次成功读取的快照，不发请求。全后端唯一的目录快照。 */
  snapshot(): Subscription[]
  invalidate(): void
}

/**
 * 技能准备的端口。实现是 `pi/sdk/pi-skill-packages.ts` 的
 * `SkillStore`，由组装根注入——B2 不允许 `service/` 直接依赖 `pi/`。
 */
export interface SkillProvisioner {
  prepare(input: {
    enterpriseId: string
    subscriptionId: string
    employeeId: string
    memberId?: string
    accessToken: string
    runtimeSkills?: readonly EmployeeRuntimeSkill[]
    skillArtifactProtocolVersion?: 1
    isCurrent?: () => boolean
  }): Promise<{ skillPaths: string[]; skills?: PreparedEmployeeSkill[] }>
  invalidate(subscriptionId?: string): void
}

export interface RuntimeProvider {
  getRuntime(subscriptionId: string, accessToken: string): Promise<unknown>
}

/**
 * 从目录快照解析运行配置。纯函数：同样的入参永远得到同样的结果，不碰任何全局。
 * 解析只依赖传入快照，不读取进程级状态，避免授权结果依赖上一次登录或刷新顺序。
 */
export function resolveEmployeeRuntime(
  instances: readonly Subscription[],
  subscriptionId: string,
  gatewayUrl: string,
  selectedModelId?: string,
): EmployeeRuntimeConfig | null {
  const instance = instances.find(item => item.subscriptionId === subscriptionId)
  const modelId = selectedModelId ?? instance?.allowedModels?.[0]
  if (!instance || instance.status !== 'ACTIVE' || !modelId || !instance.allowedModels.includes(modelId)) return null
  return {
    subscriptionId, modelId, gatewayUrl,
    employeeProfile: {
      name: instance.name,
      position: instance.position,
      functionalCategory: instance.functionalCategory,
      description: instance.description,
    },
  }
}

export class EmployeeAuthorizer {
  private generation = 0
  private authorizationRevision = 0
  private localAuthorizationRevision = 0
  private recoveryAuthorizationRevision = 0
  private readonly videoAuthorizationFingerprints = new Map<string, string>()
  private readonly videoRuntimes = new Map<string, EmployeeRuntimeConfig['video']>()
  private readonly employeeGrants = new Map<string, string | null>()
  private directoryTail: Promise<void> = Promise.resolve()
  private directoryScope: string | undefined

  constructor(
    private readonly session: SessionTokens,
    private readonly directory: EmployeeDirectoryPort,
    private readonly skills: SkillProvisioner,
    private readonly gatewayUrl: string,
    private readonly runtimeProvider?: RuntimeProvider,
  ) {}

  /** 用户显式刷新：绕过 TTL，但仍与在途请求合并（C4）。只保留 ACTIVE 实例。 */
  async refresh(): Promise<Subscription[]> {
    return this.readDirectory(true)
  }

  async list(): Promise<Subscription[]> {
    return this.readDirectory(false)
  }

  /** Model-only grant: no employee identity, runtime manifest or skill preparation. */
  async authorizeModel(modelId: string, preferredSubscriptionId?: string): Promise<EmployeeRuntimeConfig | null> {
    const instances = await this.list()
    const available = instances.filter(instance => instance.status === 'ACTIVE' && instance.allowedModels.includes(modelId))
    const selected = available.find(instance => instance.subscriptionId === preferredSubscriptionId) ?? available[0]
    return selected ? { subscriptionId: selected.subscriptionId, modelId, gatewayUrl: this.gatewayUrl } : null
  }

  /** Host fence for external invalidation and observed video policy changes. */
  getAuthorizationRevision(): number {
    return this.authorizationRevision
  }

  /** Local files and original receipt tracking do not depend on generation model capabilities. */
  getLocalAuthorizationRevision(): number {
    return this.localAuthorizationRevision
  }

  getRecoveryAuthorizationRevision(): number {
    return this.recoveryAuthorizationRevision
  }

  /** Presentation-only cached capability snapshot, with no skill or network IO. */
  resolveVideo(subscriptionId: string): EmployeeRuntimeConfig['video'] {
    if (this.directoryScope !== this.scopeKey() || !this.employeeGrants.get(subscriptionId)) return undefined
    return this.videoRuntimes.get(subscriptionId)
  }

  private observeGrant(subscriptionId: string, employeeId: string | null): void {
    const previous = this.employeeGrants.get(subscriptionId)
    if (previous !== undefined && previous !== null && previous !== employeeId) {
      // Employee grant changes fence network execution/recovery only. Local files
      // are owned by the signed-in enterprise/member and remain readable offline.
      this.authorizationRevision++
      this.recoveryAuthorizationRevision++
      this.videoRuntimes.delete(subscriptionId)
    }
    this.employeeGrants.set(subscriptionId, employeeId)
  }

  private observeDirectory(instances: readonly Subscription[]): void {
    const active = new Map(instances.filter(instance => instance.status === 'ACTIVE' && instance.employeeId)
      .map(instance => [instance.subscriptionId, instance.employeeId!]))
    for (const id of new Set([...this.employeeGrants.keys(), ...active.keys()])) this.observeGrant(id, active.get(id) ?? null)
  }

  private grantDenied(error: unknown): boolean {
    return error instanceof AuthApiError && (error.isUnauthorized || error.isForbidden) ||
      error instanceof AuthenticationRequiredError || error instanceof AppError &&
      (error.code === 'AUTH_REQUIRED' || error.code === 'PERMISSION_DENIED')
  }

  /**
   * 身份变化时的唯一收尾：丢掉平台目录的 TTL 缓存与技能缓存。
   *
   * C10：这里原来是两个入口——登录/登出走的那个不丢平台目录缓存，只有认证失效走的
   * 那个丢。于是"登出后 15 秒内换账号登录"会让 `authorize()` 从 TTL 缓存里读到
   * **上一个账号**的订阅列表（缓存不按身份分键）。平台侧仍会用新令牌校验，
   * 所以不是越权执行，但用户会看到属于别人的员工、且拿到一个无从解释的失败。
   */
  clear(): void {
    this.generation += 1
    this.authorizationRevision += 1
    this.localAuthorizationRevision += 1
    this.recoveryAuthorizationRevision += 1
    this.videoAuthorizationFingerprints.clear()
    this.videoRuntimes.clear()
    this.employeeGrants.clear()
    this.directoryScope = undefined
    this.directory.invalidate()
    this.skills.invalidate()
  }

  /** 只读快照，**禁止发网络请求**——调度循环走的就是它（C4）。 */
  resolve(subscriptionId: string): EmployeeRuntimeConfig | null {
    if (this.directoryScope !== undefined && this.directoryScope !== this.scopeKey()) return null
    return resolveEmployeeRuntime(this.directory.snapshot(), subscriptionId, this.gatewayUrl)
  }

  private scopeKey(): string {
    const meta = this.session.getMeta()
    return JSON.stringify([meta?.enterpriseId, meta?.memberId])
  }

  private captureScope(): { enterpriseId: string; memberId?: string; isCurrent: () => boolean } | null {
    const meta = this.session.getMeta()
    if (!meta?.enterpriseId) return null
    const { enterpriseId, memberId } = meta
    const generation = this.generation
    const key = this.scopeKey()
    return { enterpriseId, memberId, isCurrent: () => generation === this.generation && key === this.scopeKey() }
  }

  private async readDirectory(refresh: boolean): Promise<Subscription[]> {
    const scope = this.captureScope()
    if (!scope) return []
    const token = await this.session.getValidAccessToken()
    if (!scope.isCurrent()) return []
    return this.scopedDirectory(token, scope.isCurrent, refresh)
  }

  private async scopedDirectory(token: string, isCurrent: () => boolean, refresh = false): Promise<Subscription[]> {
    const previous = this.directoryTail
    let release!: () => void
    this.directoryTail = new Promise<void>(done => { release = done })
    await previous
    try {
      if (!isCurrent()) return []
      const key = this.scopeKey()
      if (this.directoryScope !== key) this.directory.invalidate()
      this.directoryScope = key
      // The directory's in-flight request is not identity-keyed. Drain it before a new scope reads.
      const instances = await (refresh ? this.directory.refresh(token) : this.directory.list(token))
      if (!isCurrent()) { this.directory.invalidate(); return [] }
      this.observeDirectory(instances)
      return instances
    } catch (error) {
      if (isCurrent() && this.grantDenied(error)) {
        for (const id of this.employeeGrants.keys()) this.observeGrant(id, null)
      }
      throw error
    } finally {
      release()
    }
  }

  /** Online employee grant only; original receipt access must not prepare skills or select a chat/video model. */
  async authorizeRecovery(subscriptionId: string): Promise<boolean> {
    const scope = this.captureScope()
    if (!scope) return false
    const token = await this.session.getValidAccessToken()
    if (!scope.isCurrent()) return false
    const instances = await this.scopedDirectory(token, scope.isCurrent)
    if (!scope.isCurrent()) return false
    return instances.some(instance => instance.subscriptionId === subscriptionId && instance.status === 'ACTIVE' && !!instance.employeeId)
  }

  private async readRuntime(subscriptionId: string) {
    const scope = this.captureScope()
    if (!scope) return null
    const accessToken = await this.session.getValidAccessToken()
    if (!scope.isCurrent()) return null
    const instances = await this.scopedDirectory(accessToken, scope.isCurrent)
    if (!scope.isCurrent()) return null
    const instance = instances.find(item => item.subscriptionId === subscriptionId && item.status === 'ACTIVE')
    if (!instance?.employeeId) return null
    let rawManifest: unknown
    try {
      rawManifest = this.runtimeProvider ? await this.runtimeProvider.getRuntime(subscriptionId, accessToken) : undefined
    } catch (error) {
      if (scope.isCurrent() && this.grantDenied(error)) this.observeGrant(subscriptionId, null)
      throw error
    }
    if (!scope.isCurrent()) return null
    const manifest = this.runtimeProvider ? parseEmployeeRuntimeManifest(rawManifest) : undefined
    if (manifest && (manifest.subscriptionId !== subscriptionId || manifest.employee.id !== instance.employeeId)) {
      throw new Error('Employee runtime identity mismatch.')
    }
    if (manifest) {
      const fingerprint = videoAuthorizationFingerprint(manifest.runtime.video)
      const previous = this.videoAuthorizationFingerprints.get(subscriptionId)
      if (previous !== undefined && previous !== fingerprint) this.authorizationRevision += 1
      this.videoAuthorizationFingerprints.set(subscriptionId, fingerprint)
      this.videoRuntimes.set(subscriptionId, manifest.runtime.video)
    }
    return { scope, accessToken, instance, employeeId: instance.employeeId, manifest }
  }

  /** Online capabilities only: media tools must not prepare skills or select a chat model. */
  async authorizeRuntime(subscriptionId: string): Promise<Pick<EmployeeRuntimeConfig, 'subscriptionId' | 'media' | 'video'> | null> {
    const current = await this.readRuntime(subscriptionId)
    if (!current?.scope.isCurrent()) return null
    return { subscriptionId, media: current.manifest?.runtime.media, video: current.manifest?.runtime.video }
  }

  /** Full preparation is only for run admission; the queue carries the prepared skills. */
  async authorize(subscriptionId: string, modelId?: string): Promise<EmployeeRuntimeConfig | null> {
    const current = await this.readRuntime(subscriptionId)
    if (!current?.scope.isCurrent()) return null
    const { scope, accessToken, instance, employeeId, manifest } = current
    const employee = resolveEmployeeRuntime([instance], subscriptionId, this.gatewayUrl, modelId)
    if (!employee) return null
    // Runtime may still advertise retired models that the current directory excludes.
    const selectedModel = manifest
      ? modelId ?? ([manifest.runtime.modelId, ...manifest.runtime.allowedModels].find(candidate =>
        manifest.runtime.allowedModels.includes(candidate) && instance.allowedModels.includes(candidate)))
      : employee.modelId
    if (!selectedModel || (manifest && !manifest.runtime.allowedModels.includes(selectedModel)) || !instance.allowedModels.includes(selectedModel)) return null
    const skillArtifactProtocolVersion = manifest?.runtime.skillArtifactProtocolVersion
    // Keep the approved versions and resource identities fixed throughout asynchronous preparation.
    const approvedSkills = manifest && Object.freeze(manifest.runtime.skills.map(skill => Object.freeze({
      ...skill,
      ...(skill.artifact ? { artifact: Object.freeze({ ...skill.artifact }) } : {}),
    })))
    for (const skill of approvedSkills ?? []) {
      const artifact = skill.artifact
      if (skillArtifactProtocolVersion === 1) {
        if (!artifact || artifact.status !== 'AVAILABLE' || artifact.capabilityId !== skill.capabilityId
          || artifact.versionId !== skill.versionId
          || artifact.approvedContentSha256 !== createHash('sha256').update(skill.content).digest('hex')) {
          throw new Error('Employee runtime skill artifact is unavailable or mismatched.')
        }
      } else if (artifact) {
        throw new Error('Employee runtime skill artifact protocol was not negotiated.')
      }
    }
    let prepared: Awaited<ReturnType<SkillProvisioner['prepare']>>
    try {
      prepared = await this.skills.prepare({
        enterpriseId: scope.enterpriseId,
        subscriptionId,
        employeeId,
        memberId: scope.memberId,
        accessToken,
        ...(approvedSkills ? { runtimeSkills: approvedSkills } : {}),
        ...(skillArtifactProtocolVersion !== undefined ? { skillArtifactProtocolVersion } : {}),
        isCurrent: scope.isCurrent,
      })
    } catch (error) {
      if (!scope.isCurrent()) return null
      throw error
    }
    if (!scope.isCurrent()) return null
    if (!manifest || !approvedSkills) return { ...employee, additionalSkillPaths: [...prepared.skillPaths] }
    const parsedSkills = preparedEmployeeSkillSchema.array().safeParse(prepared.skills ?? [])
    if (!parsedSkills.success) throw new Error('Employee runtime skills were not fully prepared.')
    const actualSkills = parsedSkills.data
    if (actualSkills.length !== approvedSkills.length || prepared.skillPaths.length !== actualSkills.length
      || new Set(prepared.skillPaths).size !== actualSkills.length
      || new Set(actualSkills.map(skill => skill.capabilityId)).size !== actualSkills.length
      || new Set(actualSkills.map(skill => skill.path)).size !== actualSkills.length
      || actualSkills.some(actual => {
        const approved = approvedSkills.find(skill => skill.capabilityId === actual.capabilityId)
        if (!approved || !prepared.skillPaths.includes(actual.path)
          || actual.sha256 !== createHash('sha256').update(actual.content).digest('hex')) return true
        if (actual.source === 'owner-local') return actual.artifact !== undefined
        if (actual.baseSkillVersionId !== approved.versionId || actual.version !== approved.version) return true
        const artifact: SkillArtifactAvailable | undefined = approved.artifact?.status === 'AVAILABLE' ? approved.artifact : undefined
        return !isDeepStrictEqual(actual.artifact, artifact) || (artifact !== undefined && actual.sha256 !== artifact.entrySha256)
      })) throw new Error('Employee runtime skills were not fully prepared.')
    const runtimeSnapshot = employeeRuntimeSnapshotSchema.parse({
      manifestVersion: manifest.manifestVersion,
      ...(skillArtifactProtocolVersion !== undefined ? { skillArtifactProtocolVersion } : {}),
      subscriptionId,
      ...(manifest.runtime.video !== undefined ? { video: manifest.runtime.video } : {}),
      enterpriseId: scope.enterpriseId,
      memberId: scope.memberId,
      employeeId: manifest.employee.id,
      templateVersion: manifest.templateVersion,
      employeeVersion: manifest.employee.version,
      maxSteps: manifest.employee.maxSteps,
      systemPrompt: manifest.runtime.systemPrompt,
      modelId: selectedModel,
      allowedModels: manifest.runtime.allowedModels,
      approvedSkills,
      skills: actualSkills,
    })
    for (const skill of [...runtimeSnapshot.approvedSkills, ...runtimeSnapshot.skills]) {
      if (skill.artifact) Object.freeze(skill.artifact)
    }
    return {
      ...employee,
      modelId: selectedModel,
      additionalSkillPaths: [...prepared.skillPaths],
      systemPrompt: manifest.runtime.systemPrompt,
      ...(manifest.runtime.media !== undefined ? { media: manifest.runtime.media } : {}),
      ...(runtimeSnapshot.video !== undefined ? { video: runtimeSnapshot.video } : {}),
      runtimeSnapshot,
    }
  }
}
