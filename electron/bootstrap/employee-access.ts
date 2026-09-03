/**
 * electron/bootstrap/employee-access.ts — 员工目录快照 + 授权
 *
 * 收纳 main.ts 原来的模块级 `activeInstances`、`resolveEmployee()`、
 * `authorizeEmployee()` 与 `ensureSubscriptionRuntime()` 惰性单例。
 *
 * 单独成文件有两个理由：
 *   1. 组装根 import 了 `AuthSessionManager`，后者经 `credential-vault` 拖进
 *      `import electron`，于是组装根在 Electron 之外根本 import 不了。
 *      这里只依赖下面两个结构化端口，因此可以脱离 Electron 单测（C10 的回归测试）。
 *   2. Phase 5 要把它拆成 `service/employee-directory.ts`（TTL 缓存，唯一平台目录
 *      读取点）与 `service/employee-authorizer.ts`（纯函数，目录快照入参）。
 *      拆分的前置条件是先把 `SubscriptionRuntime` 反转成注入的端口——它在 `pi/sdk/` 下，
 *      而 B2 不允许 `service/` 直接依赖 `pi/`，所以这一轮先留在 bootstrap/。
 */
import { config } from '../common/config'
import type { ClientInstance } from '../common/platform/platform-api'
import { SubscriptionRuntime } from '../pi/sdk/subscription-resource-loader'
import type { EmployeeRuntimeConfig } from '../runtime/task-execution-coordinator'

/** 只用会话的这两件事，按最小需要声明，测试才好替。 */
export interface SessionTokens {
  getValidAccessToken(): Promise<string>
  getMeta(): { enterpriseId: string } | null
}

/** 只用平台目录的这四件事。 */
export interface SubscriptionDirectory {
  list(accessToken: string): Promise<ClientInstance[]>
  refresh(accessToken: string): Promise<ClientInstance[]>
  /** 最近一次成功读取的快照，不发请求。 */
  snapshot(): ClientInstance[]
  invalidate(): void
}

export class EmployeeAccess {
  private readonly subscriptionRuntime: SubscriptionRuntime

  constructor(
    private readonly authSession: SessionTokens,
    private readonly directory: SubscriptionDirectory,
    runtimeDir: string,
  ) {
    // 构造函数不做 IO，所以不需要惰性单例：SubscriptionRuntime 只是记住根目录。
    this.subscriptionRuntime = new SubscriptionRuntime(runtimeDir)
  }

  /** 用户显式刷新：绕过 TTL，但仍与在途请求合并（C4）。只保留 ACTIVE 实例。 */
  async refresh(): Promise<ClientInstance[]> {
    return this.directory.refresh(await this.authSession.getValidAccessToken())
  }

  /**
   * 身份变化时的唯一收尾：丢掉平台目录的 TTL 缓存与技能包缓存。
   *
   * C10：这里原来是两个入口——登录/登出走的那个不丢平台目录缓存，只有认证失效走的
   * 那个丢。于是"登出后 15 秒内换账号登录"会让 `authorize()` 从 TTL 缓存里读到
   * **上一个账号**的订阅列表（`InstanceDirectory` 的缓存不按身份分键）。
   * 平台侧仍会用新令牌校验，所以不是越权执行，但用户会看到属于别人的员工、
   * 且拿到一个无从解释的失败。身份变化只有一种收尾，合并为一个入口。
   */
  clear(): void {
    this.directory.invalidate()
    this.subscriptionRuntime.invalidate()
  }

  /**
   * 从目录快照解析运行配置。**禁止在这里发网络请求**——调度循环（`pump`）走的就是它，
   * 一次慢请求会让所有任务的准入全部停摆（C4）。
   *
   * 快照只有 `InstanceDirectory` 一份。这个类原来还自己存了一份 `instances` 副本，
   * 两份靠"每次 list/refresh 后手动赋值"保持同步——同一份数据两个定义点（原则 3），
   * 而 C10 正是其中一份忘了清。
   */
  resolve(subscriptionId: string): EmployeeRuntimeConfig | null {
    const instance = this.directory.snapshot().find(item => item.id === subscriptionId)
    const modelId = instance?.allowedModels?.[0]
    if (!instance || !modelId) return null
    return { subscriptionId, modelId, gatewayUrl: config.SEP_GATEWAY_URL }
  }

  /**
   * 入队前授权一次：刷目录、备好技能包。结果随队列条目携带，调度循环内不再重算（C4）。
   * 返回值必须带 `additionalSkillPaths`——换成 `resolve()` 的结果会让排队过的 run
   * 静默丢掉技能包路径。
   */
  async authorize(subscriptionId: string): Promise<EmployeeRuntimeConfig | null> {
    const accessToken = await this.authSession.getValidAccessToken()
    const instances = await this.directory.list(accessToken)
    const instance = instances.find(item => item.id === subscriptionId)
    const employee = this.resolve(subscriptionId)
    if (!instance || !employee || !instance.template.id || !instance.templateVersion) return null
    const runtime = await this.subscriptionRuntime.prepare({
      enterpriseId: this.authSession.getMeta()?.enterpriseId ?? '',
      subscriptionId,
      employeeId: instance.template.id,
      templateVersion: instance.templateVersion,
      accessToken,
    })
    return { ...employee, additionalSkillPaths: runtime.skillPaths }
  }
}
