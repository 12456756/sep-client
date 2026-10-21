import type { SpeechAudio, SpeechPermission, SpeechResult, SpeechStart } from '../../src/shared/speech-contracts'
import type { SpeechRuntimePort, SpeechSettingsPort, SpeechSystemAccessPort } from '../domain/speech'
import { appError } from '../errors/app-error'
import { requireScope, type ScopeSource } from './scope-guard'

interface Options {
  scope: ScopeSource
  settings: SpeechSettingsPort
  microphone: SpeechSystemAccessPort
  runtime: () => Promise<SpeechRuntimePort>
  stopRuntime: () => void
}

interface Recording {
  id: string
  scope: string
  phase: 'arming' | 'recording' | 'recognizing'
}

export class SpeechService {
  private permission: SpeechPermission | null = null
  private loading: Promise<void> | null = null
  private active: Recording | null = null
  private prompting = false
  private revision = 0
  private lease: ReturnType<typeof setTimeout> | undefined

  constructor(private readonly options: Options) {}

  private scopeKey(): string {
    const scope = requireScope(this.options.scope)
    return JSON.stringify([scope.enterpriseId, scope.memberId])
  }

  private async load(): Promise<void> {
    if (this.permission !== null) return
    this.loading ??= this.options.settings.read().then(value => { this.permission ??= value })
    await this.loading
  }

  async getPermission(): Promise<SpeechPermission> {
    this.scopeKey()
    await this.load()
    return this.permission!
  }

  private async requestConsent(ask: () => Promise<boolean>): Promise<SpeechPermission> {
    if (this.prompting) throw appError('INVALID_ARGUMENT', { message: '请先完成麦克风授权。' })
    const scope = this.scopeKey()
    this.prompting = true
    const revision = this.revision
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const allowed = await Promise.race([this.options.microphone.authorize(ask), new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 60_000); timer.unref() })])
      if (revision !== this.revision || this.scopeKey() !== scope) return this.permission ?? 'denied'
      const permission = allowed ? 'granted' : 'denied'
      await this.options.settings.write(permission)
      if (revision === this.revision) this.permission = permission
      // Cancellation can arrive after the write has already started.
      else await this.options.settings.write(this.permission ?? 'denied')
      return this.permission ?? 'denied'
    } finally {
      clearTimeout(timer)
      this.prompting = false
    }
  }

  async setEnabled(enabled: boolean, ask: () => Promise<boolean>): Promise<SpeechPermission> {
    const scope = this.scopeKey()
    const revision = this.revision
    if (!enabled) {
      this.permission = 'denied'
      this.stop()
      await this.options.settings.write('denied')
      return 'denied'
    }
    await this.load()
    if (revision !== this.revision || this.scopeKey() !== scope) return this.permission!
    if (this.permission !== 'granted') return this.requestConsent(ask)
    await this.options.microphone.prepare()
    if (revision !== this.revision || this.scopeKey() !== scope) return this.permission
    return this.permission
  }

  async openSystemSettings(): Promise<void> {
    this.scopeKey()
    await this.options.microphone.openSettings()
  }

  async begin(recordingId: string, ask: () => Promise<boolean>): Promise<SpeechStart> {
    const scope = this.scopeKey()
    if (this.active || this.prompting) throw appError('INVALID_ARGUMENT', { message: '已有语音输入正在进行。' })
    const recording: Recording = { id: recordingId, scope, phase: 'arming' }
    this.active = recording
    try {
      await this.load()
      if (this.active !== recording || this.scopeKey() !== scope) return { recordingId, ready: false, permission: this.permission! }
      if (this.permission === 'prompt') {
        const permission = await this.requestConsent(ask)
        return { recordingId, ready: false, permission }
      }
      if (this.permission !== 'granted') throw appError('INVALID_ARGUMENT', { message: '语音输入已关闭，请在设置中开启。' })
      const ready = await this.options.microphone.prepare()
      if (this.active !== recording || this.scopeKey() !== scope) return { recordingId, ready: false, permission: this.permission }
      if (!ready) return { recordingId, ready: false, permission: this.permission }
      recording.phase = 'recording'
      this.lease = setTimeout(() => this.cancel(recordingId), 50_000)
      this.lease.unref()
      return { recordingId, ready: true, permission: 'granted' }
    } finally {
      if (this.active === recording && recording.phase === 'arming') this.active = null
    }
  }

  canUseMicrophone(): boolean {
    const scope = this.options.scope.currentScope()
    return Boolean(scope && this.permission === 'granted' && this.options.microphone.canRecord() && this.active?.phase === 'recording'
      && this.active.scope === JSON.stringify([scope.enterpriseId, scope.memberId]))
  }

  async recognize(input: SpeechAudio): Promise<SpeechResult> {
    const recording = this.active
    if (!recording || recording.id !== input.recordingId || recording.scope !== this.scopeKey() || recording.phase !== 'recording') {
      throw appError('INVALID_ARGUMENT', { message: '本次录音已取消，请重新录音。' })
    }
    try {
      if (!this.canUseMicrophone()) throw appError('INVALID_ARGUMENT', { message: '本次录音已取消，请重新录音。' })
      recording.phase = 'recognizing'
      clearTimeout(this.lease)
      const runtime = await this.options.runtime()
      if (this.active !== recording) throw appError('INVALID_ARGUMENT', { message: '本次录音已取消。' })
      const result = await runtime.recognize(input)
      if (this.active !== recording || this.scopeKey() !== recording.scope || result.recordingId !== recording.id) {
        throw appError('INVALID_ARGUMENT', { message: '本次录音已取消。' })
      }
      return result
    } finally {
      if (this.active === recording) {
        clearTimeout(this.lease)
        this.active = null
      }
    }
  }

  cancel(recordingId: string): void {
    if (this.active?.id === recordingId) this.stop()
  }

  stop(): void {
    this.revision++
    clearTimeout(this.lease)
    this.active = null
    this.options.stopRuntime()
  }

  /**
   * Window blur must stop capture, but it must not invalidate a consent dialog
   * opened by the settings page. Electron can emit blur while that dialog is
   * visible, before the user's choice is returned.
   */
  stopForWindowBlur(): void {
    if (this.prompting) return
    this.stop()
  }
}
