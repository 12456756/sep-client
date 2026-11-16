import * as assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { compileFunction } from 'node:vm'
import * as ts from 'typescript'
import { z } from 'zod'
import * as computeContracts from '../../src/shared/compute-credit-contracts'
import * as profileContracts from '../../src/shared/profile-wallet-contracts'
import { AuthenticationRequiredError } from '../common/platform/authentication-required-error'
import { AuthApiError } from '../common/platform/platform-api'
import { INVOKE_CHANNELS } from './channels'

interface TestRoute {
  channel: string
  schema: z.ZodType
  handle(ctx: unknown, input: unknown): Promise<{ success: true; data: unknown }>
}

const upload = { bytes: new Uint8Array([1]), filename: 'avatar.png', contentType: 'image/png' }
const groups = [
  { file: 'profile-wallet', exportName: 'profileWalletRoutes', cases: [
    [INVOKE_CHANNELS.PROFILE_GET, undefined],
    [INVOKE_CHANNELS.PROFILE_UPLOAD_AVATAR, upload],
    [INVOKE_CHANNELS.PROFILE_UPLOAD_ENTERPRISE_LOGO, upload],
    [INVOKE_CHANNELS.WALLET_CREATE_RECHARGE, { amountCNY: 10 }],
    [INVOKE_CHANNELS.WALLET_GET_RECHARGE, 'order-1'],
    [INVOKE_CHANNELS.WALLET_RECONCILE_RECHARGE, 'order-1'],
  ] },
  { file: 'compute-credit', exportName: 'computeCreditRoutes', cases: [
    [INVOKE_CHANNELS.COMPUTE_CENTER_GET_OVERVIEW, undefined],
    [INVOKE_CHANNELS.COMPUTE_CENTER_GET_TRANSACTIONS, { page: 1, pageSize: 20 }],
    [INVOKE_CHANNELS.COMPUTE_CENTER_GET_USAGE_RECORDS, { page: 1, pageSize: 20 }],
    [INVOKE_CHANNELS.COMPUTE_CENTER_GET_BREAKDOWN, { days: 30 }],
  ] },
] satisfies Array<{ file: string; exportName: string; cases: Array<[string, unknown]> }>

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail })
  return { promise, resolve, reject }
}

for (const group of groups) {
  // Load the real handlers with their platform transport and Electron router replaced.
  const source = readFileSync(new URL(`./routes/${group.file}.ts`, import.meta.url), 'utf8')
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText

  function harness(channel: string, raw: unknown, stage: 'token' | 'platform' = 'platform') {
    const request = deferred<unknown>()
    const started = deferred<void>()
    const invalidated: number[] = []
    const platformCalls: unknown[] = []
    let revision = 1
    const platform: Record<string, unknown> = { AuthApiError }
    for (const name of [
      'getClientProfile', 'uploadUserAvatar', 'uploadEnterpriseLogo', 'createPersonalRecharge',
      'getPersonalRecharge', 'reconcilePersonalRecharge', 'getMyComputeAllowance',
      'getPersonalWallet', 'getComputeUsageBreakdown', 'getPersonalWalletTransactions', 'getComputeUsageRecords',
    ]) platform[name] = (...args: unknown[]) => {
      const tokenIndex = ['uploadUserAvatar', 'uploadEnterpriseLogo', 'createPersonalRecharge', 'getPersonalRecharge', 'reconcilePersonalRecharge'].includes(name) ? 1 : 0
      platformCalls.push(args[tokenIndex])
      started.resolve()
      return request.promise
    }
    const dependencies: Record<string, unknown> = {
      zod: { z },
      '../../common/platform/platform-api': platform,
      '../../common/platform/authentication-required-error': { AuthenticationRequiredError },
      '../../../src/shared/profile-wallet-contracts': profileContracts,
      '../../../src/shared/compute-credit-contracts': computeContracts,
      '../channels': { INVOKE_CHANNELS },
      '../router': { NO_INPUT: z.undefined(), route: (channel: string, schema: z.ZodType, handle: TestRoute['handle']) => ({ channel, schema, handle }) },
    }
    const loaded = { exports: {} as Record<string, TestRoute[]> }
    compileFunction(compiled, ['require', 'exports', 'module'])((id: string) => {
      assert.ok(Object.hasOwn(dependencies, id), id)
      return dependencies[id]
    }, loaded.exports, loaded)
    const route = loaded.exports[group.exportName].find(value => value.channel === channel)
    assert.ok(route)
    const ctx = { backend: {
      authSession: {
        getSessionRevision: () => revision,
        getValidAccessToken: () => {
          if (stage === 'token') { started.resolve(); return request.promise }
          return Promise.resolve('original-session-token')
        },
      },
      invalidateAuthentication: () => { invalidated.push(revision) },
    } }
    return { request, started: started.promise, invalidated, platformCalls,
      changeSession: () => { revision++ },
      invoke: () => route.handle(ctx, route.schema.parse(raw)),
    }
  }

  for (const [channel, input] of group.cases) {
    test(`${channel} only invalidates the session that started the failed request`, async () => {
      for (const stage of ['token', 'platform'] as const) {
        for (const stale of [false, true]) {
          for (const error of [new AuthenticationRequiredError(), new AuthApiError({ statusCode: 401, message: 'Unauthorized' })]) {
            const h = harness(channel, input, stage)
            const rejected = assert.rejects(h.invoke(), value => value === error)
            await h.started
            if (stale) h.changeSession()
            h.request.reject(error)
            await rejected
            assert.deepEqual(h.invalidated, stale ? [] : [1], `${stage}, stale=${stale}, ${error.name}`)
            if (stage === 'token') assert.deepEqual(h.platformCalls, [])
          }
        }
      }
    })

    test(`${channel} does not invalidate authentication for permission or transport failures`, async () => {
      for (const error of [new AuthApiError({ statusCode: 403, message: 'Forbidden' }), new TypeError('fetch failed')]) {
        const h = harness(channel, input)
        const rejected = assert.rejects(h.invoke(), value => value === error)
        await h.started
        h.request.reject(error)
        await rejected
        assert.deepEqual(h.invalidated, [])
      }
    })

    test(`${channel} preserves successful responses and the original access token`, async () => {
      const h = harness(channel, input)
      const pending = h.invoke()
      await h.started
      const data = { result: 'ok' }
      h.request.resolve(data)
      const expected = channel === INVOKE_CHANNELS.COMPUTE_CENTER_GET_OVERVIEW
        ? { allowance: data, wallet: data, breakdown: data } : data
      assert.deepEqual(await pending, { success: true, data: expected })
      assert.ok(h.platformCalls.length > 0)
      assert.ok(h.platformCalls.every(token => token === 'original-session-token'))
      assert.deepEqual(h.invalidated, [])
    })
  }
}
