/** 工厂行为测试：执行真实工厂与 AppUpdater，替换 Electron 和原生 SDK 加载边界。 */
import * as assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { describe, it, mock } from 'node:test'
import { fileURLToPath } from 'node:url'
import { compileFunction } from 'node:vm'
import * as ts from 'typescript'
import type { CancellationToken, UpdateCheckResult } from 'electron-updater'
import type { UpdateState } from '../../src/shared/ipc'
import { supportsAppUpdates } from '../common/update-config'
import { AppError } from '../errors/app-error'
import { AppUpdater, type UpdateDriver } from './app-updater'
import type { Backend } from './build-backend'
import type { RendererBridge } from './renderer-bridge'

type SdkLogger = Record<'info' | 'warn' | 'error' | 'debug', (...args: unknown[]) => void>
type Failure = 'require' | 'construct' | 'configure'
const disabledMessage = '当前开发环境或平台不支持自动更新，请手动下载新版本。'
const sourceUrl = new URL('./create-app-updater.ts', import.meta.url).href

class Driver extends EventEmitter implements UpdateDriver {
  autoDownload = true
  autoInstallOnAppQuit = true
  autoRunAppAfterInstall = false
  allowDowngrade = true
  disableWebInstaller = false
  requestHeaders = { Authorization: 'Bearer sdk-default-secret' }
  logger: SdkLogger | null = null
  private prerelease = false
  get allowPrerelease(): boolean { return this.prerelease }
  set allowPrerelease(value: boolean) {
    this.prerelease = value
    // 模拟 SDK 的 setter 副作用，验证工厂最终仍然禁止降级。
    this.allowDowngrade = true
  }
  readonly currentVersion = { compare: mock.fn((_version: string) => -1) }
  readonly checkForUpdates = mock.fn(async (): Promise<UpdateCheckResult> => ({
    isUpdateAvailable: true,
    updateInfo: { version: '0.1.3', files: [] },
  } as unknown as UpdateCheckResult))
  readonly downloadUpdate = mock.fn(async (_token: CancellationToken): Promise<string[]> => {
    this.emit('update-downloaded', { version: '0.1.3' })
    return ['/private/update.zip']
  })
  readonly quitAndInstall = mock.fn(() => undefined)
}

function setup(options: {
  packaged?: boolean
  platform?: string
  arch?: string
  version?: string
  failure?: Failure
  installFailure?: 'cleanup' | 'install'
  recoveryWork?: Promise<void>
} = {}) {
  const driver = new Driver()
  const rawFailure = new Error('SDK failed at /Users/private/update.zip from https://updates.test/file?token=secret')
  if (options.failure === 'configure') {
    Object.defineProperty(driver, 'disableWebInstaller', { set: () => { throw rawFailure } })
  }
  const getSdkUpdater = mock.fn(() => {
    if (options.failure === 'construct') throw rawFailure
    return driver
  })
  const sdk = {
    get autoUpdater() { return getSdkUpdater() },
    CancellationToken: class extends EventEmitter {
      cancelled = false
      cancel(): void { this.cancelled = true; this.emit('cancel') }
      dispose(): void { this.removeAllListeners() }
    },
  }
  const nativeRequire = mock.fn((id: string) => {
    assert.equal(id, 'electron-updater')
    if (options.failure === 'require') throw rawFailure
    return sdk
  })
  const createRequire = mock.fn((_url: string) => nativeRequire)
  const records: Array<{ level: string; scope: string; args: unknown[] }> = []
  const logger = {
    child: (scope: string) => Object.fromEntries(['info', 'warn', 'error', 'debug'].map(level => [
      level, (...args: unknown[]) => records.push({ level, scope, args }),
    ])),
  }
  const stats = mock.fn(async () => {
    assert.ok(options.installFailure, 'factory/check must not read business task state')
    return { total: 0, pending: 0, running: 0, waitingApproval: 0, paused: 0, interrupted: 0, completed: 0, failed: 0 }
  })
  const recoveryOrder: string[] = []
  const stopAll = mock.fn(() => {
    assert.ok(options.installFailure, 'factory/check must not stop business tasks')
    recoveryOrder.push('stopAll')
    return options.installFailure === 'cleanup' ? Promise.reject(rawFailure) : Promise.resolve()
  })
  const resumeClientMonitor = mock.fn(() => {
    assert.ok(options.installFailure, 'unexpected client monitor recovery')
    recoveryOrder.push('resumeClientMonitor')
    return options.recoveryWork ?? Promise.resolve()
  })
  const loginRefresh = mock.fn(() => assert.fail('update recovery must not refresh authentication'))
  const backend = {
    tasks: { stats }, stopAll, resumeClientMonitor,
    authSession: new Proxy({}, { get: () => loginRefresh }),
  } as unknown as Backend
  if (options.installFailure === 'install') {
    driver.quitAndInstall.mock.mockImplementation(() => { throw rawFailure })
  }
  const states: UpdateState[] = []
  const notificationUpdated = mock.fn((_update: { type: 'resync' }) => { recoveryOrder.push('resync') })
  const bridge = {
    updateStateChanged: (state: UpdateState) => { states.push(state) }, notificationUpdated,
  } as unknown as RendererBridge
  const withTimeout = mock.fn((work: Promise<void>, _budgetMs: number, _operation: string) => work)
  const version = options.version ?? '0.1.2'
  const dependencies: Record<string, unknown> = {
    'node:module': { createRequire },
    electron: { app: { isPackaged: options.packaged ?? true, getVersion: () => version } },
    '../common/logger': { logger },
    '../common/update-config': { supportsAppUpdates },
    '../common/with-timeout': { withTimeout },
    './app-updater': { AppUpdater },
    './shutdown': { SHUTDOWN_BUDGET_MS: 5_000 },
  }
  const filename = fileURLToPath(sourceUrl)
  const compiled = ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: filename,
    transformers: { before: [context => {
      const visit: ts.Visitor = node => {
        // CommonJS VM 无 import.meta；只替换 URL 表达式，保留真实 createRequire 调用。
        if (ts.isPropertyAccessExpression(node) && node.name.text === 'url'
          && ts.isMetaProperty(node.expression) && node.expression.keywordToken === ts.SyntaxKind.ImportKeyword) {
          return context.factory.createStringLiteral(sourceUrl)
        }
        return ts.visitEachChild(node, visit, context)
      }
      return root => ts.visitNode(root, visit) as ts.SourceFile
    }] },
  }).outputText
  const module = { exports: {} }
  const requireStub = (id: string): unknown => {
    assert.ok(Object.hasOwn(dependencies, id), `unexpected runtime import: ${id}`)
    return dependencies[id]
  }
  // 注入平台而非修改全局 process，测试与宿主平台无关。
  compileFunction(compiled, ['require', 'exports', 'module', 'process'], { filename })(
    requireStub, module.exports, module, { platform: options.platform ?? 'darwin', arch: options.arch ?? 'arm64' },
  )
  const factory = module.exports as typeof import('./create-app-updater')
  return {
    create: () => factory.createAppUpdater(backend, bridge), driver, createRequire, nativeRequire,
    getSdkUpdater, records, stats, stopAll, states, version, resumeClientMonitor, loginRefresh,
    notificationUpdated, withTimeout, recoveryOrder,
  }
}

async function assertDisabled(updater: AppUpdater, version: string): Promise<void> {
  assert.ok(updater instanceof AppUpdater)
  assert.deepEqual(updater.getState(), { status: 'idle', currentVersion: version })
  await assert.rejects(updater.check(), error => {
    assert.ok(error instanceof AppError)
    assert.equal(error.code, 'INVALID_STATE')
    assert.equal(error.message, disabledMessage)
    return true
  })
}

describe('createAppUpdater behavior', () => {
  for (const [packaged, platform, arch] of [
    [false, 'darwin', 'arm64'],
    [false, 'win32', 'x64'],
    [true, 'linux', 'x64'],
    [true, 'linux', 'arm64'],
    [true, 'win32', 'arm64'],
    [true, 'win32', 'ia32'],
    [true, 'darwin', 'ia32'],
  ] as const) {
    it(`does not load the SDK for ${packaged ? 'packaged' : 'development'} ${platform}/${arch}`, async t => {
      const harness = setup({ packaged, platform, arch })
      const updater = harness.create()
      t.after(() => updater.dispose())
      await assertDisabled(updater, harness.version)
      assert.equal(harness.createRequire.mock.callCount(), 0)
      assert.equal(harness.nativeRequire.mock.callCount(), 0)
      assert.equal(harness.getSdkUpdater.mock.callCount(), 0)
      assert.equal(harness.driver.checkForUpdates.mock.callCount(), 0)
      assert.equal(harness.driver.eventNames().length, 0)
      assert.equal(harness.stats.mock.callCount(), 0)
      assert.equal(harness.stopAll.mock.callCount(), 0)
      assert.deepEqual(harness.records, [])
      assert.deepEqual(harness.states, [])
    })
  }

  for (const [platform, arch] of [['darwin', 'arm64'], ['darwin', 'x64'], ['win32', 'x64']] as const) {
    for (const version of ['0.1.2', '0.1.2-beta.1']) {
      it(`configures the native SDK safely for ${platform}/${arch} ${version}`, async t => {
        const harness = setup({ platform, arch, version })
        const updater = harness.create()
        t.after(() => updater.dispose())
        assert.ok(updater instanceof AppUpdater)
        assert.deepEqual(harness.createRequire.mock.calls.map(call => call.arguments), [[sourceUrl]])
        assert.deepEqual(harness.nativeRequire.mock.calls.map(call => call.arguments), [['electron-updater']])
        assert.equal(harness.getSdkUpdater.mock.callCount(), 1)
        assert.equal(harness.driver.autoDownload, false)
        assert.equal(harness.driver.autoInstallOnAppQuit, false)
        assert.equal(harness.driver.autoRunAppAfterInstall, true)
        assert.equal(harness.driver.allowPrerelease, version.includes('-'))
        assert.equal(harness.driver.allowDowngrade, false)
        assert.equal(harness.driver.disableWebInstaller, true)
        assert.deepEqual(harness.driver.requestHeaders, {})
        assert.equal(harness.driver.checkForUpdates.mock.callCount(), 0)
        assert.equal(harness.driver.downloadUpdate.mock.callCount(), 0)
        assert.equal(harness.driver.quitAndInstall.mock.callCount(), 0)

        await updater.check()
        assert.equal(harness.driver.checkForUpdates.mock.callCount(), 1)
        assert.deepEqual(harness.driver.currentVersion.compare.mock.calls.map(call => call.arguments), [['0.1.3']])
        assert.deepEqual(harness.states.map(state => state.status), ['checking', 'available'])
        assert.equal(updater.getState().currentVersion, version)
        assert.equal(harness.stats.mock.callCount(), 0)
        assert.equal(harness.stopAll.mock.callCount(), 0)
      })
    }
  }

  for (const failure of ['require', 'construct', 'configure'] as const) {
    it(`returns a disabled updater with a fixed check error after SDK ${failure} failure`, async t => {
      const harness = setup({ failure })
      const updater = harness.create()
      t.after(() => updater.dispose())
      await assertDisabled(updater, harness.version)
      assert.equal(harness.nativeRequire.mock.callCount(), 1)
      assert.equal(harness.getSdkUpdater.mock.callCount(), failure === 'require' ? 0 : 1)
      assert.equal(harness.driver.eventNames().length, 0)
      assert.equal(harness.stats.mock.callCount(), 0)
      assert.equal(harness.stopAll.mock.callCount(), 0)
      assert.deepEqual(harness.states, [])
      assert.deepEqual(harness.records, [{ level: 'warn', scope: 'app-updater', args: ['updater initialization failed'] }])
      assert.doesNotMatch(JSON.stringify(harness.records), /https?:|\/Users\/|secret|update\.zip/)
    })
  }

  for (const installFailure of ['cleanup', 'install'] as const) {
    it(`restores the client monitor and sends resync after ${installFailure} failure without refreshing login`, async t => {
      let finishRecovery!: () => void
      const recoveryWork = new Promise<void>(resolve => { finishRecovery = resolve })
      const harness = setup({ installFailure, recoveryWork })
      const updater = harness.create()
      t.after(() => updater.dispose())
      await updater.check()
      await updater.download()
      assert.equal(updater.getState().status, 'downloaded')
      let completed = false
      const installed = updater.install().finally(() => { completed = true })
      const rejected = assert.rejects(installed, error => {
        assert.ok(error instanceof AppError)
        assert.equal(error.message, '安装更新失败，请稍后重试或手动下载新版本。')
        return true
      })
      await new Promise<void>(resolve => setImmediate(resolve))

      assert.equal(completed, false, 'install must wait for background recovery to settle')
      assert.equal(harness.stopAll.mock.callCount(), 1)
      assert.equal(harness.resumeClientMonitor.mock.callCount(), 1)
      assert.deepEqual(harness.notificationUpdated.mock.calls.map(call => call.arguments), [[{ type: 'resync' }]])
      assert.deepEqual(harness.recoveryOrder, ['stopAll', 'resync', 'resumeClientMonitor'])
      assert.deepEqual(harness.withTimeout.mock.calls.map(call => call.arguments.slice(1)), [
        [5_000, 'update-install-cleanup'], [5_000, 'update-install-recovery'],
      ])
      assert.equal(harness.withTimeout.mock.calls[0].arguments[0], harness.stopAll.mock.calls[0].result)
      assert.equal(harness.withTimeout.mock.calls[1].arguments[0], recoveryWork)
      assert.equal(harness.driver.quitAndInstall.mock.callCount(), installFailure === 'cleanup' ? 0 : 1)
      assert.equal(updater.isInstallPrepared(), false)
      assert.equal(harness.loginRefresh.mock.callCount(), 0)

      finishRecovery()
      await rejected
      assert.equal(completed, true)
      assert.equal(harness.loginRefresh.mock.callCount(), 0)
    })
  }

  it('logs only fixed SDK messages without forwarding URLs, local paths, errors, or header objects', t => {
    const harness = setup()
    const updater = harness.create()
    t.after(() => updater.dispose())
    const sdkLogger = harness.driver.logger
    assert.ok(sdkLogger)
    const messages = { info: 'updater activity', warn: 'updater warning', error: 'updater failure', debug: 'updater diagnostic' }
    for (const level of ['info', 'warn', 'error', 'debug'] as const) {
      sdkLogger[level](
        'https://updates.test/file?token=secret', '/Users/private/update.zip',
        new Error('SDK response includes private-token'), { Authorization: 'Bearer secret' },
      )
    }
    assert.deepEqual(harness.records, Object.entries(messages).map(([level, message]) => ({ level, scope: 'update-sdk', args: [message] })))
    assert.doesNotMatch(JSON.stringify(harness.records), /https?:|\/Users\/|secret|Authorization|private-token/)
  })
})
