import { z } from 'zod'
import { documentPreviewRequestSchema } from './document-preview'

const localId = z.string().regex(/^[A-Za-z0-9_-]{1,160}$/)
export const resultFileRequestSchema = z.union([
  documentPreviewRequestSchema,
  z.object({ taskId: localId, assetId: localId }).strict(),
  z.object({ taskId: localId, jobId: localId, outputId: localId }).strict(),
])
export type ResultFileRequest = z.infer<typeof resultFileRequestSchema>
export const resultFileReleaseSchema = z.object({ url: z.string().regex(/^sep-result:\/\/preview\/[a-f0-9]{64}$/) }).strict()
export interface ResultFilePreview { url: string; mime: string; kind: 'image' | 'video' }
