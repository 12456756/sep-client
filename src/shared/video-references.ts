import { z } from 'zod'

export const MAX_VIDEO_REFERENCES = 10
export const MAX_VIDEO_REFERENCE_BYTES = 90 * 1024 * 1024
export const videoReferenceMimeSchema = z.enum(['video/mp4', 'video/quicktime'])
export const videoReferenceSupportSchema = z.object({
  maxCount: z.number().int().min(0).max(MAX_VIDEO_REFERENCES),
  maxInputBytes: z.number().int().min(0).max(MAX_VIDEO_REFERENCE_BYTES),
  mimeTypes: z.array(videoReferenceMimeSchema).max(2),
}).strict()
export type VideoReferenceSupport = z.infer<typeof videoReferenceSupportSchema>
export const uploadedVideoReferenceSchema = z.object({
  mock: z.literal(false), kind: z.literal('video'),
  referenceId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  profileId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
  configVersion: z.string().min(1).max(128), mimeType: videoReferenceMimeSchema,
  byteLength: z.number().int().positive().max(MAX_VIDEO_REFERENCE_BYTES),
  sha256: z.string().regex(/^[a-fA-F0-9]{64}$/), expiresAt: z.string().datetime({ offset: true }),
}).strict()
export type UploadedVideoReference = z.infer<typeof uploadedVideoReferenceSchema>
export const videoReferenceViewSchema = z.object({
  localAssetId: z.string().regex(/^vref_[a-f0-9]{32}$/), taskId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  name: z.string().min(1).max(256), mime: videoReferenceMimeSchema,
  size: z.number().int().positive().max(MAX_VIDEO_REFERENCE_BYTES),
  status: z.enum(['SAVED', 'MISSING']),
  uploadStatus: z.enum(['LOCAL', 'UPLOADING', 'UPLOADED', 'FAILED']).optional(),
  uploadProgress: z.number().min(0).max(100).optional(),
  uploadError: z.string().max(2000).optional(),
  uploadProfileId: z.string().max(128).optional(), uploadConfigVersion: z.string().max(128).optional(),
  uploadExpiresAt: z.string().datetime({ offset: true }).optional(),
}).strict()
export type VideoReferenceView = z.infer<typeof videoReferenceViewSchema>

export function videoReferenceProblem(references: Pick<VideoReferenceView, 'mime' | 'size' | 'status'>[], support: VideoReferenceSupport): string | null {
  if (!references.length || references.length > support.maxCount) return `当前模型每次支持 1 至 ${support.maxCount} 个参考视频。`
  if (references.some(ref => ref.status !== 'SAVED')) return '参考视频文件不可用，请重新导入。'
  if (references.some(ref => !support.mimeTypes.includes(ref.mime))) return '参考视频格式不受当前模型支持。'
  if (references.some(ref => ref.size > support.maxInputBytes)) return `单个参考视频不能超过 ${Math.floor(support.maxInputBytes / 1024 / 1024)} MiB。`
  return null
}
