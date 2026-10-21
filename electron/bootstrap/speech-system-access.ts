import type { SpeechSystemAccessPort } from '../domain/speech'
import { appError } from '../errors/app-error'

interface Options {
  platform: NodeJS.Platform
  status: () => string
  request: () => Promise<boolean>
  open: (url: string) => Promise<void>
  timeoutMs?: number
}

export class SpeechSystemAccess implements SpeechSystemAccessPort {
  private pending: Promise<boolean> | null = null

  constructor(private readonly options: Options) {}

  private get supported(): boolean {
    return this.options.platform === 'win32' || this.options.platform === 'darwin'
  }

  private status(): string {
    try { return this.options.status() } catch { return 'unknown' }
  }

  canRecord(): boolean {
    return !this.supported || this.status() === 'granted'
  }

  private assertGranted(): void {
    const status = this.status()
    if (status === 'granted') return
    const platform = this.options.platform === 'darwin' ? 'macOS' : 'Windows'
    const message = status === 'denied' || status === 'restricted'
      ? `${platform} 未允许访问麦克风，请在个人设置中打开系统麦克风设置。`
      : `无法确认 ${platform} 麦克风权限，请检查系统设置后重试。`
    throw appError('INVALID_ARGUMENT', { message })
  }

  private async requestMacAccess(): Promise<void> {
    if (!this.pending) {
      const pending = Promise.resolve().then(() => this.options.request())
      this.pending = pending
      // Keep a timed-out native prompt reserved until the OS actually settles it.
      void pending.then(() => { if (this.pending === pending) this.pending = null },
        () => { if (this.pending === pending) this.pending = null })
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const allowed = await Promise.race([
        this.pending.catch(() => { throw appError('INVALID_ARGUMENT', { message: '无法请求 macOS 麦克风权限，请检查系统设置后重试。' }) }),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(appError('INVALID_ARGUMENT', { message: '系统麦克风授权超时，请完成授权后重新尝试。' })), this.options.timeoutMs ?? 60_000)
          timer.unref()
        }),
      ])
      if (!allowed) throw appError('INVALID_ARGUMENT', { message: 'macOS 未允许访问麦克风，请在个人设置中打开系统麦克风设置。' })
      this.assertGranted()
    } finally { clearTimeout(timer) }
  }

  async authorize(confirm: () => Promise<boolean>): Promise<boolean> {
    if (this.options.platform === 'darwin') {
      await this.prepare()
      return true
    }
    if (this.supported) this.assertGranted()
    if (!await confirm()) return false
    if (this.supported) this.assertGranted()
    return true
  }

  async prepare(): Promise<boolean> {
    if (!this.supported) return true
    if (this.options.platform === 'darwin' && this.status() === 'not-determined') {
      await this.requestMacAccess()
      return false
    }
    this.assertGranted()
    return true
  }

  async openSettings(): Promise<void> {
    const url = this.options.platform === 'win32' ? 'ms-settings:privacy-microphone'
      : this.options.platform === 'darwin' ? 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone' : null
    if (!url) throw appError('INVALID_ARGUMENT', { message: '当前平台不支持直接打开系统麦克风设置。' })
    try { await this.options.open(url) } catch {
      throw appError('INVALID_ARGUMENT', { message: '无法打开系统麦克风设置，请手动打开系统隐私设置。' })
    }
  }
}
