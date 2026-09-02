/**
 * electron/bootstrap/composition-root.ts — 组装根
 *
 * `createBackend()` 是后端唯一的装配入口，替掉 main.ts 原来的 10 个模块级可变全局
 * （mainWindow、taskCoordinator、taskCoordinatorInitialization、taskManager、
 * taskRunStore、workflowStore、taskMetadataStore、activeInstances、
 * subscriptionRuntime、authenticationCleanupPromise）与 6 个手写的 `ensureXxx`
 * 惰性单例。依赖显式传进构造函数，可测、可替换、初始化顺序看得见。
 *
 * 只有一处惰性加载保留：`getTaskCoordinator()`。它必须留着，见该方法的注释。
 */
import { join } from 'node:path'
import { AuthSessionManager } from '../common/platform/auth-session-manager'
import { InstanceDirectory } from '../common/platform/instance-directory'
import { getInstances, type ClientInstance } from '../common/platform/platform-api'
import { config } from '../common/config'
import { lazyAsync, type LazyAsync } from '../common/lazy-async'
import { logger } from '../common/logger'
import { describeError } from '../common/redact'
import { settleWithTimeout } from '../common/with-timeout'
import { TaskMetadataStore } from '../data/task-metadata-store'
import { TaskRunStore } from '../data/task-run-store'
import { WorkflowStore } from '../data/workflow-store'
import { SubscriptionRuntime } from '../pi/sdk/subscription-resource-loader'
// 必须是 import type：静态加载协调器会把 pi SDK 拉到兼容层之前，
// Electron 33 上以 `markAsUncloneable is not a function` 崩在启动路径。
import type { EmployeeRuntimeConfig, TaskExecutionCoordinator } from '../runtime/task-execution-coordinator'
import { TaskManager } from '../runtime/task-manager'
import type { RendererPort } from '../runtime/task-notifier'
import type { TaskOwnerScope } from '../data/task-store'

const log = logger.child('composition-root')

/** 认证失效清理的预算。stopAll 内部要等 worker.abort() 与在途事件落盘（C7）。 */
export const AUTH_CLEANUP_BUDGET_MS = 5_000

export interface BackendOptions {
  /** Electron 的 userData 目录。所有持久化路径都从它派生。 */
  userDataDir: string
  /** 推给渲染进程的唯一出口，由 bootstrap/renderer-bridge.ts 实现。 */
  renderer: RendererPort
  /** safeStorage 可用性。注入而非直接 import electron，组装根才能脱离 Electron 单测。 */
  isEncryptionAvailable?: () => boolean
}

/**
 * 员工目录快照 + 授权。收纳 main.ts 原来的模块级 `activeInstances`、
 * `resolveEmployee()`、`authorizeEmployee()` 与 `ensureSubscriptionRuntime()`，行为不变。
 *
 * Phase 5 会拆成 `service/employee-directory.ts`（TTL 缓存，唯一平台目录读取点）与
 * `service/employee-authorizer.ts`（纯函数，目录快照入参）。拆分的前置条件是先把
 * `SubscriptionRuntime` 反转成注入的端口——它在 `pi/sdk/` 下，而 B2 不允许
 * `service/` 直接依赖 `pi/`。
 */
class EmployeeAccess {
  private instances: ClientInstance[] = []
  private readonly subscriptionRuntime: SubscriptionRuntime

  constructor(
    private readonly authSession: AuthSessionManager,
    private readonly directory: InstanceDirectory,
    runtimeDir: string,
  ) {
    // 构造函数不做 IO，所以不需要惰性单例：SubscriptionRuntime 只是记住根目录。
    this.subscriptionRuntime = new SubscriptionRuntime(runtimeDir)
  }

  /** 当前目录快照。只读，不发请求。 */
  snapshot(): ClientInstance[] {
    return this.instances
  }

  /** 用户显式刷新：绕过 TTL，但仍与在途请求合并（C4）。只保留 ACTIVE 实例。 */
  async refresh(): Promise<ClientInstance[]> {
    this.instances = await this.directory.refresh(await this.authSession.getValidAccessToken())
    return this.instances
  }

  /**
   * 登录与登出：丢掉目录快照与技能包缓存。
   *
   * 注意它**没有**丢平台目录的 TTL 缓存——这是照搬 main.ts 今天的行为（登录/登出只清
   * `activeInstances` 与 `subscriptionRuntime`），Phase 4 不在结构调整里夹带行为修正。
   * 这个差异本身是个缺陷，紧随其后的 C10 提交会把两者合成一个入口。
   */
  reset(): void {
    this.instances = []
    this.subscriptionRuntime.invalidate()
  }

  /** 认证失效：连平台目录的 TTL 缓存一起丢。 */
  clear(): void {
    this.reset()
    this.directory.invalidate()
  }

  /**
   * 从快照解析运行配置。**禁止在这里发网络请求**——调度循环（`pump`）走的就是它，
   * 一次慢请求会让所有任务的准入全部停摆（C4）。
   */
  resolve(subscriptionId: string): EmployeeRuntimeConfig | null {
    const instance = this.instances.find(item => item.id === subscriptionId)
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
    this.instances = await this.directory.list(accessToken)
    const instance = this.instances.find(item => item.id === subscriptionId)
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

/**
 * 装配好的后端。IPC 处理器只跟它打交道，不再有模块级可变状态。
 * 用 `createBackend()` 创建——这个类不导出，避免出现第二个装配入口。
 */
class BackendRuntime {
  readonly authSession: AuthSessionManager
  readonly taskManager: TaskManager
  readonly taskRunStore: TaskRunStore
  readonly workflowStore: WorkflowStore
  readonly taskMetadataStore: TaskMetadataStore
  readonly employees: EmployeeAccess

  private readonly userDataDir: string
  private readonly renderer: RendererPort
  private readonly isEncryptionAvailable: () => boolean
  private readonly coordinator: LazyAsync<TaskExecutionCoordinator>
  private authenticationCleanup: Promise<void> | null = null

  constructor({ userDataDir, renderer, isEncryptionAvailable = () => true }: BackendOptions) {
    this.userDataDir = userDataDir
    this.renderer = renderer
    this.isEncryptionAvailable = isEncryptionAvailable
    this.coordinator = lazyAsync(() => this.loadTaskCoordinator())
    this.authSession = new AuthSessionManager()
    this.taskManager = new TaskManager(userDataDir, renderer)
    this.taskRunStore = new TaskRunStore(userDataDir)
    this.workflowStore = new WorkflowStore(userDataDir)
    this.taskMetadataStore = new TaskMetadataStore(userDataDir)
    this.employees = new EmployeeAccess(
      this.authSession,
      // 平台订阅目录：TTL 缓存 + 单飞，避免一个 run 打多次 /client/subscriptions（C4）。
      new InstanceDirectory(getInstances),
      join(userDataDir, 'runtime'),
    )
  }

  /**
   * 任务协调器。**全后端唯一保留的惰性加载**，且必须保持异步：
   * pi SDK 自带的 undici 依赖 Electron 33 默认没有的 Node API，
   * 只有先跑完 `common/undici-polyfill` 才能加载它。所以协调器只能在这里、
   * 在一个异步边界之后用动态 `import` 取，静态 import 会崩在启动路径上
   * （`markAsUncloneable is not a function`）。见 CLAUDE.md 的加载边界一节。
   *
   * 并发等待与失败重试的语义由 `common/lazy-async.ts` 唯一实现并单测覆盖——
   * 原来手写的两字段惰性单例在失败路径上会交给等待者一个 undefined。
   */
  getTaskCoordinator(): Promise<TaskExecutionCoordinator> {
    return this.coordinator.get()
  }

  /**
   * 已加载的协调器，没加载过就是 null。
   * 停机、登出、认证失效都只关心"有没有 run 要收"，不能因为一次查询而触发加载。
   */
  peekTaskCoordinator(): TaskExecutionCoordinator | null {
    return this.coordinator.peek()
  }

  /** 收干净所有在跑的 run。协调器没加载过就没有 run。 */
  async stopAll(): Promise<void> {
    await this.coordinator.peek()?.stopAll()
  }

  /**
   * 认证失效清理进行中。此时 token 已经作废、scope 还没清掉，是个半清理状态；
   * 任何任务操作都必须直接拒掉，不能在这个状态上继续写数据（C7）。
   */
  authenticationInvalidating(): boolean {
    return this.authenticationCleanup !== null
  }

  /** 当前 scope；没有登录（或正在清理）时为 null。 */
  currentScope(): TaskOwnerScope | null {
    return this.authenticationInvalidating() ? null : this.taskManager.getCurrentUserScope()
  }

  /** 登出：停 run、清 scope、丢目录快照与令牌。 */
  async signOut(): Promise<void> {
    await this.stopAll()
    this.taskManager.clearCurrentUser()
    this.employees.reset()
    this.authSession.clear()
  }

  /**
   * 令牌失效（401）：中止在跑的 run、清空 scope 与目录，再让渲染进程回到登录页。
   * 幂等——清理进行中重复触发直接返回。
   */
  invalidateAuthentication(): void {
    if (this.authenticationCleanup) return
    this.authenticationCleanup = (async () => {
      // C7：必须有界。stopAll 会等每个 active run 的 abort 与 completion，
      // 无界等待会让"重新登录"这件事永远卡住，且清理只做了一半（scope 还在，token 已废）。
      const stopped = await settleWithTimeout(
        this.stopAll(),
        AUTH_CLEANUP_BUDGET_MS,
        'authentication-cleanup-stop-all',
      )
      if (!stopped.ok) {
        log.error('failed to stop Pi during authentication cleanup', {
          timedOut: stopped.timedOut,
          budgetMs: AUTH_CLEANUP_BUDGET_MS,
          cause: stopped.timedOut ? undefined : describeError(stopped.error),
        })
      }
      try {
        this.taskManager.clearCurrentUser()
      } catch (error) {
        log.error('failed to clear task scope during authentication cleanup', {
          cause: describeError(error),
        })
      } finally {
        this.employees.clear()
        this.authSession.clear()
        this.renderer.authenticationRequired()
        this.authenticationCleanup = null
      }
    })()
  }

  private async loadTaskCoordinator(): Promise<TaskExecutionCoordinator> {
    if (!this.isEncryptionAvailable()) {
      log.warn('safeStorage encryption is not available on this platform')
    }
    const { TaskExecutionCoordinator } = await import('../runtime/task-execution-coordinator')
    const coordinator = new TaskExecutionCoordinator({
      taskManager: this.taskManager,
      getRefreshToken: () => this.authSession.getRefreshToken(),
      onAuthenticationRequired: () => this.invalidateAuthentication(),
      onEvent: event => this.renderer.taskEvent(event),
      onApprovalRequest: request => this.renderer.approvalRequest(request),
      resolveEmployee: subscriptionId => this.employees.resolve(subscriptionId),
      authorizeEmployee: subscriptionId => this.employees.authorize(subscriptionId),
      userDataDir: this.userDataDir,
    })
    log.info('task coordinator loaded')
    return coordinator
  }
}

export type Backend = BackendRuntime

/**
 * 装配后端并完成需要 await 的初始化。窗口必须在它成功之后才创建——
 * 否则用户拿到的是一个"能打开但坏掉"的应用（C3）。
 */
export async function createBackend(options: BackendOptions): Promise<Backend> {
  const backend = new BackendRuntime(options)
  await backend.taskManager.initialize()
  // 不记 userData 路径：里面有用户目录名（第 5.3 节）。
  log.info('backend assembled')
  return backend
}
