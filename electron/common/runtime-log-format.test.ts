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

it('retains failure reasons when formatting runtime errors', () => {
  const output = formatRuntimeLog({ ...record('run failed', {
    stage: 'agent-result', modelId: 'unavailable-model', error: '404: Model unavailable\nRequest rejected', runId: 'UUID',
  }), scope: 'pi-task-worker', level: 'error' })!
  assert.match(output, /模型会话失败/)
  assert.match(output, /错误：404: Model unavailable Request rejected/)
  assert.doesNotMatch(output, /UUID/)
  const cause = formatRuntimeLog({ ...record('conversation run failed', { cause: 'Connection failed' }), scope: 'conversation-executor', level: 'error' })!
  assert.match(cause, /原因：Connection failed/)
})

it('redacts HTTP credentials in failure summaries while preserving business fields', () => {
  for (const key of ['error', 'cause']) {
    for (const text of ['HTTP 401: Authorization: Basic PRIVATE_BASIC', 'HTTP failure: Cookie: sid=PRIVATE_COOKIE; csrf=PRIVATE_CSRF', 'Request failed: X-API-Key=PRIVATE_API; access-token=PRIVATE_TOKEN']) {
      const output = formatRuntimeLog({ ...record('run failed', { [key]: text, taskTitle: 'Authorization documentation' }), scope: 'pi-task-worker', level: 'error' })!
      assert.doesNotMatch(output, /PRIVATE_/)
      assert.match(output, /\[redacted\]/)
      assert.match(output, /任务：Authorization documentation/)
    }
  }
})

it('shows safe transport diagnostics and correlation IDs without arbitrary error objects', () => {
  const output = formatRuntimeLog({ ...record('model transport interrupted', {
    transportPhase: 'response-body', providerStatus: 200, platformRequestId: 'platform-a', traceRequestId: 'trace-a',
    errorName: 'TypeError', errorMessage: 'terminated', causeName: 'SocketError', causeCode: 'UND_ERR_SOCKET',
    causeMessage: 'other side closed', elapsedMs: 2500, firstByteMs: 100, lastDataAgeMs: 2400,
    bytesReceived: 42, signalAborted: false, socket: { remoteAddress: 'PRIVATE' },
  }), level: 'warn' })!
  for (const text of ['模型传输中断', '响应流读取', 'platform-a', 'trace-a', 'terminated', 'UND_ERR_SOCKET', 'other side closed', '42', '2.400 秒', '是否主动取消：否']) {
    assert.ok(output.includes(text), text)
  }
  assert.doesNotMatch(output, /PRIVATE|remoteAddress/)
})
