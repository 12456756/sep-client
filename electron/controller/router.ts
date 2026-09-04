/**
 * electron/controller/router.ts — 表驱动的 IPC 注册
 *
 * 全后端唯一出现 `ipcMain` 的地方（边界 B1）。它统一做五件事：
 *   1. 查表注册（`ipcMain.handle` / `ipcMain.on`）
 *   2. 跑 zod，失败即 `INVALID_ARGUMENT`
 *   3. 把校验后的入参交给 handler
 *   4. catch 之后交 `error-mapper`（唯一映射点）
 *   5. 按 route 声明的形态返回信封
 *
 * **不填 schema 就注册不了**——`route()` 的第二个参数是必填位置参数。这把项目约束
 * "校验所有渲染进程传入的参数"从"靠人记得"变成结构强制（方案 Phase 6）。
 */
import { ipcMain } from 'electron'
import { z } from 'zod'
import { logger } from '../common/logger'
import { appError } from '../errors/app-error'
import { authFailure, failure } from '../errors/error-mapper'
import { reportAuthFailure, reportFailure } from '../errors/error-reporter'
import type { InvokeChannel, SendChannel } from './channels'
import type { RequestContext } from './request-context'

const log = logger.child('router')

/** 无入参的通道：`ipcRenderer.invoke(channel)` 到主进程就是 undefined。 */
export const NO_INPUT = z.undefined()

/**
 * 失败信封的形态。三种都是既有行为，逐通道照搬，不做统一：
 *   - `authenticated`  标准信封 + `authenticated: true`。已登录之后的 401/403 含义是
 *     "会话失效，请重新登录"，而不是登录接口上的"账号密码不对"（error-mapper 的判断）。
 *   - `auth`           窄化成渲染进程声明的 `AuthError` 码集合（Phase 2 的 toAuthEnvelope）。
 *   - `ipc`            标准信封，不带 authenticated。
 *   - `reject`         **不捕获**，让 invoke 直接 reject。给的是那两个返回类型里
 *     根本没有 error 字段的通道（`RememberedAccountsResult` / `PasswordAvailabilityResult`）；
 *     塞信封进去要改 `src/shared/types.ts`，本轮不动前端（第 11 章）。
 */
export type ErrorShape = 'authenticated' | 'auth' | 'ipc' | 'reject'

export interface Route {
  readonly channel: InvokeChannel
  readonly schema: z.ZodType
  readonly handle: (ctx: RequestContext, input: never) => unknown
  /** 校验失败时给用户看的中文文案。不填就用错误码表的默认文案。 */
  readonly invalidMessage?: string
  readonly errorShape: ErrorShape
}

export interface RouteOptions {
  invalidMessage?: string
  errorShape?: ErrorShape
}

/**
 * 声明一条 invoke 路由。handler 的入参类型由 schema 自动推导，不用手写。
 * handler 返回的是**成功时的完整响应对象**——各通道的成功形态各不相同
 * （`{ success, task }`、`{ accounts, encryptionAvailable }`、`{ passwordAvailable }` …），
 * 路由器只管失败那一半，不去猜成功长什么样。
 */
export function route<TSchema extends z.ZodType>(
  channel: InvokeChannel,
  schema: TSchema,
  handle: (ctx: RequestContext, input: z.output<TSchema>) => unknown,
  options: RouteOptions = {},
): Route {
  return {
    channel,
    schema,
    handle: handle as Route['handle'],
    ...(options.invalidMessage === undefined ? {} : { invalidMessage: options.invalidMessage }),
    errorShape: options.errorShape ?? 'authenticated',
  }
}

/** renderer -> main 的单向通道。没有返回值，因此也没有信封。 */
export interface Listener {
  readonly channel: SendChannel
  readonly schema: z.ZodType
  readonly handle: (ctx: RequestContext, input: never) => void
}

export function listener<TSchema extends z.ZodType>(
  channel: SendChannel,
  schema: TSchema,
  handle: (ctx: RequestContext, input: z.output<TSchema>) => void,
): Listener {
  return { channel, schema, handle: handle as Listener['handle'] }
}

/**
 * 校验失败只记字段路径与 issue code，**绝不记值**——入参里可能有工作目录、
 * 任务描述这类用户内容（第 5.3 节）。
 */
function describeIssues(error: z.ZodError): { issues: string[] } {
  return { issues: error.issues.slice(0, 8).map(issue => `${issue.path.join('.') || '<root>'}:${issue.code}`) }
}

function toFailure(route: Route, error: unknown): unknown {
  switch (route.errorShape) {
    case 'auth':
      return reportAuthFailure(route.channel, error)
    case 'ipc':
      return reportFailure(route.channel, error)
    case 'reject':
      throw error
    default:
      return reportFailure(route.channel, error, { authenticated: true })
  }
}

export function registerRoutes(
  ctx: RequestContext,
  tables: { routes: readonly Route[]; listeners: readonly Listener[] },
): void {
  for (const entry of tables.routes) {
    ipcMain.handle(entry.channel, async (_event, raw: unknown) => {
      try {
        const parsed = entry.schema.safeParse(raw)
        if (!parsed.success) {
          log.warn('rejected invalid request', {
            channel: entry.channel,
            ...describeIssues(parsed.error),
          })
          // 校验失败不走 catch：它不是"操作失败"，没有技术 cause 可记。
          // 信封形态仍按 route 的声明来，否则 auth 通道会拿到一个契约外的码。
          if (entry.errorShape === 'reject') {
            throw appError('INVALID_ARGUMENT', { message: entry.invalidMessage })
          }
          return entry.errorShape === 'auth'
            ? authFailure('INVALID_ARGUMENT', entry.invalidMessage)
            : failure('INVALID_ARGUMENT', entry.invalidMessage)
        }
        return await entry.handle(ctx, parsed.data as never)
      } catch (error) {
        return toFailure(entry, error)
      }
    })
  }

  for (const entry of tables.listeners) {
    ipcMain.on(entry.channel, (_event, raw: unknown) => {
      const parsed = entry.schema.safeParse(raw)
      if (!parsed.success) {
        // 单向通道没有回程，校验失败只能记日志——静默丢弃过的正是 C5 那类问题。
        log.warn('discarded invalid message', {
          channel: entry.channel,
          ...describeIssues(parsed.error),
        })
        return
      }
      entry.handle(ctx, parsed.data as never)
    })
  }

  log.info('ipc routes registered', {
    invoke: tables.routes.length,
    send: tables.listeners.length,
  })
}
