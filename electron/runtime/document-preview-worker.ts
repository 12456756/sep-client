import { z } from 'zod'
import { convertDocumentPreview } from './document-preview-converter'

interface ParentPort {
  on(event: 'message', callback: (event: { data: unknown }) => void): void
  postMessage(value: unknown): void
}
const parent = (process as NodeJS.Process & { parentPort: ParentPort }).parentPort
const requestSchema = z.object({ format: z.string(), bytes: z.instanceof(Uint8Array) }).strict()
parent.on('message', ({ data }) => {
  void (async () => {
    const request = requestSchema.safeParse(data)
    if (!request.success) { parent.postMessage({ error: 'INVALID_INPUT' }); return }
    try { parent.postMessage(await convertDocumentPreview(request.data.format, request.data.bytes)) }
    catch { parent.postMessage({ error: 'CONVERSION_FAILED' }) }
  })()
})
