import * as assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { compileFunction } from 'node:vm'
import * as ts from 'typescript'
import { z } from 'zod'
import { AppError, appError } from '../errors/app-error'
import { INVOKE_CHANNELS, FEEDBACK_OPERATION_BY_CHANNEL } from './channels'
import type { RequestContext } from './request-context'
import type { Route, RouteOptions } from './router'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const routesByChannel = new Map<string, (event: unknown, input: unknown) => Promise<unknown>>()
const ipcMain = { handle(channel: string, handler: (event: unknown, input: unknown) => Promise<unknown>) { routesByChannel.set(channel, handler) } }

function loadSource<T>(path: string, dependencies: Record<string, unknown>): T {
  const compiled = ts.transpileModule(readFileSync(join(root, path), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }, fileName: path,
  }).outputText
  const module = { exports: {} }
  const requireStub = (id: string): unknown => {
    assert.ok(Object.hasOwn(dependencies, id), `${path}: unexpected runtime import ${id}`)
    return dependencies[id]
  }
  compileFunction(compiled, ['require', 'exports', 'module'], { filename: path })(requireStub, module.exports, module)
  return module.exports as T
}

function loadSkillRoutes(): readonly Route[] {
  return loadSource<{ skillImportRoutes: readonly Route[] }>('electron/controller/routes/skill-import.ts', {
    electron: { dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) } },
    zod: { z },
    '../../../src/shared/skill-import-contracts': loadSource('src/shared/skill-import-contracts.ts', { zod: { z } }),
    '../../errors/app-error': { appError },
    '../../service/skill-import-service': {},
    '../channels': { INVOKE_CHANNELS },
    '../request-context': {},
    '../router': { NO_INPUT: z.undefined(), route: (channel: string, schema: z.ZodType, handle: Route['handle'], options: RouteOptions = {}) => ({ channel, schema, handle, errorShape: options.errorShape ?? 'authenticated', trustedMainFrame: options.trustedMainFrame }) },
  }).skillImportRoutes
}

function setupRouter(routes: readonly Route[]): void {
  routesByChannel.clear()
  const router = loadSource<{ registerRoutes(ctx: RequestContext, tables: { routes: readonly Route[]; listeners: readonly [] }): void }>('electron/controller/router.ts', {
    electron: { ipcMain }, zod: { z }, '../common/logger': { logger: { child: () => ({ warn() {}, info() {} }) } },
    '../errors/app-error': { appError }, '../errors/error-mapper': { authFailure: () => ({ success: false }), failure: (code: string) => ({ success: false, error: { code } }) },
    '../errors/error-reporter': { reportAuthFailure: () => ({ success: false }), reportFailure: (_channel: string, error: unknown) => ({ success: false, error: { code: error instanceof AppError ? error.code : 'FAILED' } }) },
    './channels': { FEEDBACK_OPERATION_BY_CHANNEL, INVOKE_CHANNELS, SEND_CHANNELS: {}, }, './request-context': {},
  })
  const ctx = { window: () => ({ isDestroyed: () => false, webContents: { mainFrame: { id: 1 } } }) } as unknown as RequestContext
  router.registerRoutes(ctx, { routes, listeners: [] })
}

describe('skill import IPC boundary', () => {
  it('registers only trusted-main-frame routes with ordinary IPC errors and no business auth', () => {
    const routes = loadSkillRoutes()
    assert.equal(routes.length, 7)
    for (const entry of routes) {
      assert.equal(entry.trustedMainFrame, true)
      assert.equal(entry.errorShape, 'ipc')
      assert.equal(FEEDBACK_OPERATION_BY_CHANNEL[entry.channel], undefined)
    }
    const source = readFileSync(join(root, 'electron/controller/routes/skill-import.ts'), 'utf8')
    assert.doesNotMatch(source, /withAuth|currentScope|getValidAccessToken/)
  })

  it('rejects an untrusted sender and every malformed or path-bearing input before handlers run', async () => {
    const routes = loadSkillRoutes(); setupRouter(routes)
    let calls = 0
    const service = new Proxy({}, { get: () => () => { calls += 1; return Promise.resolve() } })
    const window = { isDestroyed: () => false, webContents: { mainFrame: { id: 1 } } }
    const ctx = { window: () => window, skillImport: service } as unknown as RequestContext
    const { registerRoutes } = loadSource<{ registerRoutes: (ctx: RequestContext, tables: { routes: readonly Route[]; listeners: readonly [] }) => void }>('electron/controller/router.ts', {
      electron: { ipcMain }, zod: { z }, '../common/logger': { logger: { child: () => ({ warn() {}, info() {} }) } },
      '../errors/app-error': { appError }, '../errors/error-mapper': { authFailure: () => ({ success: false }), failure: (code: string) => ({ success: false, error: { code } }) },
      '../errors/error-reporter': { reportAuthFailure: () => ({ success: false }), reportFailure: (_channel: string, error: unknown) => ({ success: false, error: { code: error instanceof AppError ? error.code : 'FAILED' } }) },
      './channels': { FEEDBACK_OPERATION_BY_CHANNEL, INVOKE_CHANNELS, SEND_CHANNELS: {} }, './request-context': {},
    })
    registerRoutes(ctx, { routes, listeners: [] })
    const invoke = (channel: string, input: unknown, sender: unknown = window.webContents, senderFrame: unknown = window.webContents.mainFrame) => routesByChannel.get(channel)!({ sender, senderFrame }, input)
    const rejected = await invoke(INVOKE_CHANNELS.SKILL_IMPORT_STATE, undefined, {}, window.webContents.mainFrame) as { success: boolean }
    assert.equal(rejected.success, false)
    for (const [channel, input] of [
      [INVOKE_CHANNELS.SKILL_IMPORT_CONSENT, { pairingId: '../secret', rememberDevice: true, scope: 'all', rootIds: ['/Users/me'] }],
      [INVOKE_CHANNELS.SKILL_IMPORT_SELECT_ROOT, { path: '/Users/me' }],
      [INVOKE_CHANNELS.SKILL_IMPORT_REMOVE_ROOT, { rootId: '/Users/me' }],
      [INVOKE_CHANNELS.SKILL_IMPORT_CANCEL, { sessionId: 's', grant: 'bearer' }],
      [INVOKE_CHANNELS.SKILL_IMPORT_REVOKE, { deviceId: 'd', privateKey: 'secret' }],
      [INVOKE_CHANNELS.SKILL_IMPORT_VISIBLE, { visible: true, url: 'https://evil.invalid' }],
    ] as const) {
      const result = await invoke(channel, input) as { success: boolean }
      assert.equal(result.success, false, channel)
    }
    assert.equal(calls, 0, 'invalid/untrusted IPC must not reach service handlers')
  })
})
