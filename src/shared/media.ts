export type ImageMime = 'image/png' | 'image/jpeg' | 'image/webp'
export type MediaOperation = 'generate' | 'edit'
export type MediaToolName = 'media_get_capabilities' | 'media_generate_image' | 'media_get_job' | 'media_cancel_job'
export type MediaGenerationStatus = 'SUBMITTING' | 'QUEUED' | 'RUNNING' | 'SUBMISSION_UNKNOWN' | 'SUCCEEDED' | 'PARTIAL_SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'RESULT_EXPIRED'
export type MediaTrackingStatus = 'ACTIVE' | 'INTERRUPTED' | 'AUTH_REQUIRED' | 'STOPPED'
export type MediaSaveStatus = 'PENDING' | 'SAVING' | 'SAVED' | 'SAVE_FAILED' | 'MISSING'

export interface MediaProfile {
  profileId: string
  kind: 'image'
  displayName: string
  configVersion: string
  operations: MediaOperation[]
  executionMode: 'async-query' | 'sync-response'
  capabilities: { referenceImage: boolean; cancel: boolean; recoverByRequestId: boolean }
  allowedAspectRatios: string[]
  allowedSizes?: string[]
  allowedQualities?: string[]
  defaultSize?: string
  defaultQuality?: string
  maxCount: number
}

export interface MediaCapabilities {
  protocolVersion: 1
  defaultProfileId?: string | null
  tools: MediaToolName[]
  profiles: MediaProfile[]
}

export interface MediaGenerationInput {
  profileId: string
  operation: MediaOperation
  localAssetIds: string[]
  creativeBrief: string
  parameters: { aspectRatio: string; count: number; size?: string; quality?: string }
}

export interface MediaAssetView {
  localAssetId: string
  taskId: string
  jobId: string | null
  outputId: string | null
  source: 'reference' | 'output'
  mime: ImageMime
  size: number
  width: number
  height: number
  status: MediaSaveStatus
}

export interface MediaJobView {
  jobId: string
  taskId: string
  runId: string
  profileId: string
  operation: MediaOperation
  parameters: MediaGenerationInput['parameters']
  generationStatus: MediaGenerationStatus
  trackingStatus: MediaTrackingStatus
  saveStatus: MediaSaveStatus
  billingStatus: string
  error: string | null
  createdAt: number
  updatedAt: number
  assets: MediaAssetView[]
  canCancelUpstream: boolean
  canRetrySave?: boolean
  canResumeTracking?: boolean
}

export interface MediaTaskView {
  capabilities: MediaCapabilities | null
  unavailableReason: string | null
  assets: MediaAssetView[]
  selectedReferenceIds: string[]
  jobs: MediaJobView[]
  archived: boolean
}

export interface MediaPreview {
  mime: ImageMime
  bytes: Uint8Array
}
