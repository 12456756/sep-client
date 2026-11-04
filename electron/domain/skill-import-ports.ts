import type { z } from 'zod'
import type { SkillImportApi } from '../common/platform/skill-import-api'
import type { SkillImportCandidate, SkillImportChallengeViewSchema, SkillImportPreview, SkillImportScopeSchema } from '../../src/shared/skill-import-contracts'

export type ImportScope = z.infer<typeof SkillImportScopeSchema>
export type ImportChallenge = z.infer<typeof SkillImportChallengeViewSchema>
export interface ImportRoot { id: string; label: string; scope: 'user' | 'project'; sources: string[] }
export interface ImportPackage { sha256: string; bytes: number; filename: string; open(): AsyncIterable<Uint8Array> }
export interface ImportFilesPort {
  listRoots(): Promise<ImportRoot[]>
  addProjectRoot(path: string): Promise<ImportRoot>
  removeRoot(id: string): Promise<void>
  scan(rootIds: string[], options: { signal: AbortSignal }): Promise<SkillImportCandidate[]>
  getScanWarnings?(): ReadonlyArray<{ code: string; rootId?: string }>
  preview(input: { requestId: string; candidateId: string; revision: number; expiresAt: string }, signal: AbortSignal): Promise<Omit<SkillImportPreview, 'files'> & { files: Array<{ relativePath: string; bytes: number }> }>
  packageSelected(input: { candidateId: string; snapshotId: string; operationId: string }, signal: AbortSignal): Promise<ImportPackage>
  reset(): Promise<void>
  dispose(): Promise<void>
}
export interface ImportIdentity {
  publicKey: string
  keyFingerprint: string
  sign(challenge: ImportChallenge, remember: boolean, scope: ImportScope | 'revoke', rootIds: string[]): string
}
export interface ImportDeviceBinding {
  deviceId: string
  instanceId: string
  label: string
  keyFingerprint: string
  platform: string
  scope: ImportScope
  rootIds: string[]
  revocationPending: boolean
}
export interface ImportDevicesPort {
  available(): boolean
  createIdentity(): ImportIdentity
  list(): Promise<ImportDeviceBinding[]>
  identity(deviceId: string, instanceId: string): Promise<ImportIdentity>
  remember(identity: ImportIdentity, binding: Omit<ImportDeviceBinding, 'revocationPending'>): Promise<void>
  disable(deviceId: string, instanceId: string): Promise<void>
  forget(deviceId: string, instanceId: string): Promise<void>
}
export interface ImportInstance { instanceId: string; label: string; apiBaseUrl: string }
export type ImportApiPort = Pick<SkillImportApi, 'request' | 'upload'>
