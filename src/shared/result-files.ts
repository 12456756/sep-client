import { z } from 'zod'
import { documentPreviewRequestSchema } from './document-preview'

const localId = z.string().regex(/^[A-Za-z0-9_-]{1,160}$/)
export const resultFileRequestSchema = z.union([
  documentPreviewRequestSchema,
  z.object({ taskId: localId, assetId: localId }).strict(),
  z.object({ taskId: localId, jobId: localId, outputId: localId }).strict(),
])
export type ResultFileRequest = z.infer<typeof resultFileRequestSchema>
export const resultFileActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.enum(['open', 'copy-path', 'save-as']), file: resultFileRequestSchema }).strict(),
  z.object({ action: z.literal('attach'), file: resultFileRequestSchema, sessionId: localId }).strict(),
])
export type ResultFileAction = z.infer<typeof resultFileActionSchema>

const openableExtensions = new Set('pdf doc docx xls xlsx ppt pptx odt ods odp txt md markdown csv tsv json xml yaml yml log png jpg jpeg webp gif bmp tif tiff avif heic ico mp4 webm mov mp3 wav m4a ogg flac zip 7z'.split(' '))
export function canOpenResultFile(name: string): boolean {
  const dot = name.lastIndexOf('.')
  return dot > 0 && openableExtensions.has(name.slice(dot + 1).toLowerCase())
}
export const resultFileReleaseSchema = z.object({ url: z.string().regex(/^sep-result:\/\/preview\/[a-f0-9]{64}$/) }).strict()
export interface ResultFilePreview { url: string; mime: string; kind: 'image' | 'video' }
