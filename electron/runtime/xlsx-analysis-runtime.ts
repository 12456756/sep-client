import { attachmentImportLimits } from '../../src/shared/attachment-contracts'
import { XLSX_RESULT_BYTES, xlsxFailureSchema, xlsxQuerySchema, xlsxResultSchema, type RunXlsxQuery, type XlsxResult } from '../domain/xlsx-analysis'
import type { DocumentPreviewWorker } from './document-preview-runtime'

export class XlsxAnalysisRuntime {
  private cancel?: () => void
  constructor(private readonly createWorker: () => DocumentPreviewWorker, private readonly timeoutMs = 30_000) {}

  run: RunXlsxQuery = async (bytes, query, signal) => {
    signal?.throwIfAborted()
    if (this.cancel) throw new Error('XLSX_BUSY')
    if (!xlsxQuerySchema.safeParse(query).success) throw new Error('XLSX_INVALID_REQUEST')
    if (bytes.byteLength > attachmentImportLimits.maxFileBytes) throw new Error('XLSX_BUDGET_EXCEEDED')
    let worker: DocumentPreviewWorker
    try { worker = this.createWorker() } catch { throw new Error('XLSX_WORKER_FAILED') }
    return new Promise<XlsxResult>((resolve, reject) => {
      let settled = false
      const finish = (error: unknown, value?: XlsxResult) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        this.cancel = undefined
        try { worker.kill() } catch { /* Already exited. */ }
        if (value) resolve(value)
        else reject(error)
      }
      const abort = () => finish(signal?.reason ?? new Error('XLSX_CANCELLED'))
      const timer = setTimeout(() => finish(new Error('XLSX_TIMEOUT')), this.timeoutMs)
      this.cancel = abort
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) { abort(); return }
      try {
        worker.on('message', raw => {
          if (settled) return
          const message = raw as { result?: unknown; xlsxError?: unknown } | null
          const result = xlsxResultSchema.safeParse(message?.result)
          const error = xlsxFailureSchema.safeParse(message?.xlsxError)
          const value = result.success ? result.data : undefined
          if (value && value.operation === query.operation &&
            (value.operation === 'xlsx_inspect' || ('sheet' in query && value.sheet === query.sheet && value.range === query.range)) &&
            (value.operation !== 'xlsx_analyze' || ('kind' in query && value.kind === query.kind)) &&
            Buffer.byteLength(JSON.stringify(value)) <= XLSX_RESULT_BYTES) finish(undefined, value)
          else finish(new Error(error.success ? error.data : 'XLSX_WORKER_FAILED'))
        })
        worker.once('exit', () => finish(new Error('XLSX_WORKER_FAILED')))
        worker.postMessage({ xlsx: query, bytes })
      } catch { finish(new Error('XLSX_WORKER_FAILED')) }
    })
  }

  stop(): void { this.cancel?.() }
}
