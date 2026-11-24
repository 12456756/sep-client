import type { TaskOwnerScope } from '../data/scope-path'
import type { AttachmentRef } from '../../src/shared/attachment-contracts'
import type { XlsxQuery, XlsxResult } from './xlsx-analysis'

export interface BoundOriginalFile { path: string; identity: string }

export interface ResolvedAttachmentInput {
  attachmentId: string
  sha256: string
  displayName: string
  mediaType: string
  byteLength: number
  width?: number
  height?: number
  readPath?: string
  /** Host-only binding from a trusted native file selection or drop; never a media or upload grant. */
  originalFile?: BoundOriginalFile
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
  queryTaskXlsx?(scope: TaskOwnerScope, taskId: string, ref: AttachmentRef, query: XlsxQuery, signal?: AbortSignal): Promise<XlsxResult>
  describeTaskInputs(scope: TaskOwnerScope, taskId: string, refs: readonly AttachmentRef[]): Promise<ResolvedAttachmentInput[]>
  resolveTaskInputs(scope: TaskOwnerScope, taskId: string, refs: readonly (AttachmentRef | { kind: string; attachment?: AttachmentRef })[]): Promise<{ attachments: ResolvedAttachmentInput[]; images: Array<ResolvedAttachmentInput & { bytes: Uint8Array }>; digest: string }>
  resolvePlannerMaterials(scope: TaskOwnerScope, refs: readonly AttachmentRef[]): Promise<PlannerAttachmentMaterial[]>
}

export interface ConversationAttachmentReader {
  list(offset: number): { files: ReadonlyArray<{ attachmentId: string; name: string; mediaType: string; messageNumber: number; imageNumber?: number; xlsxAnalysis?: true }>; nextOffset: number | null }
  xlsx?(attachmentId: string, query: XlsxQuery, signal?: AbortSignal): Promise<XlsxResult>
  read(attachmentId: string, offset: number, signal?: AbortSignal): Promise<{
    text: string
    image?: { data: string; mimeType: string }
  }>
}
