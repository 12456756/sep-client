import { z } from 'zod'
import { convertDocumentPreview } from './document-preview-converter'
import { extractAttachment } from './attachment-extractor'

interface ParentPort {
  on(event: 'message', callback: (event: { data: unknown }) => void): void
  postMessage(value: unknown): void
}
const parent = (process as NodeJS.Process & { parentPort: ParentPort }).parentPort
const requestSchema = z.object({ format: z.string(), bytes: z.instanceof(Uint8Array) }).strict()
const extractionSchema = z.object({ extract: z.literal(true), mediaType: z.string().max(128), bytes: z.instanceof(Uint8Array).refine(value => value.byteLength <= 20 * 1024 * 1024) }).strict()
parent.on('message', ({ data }) => {
  void (async () => {
    const extraction = extractionSchema.safeParse(data)
    if (extraction.success) { parent.postMessage(await extractAttachment(extraction.data.mediaType, extraction.data.bytes)); return }
    const request = requestSchema.safeParse(data)
    if (!request.success) { parent.postMessage({ error: 'INVALID_INPUT' }); return }
    try { parent.postMessage(await convertDocumentPreview(request.data.format, request.data.bytes)) }
    catch { parent.postMessage({ error: 'CONVERSION_FAILED' }) }
  })()
})
