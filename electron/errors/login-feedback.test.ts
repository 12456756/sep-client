import * as assert from 'node:assert/strict'
import { it } from 'node:test'
import { AuthApiError } from '../common/platform/platform-api'
import { toAuthEnvelope } from './error-mapper'
import { LoginFeedbackError } from '../common/platform/login-error'

it('only identifies the verified login rejection as incorrect credentials', () => {
  const known = toAuthEnvelope(new AuthApiError({ statusCode: 401, message: '邮箱或密码错误' }, 'login'))
  assert.equal(known.message, '账号或密码错误')
  assert.equal(known.reason, 'credentials')
  const unknown = toAuthEnvelope(new AuthApiError({ statusCode: 401, message: 'Other verification failure' }, 'login'))
  assert.equal(unknown.message, '登录验证未通过')
  assert.notEqual(unknown.reason, 'credentials')
})

it('does not infer account status or expose raw platform errors', () => {
  for (const [statusCode, expected] of [
    [403, '平台拒绝了登录请求，请联系平台管理员检查账号权限或访问限制。'],
    [429, '登录操作过于频繁，请稍后再试'],
    [503, '登录服务暂时不可用，请稍后重试；持续失败请联系平台管理员。'],
    [400, '平台未接受本次登录请求，请重新输入账号密码后重试；持续失败请联系平台管理员。'],
  ] as const) {
    const result = toAuthEnvelope(new AuthApiError({ statusCode, message: 'private server detail' }, 'login'))
    assert.equal(result.message, expected)
    assert.notEqual(result.code, 'ACCOUNT_DISABLED')
  }
})

it('explains local credential failures without claiming a successful login', () => {
  const failure = toAuthEnvelope(new LoginFeedbackError('credential_save', new Error('private path /secret')))
  assert.match(failure.message, /保存失败.*重新登录/)
  assert.doesNotMatch(JSON.stringify(failure), /登录成功|private|secret/)
  assert.match(toAuthEnvelope(new LoginFeedbackError('password_read')).message, /重新输入密码/)
  assert.match(toAuthEnvelope(new LoginFeedbackError('accounts_read')).message, /手动输入账号/)
})
