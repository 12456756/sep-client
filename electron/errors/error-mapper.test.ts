import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { AuthApiError } from '../common/platform/platform-api'
import { AuthenticationRequiredError } from '../common/platform/authentication-required-error'
import { ConversationRecoveryError } from '../runtime/conversation-recovery-error'
import { InvalidTaskTransitionError, TaskAdmissionError, TaskPersistenceError, TaskScopeError } from '../runtime/task-manager'
import { TaskStatus } from '../../src/shared/types'
import { ERROR_CODES } from './error-codes'
import { appError } from './app-error'
import { authFailure, failure, toAuthEnvelope, toEnvelope } from './error-mapper'

const CJK = /[一-鿿]/

function apiError(statusCode: number, message: string): AuthApiError {
  return new AuthApiError({ statusCode, message })
}

describe('error code table', () => {
  it('carries Chinese user-facing copy for every code', () => {
    for (const [code, spec] of Object.entries(ERROR_CODES)) {
      assert.ok(spec.message.length > 0, `${code} 缺文案`)
      assert.ok(CJK.test(spec.message), `${code} 的文案不是中文：${spec.message}`)
    }
  })

  it('keeps every log level within the two allowed values', () => {
    for (const [code, spec] of Object.entries(ERROR_CODES)) {
      assert.ok(['warn', 'error'].includes(spec.level), `${code} 的日志级别非法`)
    }
  })
})

describe('toEnvelope', () => {
  it('honours an AppError code and its overridden copy', () => {
    const result = toEnvelope(appError('CONFLICT', { message: '目录忙。' }))
    assert.deepEqual(result, { code: 'CONFLICT', message: '目录忙。', statusCode: 409, retryable: true })
  })

  it('maps the platform and task error classes', () => {
    assert.equal(toEnvelope(new AuthenticationRequiredError()).code, 'AUTH_REQUIRED')
    assert.equal(toEnvelope(new TaskScopeError()).code, 'AUTH_REQUIRED')
    assert.equal(toEnvelope(new TaskAdmissionError()).code, 'INVALID_STATE')
    assert.equal(toEnvelope(new InvalidTaskTransitionError(TaskStatus.PAUSED, TaskStatus.COMPLETED)).code, 'INVALID_STATE')
    assert.equal(toEnvelope(new TaskPersistenceError()).code, 'PERSISTENCE_ERROR')
  })

  it('keeps a recovery error code that the table knows', () => {
    assert.equal(
      toEnvelope(new ConversationRecoveryError('RECOVERY_CONFIRMATION_REQUIRED', 'x')).code,
      'RECOVERY_CONFIRMATION_REQUIRED',
    )
  })

  it('separates a login 401 from an expired session 401', () => {
    const unauthorized = apiError(401, 'unauthorized')
    assert.equal(toEnvelope(unauthorized).code, 'INVALID_CREDENTIALS')
    assert.equal(toEnvelope(unauthorized, { authenticated: true }).code, 'AUTH_REQUIRED')
  })


  it('classifies transport and server failures as retryable', () => {
    assert.deepEqual(
      [
        toEnvelope(apiError(0, 'offline')),
        toEnvelope(apiError(429, 'slow down')),
        toEnvelope(apiError(503, 'boom')),
      ].map(item => [item.code, item.retryable]),
      [['NETWORK_ERROR', true], ['RATE_LIMITED', true], ['SERVICE_UNAVAILABLE', true]],
    )
  })

  it('recognizes secure storage failures by message', () => {
    assert.equal(toEnvelope(new Error('safeStorage is unavailable')).code, 'STORAGE_UNAVAILABLE')
  })

  it('falls back to INTERNAL_ERROR without leaking the technical text', () => {
    const result = toEnvelope(new Error('ECONNRESET while calling Bearer abc'))
    assert.equal(result.code, 'INTERNAL_ERROR')
    assert.equal(result.message, ERROR_CODES.INTERNAL_ERROR.message)
    assert.ok(!result.message.includes('ECONNRESET'))
    assert.ok(!result.message.includes('Bearer'))
  })
})

describe('auth channel narrowing', () => {

  it('passes declared codes through untouched', () => {
    assert.equal(toAuthEnvelope(apiError(401, 'unauthorized')).code, 'INVALID_CREDENTIALS')
  })
})

describe('failure builders', () => {
  it('default to the table copy and allow a narrower override', () => {
    assert.deepEqual(failure('NOT_FOUND'), {
      success: false,
      error: { code: 'NOT_FOUND', message: ERROR_CODES.NOT_FOUND.message, statusCode: 404 },
    })
    assert.equal(failure('NOT_FOUND', '未找到该任务。').error.message, '未找到该任务。')
    assert.equal(authFailure('AUTH_REQUIRED').error.code, 'AUTH_REQUIRED')
  })
})



