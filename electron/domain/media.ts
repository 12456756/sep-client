import type { ImageRequestedSpec, MediaParameterSources } from '../../src/shared/media-spec-contract'
import type { TaskOwnerScope } from '../data/scope-path'
import type { ImageMime, MediaAssetView, MediaCapabilities, MediaGenerationInput, MediaGenerationStatus, MediaProfile, MediaSaveStatus, MediaTrackingStatus } from '../../src/shared/media'
import type { EmployeeRuntimeSnapshot } from '../common/platform/employee-runtime-contract'
export type { ImageMime, MediaAssetView, MediaCapabilities, MediaGenerationInput, MediaJobView, MediaProfile } from '../../src/shared/media'

export interface MediaOutput {
  outputId: string
  mime: ImageMime
  size: number | null
  width: number | null
  height: number | null
  sha256?: string
  expiresAt: number | null
}

export interface MediaReceipt {
  receiptId: string
  clientRequestId: string
  profileId: string
  configVersion: string
  status: MediaGenerationStatus
  pollAfterMs: number | null
  outputs: MediaOutput[]
  actualSpec?: ImageRequestedSpec
  billingStatus: string
  recovery?: { canQuery: boolean; canCancel: boolean; canDownload: boolean }
  errorCode?: string | null
  outputErrors?: { index: number; code: string }[]
}

/** Mock/adapter port, not a finalized HTTP DTO. Amounts remain platform-owned strings. */
export interface MediaQuote {
  effectiveSpec?: ImageRequestedSpec
  quoteId: string
  requestHash: string
  expiresAt: number
  status: 'quoted' | 'unavailable'
  amount: string | null
  currency: string | null
  authorized: boolean
  budgetAuthorized: boolean
  allowUnknownCost: boolean
}

export interface MediaRequest {
  clientRequestId: string
  requestHash: string
  quoteId: string
  profileId: string
  configVersion: string
  operation: MediaGenerationInput['operation']
  referenceIds: string[]
  referenceHashes: string[]
  creativeBrief: string
  protocolVersion?: 3
  requestedSpec?: ImageRequestedSpec
  parameterSources?: MediaParameterSources
  specRevision?: number
  parameters: MediaGenerationInput['parameters']
}

export interface MediaGatewayPort {
  readonly quoteRequiresUploadedReferences?: boolean
  uploadReference(subscriptionId: string, input: { bytes: Uint8Array; mime: ImageMime; sha256: string }, signal: AbortSignal): Promise<{ referenceId: string; sha256: string; expiresAt: number }>
  quote(subscriptionId: string, request: Omit<MediaRequest, 'clientRequestId' | 'quoteId'>, signal: AbortSignal): Promise<unknown>
  submit(subscriptionId: string, request: MediaRequest, signal: AbortSignal): Promise<unknown>
  findReceipt(subscriptionId: string, clientRequestId: string, signal: AbortSignal): Promise<unknown | null>
  getReceipt(subscriptionId: string, receiptId: string, signal: AbortSignal): Promise<unknown>
  content(subscriptionId: string, receiptId: string, outputId: string, signal: AbortSignal): Promise<AsyncIterable<Uint8Array>>
  cancel(subscriptionId: string, receiptId: string, signal: AbortSignal): Promise<unknown>
}

export interface LocalMediaAsset extends MediaAssetView {
  version: 1
  owner: TaskOwnerScope
  relativePath: string
  sha256: string
  createdAt: number
  /** Newly derived references retain their first source; reused references keep their identity. */
  derivedFrom?: { localAssetId: string; jobId: string; outputId: string; sha256: string }
}

export interface LocalMediaJob {
  version: 1
  owner: TaskOwnerScope
  jobId: string
  taskId: string
  runId: string
  subscriptionId: string
  clientRequestId: string
  requestHash: string
  input: MediaGenerationInput
  profile: MediaProfile
  request: MediaRequest
  quote: MediaQuote
  approval: 'manual' | 'automatic'
  receiptId: string | null
  submission: 'NOT_SENT' | 'MAYBE_SENT' | 'RECEIPTED'
  generationStatus: MediaGenerationStatus
  trackingStatus: MediaTrackingStatus
  saveStatus: MediaSaveStatus
  outputs: MediaOutput[]
  actualSpec?: ImageRequestedSpec
  billingStatus: string
  recovery?: MediaReceipt['recovery']
  errorCode?: MediaReceipt['errorCode']
  outputErrors?: MediaReceipt['outputErrors']
  /** Last provider status query, retained for recovery diagnostics. */
  lastQueriedAt?: number
  providerWaitMs?: number
  downloadMs?: number
  nextPollAt: number
  attempts: number
  error: string | null
  createdAt: number
  updatedAt: number
}

export interface MediaRunSnapshot {
  version: 1
  owner: TaskOwnerScope
  taskId: string
  runId: string
  subscriptionId: string
  systemPrompt: string
  skills: { path: string; sha256: string; version: string }[]
  capabilities: MediaCapabilities | null
  runtimeSnapshot?: EmployeeRuntimeSnapshot
  createdAt: number
}

export interface MediaStorePort {
  getJob(scope: TaskOwnerScope, taskId: string, jobId: string): Promise<LocalMediaJob | null>
  listJobs(scope: TaskOwnerScope, taskId?: string): Promise<LocalMediaJob[]>
  saveJob(scope: TaskOwnerScope, job: LocalMediaJob): Promise<void>
  listAssets(scope: TaskOwnerScope, taskId: string): Promise<LocalMediaAsset[]>
  getAsset(scope: TaskOwnerScope, taskId: string, assetId: string): Promise<LocalMediaAsset | null>
  readAsset(scope: TaskOwnerScope, taskId: string, assetId: string): Promise<Uint8Array>
  importReference(scope: TaskOwnerScope, taskId: string, selectedPath: string): Promise<LocalMediaAsset>
  deriveReferenceFromOutput(scope: TaskOwnerScope, taskId: string, assetId: string, signal: AbortSignal, validate?: () => void): Promise<LocalMediaAsset>
  isOutputSaved?(scope: TaskOwnerScope, taskId: string, jobId: string, outputId: string): Promise<boolean>
  saveOutput(scope: TaskOwnerScope, taskId: string, jobId: string, output: MediaOutput, stream: AsyncIterable<Uint8Array>, signal: AbortSignal, options?: { repairCorrupt?: boolean }): Promise<LocalMediaAsset>
  exportAsset(scope: TaskOwnerScope, taskId: string, assetId: string, selectedPath: string): Promise<void>
  saveSnapshot(scope: TaskOwnerScope, snapshot: MediaRunSnapshot): Promise<void>
  getSnapshot(scope: TaskOwnerScope, taskId: string, runId?: string): Promise<MediaRunSnapshot | null>
  archive(scope: TaskOwnerScope, taskId: string): Promise<void>
  isArchived(scope: TaskOwnerScope, taskId: string): Promise<boolean>
}
