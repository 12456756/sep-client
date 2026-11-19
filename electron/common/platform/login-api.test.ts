import * as assert from 'node:assert/strict'
import { it } from 'node:test'
import { login } from './platform-api'
import { toAuthEnvelope } from '../../errors/error-mapper'

const request = { email: 'test@example.test', password: 'fixture', fingerprint: 'fixture', platform: 'win32' }

it('keeps credential rejection classification when the HTTP envelope also contains an error label', async () => {
  const original = globalThis.fetch
  const body = { statusCode: 401, error: 'Unauthorized', message: '邮箱或密码错误' }
  try {
    globalThis.fetch = async () => Response.json(body, { status: 401 })
    await assert.rejects(login(request), (error: unknown) => {
      const result = toAuthEnvelope(error)
      assert.equal(result.reason, 'credentials')
      assert.deepEqual(result.diagnostic?.body, body)
      assert.match(result.diagnostic?.message ?? '', /Unauthorized/)
      return true
    })
  } finally { globalThis.fetch = original }
})

it('validates a successful login and preserves the documented legacy expiry field', async () => {
  const original = globalThis.fetch
  const response = { accessToken: 'fixture-access', refreshToken: 'fixture-refresh', refreshTokenExpiresIn: 3600,
    user: { id: 'member', email: 'test@example.test', name: 'Test', role: 'USER' }, enterprise: { id: 'enterprise', name: 'Test' }, devices: [] }
  try {
    for (const expiry of [{ accessTokenExpiresIn: 123 }, { expiresIn: 123 }]) {
      globalThis.fetch = async () => Response.json({ ...response, ...expiry })
      const result = await login(request)
      assert.equal(result.accessTokenExpiresIn, 123)
      assert.equal(result.user.id, 'member')
    }
  } finally { globalThis.fetch = original }
})

it('separates failed transport, real timeout and malformed login responses without retries', async () => {
  const original = globalThis.fetch
  try {
    for (const [failure, expected] of [
      [new TypeError('fetch failed'), 'network'],
      [new TypeError('fetch failed', { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } }), 'timeout'],
      [new Response('<html>bad</html>', { status: 200 }), 'response_invalid'],
      [Response.json({ accessToken: 'fixture' }), 'response_invalid'],
      [Response.json({ statusCode: 401, message: '邮箱或密码错误' }, { status: 503 }), 'service'],
    ] as const) {
      let calls = 0
      globalThis.fetch = async (_url, options) => {
        calls++
        assert.equal(options?.signal, undefined, 'login must not introduce an artificial timeout')
        if (failure instanceof Error) throw failure
        return failure
      }
      await assert.rejects(login(request), (error: unknown) => {
        assert.equal(toAuthEnvelope(error).reason, expected)
        return true
      })
      assert.equal(calls, 1)
    }
  } finally { globalThis.fetch = original }
})
