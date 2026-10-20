import { z } from 'zod'
import type { MediaGenerationInput } from './media'
import { videoParametersSchema, type VideoParameters } from './video-media'

export interface MediaPreferenceScope { enterpriseId: string; memberId: string }
export type MediaParameterPreference = Partial<MediaGenerationInput['parameters'] & VideoParameters>
type StoragePort = Pick<Storage, 'getItem' | 'setItem'>
type MediaKind = 'image' | 'video'
const imagePreferenceSchema = z.object({
  aspectRatio: z.string().min(1).max(32).optional(), count: z.number().int().min(1).max(16).optional(),
  size: z.string().min(1).max(64).optional(), quality: z.string().min(1).max(64).optional(),
}).strict()

export function mediaPreferenceKey(scope: MediaPreferenceScope | null, kind: MediaKind, profileId?: string): string | null {
  if (!scope?.enterpriseId.trim() || !scope.memberId.trim() || !profileId?.trim()) return null
  return `sep.media-parameters.v1:${JSON.stringify([scope.enterpriseId, scope.memberId, kind, profileId])}`
}

/** Only parameter values are persisted; prompts, assets, quotes and identity tokens are excluded. */
export function readMediaPreference(storage: StoragePort | null, key: string | null, kind: MediaKind): MediaParameterPreference {
  if (!storage || !key) return {}
  try {
    const raw = storage.getItem(key)
    if (!raw || raw.length > 4096) return {}
    const result = (kind === 'image' ? imagePreferenceSchema : videoParametersSchema.partial()).safeParse(JSON.parse(raw))
    return result.success ? result.data : {}
  } catch { return {} }
}

export function saveMediaPreference(storage: StoragePort | null, key: string | null, kind: MediaKind, parameters: MediaParameterPreference): void {
  if (!storage || !key) return
  const result = (kind === 'image' ? imagePreferenceSchema : videoParametersSchema.partial()).safeParse(parameters)
  if (!result.success) return
  try { storage.setItem(key, JSON.stringify(result.data)) } catch { /* Storage denial must not disable media creation. */ }
}
