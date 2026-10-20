import { z } from 'zod'
import { speechAudioSchema, speechResultSchema, type SpeechAudio, type SpeechResult } from '../../src/shared/speech-contracts'
import type { SpeechRuntimePort } from '../domain/speech'
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
  z.object({ type: z.literal('error'), recordingId: z.string(), code: z.enum(['MODEL_UNAVAILABLE', 'RECOGNITION_FAILED', 'BUSY']) }).strict(),
])

export class SpeechRuntime implements SpeechRuntimePort {
  private worker: SpeechWorkerPort | null = null
  private idle: ReturnType<typeof setTimeout> | undefined
  private pending: { id: string; resolve: (result: SpeechResult) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> } | null = null

  constructor(private readonly options: Options) {}

  recognize(raw: SpeechAudio): Promise<SpeechResult> {
    const input = speechAudioSchema.parse(raw)
    if (this.pending) return Promise.reject(appError('INVALID_ARGUMENT', { message: '已有语音输入正在识别。' }))
    clearTimeout(this.idle)
    const worker = this.getWorker()
    return new Promise((resolve, reject) => {
      this.pending = { id: input.recordingId, resolve, reject, timer: setTimeout(() => this.stop('语音识别超时，请重试。'), this.options.timeoutMs ?? 60_000) }
      try { worker.postMessage({ ...input, modelDir: this.options.modelDir }) }
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
      const id = message.type === 'result' ? message.result.recordingId : message.recordingId
      if (id !== this.pending.id) { this.stop('语音识别响应不匹配，请重试。'); return }
      if (message.type === 'error') {
        this.stop(message.code === 'MODEL_UNAVAILABLE' ? '本地语音模型缺失或损坏，请检查安装资源。' : '语音识别失败，请重新录音。')
        return
      }
      const pending = this.pending
      this.pending = null
      clearTimeout(pending.timer)
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
    if (pending) { clearTimeout(pending.timer); pending.reject(appError('INTERNAL_ERROR', { message })) }
    const worker = this.worker
    this.worker = null
    worker?.kill()
  }
}
