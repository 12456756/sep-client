import type { PersonalSkillVersionRequest, SkillVersion } from './platform-supplement-contracts'
import { z } from 'zod'

export const FOLLOW_PLATFORM_SKILL_VERSION = 'follow-platform'

export const skillLibraryQuerySchema = z.object({
  mode: z.enum(['cache', 'auto', 'manual']).default('auto'),
  capabilityId: z.string().min(1).max(128).refine(id => id.trim().length > 0).optional(),
}).strict()

export type SkillLibraryQuery = z.input<typeof skillLibraryQuerySchema>

export interface SkillLibrarySnapshot {
  items: SkillLibraryItem[]
  skippedCount: number
  updatedAt?: number
  retryAt?: number
}

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
  item?: SkillLibraryItem
}
