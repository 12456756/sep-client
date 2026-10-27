import { z } from 'zod'

export interface ModelPreferenceScope { enterpriseId: string; memberId: string }
type StoragePort = Pick<Storage, 'getItem' | 'setItem'>
const preferenceSchema = z.object({ version: z.literal(1), defaultModelId: z.string().max(512) }).strict()

export function modelPreferenceKey(scope: ModelPreferenceScope | null): string | null {
  if (!scope?.enterpriseId.trim() || !scope.memberId.trim()) return null
  return `sep.default-model.v1:${JSON.stringify([scope.enterpriseId, scope.memberId])}`
}

export function readDefaultModel(storage: StoragePort | null, key: string | null): string {
  if (!storage || !key) return ''
  try {
    const raw = storage.getItem(key)
    if (!raw || raw.length > 4096) return ''
    const result = preferenceSchema.safeParse(JSON.parse(raw))
    return result.success ? result.data.defaultModelId : ''
  } catch { return '' }
}

export function saveDefaultModel(storage: StoragePort | null, key: string | null, defaultModelId: string): boolean {
  if (!storage || !key) return false
  const result = preferenceSchema.safeParse({ version: 1, defaultModelId })
  if (!result.success) return false
  try { storage.setItem(key, JSON.stringify(result.data)); return true } catch { return false }
}

export function resolveTaskModel(models: readonly string[], preferredModelId: string, selectedModelId?: string | null): string {
  if (selectedModelId && models.includes(selectedModelId)) return selectedModelId
  return models.includes(preferredModelId) ? preferredModelId : models[0] ?? ''
}
