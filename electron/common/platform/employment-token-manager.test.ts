import { afterEach, describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { EmploymentTokenManager } from './employment-token-manager'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

function response(value: unknown, status: number): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('EmploymentTokenManager', () => {
  it('notifies authentication loss once and stops accepting requests after a 401', async () => {
    let notifications = 0
    globalThis.fetch = async () => response({
      statusCode: 401,
      message: 'Invalid or expired refresh token',
    }, 401)

    const manager = new EmploymentTokenManager({
      getRefreshToken: () => 'expired-refresh-token',
      onAuthenticationRequired: () => { notifications += 1 },
    })

    await assert.rejects(
      () => manager.initialize('subscription-a'),
      error => error instanceof Error && error.message === 'Invalid or expired refresh token',
    )
    assert.equal(notifications, 1)
    await assert.rejects(() => manager.getValidToken(), /not initialized/)
    assert.equal(notifications, 1)
  })

  it('reuses a valid employment token for the same subscription and refresh token', async () => {
    let requests = 0
    globalThis.fetch = async () => {
      requests += 1
      return response({
        employmentToken: 'employment-token',
        expiresIn: 900,
        employment: { id: 'subscription-cache', name: 'Employee', templateId: 'employee', status: 'ACTIVE' },
      }, 200)
    }

    const createManager = (refreshToken: string) => new EmploymentTokenManager({ getRefreshToken: () => refreshToken })
    const first = createManager('refresh-token-cache')
    const sameSession = createManager('refresh-token-cache')
    const otherSession = createManager('different-refresh-token')
    try {
      await first.initialize('subscription-cache')
      await sameSession.initialize('subscription-cache')
      await otherSession.initialize('subscription-cache')

      assert.equal(await first.getValidToken(), 'employment-token')
      assert.equal(await sameSession.getValidToken(), 'employment-token')
      assert.equal(requests, 2)
    } finally {
      first.stop()
      sameSession.stop()
      otherSession.stop()
    }
  })

  it('coalesces concurrent requests for the same subscription and refresh token', async () => {
    let requests = 0
    let releaseResponse: (() => void) | undefined
    let requestAborted = false
    globalThis.fetch = async (_input, init) => {
      requests += 1
      const signal = init?.signal
      signal?.addEventListener('abort', () => { requestAborted = true })
      await new Promise<void>(resolve => { releaseResponse = resolve })
      return response({
        employmentToken: 'employment-token-coalesced',
        expiresIn: 900,
        employment: { id: 'subscription-coalesced', name: 'Employee', templateId: 'employee', status: 'ACTIVE' },
      }, 200)
    }

    const createManager = () => new EmploymentTokenManager({ getRefreshToken: () => 'refresh-token-coalesced' })
    const first = createManager()
    const second = createManager()
    try {
      const firstInitialization = first.initialize('subscription-coalesced')
      const secondInitialization = second.initialize('subscription-coalesced')
      await new Promise<void>(resolve => setImmediate(resolve))
      assert.equal(requests, 1)

      first.stop()
      await assert.rejects(firstInitialization, error => error instanceof DOMException && error.name === 'AbortError')
      assert.equal(requestAborted, false)

      releaseResponse?.()
      await secondInitialization

      assert.equal(requests, 1)
      assert.equal(await second.getValidToken(), 'employment-token-coalesced')
    } finally {
      first.stop()
      second.stop()
    }
  })
})
