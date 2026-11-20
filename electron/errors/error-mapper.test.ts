import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { AuthApiError } from '../common/platform/platform-api'
import { AuthenticationRequiredError } from '../common/platform/authentication-required-error'
import { ConversationRecoveryError } from '../runtime/conversation-recovery-error'
import { InvalidTaskTransitionError, TaskAdmissionError, TaskPersistenceError, TaskScopeError } from '../runtime/task-manager'
import { TaskStatus } from '../../src/shared/types'
import type { ApiDiagnostic } from '../../src/shared/api-diagnostic'
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
  it('publishes translated validation and conflict reasons without rendering arbitrary response strings', () => {
    const makeError = (statusCode: number, body: ApiDiagnostic['body'], message: string) => new AuthApiError({
      statusCode, message, diagnostic: { httpStatus: statusCode, message, body },
    }, 'subscriptions')
    const invalid = makeError(422, { errors: [
      { field: 'requestedSpec.count', message: 'Expected number, received string' },
      { field: 'name', message: 'Required' },
      { field: '/private/path', message: '<html>private value</html>' },
    ] }, 'Invalid parameters')
    assert.equal(toEnvelope(invalid).message, '生成数量必须为数字；请填写名称，请修改后重试。')
    assert.equal(toEnvelope(invalid, { feedbackOperation: 'workRetry' }).message, toEnvelope(invalid).message)
    const conflict = makeError(409, 'Stale client run', 'Stale client run')
    assert.match(toAuthEnvelope(conflict).message, /旧记录/)
    assert.doesNotMatch(toEnvelope(makeError(422, { message: 'private detail' }, 'private detail')).message, /private/)
  })
  it('keeps HTTP classification, validation details and retry hints through both IPC projections', () => {
    for (const [statusCode, code] of [[400, 'INVALID_ARGUMENT'], [409, 'CONFLICT'], [422, 'INVALID_ARGUMENT'], [502, 'SERVICE_UNAVAILABLE']] as const) {
      const diagnostic = { httpStatus: statusCode, message: 'Stale client run', code: 123,
        body: { errors: [{ field: 'clientRunId', message: 'Stale client run' }] }, sepRequestId: 'sep-id', retryable: false }
      const error = new AuthApiError({ statusCode, message: diagnostic.message, diagnostic, retryAfterMs: 0 }, 'subscriptions')
      for (const result of [toEnvelope(error, { authenticated: true }), toAuthEnvelope(error)]) {
        assert.equal(result.code, code)
        assert.equal(result.statusCode, statusCode)
        assert.deepEqual(result.diagnostic, diagnostic)
        assert.equal(result.retryable, false)
        assert.equal(result.retryAfterMs, 0)
      }
    }
  })
  it('keeps upstream authentication separate from desktop login expiry', () => {
    for (const statusCode of [401, 403]) {
      const error = new AuthApiError({ statusCode, message: 'Invalid API key',
        diagnostic: { httpStatus: statusCode, source: 'upstream', message: 'Invalid API key', code: 'INVALID_API_KEY' } }, 'subscriptions')
      assert.equal(error.isUnauthorized, false)
      assert.equal(error.isForbidden, false)
      const result = toEnvelope(error, { authenticated: true })
      assert.equal(result.code, 'SERVICE_UNAVAILABLE')
      assert.equal(result.statusCode, statusCode)
      assert.equal(result.diagnostic?.message, 'Invalid API key')
      assert.doesNotMatch(result.message, /重新登录/)
    }
  })
  it('only forwards an explicit sanitized AppError diagnostic, never log-only details', () => {
    const result = toEnvelope(appError('CONFLICT', { details: { raw: 'log-only' },
      diagnostic: { message: 'Denied Bearer private-token', body: { apiKey: 'private-key' }, headers: { Authorization: 'private-header' } } }))
    assert.ok(result.diagnostic)
    assert.doesNotMatch(JSON.stringify(result), /private-token|private-key|private-header|log-only/)
  })
  it('preserves bounded specification context across IPC without forwarding provider bodies', () => {
    const result = toEnvelope(appError('UPSTREAM_SPEC_UNSUPPORTED', { message: 'private provider body', details: {
      field: 'requestedSpec.durationSeconds', requestedValue: 8, source: 'provider', submissionState: 'not_submitted',
      billingState: 'not_reserved', rawResponse: 'private token', reason: 'private provider body',
    } }))
    assert.equal(result.code, 'UPSTREAM_SPEC_UNSUPPORTED')
    assert.equal(result.field, 'requestedSpec.durationSeconds')
    assert.equal(result.requestedValue, 8)
    assert.equal(result.source, 'provider')
    assert.doesNotMatch(JSON.stringify(result), /private|rawResponse/)
  })
  it('keeps a platform rate-limit cooldown in the renderer-safe envelope', () => {
    const error = new AuthApiError({ statusCode: 429, message: 'upstream-private-message', retryAfterMs: 65_000 }, 'notifications')
    assert.deepEqual(toEnvelope(error, { authenticated: true }), {
      code: 'RATE_LIMITED', message: ERROR_CODES.RATE_LIMITED.message, statusCode: 429, retryable: true, retryAfterMs: 65_000,
    })
  })
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

  it('reports a missing platform source header as a generic internal error rather than expired authentication', () => {
    const error = new AuthApiError({ statusCode: 403, message: 'Missing Origin or Referer header' }, 'skills')
    for (const authenticated of [false, true]) {
      const result = toEnvelope(error, { authenticated })
      assert.equal(result.code, 'INTERNAL_ERROR')
      assert.equal(result.message, ERROR_CODES.INTERNAL_ERROR.message)
      assert.doesNotMatch(result.message, /Origin|Referer/)
    }
    assert.equal(toEnvelope(apiError(403, 'Forbidden'), { authenticated: true }).code, 'PERMISSION_DENIED')
  })

  it('keeps permission rejection separate from session expiry and login rejection', () => {
    for (const resource of ['profile', 'skills', 'notifications'] as const) {
      const result = toEnvelope(new AuthApiError({ statusCode: 403, message: 'Bearer private' }, resource), { authenticated: true })
      assert.equal(result.code, 'PERMISSION_DENIED')
      assert.equal(result.statusCode, 403)
      assert.doesNotMatch(result.message, /重新登录|private/)
    }
    assert.equal(toEnvelope(new AuthApiError({ statusCode: 403, message: 'Forbidden' }, 'login')).reason, 'forbidden')
  })

  it('maps actual transport failures and nested timeout causes without exposing diagnostics', () => {
    for (const error of [new TypeError('fetch failed'), Object.assign(new Error('private host'), { code: 'ENOTFOUND' }),
      new TypeError('fetch failed', { cause: Object.assign(new Error('private host'), { code: 'ETIMEDOUT' }) }), apiError(408, 'private')]) {
      const result = toEnvelope(error, { authenticated: true })
      assert.equal(result.code, 'NETWORK_ERROR')
      assert.equal(result.retryable, true)
      assert.doesNotMatch(result.message, /private|fetch|ENOTFOUND/)
    }
    assert.match(toEnvelope(new TypeError('fetch failed', { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } })).message, /超时/)
    assert.match(toEnvelope(new AuthApiError({ statusCode: 0, message: 'private' }, 'model-catalog', {
      cause: new DOMException('private timeout diagnostic', 'TimeoutError'),
    })).message, /超时/)
    assert.equal(toEnvelope(new TypeError('Cannot read properties of undefined')).code, 'INTERNAL_ERROR')
    assert.equal(toEnvelope(new DOMException('cancelled', 'AbortError')).code, 'INTERNAL_ERROR')
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

  it('preserves domain error classification when a nested cause is a transport failure', () => {
    const error = new TaskPersistenceError()
    Object.defineProperty(error, 'cause', { value: Object.assign(new Error('private'), { code: 'ECONNRESET' }) })
    assert.equal(toEnvelope(error).code, 'PERSISTENCE_ERROR')
  })

  it('maps known attachment failures to actionable copy without exposing paths', () => {
    assert.match(toEnvelope(new Error('ATTACHMENT_TOO_LARGE')).message, /20/)
    assert.equal(toEnvelope(new Error('ATTACHMENT_REVISION_CONFLICT')).code, 'CONFLICT')
    assert.match(toEnvelope(new Error('ATTACHMENT_SESSION_EXPIRED')).message, /重新/)
    assert.equal(toEnvelope(new Error('ATTACHMENT_IMAGE_SIGNATURE_INVALID')).code, 'INVALID_ARGUMENT')
    const unknown = toEnvelope(new Error('ATTACHMENT_READ /Users/private/report.txt'))
    assert.equal(unknown.code, 'INTERNAL_ERROR')
    assert.doesNotMatch(unknown.message, /private|report/)
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



