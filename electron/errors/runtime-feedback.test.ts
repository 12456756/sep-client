import { it } from 'node:test'
import * as assert from 'node:assert/strict'
import { AuthApiError } from '../common/platform/platform-api'
import { runtimeFeedback, sanitizeRuntimeErrorEvent } from './runtime-feedback'
import type { TaskExecutionEvent } from '../../src/shared/types'
import { appError } from './app-error'
import { AuthenticationRequiredError } from '../common/platform/authentication-required-error'

it('recognizes the SDK timeout after its error class has been flattened', () => {
  for (const error of [new Error('Request timed out.'), Object.assign(new Error('private'), { name: 'APIConnectionTimeoutError' }),
    new Error('fetch failed', { cause: Object.assign(new Error('private'), { code: 'UND_ERR_BODY_TIMEOUT' }) })]) {
    assert.deepEqual(runtimeFeedback(error), { code: 'MODEL_TIMEOUT', message: '模型请求超时，请稍后重试' })
  }
  assert.equal(runtimeFeedback(new Error('some unrelated Request timed out. text')).code, 'INTERNAL_ERROR')
})

it('distinguishes transport, HTTP and unknown failures without guessing authentication or expiry', () => {
  assert.equal(runtimeFeedback(new Error('Connection error.')).code, 'NETWORK_ERROR')
  assert.equal(runtimeFeedback(Object.assign(new Error('private'), { code: 'ECONNRESET' })).code, 'NETWORK_ERROR')
  for (const [status, code] of [[401, 'AUTH_REQUIRED'], [403, 'REQUEST_DENIED'], [429, 'RATE_LIMITED'], [503, 'SERVICE_UNAVAILABLE']] as const) {
    const result = runtimeFeedback(new AuthApiError({ statusCode: status, message: 'private upstream response' }))
    assert.equal(result.code, code)
    assert.doesNotMatch(result.message, /private|过期|停用/)
  }
  assert.equal(runtimeFeedback(new Error('private stack /secret')).message, '工作运行失败，请联系平台管理员')
})

it('preserves verified SDK HTTP prefixes and typed application reasons after worker normalization', () => {
  for (const [status, code] of [[401, 'AUTH_REQUIRED'], [403, 'REQUEST_DENIED'], [429, 'RATE_LIMITED'], [503, 'SERVICE_UNAVAILABLE']] as const) {
    assert.equal(runtimeFeedback(new Error(`${status} private provider body`)).code, code)
    assert.equal(runtimeFeedback(new Error(`${status}: private provider body`)).code, code)
  }
  assert.equal(runtimeFeedback(new Error('index 503 is out of bounds')).code, 'INTERNAL_ERROR')
  assert.equal(runtimeFeedback(appError('NETWORK_ERROR')).code, 'NETWORK_ERROR')
  assert.equal(runtimeFeedback(appError('RATE_LIMITED')).code, 'RATE_LIMITED')
})

it('keeps safe persisted messages stable and removes intermediate SDK diagnostics', () => {
  assert.equal(runtimeFeedback(new Error('模型请求超时，请稍后重试')).code, 'MODEL_TIMEOUT')
  for (const type of ['session_error', 'auto_retry_start', 'auto_retry_end', 'retry_budget_exhausted']) {
    const event: TaskExecutionEvent = { taskId: 't', runId: 'r', subscriptionId: 's', sequence: 1, occurredAt: 1,
      type, data: { error: 'private response', message: 'private response', attempt: 1, success: false } }
    const safe = sanitizeRuntimeErrorEvent(event)
    assert.doesNotMatch(JSON.stringify(safe), /private/)
    assert.equal((safe.data as { attempt: number }).attempt, 1)
  }
})

it('uses safe reasons for recovery, authorization and service failures', () => {
  for (const [error, code] of [
    [new AuthenticationRequiredError(), 'AUTH_REQUIRED'],
    [new AuthApiError({ statusCode: 0, message: 'private' }), 'NETWORK_ERROR'],
    [Object.assign(new Error('private'), { status: 504 }), 'MODEL_TIMEOUT'],
    [appError('PERMISSION_DENIED'), 'REQUEST_DENIED'],
    [appError('SERVICE_UNAVAILABLE'), 'SERVICE_UNAVAILABLE'],
    [appError('EMPLOYEE_UNAVAILABLE'), 'EMPLOYEE_UNAVAILABLE'],
    [appError('MODEL_NOT_ALLOWED'), 'MODEL_NOT_ALLOWED'],
    [new Error('The selected employee is no longer available.'), 'EMPLOYEE_UNAVAILABLE'],
    [new Error('失败节点的历史会话记录丢失，无法继续已有上下文。'), 'SESSION_UNRECOVERABLE'],
    [new Error('中断时有工具操作未保存执行结果，请先核实该操作，避免重试时重复写入或提交。'), 'SIDE_EFFECT_UNCONFIRMED'],
    [new Error('编排媒体资产流转和最终交付尚未接通，当前节点暂不可执行。请保留已保存的媒体资产，待接入后继续，不要重新提交生成请求。'), 'MEDIA_UNAVAILABLE'],
    [null, 'INTERNAL_ERROR'],
    [{ message: 'Request timed out.' }, 'INTERNAL_ERROR'],
  ] as const) assert.equal(runtimeFeedback(error).code, code)
})

it('replaces internal SDK message error diagnostics without mutating the event', () => {
  const event: TaskExecutionEvent = { taskId: 't', runId: 'r', subscriptionId: 's', sequence: 1, occurredAt: 1,
    type: 'turn_end', data: { message: { role: 'assistant', errorMessage: 'private' } } }
  assert.doesNotMatch(JSON.stringify(sanitizeRuntimeErrorEvent(event)), /private/)
  assert.match(JSON.stringify(event), /private/)
  assert.equal(sanitizeRuntimeErrorEvent({ ...event, data: null }).data, null)
  const textEvent = { ...event, type: 'text_delta', data: { text: 'normal response' } }
  assert.equal(sanitizeRuntimeErrorEvent(textEvent), textEvent)
})
