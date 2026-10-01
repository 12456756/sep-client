import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import {
  RefreshTokenRotationQueue,
  registerSharedRefreshTokenRotation,
  runSharedRefreshTokenRotation,
} from './refresh-token-rotation'

function gate<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(settle => { resolve = settle })
  return { promise, resolve }
}

describe('refresh token rotation', () => {
  it('serializes concurrent consumers and gives each request the latest persisted token', async () => {
    let currentToken = 'refresh-0'
    const requestTokens: string[] = []
    const firstStarted = gate<void>()
    const releaseFirst = gate<void>()

    const rotation = new RefreshTokenRotationQueue(
      () => currentToken,
      refreshToken => { currentToken = refreshToken },
    )
    const first = rotation.run(async refreshToken => {
      requestTokens.push(refreshToken)
      firstStarted.resolve()
      await releaseFirst.promise
      return { refreshToken: 'refresh-1', employmentToken: 'employment-1' }
    })
    registerSharedRefreshTokenRotation(rotation)
    const second = runSharedRefreshTokenRotation(async refreshToken => {
      requestTokens.push(refreshToken)
      return { refreshToken: 'refresh-2', accessToken: 'access-2' }
    })

    await firstStarted.promise
    assert.deepEqual(requestTokens, ['refresh-0'])
    releaseFirst.resolve()
    await Promise.all([first, second])

    assert.deepEqual(requestTokens, ['refresh-0', 'refresh-1'])
    assert.equal(currentToken, 'refresh-2')
  })

  it('releases the queue after a failed request without persisting a token', async () => {
    let currentToken = 'refresh-0'
    const requestTokens: string[] = []

    const rotation = new RefreshTokenRotationQueue(
      () => currentToken,
      refreshToken => { currentToken = refreshToken },
    )
    const failed = rotation.run(async refreshToken => {
      requestTokens.push(refreshToken)
      throw new Error('network failure')
    })
    const succeeding = rotation.run(async refreshToken => {
      requestTokens.push(refreshToken)
      return { refreshToken: 'refresh-1' }
    })

    await assert.rejects(failed, /network failure/)
    await succeeding

    assert.deepEqual(requestTokens, ['refresh-0', 'refresh-0'])
    assert.equal(currentToken, 'refresh-1')
  })

  it('fails closed when a rotated token cannot be persisted', async () => {
    const requestTokens: string[] = []
    const rotation = new RefreshTokenRotationQueue(
      () => 'refresh-0',
      () => { throw new Error('storage failure') },
    )

    const failed = rotation.run(async refreshToken => {
      requestTokens.push(refreshToken)
      return { refreshToken: 'refresh-1' }
    })
    const queued = rotation.run(async refreshToken => {
      requestTokens.push(refreshToken)
      return { refreshToken: 'refresh-2' }
    })

    await assert.rejects(failed, { name: 'AuthenticationRequiredError' })
    await assert.rejects(queued, { name: 'AuthenticationRequiredError' })
    assert.deepEqual(requestTokens, ['refresh-0'])
  })

  it('stops queued requests after the server rejects the current token', async () => {
    let currentToken = 'refresh-expired'
    const requestTokens: string[] = []
    const rotation = new RefreshTokenRotationQueue(
      () => currentToken,
      refreshToken => { currentToken = refreshToken },
    )
    const unauthorized = rotation.run(async refreshToken => {
      requestTokens.push(refreshToken)
      throw Object.assign(new Error('unauthorized'), { statusCode: 401 })
    })
    const queued = rotation.run(async refreshToken => {
      requestTokens.push(refreshToken)
      return { refreshToken: 'should-not-be-used' }
    })

    await assert.rejects(unauthorized, /unauthorized/)
    await assert.rejects(queued, { name: 'AuthenticationRequiredError' })
    assert.deepEqual(requestTokens, ['refresh-expired'])

    currentToken = 'refresh-after-login'
    rotation.reset()
    await rotation.run(async refreshToken => {
      assert.equal(refreshToken, 'refresh-after-login')
      return { refreshToken: 'refresh-after-login-rotated' }
    })
  })

})
