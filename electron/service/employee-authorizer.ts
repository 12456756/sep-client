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
import type { Subscription } from '../common/platform/platform-api'
// import type 会被编译擦除，所以不构成对 runtime/ 的运行时依赖；
// EmployeeRuntimeConfig 是运行时的入参契约。定义点在 runtime/run-types.ts——
// 那是个零依赖的类型模块，import 它不会把 pi SDK 拉进服务层（B2）。
import type { EmployeeRuntimeConfig } from '../runtime/run-types'

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
  }): Promise<{ skillPaths: string[] }>
  invalidate(subscriptionId?: string): void
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
  if (!instance || !modelId || !instance.allowedModels.includes(modelId)) return null
  return { subscriptionId, modelId, gatewayUrl }
}

export class EmployeeAuthorizer {
  constructor(
    private readonly session: SessionTokens,
    private readonly directory: EmployeeDirectoryPort,
    private readonly skills: SkillProvisioner,
    private readonly gatewayUrl: string,
  ) {}

  /** 用户显式刷新：绕过 TTL，但仍与在途请求合并（C4）。只保留 ACTIVE 实例。 */
  async refresh(): Promise<Subscription[]> {
    return this.directory.refresh(await this.session.getValidAccessToken())
  }

  async list(): Promise<Subscription[]> {
    return this.directory.list(await this.session.getValidAccessToken())
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
    this.directory.invalidate()
    this.skills.invalidate()
  }

  /** 只读快照，**禁止发网络请求**——调度循环走的就是它（C4）。 */
  resolve(subscriptionId: string): EmployeeRuntimeConfig | null {
    return resolveEmployeeRuntime(this.directory.snapshot(), subscriptionId, this.gatewayUrl)
  }

  /**
   * 入队前授权一次：刷目录、备好技能。结果随队列条目携带，调度循环内不再重算（C4）。
   * 返回值必须带 `additionalSkillPaths`——换成 `resolve()` 的结果会让排队过的 run
   * 静默丢掉技能路径。
   */
  async authorize(subscriptionId: string, modelId?: string): Promise<EmployeeRuntimeConfig | null> {
    const accessToken = await this.session.getValidAccessToken()
    const instances = await this.directory.list(accessToken)
    const instance = instances.find(item => item.subscriptionId === subscriptionId)
    const employee = resolveEmployeeRuntime(instances, subscriptionId, this.gatewayUrl, modelId)
    if (!instance || !employee || !instance.employeeId) return null
    const runtime = await this.skills.prepare({
      enterpriseId: this.session.getMeta()?.enterpriseId ?? '',
      subscriptionId,
      employeeId: instance.employeeId,
      memberId: this.session.getMeta()?.memberId,
      accessToken,
    })
    return { ...employee, additionalSkillPaths: runtime.skillPaths }
  }
}
