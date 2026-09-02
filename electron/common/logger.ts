/**
 * electron/common/logger.ts — 全后端唯一日志出口（方案 W2 / 第 5 章）
 *
 * 禁止裸 console.*，由 scripts/check-boundaries.ts 的 log:no-bare-console 规则检查。
 * 本文件与 undici-polyfill.ts 是唯一豁免——后者在 logger 可用之前运行。
 *
 * 三条硬约定：
 *   - 结构化字段，不做字符串拼接。便于过滤，也便于后续接落盘而不用改调用点。
 *   - 每个模块用 child(模块名)，来源自带，不再手写 `[TaskExecutionCoordinator]` 前缀。
 *   - 全部字段过 redact。这条与安全约束绑定，不是风格问题。
 */
import { redactValue } from './redact'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export type LogFields = Record<string, unknown>

export interface Logger {
  debug(message: string, fields?: LogFields): void
  info(message: string, fields?: LogFields): void
  warn(message: string, fields?: LogFields): void
  error(message: string, fields?: LogFields): void
  /** 绑定模块名与常驻字段，返回子记录器。 */
  child(scope: string, fields?: LogFields): Logger
}

export interface LogRecord {
  level: LogLevel
  scope: string
  message: string
  fields: LogFields
  timestamp: number
}

export type LogSink = (record: LogRecord) => void

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }

function parseLevel(value: string | undefined): LogLevel | null {
  return value && value in LEVEL_ORDER ? value as LogLevel : null
}

/**
 * 默认级别：显式的 SEP_LOG_LEVEL 优先，否则开发态 debug、其余 info。
 * 直接读 process.env 而不是引 config，是为了让 common/ 保持叶子层（边界 B4）。
 */
function defaultLevel(): LogLevel {
  return parseLevel(process.env['SEP_LOG_LEVEL'])
    ?? (process.env['NODE_ENV'] === 'production' ? 'info' : 'debug')
}

/** 唯一允许调用 console 的地方。级别映射到对应的 console 方法，便于 devtools 过滤。 */
function writeToConsole(record: LogRecord): void {
  const prefix = `${record.level.toUpperCase().padEnd(5)} ${record.scope}`
  const hasFields = Object.keys(record.fields).length > 0
  const payload = hasFields ? [record.fields] : []
  if (record.level === 'error') console.error(prefix, record.message, ...payload)
  else if (record.level === 'warn') console.warn(prefix, record.message, ...payload)
  else if (record.level === 'info') console.info(prefix, record.message, ...payload)
  else console.debug(prefix, record.message, ...payload)
}

interface LoggerState {
  level: LogLevel
  sink: LogSink
}

const state: LoggerState = { level: defaultLevel(), sink: writeToConsole }

/** 运行期改级别。测试与排障用；生产由 SEP_LOG_LEVEL 决定。 */
export function setLogLevel(level: LogLevel): void {
  state.level = level
}

/** 替换输出目标。返回恢复函数，便于测试断言后复原。 */
export function setLogSink(sink: LogSink): () => void {
  const previous = state.sink
  state.sink = sink
  return () => { state.sink = previous }
}

function emit(level: LogLevel, scope: string, bound: LogFields, message: string, fields?: LogFields): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[state.level]) return
  const merged = { ...bound, ...fields }
  state.sink({
    level,
    scope,
    message,
    fields: (redactValue(merged) ?? {}) as LogFields,
    timestamp: Date.now(),
  })
}

function build(scope: string, bound: LogFields): Logger {
  return {
    debug: (message, fields) => emit('debug', scope, bound, message, fields),
    info: (message, fields) => emit('info', scope, bound, message, fields),
    warn: (message, fields) => emit('warn', scope, bound, message, fields),
    error: (message, fields) => emit('error', scope, bound, message, fields),
    child: (childScope, childFields) =>
      build(scope === 'sep' ? childScope : `${scope}.${childScope}`, { ...bound, ...childFields }),
  }
}

/** 根记录器。业务代码一律用 `logger.child('模块名')`，不直接用它打日志。 */
export const logger: Logger = build('sep', {})
