import * as assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { compileFunction } from 'node:vm'
import { describe, it } from 'node:test'
import * as ts from 'typescript'
import { z } from 'zod'
import * as contracts from '../../src/shared/speech-contracts'
import { appError } from '../errors/app-error'
import { INVOKE_CHANNELS, FEEDBACK_OPERATION_BY_CHANNEL } from './channels'
import type { RequestContext } from './request-context'
import type { Route } from './router'

function load<T>(file: string, dependencies: Record<string, unknown>): T {
  const source = readFileSync(new URL(file, import.meta.url), 'utf8')
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const module = { exports: {} }
  compileFunction(output, ['require', 'exports', 'module'])(
    (name: string) => { assert.ok(Object.hasOwn(dependencies, name), name); return dependencies[name] }, module.exports, module,
  )
  return module.exports as T
}

function fixture(permission = 'prompt') {
  const handlers = new Map<string, (event: unknown, input: unknown) => Promise<{ success: boolean }>>()
  const failure = () => ({ success: false, error: { code: 'INVALID_ARGUMENT' } })
  const router = load<typeof import('./router')>('./router.ts', {
    electron: { ipcMain: { handle: (name: string, handle: (event: unknown, input: unknown) => Promise<{ success: boolean }>) => handlers.set(name, handle) } },
    zod: { z }, '../common/logger': { logger: { child: () => ({ info: () => {}, warn: () => {} }) } },
    '../errors/app-error': { appError }, '../errors/error-mapper': { authFailure: failure, failure },
    '../errors/error-reporter': { reportAuthFailure: failure, reportFailure: failure },
    './channels': { FEEDBACK_OPERATION_BY_CHANNEL, INVOKE_CHANNELS },
  })
  const { speechRoutes } = load<{ speechRoutes: Route[] }>('./routes/speech.ts', {
    electron: { dialog: { showMessageBox: () => assert.fail('Must not ask consent while opening system settings') } },
    zod: { z }, '../../../src/shared/speech-contracts': contracts,
    '../../errors/app-error': { appError }, '../channels': { INVOKE_CHANNELS }, '../router': router,
  })
  let opened = 0
  let begun = 0
  let enabled = 0
  const webContents = { mainFrame: {} }
  const ctx = { window: () => ({ isDestroyed: () => false, webContents }),
    speech: {
      openSystemSettings: async () => { opened++ },
      getPermission: async () => permission,
      begin: async (recordingId: string, ask: () => Promise<boolean>) => { begun++; return { recordingId, ready: false, permission: await ask() ? 'granted' : permission } },
      setEnabled: async (_enabled: boolean, ask: () => Promise<boolean>) => { enabled++; return await ask() ? 'granted' : permission },
    } } as unknown as RequestContext
  router.registerRoutes(ctx, { routes: speechRoutes, listeners: [] })
  const invoke = (input: unknown, event = { sender: webContents, senderFrame: webContents.mainFrame }) => handlers.get(INVOKE_CHANNELS.SPEECH_OPEN_SYSTEM_SETTINGS)!(event, input)
  const command = (channel: string, input: unknown, event = { sender: webContents, senderFrame: webContents.mainFrame }) => handlers.get(channel)!(event, input)
  return { routes: speechRoutes, invoke, command, get opened() { return opened }, get begun() { return begun }, get enabled() { return enabled } }
}

describe('system microphone settings IPC boundary', () => {
  it('all speech commands require the trusted main frame', () => {
    const f = fixture()
    assert.equal(f.routes.length, 6)
    assert.ok(f.routes.every(route => route.trustedMainFrame))
  })
  it('accepts only an argument-free explicit settings action', async () => {
    const f = fixture()
    for (const input of [{ url: 'https://untrusted.invalid' }, 'ms-settings:privacy-microphone', null, true]) {
      assert.equal((await f.invoke(input)).success, false)
    }
    assert.equal(f.opened, 0)
    assert.equal((await f.invoke(undefined)).success, true)
    assert.equal(f.opened, 1)
  })
  it('rejects subframes and other renderers before opening anything', async () => {
    const f = fixture()
    assert.equal((await f.invoke(undefined, { sender: {}, senderFrame: {} } as never)).success, false)
    assert.equal(f.opened, 0)
  })
  it('does not begin recording or enable speech without explicit application consent', async () => {
    const f = fixture()
    for (const consent of [undefined, false]) {
      assert.equal((await f.command(INVOKE_CHANNELS.SPEECH_BEGIN, { recordingId: 'recording-a', consent })).success, true)
      assert.equal((await f.command(INVOKE_CHANNELS.SPEECH_SET_ENABLED, { enabled: true, consent })).success, true)
    }
    assert.equal(f.begun, 0)
    assert.equal(f.enabled, 0)
    await f.command(INVOKE_CHANNELS.SPEECH_BEGIN, { recordingId: 'recording-a', consent: true })
    await f.command(INVOKE_CHANNELS.SPEECH_SET_ENABLED, { enabled: true, consent: true })
    assert.equal(f.begun, 1)
    assert.equal(f.enabled, 1)
  })
  it('validates consent and sender identity before accepting permission', async () => {
    const f = fixture()
    assert.equal((await f.command(INVOKE_CHANNELS.SPEECH_BEGIN, { recordingId: 'recording-a', consent: 'yes' })).success, false)
    assert.equal((await f.command(INVOKE_CHANNELS.SPEECH_SET_ENABLED, { enabled: true, consent: true }, { sender: {}, senderFrame: {} } as never)).success, false)
    assert.equal(f.begun, 0)
    assert.equal(f.enabled, 0)
    const granted = fixture('granted')
    assert.equal((await granted.command(INVOKE_CHANNELS.SPEECH_BEGIN, { recordingId: 'recording-a' })).success, true)
    assert.equal(granted.begun, 1)
  })
})
