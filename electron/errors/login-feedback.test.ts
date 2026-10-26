import * as assert from 'node:assert/strict'
import { it } from 'node:test'
import { AuthApiError } from '../common/platform/platform-api'
import { toAuthEnvelope } from './error-mapper'

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
    [403, '登录请求被拒绝，请联系平台管理员'],
    [429, '登录操作过于频繁，请稍后再试'],
    [503, '登录服务异常，请联系平台管理员'],
    [400, '登录请求未被接受，请联系平台管理员'],
  ] as const) {
    const result = toAuthEnvelope(new AuthApiError({ statusCode, message: 'private server detail' }, 'login'))
    assert.equal(result.message, expected)
    assert.notEqual(result.code, 'ACCOUNT_DISABLED')
  }
})
