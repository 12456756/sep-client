/**
 * 后端组合根。
 *
 * 所有存储、服务和运行时依赖都在这里绑定。除运行时的惰性加载外，业务模块不创建
 * 隐藏单例，因此入口、生命周期和依赖方向都能从这个文件追踪。
 */
import { join } from 'node:path'
import { AuthSessionManager } from '../common/platform/auth-session-manager'
import { getSubscriptions } from '../common/platform/platform-api'
import { config } from '../common/config'
import { loadOnce, type LazyAsync } from '../common/load-once'
import { logger } from '../common/logger'
import { describeError } from '../common/redact'
import { settleWithTimeout } from '../common/with-timeout'
import { SkillVersionStore } from '../data/skill-version-store'
import { TaskMetadataStore } from '../data/task-metadata-store'
import { TaskRunStore } from '../data/task-run-store'
import { WorkPlanStore } from '../data/work-plan-store'
import { ArrangementCheckpointStore } from '../data/arrangement-checkpoint-store'
import { SkillPackageStore } from '../pi/sdk/pi-skill-packages'
// 必须是 import type：静态加载运行时会把 pi SDK 拉到兼容层之前，
// Electron 33 上以 `markAsUncloneable is not a function` 崩在启动路径。
import type { TaskRuntime } from '../runtime/task-runtime'
import { TaskManager } from '../runtime/task-manager'
import type { RendererPort } from '../runtime/task-notifier'
import type { TaskOwnerScope } from '../data/scope-path'
import { EmployeeAuthorizer } from '../service/employee-authorizer'
import { EmployeeDirectory } from '../service/employee-directory'
import { ConversationService } from '../service/conversation-service'
import { TaskService } from '../service/task-service'
import { ArrangementService } from '../service/arrangement-service'
import { ArrangementDraftStore } from '../data/arrangement-draft-store'

const log = logger.child('build-backend')

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
 * 装配好的后端。IPC 处理器只跟它打交道，不再有模块级可变状态。
 * 用 `createBackend()` 创建——这个类不导出，避免出现第二个装配入口。
 */
class BackendRuntime {
  readonly authSession: AuthSessionManager
  readonly taskManager: TaskManager
  readonly taskRunStore: TaskRunStore
  readonly taskMetadataStore: TaskMetadataStore
  readonly employees: EmployeeAuthorizer
  readonly tasks: TaskService
  readonly conversations: ConversationService
  readonly arrangements: ArrangementService

  private readonly workPlans: WorkPlanStore
  private readonly arrangementCheckpoints: ArrangementCheckpointStore
  private readonly userDataDir: string
  private readonly renderer: RendererPort
  private readonly isEncryptionAvailable: () => boolean
  private readonly runtime: LazyAsync<TaskRuntime>
  private authenticationCleanup: Promise<void> | null = null

  constructor({ userDataDir, renderer, isEncryptionAvailable = () => true }: BackendOptions) {
    this.userDataDir = userDataDir
    this.renderer = renderer
    this.isEncryptionAvailable = isEncryptionAvailable
    this.runtime = loadOnce(() => this.loadTaskRuntime())
    this.authSession = new AuthSessionManager()
    this.taskManager = new TaskManager(userDataDir, renderer)
    this.taskRunStore = new TaskRunStore(userDataDir)
    this.taskMetadataStore = new TaskMetadataStore(userDataDir)
    const arrangementDrafts = new ArrangementDraftStore(userDataDir)
    this.workPlans = new WorkPlanStore(userDataDir)
    this.arrangementCheckpoints = new ArrangementCheckpointStore(userDataDir)
    this.employees = new EmployeeAuthorizer(
      this.authSession,
      // 全后端唯一的平台目录读取点：TTL 缓存 + 单飞，
      // 避免一个 run 打多次 /client/subscriptions（C4）。
      new EmployeeDirectory(getSubscriptions),
      // 技能包准备经端口注入——B2 不允许 service/ 直接依赖 pi/。
      new SkillPackageStore(join(userDataDir, 'runtime'), new SkillVersionStore(join(userDataDir, 'skill-data', 'v1'))),
      config.SEP_GATEWAY_URL,
    )

    // 服务只拿到作用域、数据存取和执行端口；运行时实现继续由组合根延迟加载。
    const shared = {
      scope: this,
      taskManager: this.taskManager,
      taskMetadataStore: this.taskMetadataStore,
      employees: this.employees,
      execution: () => this.getTaskRuntime(),
    }
    this.tasks = new TaskService({ ...shared, taskRunStore: this.taskRunStore })
    this.conversations = new ConversationService({ ...shared, tasks: this.tasks })
    this.arrangements = new ArrangementService({
      scope: this,
      drafts: arrangementDrafts,
      employees: this.employees,
      workPlans: this.workPlans,
      taskMetadata: this.taskMetadataStore,
      taskManager: this.taskManager,
      execution: () => this.getTaskRuntime(),
    })
  }

  /**
   * 获取任务运行时。它必须保持异步：
   * pi SDK 自带的 undici 依赖 Electron 33 默认没有的 Node API，
   * 只有先跑完 `common/undici-polyfill` 才能加载 Pi 依赖。所以运行时只能在这里、
   * 在一个异步边界之后用动态 `import` 取，静态 import 会崩在启动路径上
   * （`markAsUncloneable is not a function`）。见 CLAUDE.md 的加载边界一节。
   *
   * 并发等待与失败重试的语义由 `common/load-once.ts` 唯一实现并单测覆盖——
   * 原来手写的两字段惰性单例在失败路径上会交给等待者一个 undefined。
   */
  getTaskRuntime(): Promise<TaskRuntime> {
    return this.runtime.get()
  }

  /**
   * 已加载的运行时，没加载过就是 null。
   * 停机、登出、认证失效都只关心"有没有 run 要收"，不能因为一次查询而触发加载。
   */
  peekTaskRuntime(): TaskRuntime | null {
    return this.runtime.peek()
  }

  /** 收干净所有在跑的 run。运行时没加载过就没有 run。 */
  async stopAll(): Promise<void> {
    await this.runtime.peek()?.stopAll()
  }

  /**
   * 认证失效清理进行中。此时 token 已经作废、scope 还没清掉，是个半清理状态；
   * 任何任务操作都必须直接拒掉，不能在这个状态上继续写数据（C7）。
   *
   * 私有：外部只该问 `currentScope()`，这个判断是它的一部分——留成公开方法就等于
   * 邀请调用方自己拼"先判失效中、再取 scope"，那正是 12 处重复守卫的来路。
   */
  private authenticationInvalidating(): boolean {
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
    this.employees.clear()
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

  private async loadTaskRuntime(): Promise<TaskRuntime> {
    if (!this.isEncryptionAvailable()) {
      log.warn('safeStorage encryption is not available on this platform')
    }
    const { TaskRuntime } = await import('../runtime/task-runtime')
    const runtime = new TaskRuntime({
      taskManager: this.taskManager,
      getRefreshToken: () => this.authSession.getRefreshToken(),
      onAuthenticationRequired: () => this.invalidateAuthentication(),
      onEvent: event => this.renderer.taskEvent(event),
      onApprovalRequest: request => this.renderer.approvalRequest(request),
      resolveEmployee: subscriptionId => this.employees.resolve(subscriptionId),
      authorizeEmployee: subscriptionId => this.employees.authorize(subscriptionId),
      userDataDir: this.userDataDir,
      // 必须显式注入：运行时的默认值是 `process.cwd()`，打包后那是安装目录，
      // 而这个根被用作 workDir 为空时的兜底（workspaceDir 与 .pi-runs/.pi-sessions），
      // 也就是 pi 真正落文件的位置。指向 TaskManager 放默认工作区的同一棵树。
      getTaskWorkspaceRoot: () => join(this.userDataDir, 'task-workspaces'),
      workPlanStore: this.workPlans,
      arrangementCheckpointStore: this.arrangementCheckpoints,
    })
    log.info('task runtime loaded')
    return runtime
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
