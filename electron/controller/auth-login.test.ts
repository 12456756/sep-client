import * as assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { compileFunction } from 'node:vm'
import * as ts from 'typescript'
import { z } from 'zod'
import type { LoginResult } from '../../src/shared/types'
import { INVOKE_CHANNELS } from './channels'
import { AuthenticationRequiredError } from '../common/platform/authentication-required-error'
import { LoginFeedbackError } from '../common/platform/login-error'
import { toAuthEnvelope } from '../errors/error-mapper'
import { AuthApiError } from '../common/platform/platform-api'

function setup(options: { saveFails?: boolean; saveFailureReason?: 'accounts_read' | 'password_read'; loginFails?: boolean; deviceFails?: boolean; workspaceFails?: boolean; sessionFails?: boolean; passwordReadFails?: boolean; accountReadFails?: boolean; encryptionAvailable?: boolean; savedPassword?: string | null } = {}) {
  let finishRecovery!: () => void
  const recovery = new Promise<void>(resolve => { finishRecovery = resolve })
  let rejectRead!: (error: Error) => void
  const read = new Promise<never>((_resolve, reject) => { rejectRead = reject })
  let revision = 1
  const calls: string[] = []
  const response = {
    accessToken: 'fixture-access', refreshToken: 'fixture-refresh',
    user: { id: 'member', email: 'test@example.test', name: 'Test' },
    enterprise: { id: 'enterprise', name: 'Test Enterprise' },
  }
  const ctx = { employees: { refresh: () => read }, backend: {
    stopAll: async () => { calls.push('stop') },
    authSession: {
      setLogin: () => { calls.push('session'); if (options.sessionFails) throw new Error('storage failed') }, clear: () => { calls.push('clear-session') },
      getSessionRevision: () => revision, getValidAccessToken: async () => 'fixture-access',
    },
    invalidateAuthentication: () => { calls.push('invalidate') },
    taskManager: { setCurrentUser: async () => { calls.push('scope'); if (options.workspaceFails) throw new Error('scope failed') }, clearCurrentUser: () => { calls.push('clear-scope') } },
    employees: { clear: () => { calls.push('clear-employees') } },
    resumeClientMonitor: () => { calls.push('recovery'); return recovery },
  } }
  const dependencies: Record<string, unknown> = {
    electron: { app: { getVersion: () => 'test' }, safeStorage: { isEncryptionAvailable: () => options.encryptionAvailable ?? true } },
    zod: { z },
    '../../common/platform/platform-api': {
      AuthApiError,
      getEmployeeStatus: () => read, getEnterpriseOrganization: () => read, getEmployeeSkills: () => read, previewSkill: () => read,
      login: async () => {
      if (options.loginFails) throw new Error('login rejected')
      return response
    } },
    '../../common/platform/authentication-required-error': { AuthenticationRequiredError },
    '../../common/platform/login-error': { LoginFeedbackError },
    '../../errors/error-reporter': { reportAuthFailure: (_operation: string, error: unknown) => ({ success: false, error: toAuthEnvelope(error) }) },
    '../../common/platform/device-fingerprint': { getDeviceFingerprint: () => { if (options.deviceFails) throw new Error('device failed'); return 'fixture-device' } },
    '../../common/platform/credential-vault': {
      listRememberedAccounts: () => { if (options.accountReadFails) throw new Error('disk failed'); return [] },
      getRememberedPassword: () => { if (options.passwordReadFails) throw new LoginFeedbackError('password_read'); return options.savedPassword ?? null },
      saveRememberedAccount: () => {
      calls.push('save-account')
      if (options.saveFailureReason) throw new LoginFeedbackError(options.saveFailureReason)
      if (options.saveFails) throw new Error('disk unavailable')
    } },
    '../../errors/error-mapper': { authFailure: (code: string) => ({ success: false, error: { code } }) },
    '../../common/logger': { logger: { child: () => ({ warn: () => {} }) } },
    '../../common/redact': { describeError: () => 'redacted' },
    '../channels': { INVOKE_CHANNELS },
    '../router': { NO_INPUT: z.undefined(), route: (channel: string, schema: z.ZodType, handle: unknown) => ({ channel, schema, handle }) },
  }
  const filename = fileURLToPath(new URL('./routes/auth.ts', import.meta.url))
  const compiled = ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }, fileName: filename,
  }).outputText
  const module = { exports: {} }
  compileFunction(compiled, ['require', 'exports', 'module'], { filename })(
    (id: string) => { assert.ok(Object.hasOwn(dependencies, id), id); return dependencies[id] }, module.exports, module,
  )
  const { authRoutes } = module.exports as { authRoutes: Array<{ channel: string; handle: (ctx: unknown, input: unknown) => Promise<LoginResult> }> }
  const route = authRoutes.find(entry => entry.channel === INVOKE_CHANNELS.AUTH_LOGIN)!
  return {
    calls, finishRecovery, rejectRead, changeSession: () => { revision++ },
    read: (channel: string, input?: unknown) => authRoutes.find(entry => entry.channel === channel)!.handle(ctx, input),
    login: (saved = false, rememberPassword = false) => route.handle(ctx, { email: 'test@example.test', password: saved ? undefined : 'fixture-password', rememberPassword, useSavedPassword: saved }),
  }
}

describe('login background recovery', () => {
  it('reports the failed login stage without starting recovery', async () => {
    for (const [options, reason] of [
      [{ deviceFails: true }, 'device'], [{ workspaceFails: true }, 'workspace'],
      [{ sessionFails: true }, 'credential_save'], [{ saveFails: true }, 'credential_save'],
      [{ encryptionAvailable: false }, 'storage_unavailable'],
    ] as const) {
      const h = setup(options)
      await assert.rejects(h.login(), { reason })
      assert.equal(h.calls.includes('recovery'), false)
      h.finishRecovery()
    }
  })

  it('distinguishes a missing saved password from a password read failure', async () => {
    for (const [options, reason] of [[{}, 'saved_password_missing'], [{ passwordReadFails: true }, 'password_read']] as const) {
      const h = setup(options)
      await assert.rejects(h.login(true), { reason })
      assert.equal(h.calls.includes('session'), false)
      h.finishRecovery()
    }
  })

  it('allows manual login without persistence when remembered credentials are corrupt', async () => {
    for (const saveFailureReason of ['accounts_read', 'password_read'] as const) {
      const harness = setup({ saveFailureReason })
      const result = await harness.login()
      assert.equal(result.success, true)
      assert.ok(harness.calls.includes('recovery'))
      assert.ok(!harness.calls.includes('clear-session'))
      harness.finishRecovery()
    }
  })

  it('does not ignore corrupt remembered credentials when persistence was requested', async () => {
    for (const [saved, rememberPassword] of [[false, true], [true, false]] as const) {
      const harness = setup({ saveFailureReason: 'accounts_read', savedPassword: 'fixture-password' })
      harness.finishRecovery()
      await assert.rejects(harness.login(saved, rememberPassword), { reason: 'credential_save' })
      assert.ok(harness.calls.includes('clear-session'))
      assert.ok(!harness.calls.includes('recovery'))
    }
  })

  it('returns safe structured errors when listing accounts or revealing a password fails', async () => {
    const h = setup({ accountReadFails: true, passwordReadFails: true })
    const accounts = await h.read(INVOKE_CHANNELS.AUTH_LIST_REMEMBERED_ACCOUNTS)
    assert.equal(accounts.error?.reason, 'accounts_read')
    const password = await h.read(INVOKE_CHANNELS.AUTH_REVEAL_REMEMBERED_PASSWORD, 'test@example.test')
    assert.equal(password.error?.reason, 'password_read')
    h.finishRecovery()
  })
  it('returns success while recovery is pending, after credentials and caches are ready', async () => {
    const harness = setup()
    let result: LoginResult | undefined
    const pending = harness.login().then(value => { result = value })
    try {
      await new Promise<void>(resolve => setImmediate(resolve))
      assert.equal(result?.success, true)
      assert.ok(harness.calls.indexOf('recovery') > harness.calls.indexOf('save-account'))
      assert.ok(harness.calls.indexOf('recovery') > harness.calls.indexOf('clear-employees'))
    } finally { harness.finishRecovery(); await pending }
  })

  it('does not start recovery if authentication or local credential saving fails', async () => {
    for (const options of [{ loginFails: true }, { saveFails: true }]) {
      const harness = setup(options)
      harness.finishRecovery()
      await assert.rejects(harness.login())
      assert.ok(!harness.calls.includes('recovery'))
      assert.ok(harness.calls.includes('clear-session'))
      assert.ok(harness.calls.includes('clear-scope'))
    }
  })

  for (const channel of [
    INVOKE_CHANNELS.AUTH_GET_INSTANCES, INVOKE_CHANNELS.AUTH_GET_EMPLOYEE_STATUS,
    INVOKE_CHANNELS.AUTH_GET_ORGANIZATION, INVOKE_CHANNELS.SUBSCRIPTION_GET_SKILLS, INVOKE_CHANNELS.SUBSCRIPTION_PREVIEW_SKILL,
  ]) {
    it(`${channel} ignores an old session failure and still invalidates the current session`, async () => {
      for (const stale of [false, true]) {
        const harness = setup()
        const rejected = assert.rejects(harness.read(channel), AuthenticationRequiredError)
        await new Promise<void>(resolve => setImmediate(resolve))
        if (stale) harness.changeSession()
        harness.rejectRead(new AuthenticationRequiredError())
        await rejected
        assert.equal(harness.calls.includes('invalidate'), !stale)
      }
    })
  }
})
