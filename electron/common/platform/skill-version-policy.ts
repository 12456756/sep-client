import type { SkillVersion } from './platform-api'

/** Remote versions require approval; owner-scoped local copies are authorized separately. */
export function canUseSkillVersion(version: Pick<SkillVersion, 'scope' | 'status' | 'ownerId'>, userId: string): boolean {
  if (version.scope === 'PLATFORM') return version.status === 'PLATFORM_APPROVED'
  if (version.scope === 'ENTERPRISE') return version.status === 'ENTERPRISE_APPROVED'
  return version.scope === 'PERSONAL'
    && version.status === 'ENTERPRISE_APPROVED'
    && Boolean(userId)
    && version.ownerId === userId
}
