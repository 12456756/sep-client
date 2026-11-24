import { z } from 'zod'
import { speechAudioSchema, speechResultSchema, type SpeechAudio, type SpeechResult } from '../../src/shared/speech-contracts'
import type { SpeechRuntimePort } from '../domain/speech'
import { timedSpeechResultSchema, type SubtitleRecognizer, type TimedSpeechResult } from '../domain/timed-speech'
import { appError } from '../errors/app-error'

export interface SpeechWorkerPort {
  postMessage(message: unknown): void
  kill(): boolean | void
  on(event: 'message', callback: (message: unknown) => void): unknown
  once(event: 'exit', callback: () => void): unknown
}

interface Options {
  createWorker: () => SpeechWorkerPort
  modelDir: string
  timeoutMs?: number
  idleMs?: number
}

const responseSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('result'), result: speechResultSchema }).strict(),
  z.object({ type: z.literal('timed-result'), result: timedSpeechResultSchema }).strict(),
  z.object({ type: z.literal('error'), recordingId: z.string(), code: z.enum(['MODEL_UNAVAILABLE', 'RECOGNITION_FAILED', 'BUSY']) }).strict(),
])

export class SpeechRuntime implements SpeechRuntimePort, SubtitleRecognizer {
  private worker: SpeechWorkerPort | null = null
  private idle: ReturnType<typeof setTimeout> | undefined
  private pending: { id: string; timed: boolean; duration: number; resolve: (result: SpeechResult | TimedSpeechResult) => void;
    reject: (error: Error) => void; cleanup: () => void } | null = null

  constructor(private readonly options: Options) {}

  recognize(raw: SpeechAudio): Promise<SpeechResult> {
    return this.request(raw, false)
  }

  async recognizeTimed(raw: SpeechAudio, signal: AbortSignal): Promise<TimedSpeechResult> {
    const result = await this.request(raw, true, signal)
    if (!('tokens' in result)) throw appError('INTERNAL_ERROR', { message: '语音识别没有返回时间轴。' })
    return result
  }

  private request(raw: SpeechAudio, timed: boolean, signal?: AbortSignal): Promise<SpeechResult | TimedSpeechResult> {
    signal?.throwIfAborted()
    const input = speechAudioSchema.parse(raw)
    if (this.pending) return Promise.reject(appError('INVALID_ARGUMENT', { message: '已有语音输入正在识别。' }))
    clearTimeout(this.idle)
    const worker = this.getWorker()
    return new Promise((resolve, reject) => {
      const cancel = () => this.stop('字幕识别已取消。')
      const timer = setTimeout(() => this.stop('语音识别超时，请重试。'), this.options.timeoutMs ?? 60_000)
      this.pending = { id: input.recordingId, timed, duration: input.samples.length / input.sampleRate, resolve, reject,
        cleanup: () => { clearTimeout(timer); signal?.removeEventListener('abort', cancel) } }
      signal?.addEventListener('abort', cancel, { once: true })
      if (signal?.aborted) { cancel(); return }
      try { worker.postMessage({ ...input, modelDir: this.options.modelDir, ...(timed && { timed: true }) }) }
      catch { this.stop('无法启动语音识别，请重试。') }
    })
  }

  private getWorker(): SpeechWorkerPort {
    if (this.worker) return this.worker
    const worker = this.options.createWorker()
    this.worker = worker
    worker.on('message', raw => {
      if (this.worker !== worker || !this.pending) return
      const response = responseSchema.safeParse(raw)
      if (!response.success) { this.stop('语音识别响应异常，请重试。'); return }
      const message = response.data
      const id = message.type === 'error' ? message.recordingId : message.result.recordingId
      if (id !== this.pending.id) { this.stop('语音识别响应不匹配，请重试。'); return }
      if (message.type === 'error') {
        this.stop(message.code === 'MODEL_UNAVAILABLE' ? '本地语音模型缺失或损坏，请检查安装资源。' :
          this.pending.timed ? '字幕识别失败，请检查素材后重试。' : '语音识别失败，请重新录音。')
        return
      }
      const pending = this.pending
      if (pending.timed !== (message.type === 'timed-result') ||
        (message.type === 'timed-result' && message.result.timestamps.some(time => time > pending.duration))) {
        this.stop('语音识别响应时间轴异常，请重试。'); return
      }
      this.pending = null
      pending.cleanup()
      pending.resolve(message.result)
      this.idle = setTimeout(() => this.stop(), this.options.idleMs ?? 5 * 60_000)
      this.idle.unref()
    })
    worker.once('exit', () => { if (this.worker === worker) this.stop('语音识别进程已退出，请重试。') })
    return worker
  }

  stop(message = '本次语音输入已取消。'): void {
    clearTimeout(this.idle)
    const pending = this.pending
    this.pending = null
    if (pending) { pending.cleanup(); pending.reject(appError('INTERNAL_ERROR', { message })) }
    const worker = this.worker
    this.worker = null
    worker?.kill()
  }
}
