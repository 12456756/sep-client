/**
 * electron/controller/request-context.ts — RequestContext
 *
 * route handler 能看到的全部东西。这里不暴露 scope；服务层通过 scope guard 读取它，
 * 这样所有业务入口共享同一套认证失效语义。
 */
import type { BrowserWindow } from 'electron'
import type { AppUpdater } from '../bootstrap/app-updater'
import type { Backend } from '../bootstrap/build-backend'
import type { MockVideoHostService } from '../service/mock-video-host-service'

export interface RequestContext {
  readonly knowledge: Backend['knowledge']
  /** 服务层句柄。任务类路由只该用这几个。 */
  readonly notifications: Backend['notifications']
  readonly skills: Backend['skills']
  readonly tasks: Backend['tasks']
  readonly conversations: Backend['conversations']
  readonly arrangements: Backend['arrangements']
  readonly employees: Backend['employees']
  readonly media: Backend['media']
  readonly speech: Backend['speech']
  /** Explicit opt-in composition only; isolated harnesses may override it. */
  readonly video?: MockVideoHostService
  /**
   * 后端本体。auth 与 system 路由需要它的生命周期能力：登录要 `stopAll` +
   * `setCurrentUser`，登出要 `signOut`，401 要 `invalidateAuthentication`。
   * 任务类路由不该碰它——它们的入口是上面的服务句柄。
   */
  readonly backend: Backend
  /** 自动更新独立于登录会话；未组装时路由返回普通 IPC 错误。 */
  readonly updater?: AppUpdater
  /** 需要父窗口的原生弹框（目录选择）用它。 */
  readonly window: () => BrowserWindow | null
}

export function createRequestContext(
  backend: Backend,
  window: () => BrowserWindow | null,
  updater?: AppUpdater,
  video?: MockVideoHostService,
): RequestContext {
  return {
    knowledge: backend.knowledge,
    notifications: backend.notifications,
    skills: backend.skills,
    tasks: backend.tasks,
    conversations: backend.conversations,
    arrangements: backend.arrangements,
    employees: backend.employees,
    media: backend.media,
    speech: backend.speech,
    video: video ?? backend.video,
    backend,
    updater,
    window,
  }
}


