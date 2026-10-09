/** 自动更新边界契约：编译源码并注入替身，不加载 Electron 或真实 updater。 */
import * as assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { compileFunction } from 'node:vm'
import * as ts from 'typescript'
import { z } from 'zod'
import type { ElectronAPI, UpdateState } from '../../src/shared/ipc'
import type { RendererBridge } from '../bootstrap/renderer-bridge'
import { AppError, appError } from '../errors/app-error'
import { EVENT_CHANNELS, INVOKE_CHANNELS } from './channels'
import type { RequestContext, createRequestContext } from './request-context'
import type { Route, RouteOptions } from './router'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const updateCommands = [
  ['getUpdateState', INVOKE_CHANNELS.UPDATE_GET_STATE, 'getState'],
  ['checkForUpdate', INVOKE_CHANNELS.UPDATE_CHECK, 'check'],
  ['downloadUpdate', INVOKE_CHANNELS.UPDATE_DOWNLOAD, 'download'],
  ['cancelUpdateDownload', INVOKE_CHANNELS.UPDATE_CANCEL, 'cancel'],
  ['installUpdate', INVOKE_CHANNELS.UPDATE_INSTALL, 'install'],
] as const

function source(relativePath: string): ts.SourceFile {
  return ts.createSourceFile(relativePath, readFileSync(join(repoRoot, relativePath), 'utf8'), ts.ScriptTarget.ESNext, true)
}

function loadSource<T>(relativePath: string, dependencies: Record<string, unknown> = {}): T {
  const compiled = ts.transpileModule(source(relativePath).text, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: relativePath,
  }).outputText
  const module = { exports: {} }
  const requireStub = (id: string): unknown => {
    assert.ok(Object.hasOwn(dependencies, id), `unexpected runtime import: ${id}`)
    return dependencies[id]
  }
  compileFunction(compiled, ['require', 'exports', 'module'], { filename: relativePath })(requireStub, module.exports, module)
  return module.exports as T
}

function loadRoutes(): readonly Route[] {
  return loadSource<{ updateRoutes: readonly Route[] }>('electron/controller/routes/update.ts', {
    '../channels': { INVOKE_CHANNELS },
    '../../errors/app-error': { appError },
    '../router': {
      NO_INPUT: z.undefined(),
      route: (channel: string, schema: z.ZodType, handle: Route['handle'], options: RouteOptions = {}) => ({
        channel, schema, handle, errorShape: options.errorShape ?? 'authenticated',
      }),
    },
  }).updateRoutes
}

function context(updater?: RequestContext['updater']): RequestContext {
  return {
    updater,
    backend: new Proxy({}, { get: () => assert.fail('update routes must not access authentication') }),
  } as RequestContext
}

function invoke(entry: Route, ctx: RequestContext): Promise<unknown> {
  return Promise.resolve().then(() => entry.handle(ctx, undefined as never))
}

describe('auto-update IPC contract', () => {
  it('declares the planned channels and registers the update route table', () => {
    assert.deepEqual(updateCommands.map(([, channel]) => channel), [
      'update:get-state', 'update:check', 'update:download', 'update:cancel', 'update:install',
    ])
    assert.equal(EVENT_CHANNELS.UPDATE_STATE_CHANGED, 'update:state-changed')
    const index = source('electron/controller/routes/index.ts')
    assert.ok(index.statements.some(statement => ts.isImportDeclaration(statement)
      && ts.isStringLiteral(statement.moduleSpecifier) && statement.moduleSpecifier.text === './update'
      && statement.importClause?.namedBindings?.getText(index) === '{ updateRoutes }'))
    let registered = false
    const visit = (node: ts.Node): void => {
      if (ts.isSpreadElement(node) && node.expression.getText(index) === 'updateRoutes') registered = true
      node.forEachChild(visit)
    }
    index.forEachChild(visit)
    assert.ok(registered)
  })

  it('keeps the exact public state fields and result envelope', () => {
    const ipc = source('src/shared/ipc.ts')
    const state = ipc.statements.find(statement => ts.isTypeAliasDeclaration(statement) && statement.name.text === 'UpdateState')
    assert.ok(state && ts.isTypeAliasDeclaration(state) && ts.isUnionTypeNode(state.type))
    const variants = state.type.types.map(variant => {
      assert.ok(ts.isTypeLiteralNode(variant))
      return Object.fromEntries(variant.members.map(member => {
        assert.ok(ts.isPropertySignature(member) && member.type && member.name)
        assert.equal(member.questionToken, undefined)
        return [member.name.getText(ipc), member.type.getText(ipc).replace(/\s+/g, '')]
      }))
    })
    assert.deepEqual(variants, [
      { status: "'idle'", currentVersion: 'string' },
      { status: "'checking'", currentVersion: 'string' },
      { status: "'available'", currentVersion: 'string', version: 'string', releaseDate: 'string|null', releaseNotes: 'string[]' },
      { status: "'downloading'", currentVersion: 'string', version: 'string', percent: 'number', transferred: 'number', total: 'number', bytesPerSecond: 'number' },
      { status: "'downloaded'", currentVersion: 'string', version: 'string' },
      { status: "'not-available'", currentVersion: 'string', checkedAt: 'string' },
      { status: "'error'", currentVersion: 'string', operation: "'check'|'download'|'cancel'|'install'", message: 'string', retryable: 'boolean' },
    ])
    const result = ipc.statements.find(statement => ts.isInterfaceDeclaration(statement) && statement.name.text === 'UpdateStateResult')
    assert.ok(result && ts.isInterfaceDeclaration(result))
    assert.equal(result.heritageClauses?.[0].getText(ipc), 'extends IpcCommandResult')
    assert.deepEqual(result.members.map(member => member.getText(ipc)), ['state?: UpdateState'])
    const api = ipc.statements.find(statement => ts.isInterfaceDeclaration(statement) && statement.name.text === 'ElectronAPI')
    assert.ok(api && ts.isInterfaceDeclaration(api))
    const members = new Map(api.members.map(member => [member.name?.getText(ipc), member.getText(ipc).replace(/\s+/g, '')]))
    for (const [method] of updateCommands) {
      assert.equal(members.get(method), `${method}:()=>Promise<${method === 'getUpdateState' ? 'UpdateStateResult' : 'IpcCommandResult'}>`)
    }
    assert.equal(members.get('onUpdateStateChanged'), 'onUpdateStateChanged:(callback:(state:UpdateState)=>void)=>()=>void')
  })

  it('accepts only undefined input and uses ordinary IPC errors for all five routes', () => {
    const routes = loadRoutes()
    assert.deepEqual(routes.map(entry => entry.channel), updateCommands.map(([, channel]) => channel))
    for (const entry of routes) {
      assert.equal(entry.errorShape, 'ipc')
      assert.equal(entry.schema.safeParse(undefined).success, true)
      for (const input of [null, {}, { confirmed: true }, '/tmp/update.exe', true, 1]) {
        assert.equal(entry.schema.safeParse(input).success, false)
      }
    }
  })

  it('returns the snapshot as state and delegates every command exactly once', async () => {
    const state: UpdateState = { status: 'idle', currentVersion: '1.0.0' }
    const calls: string[] = []
    const updater = Object.fromEntries(updateCommands.map(([, , method]) => [method, (...args: unknown[]) => {
      assert.deepEqual(args, [])
      calls.push(method)
      return method === 'getState' ? state : Promise.resolve()
    }])) as unknown as RequestContext['updater']
    for (const entry of loadRoutes()) {
      const result = await invoke(entry, context(updater))
      assert.deepEqual(result, entry.channel === INVOKE_CHANNELS.UPDATE_GET_STATE ? { success: true, state } : { success: true })
    }
    assert.deepEqual(calls, updateCommands.map(([, , method]) => method))
  })

  it('awaits command completion and propagates failures to the IPC router', async () => {
    for (const [, channel, method] of updateCommands.slice(1)) {
      let finish!: () => void
      const pending = new Promise<void>(resolve => { finish = resolve })
      const updater = { [method]: () => pending } as unknown as RequestContext['updater']
      const entry = loadRoutes().find(candidate => candidate.channel === channel)!
      let completed = false
      const result = invoke(entry, context(updater)).then(value => { completed = true; return value })
      await Promise.resolve()
      await Promise.resolve()
      assert.equal(completed, false)
      finish()
      assert.deepEqual(await result, { success: true })
    }
    const error = new Error('updater failure')
    const updater = Object.fromEntries(updateCommands.map(([, , method]) => [method, () => {
      if (method === 'getState') throw error
      return Promise.reject(error)
    }])) as unknown as RequestContext['updater']
    for (const entry of loadRoutes()) await assert.rejects(invoke(entry, context(updater)), candidate => candidate === error)
  })

  it('fails with a fixed non-authentication error when the updater is unavailable', async () => {
    for (const entry of loadRoutes()) {
      await assert.rejects(invoke(entry, context()), error => {
        assert.ok(error instanceof AppError)
        assert.equal(error.code, 'SERVICE_UNAVAILABLE')
        assert.equal(error.userMessage, '自动更新服务暂不可用')
        return true
      })
    }
  })

  it('preserves two-argument context creation and exposes the optional updater', () => {
    const { createRequestContext: create } = loadSource<{ createRequestContext: typeof createRequestContext }>('electron/controller/request-context.ts')
    const backend = { notifications: {}, skills: {}, tasks: {}, conversations: {}, arrangements: {}, employees: {} } as unknown as RequestContext['backend']
    const window = () => null
    const existing = create(backend, window)
    assert.equal(existing.updater, undefined)
    assert.equal(existing.backend, backend)
    assert.equal(existing.window, window)
    for (const key of ['notifications', 'skills', 'tasks', 'conversations', 'arrangements', 'employees'] as const) {
      assert.equal(existing[key], backend[key])
    }
    const updater = {} as NonNullable<RequestContext['updater']>
    assert.equal(create(backend, window, updater).updater, updater)
  })

  it('preload invokes commands without input and unsubscribes the exact event handler', async () => {
    let api!: ElectronAPI
    const calls: unknown[][] = []
    const listeners = new Map<string, (event: unknown, state: UpdateState) => void>()
    const responses = new Map(updateCommands.map(([, channel]) => [channel, { success: true }]))
    loadSource('electron/preload.ts', {
      electron: {
        contextBridge: { exposeInMainWorld: (name: string, value: ElectronAPI) => { assert.equal(name, 'electronAPI'); api = value } },
        ipcRenderer: {
          invoke: (...args: unknown[]) => { calls.push(args); return Promise.resolve(responses.get(args[0] as typeof INVOKE_CHANNELS.UPDATE_CHECK)) },
          on: (channel: string, handler: (event: unknown, state: UpdateState) => void) => { listeners.set(channel, handler) },
          removeListener: (channel: string, handler: unknown) => { assert.equal(listeners.get(channel), handler); listeners.delete(channel) },
        },
      },
      './controller/channels': { INVOKE_CHANNELS, EVENT_CHANNELS },
      './common/window-layout': { getWindowChromeConfig: () => ({ contentTop: 0, windowsRightInset: 0 }) },
    })
    for (const [method, channel] of updateCommands) assert.equal(await api[method](), responses.get(channel))
    assert.deepEqual(calls, updateCommands.map(([, channel]) => [channel]))
    const received: UpdateState[] = []
    const unsubscribe = api.onUpdateStateChanged(state => received.push(state))
    const state: UpdateState = { status: 'checking', currentVersion: '1.0.0' }
    assert.deepEqual([...listeners.keys()], [EVENT_CHANNELS.UPDATE_STATE_CHANGED])
    listeners.get(EVENT_CHANNELS.UPDATE_STATE_CHANGED)!({ secret: 'event is not forwarded' }, state)
    assert.deepEqual(received, [state])
    unsubscribe()
    assert.equal(listeners.size, 0)
  })

  it('bridge pushes update snapshots only to an attached live window', () => {
    const { RendererBridge: Bridge } = loadSource<{ RendererBridge: typeof RendererBridge }>('electron/bootstrap/renderer-bridge.ts', {
      '../controller/channels': { EVENT_CHANNELS },
    })
    const bridge = new Bridge()
    const state: UpdateState = { status: 'downloaded', currentVersion: '1.0.0', version: '1.1.0' }
    const calls: unknown[][] = []
    let destroyed = false
    const window = { isDestroyed: () => destroyed, webContents: { send: (...args: unknown[]) => calls.push(args) } } as unknown as NonNullable<ReturnType<RendererBridge['currentWindow']>>
    bridge.updateStateChanged(state)
    bridge.attach(window)
    bridge.updateStateChanged(state)
    destroyed = true
    bridge.updateStateChanged(state)
    bridge.attach(null)
    bridge.updateStateChanged(state)
    assert.deepEqual(calls, [[EVENT_CHANNELS.UPDATE_STATE_CHANGED, state]])
  })
})
