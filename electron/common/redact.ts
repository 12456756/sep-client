/**
 * electron/common/redact.ts — 全后端唯一的脱敏实现
 *
 * 归并自两处几乎相同的副本（`tasks/task-run-store.ts` 与
 * `pi/sdk/pi-coding-agent-adapter.ts`，方案第 6 章）。
 *
 * 这不是风格问题：项目约束要求 token 值不得出现在日志、控制台或 IPC 事件载荷里，
 * 而事件 data、工具参数、平台错误文本都可能夹带凭据。所有对外输出必须先过这里。
 */

const SENSITIVE_KEY = /authorization|cookie|password|secret|token|api[-_]?key|credential/i
const MAX_STRING_LENGTH = 8_192
const MAX_ARRAY_LENGTH = 50
const MAX_OBJECT_KEYS = 50
const MAX_DEPTH = 5

/** 抹掉字符串里的 Bearer 令牌与查询串凭据，并限制长度。 */
export function redactText(value: string): string {
  const redacted = value
    .replace(/Bearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .replace(/([?&](?:token|password|secret|api[_-]?key)=)[^&\s]+/gi, '$1[redacted]')
  return redacted.length <= MAX_STRING_LENGTH
    ? redacted
    : `${redacted.slice(0, MAX_STRING_LENGTH)}...[truncated]`
}

/** 可空文本的脱敏，空值统一成 null，便于直接落库。 */
export function redactOptionalText(value: string | undefined | null): string | null {
  return value ? redactText(value) : null
}

/**
 * 深度脱敏任意值。键名命中敏感词直接替换，字符串走 redactText，
 * 数组与对象限量限深——日志与事件载荷都不该无界增长。
 */
export function redactValue(value: unknown, depth = 0, key = ''): unknown {
  if (SENSITIVE_KEY.test(key)) return '[redacted]'
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value
  if (typeof value === 'string') return redactText(value)
  if (typeof value !== 'object') return undefined
  if (depth >= MAX_DEPTH) return '[max-depth]'
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY_LENGTH).map(item => redactValue(item, depth + 1))
  }
  const output: Record<string, unknown> = {}
  for (const [entryKey, entryValue] of Object.entries(value).slice(0, MAX_OBJECT_KEYS)) {
    const redacted = redactValue(entryValue, depth + 1, entryKey)
    if (redacted !== undefined) output[entryKey] = redacted
  }
  return output
}

/** 把 unknown 错误压成一行可读、已脱敏的文本。日志与 details 都用它。 */
export function describeError(error: unknown): string {
  if (error instanceof Error) return redactText(`${error.name}: ${error.message}`)
  if (typeof error === 'string') return redactText(error)
  return redactText(String(error))
}


