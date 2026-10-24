import { app, utilityProcess } from 'electron'
import { join } from 'node:path'
import { DocumentPreviewRuntime, type DocumentPreviewWorker } from '../runtime/document-preview-runtime'
import { AttachmentExtractionRuntime } from '../runtime/attachment-extraction-runtime'

export function createDocumentPreviewRuntime(): DocumentPreviewRuntime {
  return new DocumentPreviewRuntime(createWorker)
}

export function createAttachmentExtractionRuntime(): AttachmentExtractionRuntime {
  return new AttachmentExtractionRuntime(createWorker)
}

function createWorker(): DocumentPreviewWorker {
    const worker = utilityProcess.fork(join(app.getAppPath(), 'out/main/document-preview-worker.js'), [], { serviceName: 'SEP document preview', stdio: 'pipe' })
    worker.stdout?.on('data', () => undefined)
    worker.stderr?.on('data', () => undefined)
    let stopped = false
    const port: DocumentPreviewWorker = {
      postMessage: message => {
        if (worker.pid) worker.postMessage(message)
        else worker.once('spawn', () => { if (!stopped) { try { worker.postMessage(message) } catch { worker.kill() } } })
      },
      kill: () => { stopped = true; return worker.kill() },
      on: (_event, listener) => worker.on('message', listener),
      once: (_event, listener) => worker.once('exit', listener),
    }
    return port
}
