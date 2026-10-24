import { NotificationService } from '../service/notification-service'
import { NotificationSocket } from '../common/platform/notification-socket'
import { SkillSubmissionStore } from '../data/skill-submission-store'
import { SkillLibraryService } from '../service/skill-library-service'
import { KnowledgeService } from '../service/knowledge-service'
import { KnowledgeApi } from '../common/platform/knowledge-api'
/**
 * 后端组合根。
 *
 * 所有存储、服务和运行时依赖都在这里绑定。除运行时的惰性加载外，业务模块不创建
 * 隐藏单例，因此入口、生命周期和依赖方向都能从这个文件追踪。
 */
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { shell, systemPreferences } from 'electron'
import { SpeechSystemAccess } from './speech-system-access'
import { AuthSessionManager } from '../common/platform/auth-session-manager'
import { EmploymentTokenManager } from '../common/platform/employment-token-manager'
import { getSubscriptions, getEmployeeRuntime, getEnterpriseOverview, getAllPlatformEmployees, createEmployeeAccessRequest, getEmployeeAccessRequest, getEmployeeSkills, listSkillVersions, previewSkill, createPersonalSkillVersion } from '../common/platform/platform-api'
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
import { SkillStore } from '../pi/sdk/pi-skill-packages'
// 必须是 import type：静态加载运行时会把 pi SDK 拉到兼容层之前，
// Electron 33 上以 `markAsUncloneable is not a function` 崩在启动路径。
import type { TaskRuntime } from '../runtime/task-runtime'
import { TaskManager } from '../runtime/task-manager'
import type { RendererPort } from '../runtime/task-notifier'
import type { ArrangementPlannerPort } from '../domain/arrangement-planner'
import type { TaskOwnerScope } from '../data/scope-path'
import { EmployeeAuthorizer } from '../service/employee-authorizer'
import { EmployeeDirectory } from '../service/employee-directory'
import { ConversationService } from '../service/conversation-service'
import { TaskService } from '../service/task-service'
import { TaskCreationGate } from '../service/task-creation-gate'
import { ArrangementService } from '../service/arrangement-service'
import { ArrangementDraftStore } from '../data/arrangement-draft-store'
import { ClientMonitorApi } from '../common/platform/client-monitor-api'
import { ClientMonitorStore } from '../data/client-monitor-store'
import { ConversationContextStore } from '../domain/conversation-context'
import { ClientMonitorHistoryService } from '../service/client-monitor-history-service'
import { ClientMonitorService } from '../service/client-monitor-service'
import { MediaStore } from '../data/media-store'
import { ArrangementMediaLinkStore } from '../data/arrangement-media-link-store'
import { ArrangementMediaAssets } from '../data/arrangement-media-assets'
import { ArrangementMediaService } from '../service/arrangement-media-service'
import { MediaService } from '../service/media-service'
import { SpeechService } from '../service/speech-service'
import { SpeechSettingsStore } from '../data/speech-settings-store'
import type { SpeechRuntimePort } from '../domain/speech'
import { SepRealMediaGateway } from '../data/sep-real-media-gateway'
import type { MediaGatewayPort } from '../domain/media'
import { VideoStore } from '../data/video-store'
import { SepMockVideoGateway, SepRealVideoGateway } from '../data/sep-video-media-gateway'
import { createVideoScopeAdapter } from '../data/video-scope-adapter'
import { MockVideoHostService, type MockVideoHostOptions } from '../service/mock-video-host-service'
import { VideoRunService } from '../service/video-run-service'
import { AppError } from '../errors/app-error'
import { DocumentPreviewService } from '../service/document-preview-service'
import { DocumentPreviewStore } from '../data/document-preview-store'
import type { DocumentPreviewRuntime } from '../runtime/document-preview-runtime'

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
  /** Explicit local/test adapter until SEP media HTTP schemas are finalized. */
  mediaGateway?: MediaGatewayPort
  mediaCapabilities?: import('../service/media-service').MediaServiceOptions['capabilities']
}

/**
 * 装配好的后端。IPC 处理器只跟它打交道，不再有模块级可变状态。
 * 用 `createBackend()` 创建——这个类不导出，避免出现第二个装配入口。
 */
class BackendRuntime {
  readonly knowledge: KnowledgeService
  readonly authSession: AuthSessionManager
  readonly taskManager: TaskManager
  readonly taskRunStore: TaskRunStore
  readonly taskMetadataStore: TaskMetadataStore
  readonly employees: EmployeeAuthorizer
  readonly tasks: TaskService
  readonly conversations: ConversationService
  readonly arrangements: ArrangementService
  readonly documentPreviews: DocumentPreviewService
  private readonly documentPreviewRuntime: LazyAsync<DocumentPreviewRuntime>
  readonly skills: SkillLibraryService
  readonly clientMonitor: ClientMonitorService
  readonly notifications: NotificationService
  readonly media: MediaService
  readonly speech: SpeechService
  private readonly speechRuntime: LazyAsync<SpeechRuntimePort>
  readonly video?: MockVideoHostService
  private readonly videoRuns?: VideoRunService
  private readonly arrangementMedia: ArrangementMediaService

  private readonly workPlans: WorkPlanStore
  private readonly arrangementCheckpoints: ArrangementCheckpointStore
  private readonly userDataDir: string
  private readonly renderer: RendererPort
  private readonly isEncryptionAvailable: () => boolean
  private readonly runtime: LazyAsync<TaskRuntime>
  private readonly arrangementPlanner: LazyAsync<ArrangementPlannerPort>
  private readonly employmentTokens = new Map<string, { manager: EmploymentTokenManager; initialized: Promise<void> }>()
  private authenticationCleanup: Promise<void> | null = null

  constructor({ userDataDir, renderer, isEncryptionAvailable = () => true, mediaGateway, mediaCapabilities }: BackendOptions) {
    this.userDataDir = userDataDir
    this.renderer = renderer
    this.isEncryptionAvailable = isEncryptionAvailable
    this.runtime = loadOnce(() => this.loadTaskRuntime())
    this.arrangementPlanner = loadOnce(() => this.loadArrangementPlanner())
    this.documentPreviewRuntime = loadOnce(async () => (await import('./create-document-preview-runtime')).createDocumentPreviewRuntime())
    this.speechRuntime = loadOnce(async () => (await import('./create-speech-runtime')).createSpeechRuntime())
    this.speech = new SpeechService({
      scope: this, settings: new SpeechSettingsStore(userDataDir),
      microphone: new SpeechSystemAccess({
        platform: process.platform,
        status: () => systemPreferences.getMediaAccessStatus('microphone'),
        request: () => systemPreferences.askForMediaAccess('microphone'),
        open: url => shell.openExternal(url),
      }),
      runtime: () => this.speechRuntime.get(), stopRuntime: () => this.speechRuntime.peek()?.stop(),
    })
    this.authSession = new AuthSessionManager()
    this.knowledge = new KnowledgeService({
      scope: this,
      api: new KnowledgeApi({ getAccessToken: force => this.authSession.getValidAccessToken(force) }),
      onAuthenticationRequired: () => this.invalidateAuthentication(),
    })
    this.authSession.subscribeAccessToken(token => { if (token === null) this.knowledge.clear() })
    const realMediaGateway = mediaGateway ?? new SepRealMediaGateway({
      baseUrl: config.SEP_BASE_URL,
      token: (subscriptionId, signal) => this.getEmploymentToken(subscriptionId, signal),
    })
    this.notifications = new NotificationService({
      scope: this,
      getAccessToken: forceRefresh => this.authSession.getValidAccessToken(forceRefresh),
      onAuthenticationRequired: () => this.invalidateAuthentication(),
      onUpdate: event => this.renderer.notificationUpdated?.(event),
      createSocket: onMessage => new NotificationSocket({
        baseUrl: config.SEP_BASE_URL,
        origin: config.SEP_WEB_ORIGIN,
        getAccessToken: forceRefresh => this.authSession.getValidAccessToken(forceRefresh),
        subscribeAccessToken: callback => this.authSession.subscribeAccessToken(callback),
        onAuthenticationRequired: () => this.invalidateAuthentication(),
        onMessage,
      }),
    })
    this.taskManager = new TaskManager(userDataDir, renderer)
    this.taskRunStore = new TaskRunStore(userDataDir)
    this.clientMonitor = new ClientMonitorService({
      store: new ClientMonitorStore(userDataDir),
      api: new ClientMonitorApi({
        getAccessToken: forceRefresh => this.authSession.getValidAccessToken(forceRefresh),
        baseUrl: config.SEP_BASE_URL,
        scopeProvider: () => this.currentScope(),
      }),
      history: new ClientMonitorHistoryService({
        scopeProvider: () => this.currentScope(),
        listTasks: () => this.taskManager.getAllTasks(),
        listRuns: (scope, taskId) => this.taskRunStore.list(scope, taskId),
        listMessages: (scope, taskId) => new ConversationContextStore(this.taskRunStore.getTaskDir(scope, taskId)).listMessages(),
        getTimeline: (scope, taskId, runId) => this.taskRunStore.events.getTimeline(scope, taskId, runId),
        taskType: async (scope, taskId) => {
          const diagnostic = await this.workPlans.diagnose(scope, taskId)
          if (diagnostic.state === 'unavailable') throw new Error('Monitoring work plan is unavailable for inspection.')
          const plan = diagnostic.state === 'found' ? diagnostic.value : null
          return plan && plan.mode !== 'conversation' ? 'arrangement' : 'conversation'
        },
      }),
      scopeProvider: () => this.currentScope(),
      clientVersion: config.CLIENT_VERSION,
    })
    this.taskMetadataStore = new TaskMetadataStore(userDataDir)
    const arrangementDrafts = new ArrangementDraftStore(userDataDir)
    this.workPlans = new WorkPlanStore(userDataDir)
    this.arrangementCheckpoints = new ArrangementCheckpointStore(userDataDir)
    const skillVersions = new SkillVersionStore(join(userDataDir, 'skill-data', 'v1'))
    this.employees = new EmployeeAuthorizer(
      this.authSession,
      // 全后端唯一的平台目录读取点：TTL 缓存 + 单飞，
      // 避免一个 run 打多次 /client/subscriptions（C4）。
      new EmployeeDirectory(getSubscriptions),
      // 技能准备经端口注入——B2 不允许 service/ 直接依赖 pi/。
      new SkillStore(join(userDataDir, 'runtime'), skillVersions),
      config.SEP_GATEWAY_URL,
      { getRuntime: getEmployeeRuntime },
    )

    const mediaStore = new MediaStore(userDataDir)
    this.media = new MediaService({
      scope: this,
      store: mediaStore,
      gateway: realMediaGateway,
      capabilities: mediaCapabilities,
      getTask: taskId => this.taskManager.getTask(taskId),
      authorize: subscriptionId => this.employees.authorizeRuntime(subscriptionId),
      requestApproval: async input => (await this.getTaskRuntime()).requestMediaApproval(input),
      policy: async taskId => {
        const scope = this.currentScope()
        if (!scope) return undefined
        const plan = await this.workPlans.get(scope, taskId)
        if (!plan) return undefined
        const task = await this.taskManager.getTask(taskId)
        return { ...plan.permissions, approvalMode: plan.permissions.approvalMode ?? 'confirm-each', workspaceDir: task?.workDir ?? join(userDataDir, 'task-workspaces') }
      },
    })

    const videoStore = config.SEP_VIDEO_MOCK_ENABLED || config.SEP_VIDEO_REAL_ENABLED ? new VideoStore(userDataDir) : undefined
    if (videoStore) {
      const store = videoStore
      const videoOptions: MockVideoHostOptions = {
        mock: !config.SEP_VIDEO_REAL_ENABLED, scope: this, store,
        arrangementMediaLinks: new ArrangementMediaLinkStore(userDataDir),
        getTask: taskId => this.taskManager.getTask(taskId),
        authorize: async (subscriptionId, signal) => {
          signal.throwIfAborted()
          const employee = await this.employees.authorizeRuntime(subscriptionId)
          signal.throwIfAborted()
          return employee?.video
        },
        authorizationRevision: () => this.employees.getAuthorizationRevision(),
        localAuthorizationRevision: () => this.employees.getLocalAuthorizationRevision(),
        recoveryAuthorizationRevision: () => this.employees.getRecoveryAuthorizationRevision(),
        localRuntime: subscriptionId => this.employees.resolveVideo(subscriptionId),
        authorizeRecovery: async (subscriptionId, signal) => {
          signal.throwIfAborted()
          if (!await this.employees.authorizeRecovery(subscriptionId)) throw new AppError('PERMISSION_DENIED')
          signal.throwIfAborted()
        },
        gateway: scope => {
          const transport = { baseUrl: config.SEP_BASE_URL, subscriptionId: scope.subscriptionId,
            token: (subscriptionId: string, signal: AbortSignal) => this.getEmploymentToken(subscriptionId, signal) }
          return config.SEP_VIDEO_REAL_ENABLED ? new SepRealVideoGateway({ ...transport, mock: false }) : new SepMockVideoGateway({ ...transport, mock: true })
        },
        ...createVideoScopeAdapter(userDataDir, mediaStore, store, async path => {
          const error = await shell.openPath(path)
          if (error) throw new Error('Local video player unavailable.')
        }),
        requestApproval: async input => (await this.getTaskRuntime()).requestMediaApproval(input),
        policy: async taskId => {
          const scope = this.currentScope()
          if (!scope) return undefined
          const plan = await this.workPlans.get(scope, taskId)
          if (!plan) return undefined
          const task = await this.taskManager.getTask(taskId)
          return { ...plan.permissions, approvalMode: plan.permissions.approvalMode ?? 'confirm-each', workspaceDir: task?.workDir ?? join(userDataDir, 'task-workspaces') }
        },
      }
      this.video = new MockVideoHostService(videoOptions)
      this.videoRuns = new VideoRunService(videoOptions, this.video)
    }
    this.arrangementMedia = new ArrangementMediaService({
      scope: this, plans: this.workPlans, checkpoints: this.arrangementCheckpoints, runs: this.taskRunStore,
      links: new ArrangementMediaLinkStore(userDataDir), images: mediaStore, videos: videoStore,
      assets: new ArrangementMediaAssets(userDataDir, mediaStore, videoStore), media: this.media,
      getTask: taskId => this.taskManager.getTask(taskId),
    })

    this.skills = new SkillLibraryService({
      scope: this, token: () => this.authSession.getValidAccessToken(),
      subscriptions: () => this.employees.list(), versions: skillVersions,
      submissions: new SkillSubmissionStore(userDataDir),
      platform: { skills: getEmployeeSkills, list: listSkillVersions, preview: previewSkill, create: createPersonalSkillVersion },
    })

    // 服务只拿到作用域、数据存取和执行端口；运行时实现继续由组合根延迟加载。
    const creationGate = new TaskCreationGate()
    const shared = {
      scope: this,
      taskManager: this.taskManager,
      taskMetadataStore: this.taskMetadataStore,
      employees: this.employees,
      execution: () => this.getTaskRuntime(),
    }
    this.tasks = new TaskService({ ...shared, taskRunStore: this.taskRunStore, workPlans: this.workPlans, creationGate, media: this.media })
    this.conversations = new ConversationService({ ...shared, tasks: this.tasks })
    const previewFiles = new DocumentPreviewStore(userDataDir, this.workPlans, this.arrangementCheckpoints)
    this.documentPreviews = new DocumentPreviewService({
      scope: this,
      getDelivery: (...args) => previewFiles.getDelivery(...args),
      read: (...args) => previewFiles.read(...args),
      render: (format, bytes, validate) => this.documentPreviewRuntime.get().then(runtime => { validate(); return runtime.render(format, bytes) }),
      stop: () => this.documentPreviewRuntime.peek()?.stop(),
    })
    const platformSession = this.authSession
    this.arrangements = new ArrangementService({
      scope: this,
      drafts: arrangementDrafts,
      employees: this.employees,
      workPlans: this.workPlans,
      taskMetadata: this.taskMetadataStore,
      taskManager: this.taskManager,
      arrangementCheckpoints: this.arrangementCheckpoints,
      arrangementMediaLinks: new ArrangementMediaLinkStore(userDataDir),
      arrangementMediaAssets: new ArrangementMediaAssets(userDataDir, mediaStore, videoStore),
      mediaStore,
      videoStore,
      creationGate,
      execution: () => this.getTaskRuntime(),
      planner: {
        plan: input => this.arrangementPlanner.get().then(planner => planner.plan(input)),
        cancel: planningId => { this.arrangementPlanner.peek()?.cancel?.(planningId) },
      },
      onPlanningEvent: event => this.renderer.arrangementPlanningEvent(event),
      employeeAccessRequests: {
        async create(input, idempotencyKey) {
          const accessToken = await platformSession.getValidAccessToken()
          return createEmployeeAccessRequest(input, idempotencyKey, accessToken)
        },
        async get(requestId) {
          const accessToken = await platformSession.getValidAccessToken()
          return getEmployeeAccessRequest(requestId, accessToken)
        },
      },
      employeeCapabilities: {
        async list(employeeId) {
          const accessToken = await platformSession.getValidAccessToken()
          const response = await getEmployeeSkills(employeeId, accessToken)
          return response.skills.map(skill => ({
            id: skill.capability.id,
            name: skill.capability.name,
            description: skill.capability.description,
            type: skill.capability.type,
          }))
        },
      },
      candidateEmployees: {
        async listEnterprise() {
          const accessToken = await platformSession.getValidAccessToken()
          const overview = await getEnterpriseOverview(accessToken)
          const candidates = overview.employees
            .filter(employee => employee.status === 'ACTIVE' && employee.active && !employee.currentUserCanUse)
          return Promise.all(candidates.map(async employee => {
            let capabilities = employee.capabilities?.map(capability => ({ ...capability })) ?? []
            if (!employee.capabilities) {
              try {
                const response = await getEmployeeSkills(employee.employeeId, accessToken)
                capabilities = response.skills.map(skill => ({
                  id: skill.capability.id,
                  name: skill.capability.name,
                  description: skill.capability.description,
                  type: skill.capability.type,
                }))
              } catch (error) {
                log.warn('enterprise candidate capability summary unavailable', {
                  employeeId: employee.employeeId,
                  errorType: describeError(error).slice(0, 120),
                })
              }
            }
            return {
              subscriptionId: employee.subscriptionId,
              employeeId: employee.employeeId,
              name: employee.name,
              description: employee.description,
              position: employee.position,
              capabilities,
              allowedModels: [],
              status: employee.status,
              source: 'enterprise' as const,
              canExecute: false,
              canApply: true,
            }
          }))
        },
        async listPlatform() {
          const accessToken = await platformSession.getValidAccessToken()
          const employees = await getAllPlatformEmployees(accessToken)
          return employees
            .filter(employee => employee.employeeStatus === 'APPROVED' && employee.canApply && employee.availability === 'AVAILABLE')
            .map(employee => ({
              subscriptionId: `platform:${employee.employeeId}`,
              employeeId: employee.employeeId,
              name: employee.name,
              description: employee.description,
              position: employee.position,
              functionalCategory: employee.functionalCategory ?? undefined,
              capabilities: employee.capabilities,
              allowedModels: [],
              status: employee.employeeStatus,
              source: 'platform' as const,
              canExecute: false,
              canApply: employee.canApply,
            }))
        },
      },
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
    this.knowledge.clear()
    this.documentPreviews.clear()
    this.speech.stop()
    this.notifications.stop()
    for (const entry of this.employmentTokens.values()) entry.manager.stop()
    this.employmentTokens.clear()
    await this.media.stopAll()
    await this.videoRuns?.stopAll()
    await this.runtime.peek()?.stopAll()
    await this.clientMonitor.stop()
  }

  async resumeClientMonitor(): Promise<void> {
    await this.clientMonitor.resumePending()
    await this.media.resumePending()
    if (this.video) await this.video.resumePending((await this.taskManager.getAllTasks()).map(task => task.id))
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
    this.knowledge.clear()
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

  private async loadArrangementPlanner(): Promise<ArrangementPlannerPort> {
    const { PiArrangementPlanner } = await import('../runtime/pi-arrangement-planner')
    return new PiArrangementPlanner({
      gatewayUrl: config.SEP_GATEWAY_URL,
      workspaceRoot: join(this.userDataDir, 'arrangement-planning'),
      getRefreshToken: () => this.authSession.getRefreshToken(),
      onAuthenticationRequired: () => this.invalidateAuthentication(),
    })
  }

  private async getEmploymentToken(subscriptionId: string, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted()
    let entry = this.employmentTokens.get(subscriptionId)
    if (!entry) {
      const manager = new EmploymentTokenManager({ getRefreshToken: () => this.authSession.getRefreshToken() })
      entry = { manager, initialized: manager.initialize(subscriptionId) }
      this.employmentTokens.set(subscriptionId, entry)
    }
    try { await entry.initialized } catch (error) {
      if (this.employmentTokens.get(subscriptionId) === entry) this.employmentTokens.delete(subscriptionId)
      entry.manager.stop()
      throw error
    }
    signal.throwIfAborted()
    return entry.manager.getValidToken()
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
      authorizeEmployee: (subscriptionId, modelId) => this.employees.authorize(subscriptionId, modelId),
      userDataDir: this.userDataDir,
      // 必须显式注入：运行时的默认值是 `process.cwd()`，打包后那是安装目录，
      // 而这个根被用作 workDir 为空时的兜底（workspaceDir 与 .pi-runs/.pi-sessions），
      // 也就是 pi 真正落文件的位置。指向 TaskManager 放默认工作区的同一棵树。
      getTaskWorkspaceRoot: () => join(this.userDataDir, 'task-workspaces'),
      workPlanStore: this.workPlans,
      arrangementCheckpointStore: this.arrangementCheckpoints,
      monitor: this.clientMonitor,
      knowledgeSearch: (query, signal) => this.knowledge.execute({
        action: 'search', requestId: randomUUID(), query, topK: 5,
      }, signal),
      media: this.media,
      video: this.videoRuns,
      arrangementMedia: this.arrangementMedia,
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
