import { it } from 'node:test'
import * as assert from 'node:assert/strict'
import { formatRuntimeLog } from './runtime-log-format'
import type { LogRecord } from './logger'

const record = (message: string, fields: Record<string, unknown> = {}): LogRecord => ({
  scope: 'pi-gateway', level: 'info', message, fields, timestamp: 0,
})
it('never displays model bodies, arguments, or identifiers, even at trace level', () => {
  for (const message of ['model input added: user', 'model response thinking', 'model response content', 'model request tool list']) {
    assert.equal(formatRuntimeLog({ ...record(message, { content: 'PRIVATE', runId: 'UUID' }), level: 'trace' }), null)
  }
  const output = formatRuntimeLog(record('model response completed', {
    taskTitle: '市场报告', runId: 'UUID', requestId: 1, elapsedMs: 125221,
    usage: { input: 13676, output: 7169, total: 20910 }, content: 'PRIVATE', stopReason: 'stop',
  }))!
  assert.match(output, /模型响应完成/)
  assert.match(output, /市场报告/)
  assert.match(output, /2 分 5.221 秒/)
  assert.doesNotMatch(output, /UUID|PRIVATE|runId|elapsedMs/)
})
it('separates validation and client monitor warnings with Chinese headings', () => {
  const planning = formatRuntimeLog({ ...record('planning phase completed', { phase: 'dag-validation', elapsedMs: 2 }), scope: 'arrangement-planner' })!
  assert.match(planning, /依赖关系校验/)
  const monitor = formatRuntimeLog({ ...record('client monitor pending operation retained', { taskId: 'UUID', statusCode: 403, kind: 'create' }), scope: 'client-monitor', level: 'warn' })!
  assert.match(monitor, /客户端同步/)
  assert.match(monitor, /403/)
  assert.doesNotMatch(monitor, /UUID/)
})
