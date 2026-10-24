import { documentPreviewContentSchema, type DocumentPreviewContent } from '../../src/shared/document-preview'
import { AppError } from '../errors/app-error'

export interface DocumentPreviewWorker {
  postMessage(value: unknown): void
  kill(): unknown
  on(event: 'message', listener: (value: unknown) => void): unknown
  once(event: 'exit', listener: () => void): unknown
}

/** Serialized, disposable utility processes keep Office parsing off the task/UI processes. */
export class DocumentPreviewRuntime {
  private tail: Promise<unknown> = Promise.resolve()
  private epoch = 0
  private cancel: (() => void) | undefined
  constructor(private readonly createWorker: () => DocumentPreviewWorker, private readonly timeoutMs = 90_000) {}

  render(format: string, bytes: Uint8Array): Promise<DocumentPreviewContent> {
    const epoch = this.epoch
    const result = this.tail.then(() => {
      if (epoch !== this.epoch) throw new AppError('AUTH_REQUIRED')
      return new Promise<DocumentPreviewContent>((resolve, reject) => {
        const worker = this.createWorker()
        let settled = false
        const settle = (content?: DocumentPreviewContent, message = '文档预览失败，可重试或复制路径查看原件。') => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          this.cancel = undefined
          worker.kill()
          if (content) resolve(content)
          else reject(new AppError('INTERNAL_ERROR', { message }))
        }
        const timer = setTimeout(() => settle(undefined, '文档预览耗时较长，可重试或复制路径查看原件。'), this.timeoutMs)
        this.cancel = () => settle(undefined, '文档预览已取消。')
        worker.on('message', raw => {
          const parsed = documentPreviewContentSchema.safeParse(raw)
          settle(parsed.success ? parsed.data : undefined)
        })
        worker.once('exit', () => settle())
        try { worker.postMessage({ format, bytes }) } catch { settle() }
      })
    })
    this.tail = result.catch(() => undefined)
    return result
  }

  stop(): void { this.epoch++; this.cancel?.() }
}
