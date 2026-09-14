/**
 * electron/errors/error-reporter.ts — 脱敏上报 + 进程级兜底 + 致命错误提示
 *
 * 三件事：
 *   1. reportError：按错误码表决定日志级别，把技术细节记到日志、把中文信封交回调用方。
 *      级别由表决定，不由调用方临时拍。
 *   2. installProcessHandlers：接住 unhandledRejection / uncaughtException。
 *      当前进程完全没有注册这两个，一条漏掉的拒绝就是静默失败。
 *   3. reportFatal：初始化失败要让用户看见，而不是留一个"能打开但坏掉"的窗口。
 *      弹框实现由外部注入，本模块不依赖 electron，才能脱离 Electron 单测。
 */
import { logger, type LogFields } from '../common/logger'
import { describeError } from '../common/redact'
import { errorCodeSpec } from './error-codes'
import { AppError } from './app-error'
import { authFailureFrom, toEnvelope, type IpcErrorEnvelope, type IpcFailure } from './error-mapper'
import type { AuthError } from '../../src/shared/types'

const log = logger.child('errors')

export type FatalPresenter = (title: string, message: string) => void

let presentFatal: FatalPresenter | null = null

/** 注入致命错误的呈现方式（主进程注入 dialog.showErrorBox）。 */
export function setFatalPresenter(presenter: FatalPresenter | null): void {
  presentFatal = presenter
}

/**
 * 记录错误并返回可以直接回给渲染进程的中文信封。
 * `operation` 是调用点标识（通道名或用例名），进日志不进载荷。
 */
export function reportError(
  operation: string,
  error: unknown,
  context: LogFields & { authenticated?: boolean } = {},
): IpcErrorEnvelope {
  const { authenticated, ...fields } = context
  const result = toEnvelope(error, { authenticated })
  const spec = errorCodeSpec(result.code)
  const payload: LogFields = {
    ...fields,
    operation,
    code: result.code,
    cause: describeError(error),
    ...(error instanceof AppError && error.details ? { details: error.details } : {}),
  }
  if (spec.level === 'error') log.error('operation failed', payload)
  else log.warn('operation failed', payload)
  return result
}

/** reportError 的信封包装，handler 的 catch 直接 return 它。 */
export function reportFailure(
  operation: string,
  error: unknown,
  context: LogFields & { authenticated?: boolean } = {},
): IpcFailure {
  return { success: false, error: reportError(operation, error, context) }
}

/** auth 通道版本：记日志之后把码窄化回渲染进程声明的集合。 */
export function reportAuthFailure(
  operation: string,
  error: unknown,
  context: LogFields = {},
): { success: false; error: AuthError } {
  reportError(operation, error, context)
  return authFailureFrom(error)
}

let processHandlersInstalled = false

/**
 * 注册进程级兜底。幂等——重复调用只装一次。
 *
 * uncaughtException 之后进程状态已不可信，这里只负责留下痕迹；是否退出由调用方
 * 通过 onFatal 决定，报错模块不替应用做生死决定。
 */
export function installProcessHandlers(options: { onFatal?: (error: unknown) => void } = {}): void {
  if (processHandlersInstalled) return
  processHandlersInstalled = true
  process.on('unhandledRejection', reason => {
    log.error('unhandled rejection', {
      cause: describeError(reason),
      stack: reason instanceof Error ? describeError(reason.stack ?? '') : undefined,
    })
  })
  process.on('uncaughtException', error => {
    log.error('uncaught exception', {
      cause: describeError(error),
      stack: describeError(error.stack ?? ''),
    })
    options.onFatal?.(error)
  })
}

/**
 * 致命错误：记 error 并让用户看见中文提示。
 * 没有注入呈现方式时只记日志——测试环境不该弹框。
 */
export function reportFatal(title: string, error: unknown, context: LogFields = {}): void {
  const message = toEnvelope(error).message
  log.error('fatal error', { ...context, title, cause: describeError(error) })
  presentFatal?.(title, message)
}


