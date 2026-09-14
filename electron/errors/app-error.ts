/**
 * electron/errors/app-error.ts — 带错误码的应用错误
 *
 * 用于"这里就是要以某个明确的码失败"的场合。原有 8 个 Error 类保持原位不动
 * （方案第 4.2 节）：领域层不该知道错误码，数据层不该知道 HTTP 状态；
 * 改的只是"谁负责翻译"——由 error-mapper 一处统一翻译。
 */
import type { LogFields } from '../common/logger'
import { ERROR_CODES, type ErrorCode } from './error-codes'

export interface AppErrorOptions {
  /** 覆写用户可见的中文文案。不传则用错误码表里的。 */
  message?: string
  /** 原始错误，只进日志。 */
  cause?: unknown
  /** 英文技术上下文，只进日志，**绝不进 IPC 载荷**。 */
  details?: LogFields
}

export class AppError extends Error {
  readonly code: ErrorCode
  /** 用户可见的中文文案。message 与它一致，便于 catch 后直接读。 */
  readonly userMessage: string
  readonly details: LogFields | undefined

  constructor(code: ErrorCode, options: AppErrorOptions = {}) {
    const userMessage = options.message ?? ERROR_CODES[code].message
    super(userMessage, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'AppError'
    this.code = code
    this.userMessage = userMessage
    this.details = options.details
  }
}

export function appError(code: ErrorCode, options?: AppErrorOptions): AppError {
  return new AppError(code, options)
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError
}


