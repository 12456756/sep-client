import type { ClientProfile } from '../../shared/profile-wallet-contracts'
import type { EmployeeAvatarSource } from '../../shared/types'

/**
 * Profile is the authoritative source once it has loaded. In particular, a
 * successful `null` means "not configured" and must not be replaced with a
 * stale login or organization value.
 */
export function displayedUserAvatar(
  profile: ClientProfile | null,
  initialAvatar: EmployeeAvatarSource | null,
  userName: string,
): EmployeeAvatarSource | null {
  if (!profile) return initialAvatar
  return {
    name: profile.user.name || userName,
    avatar: profile.user.avatar,
  }
}

/** Profile owns the enterprise image after it has loaded, including null. */
export function displayedEnterpriseLogo(
  profile: ClientProfile | null,
  organizationLogo: string | null,
): string | null {
  return profile ? profile.enterprise?.logo ?? null : organizationLogo
}
