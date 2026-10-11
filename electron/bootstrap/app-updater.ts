import type { CancellationToken, UpdateCheckResult } from 'electron-updater'
import { z } from 'zod'
import type { UpdateState } from '../../src/shared/ipc'
import type { ClientTaskStats } from '../../src/shared/types'
import { logger } from '../common/logger'
import { UPDATE_RETRY_DELAYS_MS, UPDATE_STARTUP_DELAY_MS } from '../common/update-config'
import { appError, isAppError } from '../errors/app-error'

const log = logger.child('app-updater')
const versionSchema = z.string().max(100).regex(/^\d+\.\d+\.\d+(?:-[\da-zA-Z.-]+)?(?:\+[\da-zA-Z.-]+)?$/)
const infoSchema = z.object({
  version: versionSchema,
  releaseDate: z.string().max(100).optional(),
  releaseNotes: z.unknown().optional(),
})
const checkResultSchema = z.object({ isUpdateAvailable: z.boolean(), updateInfo: infoSchema })
const progressSchema = z.object({
  percent: z.number().finite(), transferred: z.number().finite().nonnegative(),
  total: z.number().finite().nonnegative(), bytesPerSecond: z.number().finite().nonnegative(),
})

type Operation = 'check' | 'download' | 'cancel' | 'install'
type AvailableState = Extract<UpdateState, { status: 'available' }>

/** SDK 与 Electron 留在组装适配器中；状态机可用受控驱动测试。 */
export interface UpdateDriver {
  checkForUpdates(): Promise<UpdateCheckResult | null>
  downloadUpdate(token: CancellationToken): Promise<string[]>
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void
  on(event: string, handler: (payload: unknown) => void): unknown
  removeListener(event: string, handler: (payload: unknown) => void): unknown
}

export interface AppUpdaterOptions {
  currentVersion: string
  driver: UpdateDriver | null
  createToken: () => CancellationToken
  isNewerVersion: (version: string) => boolean
  taskStats: () => Promise<ClientTaskStats>
  prepareInstall: () => Promise<void>
  restoreAfterInstallFailure?: () => Promise<void>
  publish: (state: UpdateState) => void
}

/** 远程说明仅保留有限纯文本；带链接、路径或凭据的行不进入 IPC。 */
export function normalizeReleaseNotes(value: unknown): string[] {
  const source = typeof value === 'string' ? value : ''
  return source.slice(0, 8_000).split(/\r?\n/)
    .map(line => line.replace(/<[^>]*>/g, '').replace(/^[\s#*>`-]+/, '').replace(/\p{Cc}/gu, '').trim())
    .filter(line => line.length > 0 && !/(?:https?:|www\.|token|password|secret|authorization|[A-Z]:\\|\/[^\s]+|\\[^\s]+)/i.test(line))
    .slice(0, 20).map(line => line.slice(0, 300))
}

export class AppUpdater {
  private state: UpdateState
  private available: AvailableState | null = null
  private checking = false
  private installing = false
  private installPrepared = false
  private cleanupStarted = false
  private recovery: Promise<void> | null = null
  private downloadWork: Promise<void> | null = null
  private token: CancellationToken | null = null
  private downloadedEvent = false
  private disposed = false
  private automaticStarted = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private readonly handlers: Array<[string, (payload: unknown) => void]>

  constructor(private readonly options: AppUpdaterOptions) {
    this.state = { status: 'idle', currentVersion: options.currentVersion }
    this.handlers = [
      ['download-progress', payload => this.progress(payload)],
      ['update-downloaded', payload => this.downloaded(payload)],
      // SDK 也会在 Promise reject 前触发 error；由操作 catch 统一处理，避免重复状态。
      ['error', () => {
        if (this.installing && !this.disposed) {
          this.installPrepared = false
          this.fail('install')
          void this.recoverInstall().finally(() => { this.installing = false })
        }
      }],
    ]
    for (const [event, handler] of this.handlers) options.driver?.on(event, handler)
  }

  getState(): UpdateState { return structuredClone(this.state) }

  /** 仅供退出协调器使用；清理与任务检查完成后允许 updater 原生退出。 */
  isInstallPrepared(): boolean { return this.installPrepared }

  startAutomaticCheck(): void {
    if (this.disposed || this.automaticStarted || !this.options.driver) return
    this.automaticStarted = true
    this.scheduleAutomatic(UPDATE_STARTUP_DELAY_MS, 0)
  }

  async check(): Promise<void> {
    const driver = this.requireDriver()
    this.requireFree()
    if (this.state.status === 'downloaded') throw this.invalid('更新已下载，请安装或重启客户端后重新检查。')
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.checking = true
    this.available = null
    this.setState({ status: 'checking', currentVersion: this.options.currentVersion })
    try {
      const result = await driver.checkForUpdates()
      if (this.disposed) return
      if (!result) throw new Error('Missing check result')
      const checked = checkResultSchema.parse(result)
      const info = checked.updateInfo
      if (checked.isUpdateAvailable && this.options.isNewerVersion(info.version)) {
        const date = info.releaseDate ? new Date(info.releaseDate) : null
        this.available = {
          status: 'available', currentVersion: this.options.currentVersion, version: info.version,
          releaseDate: date && Number.isFinite(date.getTime()) ? date.toISOString() : null,
          releaseNotes: normalizeReleaseNotes(info.releaseNotes),
        }
        this.setState(this.available)
      } else {
        this.setState({ status: 'not-available', currentVersion: this.options.currentVersion, checkedAt: new Date().toISOString() })
      }
    } catch {
      if (!this.disposed) this.fail('check')
      throw this.operationError('check')
    } finally { this.checking = false }
  }

  async download(): Promise<void> {
    const driver = this.requireDriver()
    this.requireFree()
    const available = this.available
    if (!available || (this.state.status !== 'available' && !(this.state.status === 'error' && this.state.operation === 'download'))) {
      throw this.invalid('请先检查并选择可用更新。')
    }
    const token = this.options.createToken()
    this.token = token
    this.downloadedEvent = false
    this.setState({ status: 'downloading', currentVersion: this.options.currentVersion, version: available.version,
      percent: 0, transferred: 0, total: 0, bytesPerSecond: 0 })
    // 微任务边界保证锁先建立，即使驱动同步发事件也只接受当前下载。
    const work = Promise.resolve().then(async () => {
      try {
        const files = await driver.downloadUpdate(token)
        if (this.disposed || token.cancelled) return
        if (!this.downloadedEvent || files.length === 0) throw new Error('Unverified download')
        this.setState({ status: 'downloaded', currentVersion: this.options.currentVersion, version: available.version })
      } catch {
        if (this.disposed || token.cancelled) return
        this.fail('download')
        throw this.operationError('download')
      } finally {
        if (token.cancelled && !this.disposed) this.setState({ status: 'idle', currentVersion: this.options.currentVersion })
        token.dispose()
        this.token = null
        this.downloadWork = null
      }
    })
    this.downloadWork = work
    await work
  }

  async cancel(): Promise<void> {
    this.requireDriver()
    if (!this.token || !this.downloadWork || this.token.cancelled) throw this.invalid('当前没有可取消的下载。')
    this.token.cancel()
    await this.downloadWork
  }

  async install(): Promise<void> {
    const driver = this.requireDriver()
    this.requireFree()
    if (this.state.status !== 'downloaded') throw this.invalid('更新尚未下载完成，无法安装。')
    this.installing = true
    try {
      await this.ensureNoActiveTasks()
      this.cleanupStarted = true
      await this.options.prepareInstall()
      await this.ensureNoActiveTasks()
      if (this.disposed || this.state.status !== 'downloaded') throw this.invalid('更新状态已改变，请重新检查。')
      this.installPrepared = true
      driver.quitAndInstall(false, true)
      if (this.getState().status === 'error') throw this.operationError('install')
    } catch (error) {
      this.installPrepared = false
      await this.recoverInstall()
      this.installing = false
      // 任务或停机检查失败时保留 downloaded，用户可以稍后直接重试。
      throw isAppError(error) && error.code === 'INVALID_STATE' ? error : this.operationError('install')
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.token?.cancel()
    for (const [event, handler] of this.handlers) this.options.driver?.removeListener(event, handler)
  }

  private recoverInstall(): Promise<void> {
    if (this.recovery) return this.recovery
    if (!this.cleanupStarted) return Promise.resolve()
    this.cleanupStarted = false
    this.recovery = Promise.resolve().then(() => this.options.restoreAfterInstallFailure?.())
      .catch(() => { log.warn('update cleanup recovery failed') })
      .finally(() => { this.recovery = null })
    return this.recovery
  }

  private scheduleAutomatic(delay: number, retry: number): void {
    this.timer = setTimeout(() => {
      this.timer = null
      if (this.disposed || this.checking || this.downloadWork || this.installing || this.state.status === 'downloaded') return
      void this.check().catch(() => {
        const nextDelay = UPDATE_RETRY_DELAYS_MS[retry]
        if (!this.disposed && nextDelay !== undefined) this.scheduleAutomatic(nextDelay, retry + 1)
      })
    }, delay)
    this.timer.unref?.()
  }

  private requireDriver(): UpdateDriver {
    if (this.disposed || !this.options.driver) throw this.invalid('当前开发环境或平台不支持自动更新，请手动下载新版本。')
    return this.options.driver
  }

  private requireFree(): void {
    if (this.checking || this.downloadWork || this.installing) throw this.invalid('更新操作正在进行，请稍后重试。')
  }

  private async ensureNoActiveTasks(): Promise<void> {
    const stats = await this.options.taskStats()
    if (![stats.running, stats.pending, stats.waitingApproval].every(value => Number.isInteger(value) && value >= 0)) {
      throw this.invalid('无法确认任务状态，请稍后重试。')
    }
    if (stats.running + stats.pending + stats.waitingApproval > 0) {
      throw this.invalid('仍有运行、排队或待审批的任务，请结束任务后再安装更新。')
    }
  }

  private progress(payload: unknown): void {
    if (!this.token || this.token.cancelled || this.disposed || this.state.status !== 'downloading') return
    const parsed = progressSchema.safeParse(payload)
    if (!parsed.success) return
    this.setState({ ...this.state, ...parsed.data, percent: Math.max(0, Math.min(100, parsed.data.percent)) })
  }

  private downloaded(payload: unknown): void {
    if (!this.token || this.token.cancelled || this.disposed) return
    const parsed = infoSchema.safeParse(payload)
    this.downloadedEvent = parsed.success && parsed.data.version === this.available?.version
  }

  private setState(state: UpdateState): void {
    if (this.disposed) return
    this.state = structuredClone(state)
    this.options.publish(this.getState())
  }

  private invalid(message: string): Error { return appError('INVALID_STATE', { message }) }

  private operationError(operation: Operation): Error {
    const messages = { check: '检查更新失败，请稍后重试。', download: '下载更新失败，请检查网络后重试。', cancel: '取消下载失败，请稍后重试。', install: '安装更新失败，请稍后重试或手动下载新版本。' }
    return appError('SERVICE_UNAVAILABLE', { message: messages[operation] })
  }

  private fail(operation: Operation): void {
    log.warn('update operation failed', { operation })
    this.setState({ status: 'error', currentVersion: this.options.currentVersion, operation,
      message: this.operationError(operation).message, retryable: true })
  }
}
