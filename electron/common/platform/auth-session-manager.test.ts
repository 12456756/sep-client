import * as assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { compileFunction } from 'node:vm'
import * as ts from 'typescript'
import { AuthenticationRequiredError } from './authentication-required-error'
import { RefreshTokenRotationQueue } from './refresh-token-rotation'
import type { LoginResponse, RefreshResponse } from './platform-api'
import type { AuthMeta } from './credential-vault'
import type { AuthSessionManager } from './auth-session-manager'

function setup() {
  let savedToken: string | null = null
  let savedMeta: AuthMeta | null = null
  let resolve!: (response: RefreshResponse) => void
  let reject!: (error: Error) => void
  let started!: () => void
  const ready = new Promise<void>(done => { started = done })
  const refresh = new Promise<RefreshResponse>((done, fail) => { resolve = done; reject = fail })
  const dependencies: Record<string, unknown> = {
    '../logger': { logger: { child: () => ({ warn: () => {} }) } },
    './authentication-required-error': { AuthenticationRequiredError },
    './platform-api': { refreshAccessToken: () => { started(); return refresh } },
    './refresh-token-rotation': { RefreshTokenRotationQueue, registerSharedRefreshTokenRotation: () => {} },
    './credential-vault': {
      saveRefreshToken: (token: string) => { savedToken = token }, getRefreshToken: () => savedToken,
      saveAuthMeta: (meta: AuthMeta) => { savedMeta = meta }, getAuthMeta: () => savedMeta,
      clearCredentials: () => { savedToken = null; savedMeta = null },
    },
  }
  const filename = fileURLToPath(new URL('./auth-session-manager.ts', import.meta.url))
  const compiled = ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }, fileName: filename,
  }).outputText
  const module = { exports: {} }
  compileFunction(compiled, ['require', 'exports', 'module'], { filename })(
    (id: string) => { assert.ok(Object.hasOwn(dependencies, id), id); return dependencies[id] }, module.exports, module,
  )
  const exported = module.exports as { AuthSessionManager: new () => AuthSessionManager }
  return { session: new exported.AuthSessionManager(), ready, resolve, reject, saved: () => ({ token: savedToken, meta: savedMeta }) }
}

function response(memberId: string, suffix: string): LoginResponse {
  return {
    accessToken: `fixture-access-${suffix}`, refreshToken: `fixture-refresh-${suffix}`,
    accessTokenExpiresIn: 3600, refreshTokenExpiresIn: 86400,
    user: { id: memberId, email: 'test@example.test', name: 'Test', role: 'MEMBER' },
    enterprise: { id: 'enterprise', name: 'Test Enterprise' }, devices: [],
  }
}

describe('authentication session isolation', () => {
  for (const sameAccount of [false, true]) {
    for (const outcome of ['success', 'unauthorized'] as const) {
      it(`keeps a new ${sameAccount ? 'same-account' : 'different-account'} login after an old refresh ${outcome}`, async () => {
        const harness = setup()
        harness.session.setLogin(response('member-a', 'old'))
        const old = harness.session.getValidAccessToken(true)
        const rejected = assert.rejects(old, AuthenticationRequiredError)
        await harness.ready
        harness.session.clear()
        const current = response(sameAccount ? 'member-a' : 'member-b', 'new')
        harness.session.setLogin(current)
        if (outcome === 'success') harness.resolve(response('member-a', 'rotated-old'))
        else harness.reject(Object.assign(new Error('unauthorized'), { statusCode: 401 }))
        await rejected
        assert.equal(harness.session.getAccessToken(), current.accessToken)
        assert.equal(harness.session.getMeta()?.memberId, current.user.id)
        assert.equal(harness.saved().token, current.refreshToken)
      })
    }
  }

  it('still clears the current session when its own refresh is unauthorized', async () => {
    const harness = setup()
    harness.session.setLogin(response('member-a', 'current'))
    const rejected = assert.rejects(harness.session.getValidAccessToken(true), AuthenticationRequiredError)
    await harness.ready
    harness.reject(Object.assign(new Error('unauthorized'), { statusCode: 401 }))
    await rejected
    assert.equal(harness.session.getMeta(), null)
    assert.equal(harness.saved().token, null)
  })
})
