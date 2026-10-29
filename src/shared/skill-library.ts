import type { PersonalSkillVersionRequest, SkillVersion } from './platform-supplement-contracts'

export const FOLLOW_PLATFORM_SKILL_VERSION = 'follow-platform'

export interface SkillBinding {
  subscriptionId: string
  employeeId: string
  currentVersion: SkillVersion | null
  selectedVersionId: string | null
  selectionMode?: 'follow-platform' | 'personal'
}

export interface LocalSkillSubmission {
  idempotencyKey: string
  request: PersonalSkillVersionRequest
  createdAt: string
  uploadedVersion?: SkillVersion
}

export interface SkillLibraryItem {
  capability: { id: string; name: string; description: string; type: string }
  bindings: SkillBinding[]
  usableVersionIds: string[]
  versions: SkillVersion[]
  localVersions: LocalSkillSubmission[]
}

export interface SaveSkillInput {
  request: PersonalSkillVersionRequest
  idempotencyKey: string
}
export interface SaveSkillResult {
  idempotencyKey: string
  uploaded: boolean
  version?: SkillVersion
}
