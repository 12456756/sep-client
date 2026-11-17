import { z } from 'zod'
import type { MediaProfile } from './media'

export const MAX_MEDIA_REFERENCES = 32
export const MAX_MEDIA_REFERENCE_BYTES = 100 * 1024 * 1024
export const mediaReferenceSupportSchema = z.object({
  maxCount: z.number().int().nonnegative().safe(),
  maxInputBytes: z.number().int().positive().safe(),
  mimeTypes: z.array(z.string().trim().min(1).max(128)).max(16),
}).strict()
export type MediaReferenceSupport = z.infer<typeof mediaReferenceSupportSchema>
export interface MediaReferenceInfo { localAssetId: string; mime: string; size: number; status: string }

export function imageReferenceSupport(profile: MediaProfile, negotiated: boolean): MediaReferenceSupport {
  return profile.adapter?.referenceSupport ?? { maxCount: profile.capabilities.referenceImage ? (negotiated ? 1 : 16) : 0,
    maxInputBytes: 5 * 1024 * 1024, mimeTypes: ['image/png', 'image/jpeg', 'image/webp'] }
}

export function mediaReferenceProblem(assets: readonly MediaReferenceInfo[], support: MediaReferenceSupport): string | null {
  const maxCount = Math.min(MAX_MEDIA_REFERENCES, support.maxCount)
  if (assets.length > maxCount) return `当前模型最多支持 ${maxCount} 张参考图，请减少选择。`
  if (new Set(assets.map(asset => asset.localAssetId)).size !== assets.length) return '参考图不能重复。'
  let total = 0
  for (const asset of assets) {
    if (asset.status !== 'SAVED') return '参考图尚未保存或文件已缺失，请重新导入。'
    if (!support.mimeTypes.includes(asset.mime)) return `当前模型不支持 ${asset.mime} 格式，请更换参考图。`
    if (!Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > support.maxInputBytes) return `单张参考图不能超过 ${Math.round(support.maxInputBytes / 1024 / 1024 * 100) / 100} MiB。`
    total += asset.size
  }
  if (total > MAX_MEDIA_REFERENCE_BYTES) return '参考图总大小不能超过 100 MiB，请缩小图片或减少选择。'
  return null
}
