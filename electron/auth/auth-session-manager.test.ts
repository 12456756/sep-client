import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import {
  AuthSessionManager,
  type AuthSessionStorage,
} from './auth-session-manager'
import type { RefreshResponse } from './auth-api'
import type { AuthMeta } from './credentials'

function createStorage(initial?: { refreshToken?: string; meta?: AuthMeta }) {
  let refreshToken = initial?.refreshToken ?? null
  let meta = initial?.meta ?? null
  let clears = 0
  const storage: AuthSessionStorage = {
    getRefreshToken: () => refreshToken,
    getAuthMeta: () => meta,
    saveRefreshToken: value => { refreshToken = value },
    saveAuthMeta: value => { meta = value },
    clearCredentials: () => {
      refreshToken = null
      meta = null
      clears += 1
    },
  }
  return {
    storage,
    snapshot: () => ({ refreshToken, meta, clears }),
  }
}

const meta: AuthMeta = {
  memberId: 'member_1',
  enterpriseId: 'enterprise_1',
  displayName: 'Member',
  enterpriseName: 'Enterprise',
  email: 'member@example.com',
}

function refreshed(accessToken = 'access_1'): RefreshResponse {
  return {
    accessToken,
    accessTokenExpiresIn: 3_600,
    user: { id: meta.memberId, email: meta.email, name: meta.displayName },
    enterprise: { id: meta.enterpriseId, name: meta.enterpriseName },
  }
}

describe('AuthSessionManager', () => {
  it('restores a session from safe storage and coalesces concurrent refreshes', async () => {
    const state = createStorage({ refreshToken: 'refresh_1', meta })
    let refreshes = 0
    const manager = new AuthSessionManager({
      storage: state.storage,
      refreshAccessToken: async () => {
        refreshes += 1
        await Promise.resolve()
        return refreshed()
      },
    })

    const [restored, accessToken] = await Promise.all([
      manager.restore(),
      manager.getValidAccessToken(),
    ])

    assert.deepEqual(restored, meta)
    assert.equal(accessToken, 'access_1')
    assert.equal(refreshes, 1)
    assert.equal(state.snapshot().clears, 0)
  })

  it('clears persisted credentials when the device refresh token is rejected', async () => {
    const state = createStorage({ refreshToken: 'revoked', meta })
    const manager = new AuthSessionManager({
      storage: state.storage,
      refreshAccessToken: async () => { throw { statusCode: 401 } },
    })

    assert.equal(await manager.restore(), null)
    assert.equal(state.snapshot().refreshToken, null)
    assert.equal(state.snapshot().meta, null)
    assert.equal(state.snapshot().clears, 1)
  })

  it('keeps persisted credentials after a transient refresh failure', async () => {
    const state = createStorage({ refreshToken: 'refresh_1', meta })
    const manager = new AuthSessionManager({
      storage: state.storage,
      refreshAccessToken: async () => { throw Object.assign(new Error('network unavailable'), { statusCode: 0 }) },
    })

    await assert.rejects(() => manager.restore(), /network unavailable/)
    assert.equal(state.snapshot().refreshToken, 'refresh_1')
    assert.deepEqual(state.snapshot().meta, meta)
    assert.equal(state.snapshot().clears, 0)
  })
})
