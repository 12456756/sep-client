import { attachmentExtractionSchema, type AttachmentExtraction } from '../domain/attachment-extraction'
import type { DocumentPreviewWorker } from './document-preview-runtime'

export class AttachmentExtractionRuntime {
  private tail: Promise<unknown> = Promise.resolve()
  private epoch = 0
  private cancel?: () => void
  constructor(private readonly createWorker: () => DocumentPreviewWorker, private readonly timeoutMs = 30000) {}

  extract(mediaType: string, bytes: Uint8Array): Promise<AttachmentExtraction> {
    const epoch = this.epoch
    const result = this.tail.then(() => new Promise<AttachmentExtraction>(resolve => {
      const failed: AttachmentExtraction = { status: 'failed', text: '', warnings: ['EXTRACTION_FAILED'] }
      if (epoch !== this.epoch) { resolve(failed); return }
      let worker: DocumentPreviewWorker
      try { worker = this.createWorker() } catch { resolve(failed); return }
      let settled = false
      const finish = (value = failed) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.cancel = undefined
        try { worker.kill() } finally { resolve(value) }
      }
      const timer = setTimeout(() => finish({ ...failed, warnings: ['EXTRACTION_TIMEOUT'] }), this.timeoutMs)
      this.cancel = () => finish()
      worker.on('message', raw => {
        const parsed = attachmentExtractionSchema.safeParse(raw)
        finish(parsed.success ? parsed.data : failed)
      })
      worker.once('exit', () => finish())
      try { worker.postMessage({ extract: true, mediaType, bytes }) } catch { finish() }
    }))
    this.tail = result.catch(() => undefined)
    return result
  }

  stop(): void { this.epoch++; this.cancel?.() }
}
