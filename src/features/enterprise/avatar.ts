import type { EmployeeAvatarSource } from '../../shared/types'

export type AvatarVariant = 'face' | 'portrait'

function pushUnique(values: string[], value: string | null | undefined): void {
  if (typeof value === 'string' && value.length > 0 && !values.includes(value)) values.push(value)
}

/**
 * Returns only URLs supplied by SEP (or the legacy avatar field), in the
 * documented fallback order. URLs are intentionally not normalized or rebuilt.
 */
export function avatarCandidates(
  employee: EmployeeAvatarSource,
  variant: AvatarVariant,
): string[] {
  const candidates: string[] = []
  if (variant === 'face') {
    pushUnique(candidates, employee.avatarAsset?.faceUrl)
    pushUnique(candidates, employee.avatarAsset?.portraitUrl)
  } else {
    pushUnique(candidates, employee.avatarAsset?.portraitUrl)
    pushUnique(candidates, employee.avatarAsset?.faceUrl)
  }
  pushUnique(candidates, employee.avatar)
  return candidates
}

/**
 * Cache identity follows the asset id + version. A null version uses the full
 * URL so a platform-side asset replacement cannot keep an old browser key.
 */
export function avatarCacheKey(
  employee: EmployeeAvatarSource,
  variant: AvatarVariant,
): string {
  const asset = employee.avatarAsset
  if (asset) {
    const versionOrUrl = asset.version ?? (variant === 'face' ? asset.faceUrl : asset.portraitUrl)
    return `avatar:${asset.id}:${versionOrUrl}:${variant}`
  }
  if (employee.avatar) return `avatar:legacy:${employee.avatar}:${variant}`
  return `avatar:placeholder:${variant}`
}
