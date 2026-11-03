import { documentPreviewContentSchema, type DocumentPreviewContent } from '../../src/shared/document-preview'
import { AppError } from '../errors/app-error'
import { DOCUMENT_PREVIEW_FAILURES, documentPreviewFailureSchema, type DocumentPreviewFailure } from '../errors/document-preview-error'

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
        const settle = (content?: DocumentPreviewContent, reason: DocumentPreviewFailure = 'CONVERSION_FAILED') => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          this.cancel = undefined
          worker.kill()
          if (content) resolve(content)
          else reject(new AppError('INTERNAL_ERROR', { message: DOCUMENT_PREVIEW_FAILURES[reason], details: { reason } }))
        }
        const timer = setTimeout(() => settle(undefined, 'CONVERSION_TIMEOUT'), this.timeoutMs)
        this.cancel = () => settle(undefined, 'CANCELLED')
        worker.on('message', raw => {
          const parsed = documentPreviewContentSchema.safeParse(raw)
          const failed = documentPreviewFailureSchema.safeParse(raw)
          settle(parsed.success ? parsed.data : undefined, failed.success ? failed.data.error : 'INVALID_RESPONSE')
        })
        worker.once('exit', () => settle(undefined, 'WORKER_EXITED'))
        try { worker.postMessage({ format, bytes }) } catch { settle(undefined, 'SEND_FAILED') }
      })
    })
    this.tail = result.catch(() => undefined)
    return result
  }

  stop(): void { this.epoch++; this.cancel?.() }
}
