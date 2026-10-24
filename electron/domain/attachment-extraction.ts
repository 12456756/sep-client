import { z } from 'zod'

export const attachmentExtractionSchema = z.object({
  status: z.enum(['ready', 'partial', 'not-required', 'unsupported', 'failed']),
  text: z.string().max(100000),
  warnings: z.array(z.string().max(512)).max(32),
}).strict()
export type AttachmentExtraction = z.infer<typeof attachmentExtractionSchema>
export type AttachmentExtractor = (mediaType: string, bytes: Uint8Array) => Promise<AttachmentExtraction>
