import type { TaskOwnerScope } from '../data/scope-path'
import type { AttachmentRef } from '../../src/shared/attachment-contracts'

export interface ResolvedAttachmentInput {
  attachmentId: string
  sha256: string
  displayName: string
  mediaType: string
  byteLength: number
  width?: number
  height?: number
  readPath?: string
  extractedText?: string
  extractionStatus: string
}

export interface PlannerAttachmentMaterial {
  attachmentId: string
  sha256: string
  displayName: string
  mediaType: string
  byteLength: number
  summary: string
  warnings: string[]
}

export interface AttachmentInputPort {
  describeTaskInputs(scope: TaskOwnerScope, taskId: string, refs: readonly AttachmentRef[]): Promise<ResolvedAttachmentInput[]>
  resolveTaskInputs(scope: TaskOwnerScope, taskId: string, refs: readonly (AttachmentRef | { kind: string; attachment?: AttachmentRef })[]): Promise<{ attachments: ResolvedAttachmentInput[]; images: Array<ResolvedAttachmentInput & { bytes: Uint8Array }>; digest: string }>
  resolvePlannerMaterials(scope: TaskOwnerScope, refs: readonly AttachmentRef[]): Promise<PlannerAttachmentMaterial[]>
}

export interface ConversationAttachmentReader {
  list(offset: number): { files: ReadonlyArray<{ attachmentId: string; name: string; mediaType: string; messageNumber: number; imageNumber?: number }>; nextOffset: number | null }
  read(attachmentId: string, offset: number, signal?: AbortSignal): Promise<{
    text: string
    image?: { data: string; mimeType: string }
  }>
}
