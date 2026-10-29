import type { TaskOwnerScope } from '../data/scope-path'
import type { ArrangementDeliverable, ArrangementNode } from './arrangement-plan'
import type { DeliverySubmission, FinalDeliveryFile } from './arrangement-delivery'
import type { ArrangementMediaLink } from './arrangement-media'
import type { MediaHostTools, MediaJobCreated } from './media-tools'
import type { VideoHostTools } from './video-tools'
import type { AttachmentRef } from '../../src/shared/attachment-contracts'

export class ArrangementMediaSubmissionError extends Error {}

export interface ArrangementMediaAsset {
  artifactId: string
  kind: 'image' | 'video'
  sha256: string
  size: number
  mime: string
  status: 'saved' | 'missing'
}

export interface ArrangementMediaAssetsPort {
  attachmentReference?(scope: TaskOwnerScope, taskId: string, ref: AttachmentRef, signal: AbortSignal, validate: () => void): Promise<{ artifactId: string; sha256: string }>
  outputs(scope: TaskOwnerScope, taskId: string, link: ArrangementMediaLink): Promise<ArrangementMediaAsset[]>
  reference(scope: TaskOwnerScope, taskId: string, artifactId: string, signal: AbortSignal, validate: () => void): Promise<{ artifactId: string; sha256: string }>
  materialize(scope: TaskOwnerScope, taskId: string, workspace: string, deliverable: ArrangementDeliverable,
    link: ArrangementMediaLink, artifactId: string, nodeRunId: string, signal: AbortSignal, validate: () => void): Promise<FinalDeliveryFile>
}

export interface ArrangementMediaSession {
  readonly inputPrompt: string
  readonly recoverJobIds: readonly string[]
  /** Only media-only nodes with every declared operation durably associated may yield. */
  readyForTracking(): boolean
  automaticSubmission(): Promise<DeliverySubmission | undefined>
  artifactSummary(): Promise<Array<{ kind: 'image' | 'video'; jobId: string; assets: ArrangementMediaLink['outputs'] }>>
  onJobCreated(job: MediaJobCreated): Promise<void>
  bind(media?: MediaHostTools, video?: VideoHostTools): { media?: MediaHostTools; video?: VideoHostTools }
  materialize(submission: DeliverySubmission): Promise<FinalDeliveryFile[]>
}

export interface ArrangementMediaPort {
  prepareNode(input: {
    taskId: string; arrangementRunId: string; nodeRunId: string; attempt: number
    planHash: string; node: ArrangementNode; signal: AbortSignal
    specRevisions?: Record<string, number>
  }): Promise<ArrangementMediaSession>
}
