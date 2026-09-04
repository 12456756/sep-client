/**
 * electron/controller/request-context.ts — RequestContext
 *
 * route handler 能看到的全部东西。**不含 scope**：scope 的唯一解析点是
 * `service/scope-guard.ts`（Phase 5 把它做成"服务层内部抛 AppError"），
 * 在这里再放一份就等于第二个定义点，正是方案 0.1 节原则 3 要消掉的东西。
 * 方案 3.2 节写的是"RequestContext：scope + 各服务句柄"，那份设计早于 Phase 5 的决定。
 */
import type { BrowserWindow } from 'electron'
import type { Backend } from '../bootstrap/build-backend'

export interface RequestContext {
  /** 服务层句柄。任务类路由只该用这几个。 */
  readonly tasks: Backend['tasks']
  readonly conversations: Backend['conversations']
  readonly workflows: Backend['workflows']
  readonly employees: Backend['employees']
  /**
   * 后端本体。auth 与 system 路由需要它的生命周期能力：登录要 `stopAll` +
   * `setCurrentUser`，登出要 `signOut`，401 要 `invalidateAuthentication`。
   * 任务类路由不该碰它——它们的入口是上面的服务句柄。
   */
  readonly backend: Backend
  /** 需要父窗口的原生弹框（目录选择）用它。 */
  readonly window: () => BrowserWindow | null
}

export function createRequestContext(
  backend: Backend,
  window: () => BrowserWindow | null,
): RequestContext {
  return {
    tasks: backend.tasks,
    conversations: backend.conversations,
    workflows: backend.workflows,
    employees: backend.employees,
    backend,
    window,
  }
}
