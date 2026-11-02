import { z } from 'zod'
import { documentPreviewRequestSchema } from './document-preview'

export const resultFileRequestSchema = documentPreviewRequestSchema
export type ResultFileRequest = z.infer<typeof resultFileRequestSchema>
export const resultFileReleaseSchema = z.object({ url: z.string().regex(/^sep-result:\/\/preview\/[a-f0-9]{64}$/) }).strict()
export interface ResultFilePreview { url: string; mime: string; kind: 'image' | 'video' }
