import { afterEach, describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { EmploymentTokenManager } from './employment-token-manager'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('EmploymentTokenManager', () => {
  it('coalesces forced refreshes and always uses subscriptionId', async () => {
    const requestBodies: Array<Record<string, unknown>> = []
    globalThis.fetch = async (_input, init) => {
      requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return Response.json({
        employmentToken: `employment_${requestBodies.length}`,
        expiresIn: 900,
        employment: { id: 'sub_1', name: 'Employee', templateId: 'employee_1', status: 'ACTIVE' },
      })
    }
    const manager = new EmploymentTokenManager({ getRefreshToken: () => 'refresh_1' })

    try {
      await manager.initialize('sub_1')
      const [left, right] = await Promise.all([manager.forceRefresh(), manager.forceRefresh()])

      assert.equal(left, 'employment_2')
      assert.equal(right, 'employment_2')
      assert.equal(requestBodies.length, 2)
      assert.deepEqual(requestBodies, [
        { refreshToken: 'refresh_1', subscriptionId: 'sub_1' },
        { refreshToken: 'refresh_1', subscriptionId: 'sub_1' },
      ])
    } finally {
      manager.stop()
    }
  })

  it('invalidates authentication after a rejected refresh token', async () => {
    let authenticationRequired = 0
    globalThis.fetch = async () => Response.json({ message: 'revoked' }, { status: 401 })
    const manager = new EmploymentTokenManager({
      getRefreshToken: () => 'revoked',
      onAuthenticationRequired: () => { authenticationRequired += 1 },
    })

    await assert.rejects(() => manager.initialize('sub_1'), /revoked/)
    assert.equal(authenticationRequired, 1)
    await assert.rejects(() => manager.getValidToken(), /not initialized/)
  })
})
