import * as assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { describe, it } from 'node:test'
import type { CancellationToken, UpdateCheckResult } from 'electron-updater'
import type { UpdateState } from '../../src/shared/ipc'
import type { ClientTaskStats } from '../../src/shared/types'
import { AppUpdater, normalizeReleaseNotes, type UpdateDriver } from './app-updater'

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: unknown) => void } {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b })
  return { promise, resolve, reject }
}

class FakeToken extends EventEmitter {
  cancelled = false
  disposed = false
  cancel(): void { this.cancelled = true; this.emit('cancel') }
  dispose(): void { this.disposed = true }
}

class Driver extends EventEmitter implements UpdateDriver {
  checkCalls = 0
  downloadCalls = 0
  installCalls = 0
  result = { isUpdateAvailable: true, updateInfo: { version: '0.1.3', files: [], releaseDate: '2026-10-09', releaseNotes: '修复启动失败\nhttps://cdn.test/private?token=secret' } } as unknown as UpdateCheckResult
  checkWork: Promise<UpdateCheckResult | null> | null = null
  downloadWork: ((token: CancellationToken) => Promise<string[]>) | null = null
  async checkForUpdates(): Promise<UpdateCheckResult | null> { this.checkCalls++; return this.checkWork ?? this.result }
  async downloadUpdate(token: CancellationToken): Promise<string[]> {
    this.downloadCalls++
    if (this.downloadWork) return this.downloadWork(token)
    this.emit('update-downloaded', { version: '0.1.3', downloadedFile: '/private/secret.zip' })
    return ['/private/secret.zip']
  }
  quitAndInstall(): void { this.installCalls++ }
}

function setup(enabled = true): {
  driver: Driver; updater: AppUpdater; states: UpdateState[]; tokens: FakeToken[]
  stats: ClientTaskStats; setPrepare: (work: () => Promise<void>) => void; setRecover: (work: () => Promise<void>) => void
} {
  const driver = new Driver()
  const states: UpdateState[] = []
  const tokens: FakeToken[] = []
  const stats: ClientTaskStats = { total: 0, pending: 0, running: 0, waitingApproval: 0, paused: 0, interrupted: 0, completed: 0, failed: 0 }
  let prepare = async (): Promise<void> => {}
  let recover = async (): Promise<void> => {}
  const updater = new AppUpdater({
    currentVersion: '0.1.2', driver: enabled ? driver : null,
    createToken: () => { const token = new FakeToken(); tokens.push(token); return token as unknown as CancellationToken },
    isNewerVersion: version => version === '0.1.3',
    taskStats: async () => ({ ...stats }), prepareInstall: () => prepare(), restoreAfterInstallFailure: () => recover(), publish: state => states.push(state),
  })
  return { driver, updater, states, tokens, stats, setPrepare: work => { prepare = work }, setRecover: work => { recover = work } }
}

async function downloaded(): Promise<ReturnType<typeof setup>> {
  const test = setup()
  await test.updater.check()
  await test.updater.download()
  return test
}

describe('AppUpdater', () => {
  it('checks without downloading and exposes a detached sanitized snapshot', async () => {
    const { updater, driver, states } = setup()
    await updater.check()
    assert.deepEqual(states.map(state => state.status), ['checking', 'available'])
    assert.equal(driver.downloadCalls, 0)
    const state = updater.getState()
    assert.equal(state.status, 'available')
    if (state.status !== 'available') return
    assert.deepEqual(state.releaseNotes, ['修复启动失败'])
    state.releaseNotes.push('mutation')
    assert.deepEqual((updater.getState() as typeof state).releaseNotes, ['修复启动失败'])
    assert.doesNotMatch(JSON.stringify(states), /https:|secret|downloadedFile/)
  })

  it('reports equal/older versions as unavailable and rejects download', async () => {
    for (const version of ['0.1.1', '0.1.2']) {
      const { updater, driver } = setup()
      driver.result = { ...driver.result, updateInfo: { ...driver.result.updateInfo, version } }
      await updater.check()
      assert.equal(updater.getState().status, 'not-available')
      await assert.rejects(updater.download(), /先检查/)
    }
  })

  it('does not treat an unavailable newer response as an available update', async () => {
    const { updater, driver } = setup()
    driver.result = { ...driver.result, isUpdateAvailable: false }
    await updater.check()
    assert.equal(updater.getState().status, 'not-available')
  })

  it('rejects malformed or missing check results with a fixed error', async () => {
    for (const result of [null, { isUpdateAvailable: true, updateInfo: { version: 'https://secret.test/token' } }, { isUpdateAvailable: 'yes', updateInfo: { version: '0.1.3' } }]) {
      const { updater, driver } = setup()
      driver.checkWork = Promise.resolve(result as UpdateCheckResult | null)
      await assert.rejects(updater.check(), /检查更新失败/)
      assert.equal(updater.getState().status, 'error')
      assert.doesNotMatch(JSON.stringify(updater.getState()), /secret|https:/)
    }
  })

  it('keeps one check in flight and can retry after failure', async () => {
    const { updater, driver } = setup()
    const work = deferred<UpdateCheckResult>()
    driver.checkWork = work.promise
    const first = updater.check()
    await assert.rejects(updater.check(), /正在进行/)
    work.reject(new Error('https://secret.test/token=password'))
    await assert.rejects(first, /检查更新失败/)
    assert.doesNotMatch(JSON.stringify(updater.getState()), /secret|password/)
    driver.checkWork = null
    await updater.check()
    assert.equal(driver.checkCalls, 2)
  })

  it('normalizes valid progress, ignores malformed progress, and requires verified completion', async () => {
    const { updater, driver, tokens } = setup()
    await updater.check()
    const work = deferred<string[]>()
    driver.downloadWork = () => work.promise
    const download = updater.download()
    await Promise.resolve()
    await assert.rejects(updater.download(), /正在进行/)
    await assert.rejects(updater.check(), /正在进行/)
    driver.emit('download-progress', { percent: 120, transferred: 20, total: 20, bytesPerSecond: 10, path: '/private' })
    const state = updater.getState()
    assert.equal(state.status, 'downloading')
    if (state.status === 'downloading') assert.equal(state.percent, 100)
    driver.emit('download-progress', { percent: NaN })
    assert.deepEqual(updater.getState(), state)
    driver.emit('update-downloaded', { version: '0.1.3', downloadedFile: '/private/secret.zip' })
    work.resolve(['/private/secret.zip'])
    await download
    assert.equal(updater.getState().status, 'downloaded')
    assert.equal(tokens[0]?.disposed, true)
    assert.doesNotMatch(JSON.stringify(updater.getState()), /private|secret|\.zip/)
  })

  it('does not allow installation from progress or an unverified download', async () => {
    const { updater, driver } = setup()
    await assert.rejects(updater.install(), /未下载完成/)
    await updater.check()
    driver.downloadWork = async () => ['/fake.zip']
    await assert.rejects(updater.download(), /下载更新失败/)
    await assert.rejects(updater.install(), /未下载完成/)
    assert.equal(driver.installCalls, 0)
  })

  it('rejects a mismatched downloaded version', async () => {
    const { updater, driver } = setup()
    await updater.check()
    driver.downloadWork = async () => { driver.emit('update-downloaded', { version: '0.0.1' }); return ['/fake.zip'] }
    await assert.rejects(updater.download(), /下载更新失败/)
  })

  it('cancels the real active token, ignores late events, then requires another check', async () => {
    const { updater, driver, tokens } = setup()
    await updater.check()
    driver.downloadWork = token => new Promise((_resolve, reject) => token.once('cancel', () => reject(new Error('cancelled'))))
    const work = updater.download()
    await Promise.resolve()
    await updater.cancel()
    await work
    assert.equal(tokens[0]?.cancelled, true)
    driver.emit('download-progress', { percent: 100, transferred: 20, total: 20, bytesPerSecond: 10 })
    driver.emit('update-downloaded', { version: '0.1.3' })
    assert.equal(updater.getState().status, 'idle')
    await assert.rejects(updater.download(), /先检查/)
    await assert.rejects(updater.install(), /未下载完成/)
    assert.equal(driver.installCalls, 0)
    await assert.rejects(updater.cancel(), /没有可取消/)
  })

  it('can retry a failed download with a fresh token', async () => {
    const { updater, driver, tokens } = setup()
    await updater.check()
    driver.downloadWork = async () => { throw new Error('SHA512 mismatch /private/secret') }
    await assert.rejects(updater.download(), /下载更新失败/)
    driver.downloadWork = null
    await updater.download()
    assert.equal(updater.getState().status, 'downloaded')
    assert.equal(tokens.length, 2)
  })

  for (const kind of ['running', 'pending', 'waitingApproval'] as const) {
    it(`blocks installation with ${kind} tasks and keeps downloaded state for retry`, async () => {
      const { updater, driver, stats } = await downloaded()
      stats[kind] = 1
      await assert.rejects(updater.install(), /任务/)
      assert.equal(driver.installCalls, 0)
      assert.equal(updater.getState().status, 'downloaded')
      stats[kind] = 0
      await updater.install()
      assert.equal(driver.installCalls, 1)
      assert.equal(updater.isInstallPrepared(), true)
      await assert.rejects(updater.install(), /正在进行/)
    })
  }

  it('checks task state again after cleanup and blocks malformed statistics', async () => {
    const { updater, driver, stats, setPrepare } = await downloaded()
    setPrepare(async () => { stats.running = 1 })
    await assert.rejects(updater.install(), /任务/)
    assert.equal(driver.installCalls, 0)
    stats.running = NaN
    await assert.rejects(updater.install(), /无法确认任务/)
  })

  it('keeps installation locked during cleanup and sanitizes cleanup failure', async () => {
    const { updater, driver, setPrepare } = await downloaded()
    const work = deferred<void>()
    setPrepare(() => work.promise)
    const installation = updater.install()
    await assert.rejects(updater.install(), /正在进行/)
    work.reject(new Error('/private/token=password'))
    await assert.rejects(installation, /安装更新失败/)
    assert.equal(driver.installCalls, 0)
    assert.equal(updater.getState().status, 'downloaded')
  })

  it('handles SDK installation errors without returning success', async () => {
    const { updater, driver } = await downloaded()
    driver.quitAndInstall = () => { driver.emit('error', new Error('/private/secret')) }
    await assert.rejects(updater.install(), /安装更新失败/)
    assert.equal(updater.getState().status, 'error')
    assert.equal(updater.isInstallPrepared(), false)
  })

  it('development/unsupported platform never invokes the SDK', async () => {
    const { updater, driver } = setup(false)
    for (const action of [() => updater.check(), () => updater.download(), () => updater.cancel(), () => updater.install()]) {
      await assert.rejects(action(), /不支持自动更新/)
    }
    updater.startAutomaticCheck()
    updater.dispose()
    assert.equal(driver.checkCalls + driver.downloadCalls + driver.installCalls, 0)
  })

  it('disposal removes listeners, suppresses late check results and blocks future work', async () => {
    const { updater, driver, states } = setup()
    const work = deferred<UpdateCheckResult>()
    driver.checkWork = work.promise
    const check = updater.check()
    updater.dispose()
    updater.dispose()
    work.resolve(driver.result)
    await check
    assert.deepEqual(states.map(state => state.status), ['checking'])
    assert.equal(driver.eventNames().length, 0)
    await assert.rejects(updater.check(), /不支持自动更新/)
  })
})

it('release notes are bounded plain text and reject credentials, URLs and paths', () => {
  assert.deepEqual(normalizeReleaseNotes('# 标题\n<b>修复错误</b>\naccessToken=secret\nhttps://test/secret\n/Users/test/file\nC:\\secret'), ['标题', '修复错误'])
  assert.deepEqual(normalizeReleaseNotes({ arbitrary: 'secret' }), [])
  assert.equal(normalizeReleaseNotes(Array.from({ length: 100 }, () => '修复').join('\n')).length, 20)
})

it('delays automatic checks, bounds retries, and cancels scheduled work on disposal', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const { updater, driver } = setup()
  driver.checkForUpdates = async () => { driver.checkCalls++; throw new Error('network') }
  updater.startAutomaticCheck()
  updater.startAutomaticCheck()
  context.mock.timers.tick(2_999)
  assert.equal(driver.checkCalls, 0)
  context.mock.timers.tick(1)
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(driver.checkCalls, 1)
  for (const delay of [60_000, 5 * 60_000, 15 * 60_000]) {
    context.mock.timers.tick(delay)
    await new Promise<void>(resolve => setImmediate(resolve))
  }
  assert.equal(driver.checkCalls, 4)
  context.mock.timers.tick(60 * 60_000)
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(driver.checkCalls, 4)
  updater.dispose()
  context.mock.timers.reset()
})

it('manual check clears a queued retry and disposal clears startup delay', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const test = setup()
  test.updater.startAutomaticCheck()
  test.updater.dispose()
  context.mock.timers.tick(3_000)
  assert.equal(test.driver.checkCalls, 0)
  const { updater, driver } = setup()
  const original = driver.checkForUpdates.bind(driver)
  driver.checkForUpdates = async () => { driver.checkCalls++; throw new Error('network') }
  updater.startAutomaticCheck()
  context.mock.timers.tick(3_000)
  await new Promise<void>(resolve => setImmediate(resolve))
  driver.checkForUpdates = original
  await updater.check()
  context.mock.timers.tick(60_000)
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(driver.checkCalls, 2)
  updater.dispose()
  context.mock.timers.reset()
})


it('restores background services exactly once after installation cleanup or SDK failure', async () => {
  const { updater, driver, stats, setPrepare, setRecover } = await downloaded()
  let recovered = 0
  setRecover(async () => { recovered++ })
  stats.running = 1
  await assert.rejects(updater.install(), /任务/)
  assert.equal(recovered, 0)
  stats.running = 0
  setPrepare(async () => { throw new Error('cleanup failure') })
  await assert.rejects(updater.install(), /安装更新失败/)
  assert.equal(recovered, 1)
  setPrepare(async () => {})
  driver.quitAndInstall = () => { driver.emit('error', new Error('installer failure')) }
  await assert.rejects(updater.install(), /安装更新失败/)
  assert.equal(recovered, 2)
  assert.equal(updater.isInstallPrepared(), false)
})
