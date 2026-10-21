import type { ElectronAPI } from '../../shared/ipc'
import { speechResultSchema, speechStartSchema } from '../../shared/speech-contracts'

export type SpeechClientApi = Pick<ElectronAPI, 'beginSpeechRecording' | 'recognizeSpeech' | 'cancelSpeechRecording'>
export interface CapturedAudio { sampleRate: number; samples: Float32Array }
export interface MicrophoneCapture { stop(): Promise<CapturedAudio>; cancel(): void }
export interface CaptureOptions {
  signal: AbortSignal
  onProgress: (seconds: number) => void
  onLimit: () => void
  onError: (error: Error) => void
}
export interface SpeechSnapshot {
  owner: string | null
  phase: 'idle' | 'arming' | 'recording' | 'stopping' | 'recognizing'
  seconds: number
  error: string | null
  notice: string | null
}
interface Options {
  api: () => SpeechClientApi
  capture: (options: CaptureOptions) => Promise<MicrophoneCapture>
  id?: () => string
}
interface Active {
  owner: string
  id: string
  abort: AbortController
  capture?: MicrophoneCapture
  onResult: (text: string) => void
  timer?: ReturnType<typeof setTimeout>
}

function microphoneError(error: unknown): string {
  const name = error instanceof Error ? error.name : ''
  if (name === 'NotAllowedError' || name === 'SecurityError') return '未获得麦克风权限，请检查系统麦克风隐私设置。'
  if (name === 'NotFoundError') return '未找到麦克风，请连接麦克风后重试。'
  if (name === 'NotReadableError') return '无法读取麦克风，请检查设备是否被其他程序占用。'
  return '录音失败，请检查麦克风连接和系统输入音量后重试。'
}

export class SpeechInputController {
  private snapshot: SpeechSnapshot = { owner: null, phase: 'idle', seconds: 0, error: null, notice: null }
  private readonly listeners = new Set<() => void>()
  private active: Active | null = null

  constructor(private readonly options: Options) {}

  readonly getSnapshot = (): SpeechSnapshot => this.snapshot
  readonly subscribe = (callback: () => void): (() => void) => {
    this.listeners.add(callback)
    return () => this.listeners.delete(callback)
  }

  private update(patch: Partial<SpeechSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch }
    for (const listener of this.listeners) listener()
  }

  async start(owner: string, onResult: (text: string) => void): Promise<void> {
    if (this.active) return
    const session: Active = { owner, id: this.options.id?.() ?? crypto.randomUUID(), abort: new AbortController(), onResult }
    this.active = session
    this.update({ owner, phase: 'arming', seconds: 0, error: null, notice: null })
    session.timer = setTimeout(() => this.fail(session, '麦克风授权超时，请重试。'), 65_000)
    try {
      const response = await this.options.api().beginSpeechRecording({ recordingId: session.id })
      if (this.active !== session) return
      if (!response.success) { this.fail(session, response.error?.message || '无法使用语音输入，请检查设置。'); return }
      const start = speechStartSchema.parse(response.data)
      if (start.recordingId !== session.id) throw new Error('Recording mismatch')
      if (!start.ready) {
        this.cancel(owner)
        this.update({ notice: start.permission === 'granted' ? '麦克风已授权。' : null,
          error: start.permission === 'denied' ? '语音输入未授权，可在设置中开启。' : null })
        return
      }
      clearTimeout(session.timer)
      session.timer = setTimeout(() => this.fail(session, '麦克风启动超时，请检查设备后重试。'), 15_000)
      const capture = await this.options.capture({
        signal: session.abort.signal,
        onProgress: seconds => {
          const value = Math.floor(seconds * 10) / 10
          if (this.active === session && value !== this.snapshot.seconds) this.update({ seconds: value })
        },
        onLimit: () => { if (this.active === session) void this.stop(owner) },
        onError: error => this.fail(session, microphoneError(error)),
      })
      if (this.active !== session) { capture.cancel(); return }
      session.capture = capture
      clearTimeout(session.timer)
      session.timer = setTimeout(() => this.fail(session, '录音超时，请重新录音。'), 32_000)
      this.update({ phase: 'recording' })
    } catch (error) { this.fail(session, microphoneError(error)) }
  }

  async stop(owner: string): Promise<void> {
    const session = this.active
    if (!session || session.owner !== owner) return
    if (this.snapshot.phase === 'arming') { this.cancel(owner); return }
    if (this.snapshot.phase !== 'recording' || !session.capture) return
    clearTimeout(session.timer)
    this.update({ phase: 'stopping' })
    try {
      const audio = await session.capture.stop()
      if (this.active !== session) return
      this.update({ phase: 'recognizing' })
      session.timer = setTimeout(() => this.fail(session, '语音识别超时，请重试。'), 65_000)
      const response = await this.options.api().recognizeSpeech({ recordingId: session.id, sampleRate: audio.sampleRate, samples: new Float32Array(audio.samples) })
      if (this.active !== session) return
      if (!response.success) { this.fail(session, response.error?.message || '语音识别失败，请重试。'); return }
      const result = speechResultSchema.parse(response.data)
      if (result.recordingId !== session.id) throw new Error('Recording mismatch')
      clearTimeout(session.timer)
      session.capture.cancel()
      this.active = null
      this.update({ phase: 'idle', error: result.silent || !result.text.trim() ? '未检测到有效声音，请检查麦克风输入音量。' : null })
      if (!result.silent && result.text.trim()) session.onResult(result.text.trim())
    } catch { this.fail(session, '语音识别失败，请重新录音。') }
  }

  cancel(owner?: string): void {
    const session = this.active
    if (!session || (owner !== undefined && session.owner !== owner)) return
    this.active = null
    clearTimeout(session.timer)
    session.abort.abort()
    session.capture?.cancel()
    try { void this.options.api().cancelSpeechRecording({ recordingId: session.id }).catch(() => undefined) } catch { /* Window may already be closing. */ }
    this.update({ phase: 'idle', error: null, notice: null })
  }

  private fail(session: Active, message: string): void {
    if (this.active !== session) return
    this.cancel(session.owner)
    this.update({ error: message })
  }
}
