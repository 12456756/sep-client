import type { PersonalSkillVersionRequest, SkillVersion } from './platform-supplement-contracts'

export interface SkillBinding {
  subscriptionId: string
  employeeId: string
  currentVersion: SkillVersion
  selectedVersionId: string
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
