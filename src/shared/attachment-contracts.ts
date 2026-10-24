import { z } from 'zod'

const safeId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)
const sha256 = z.string().regex(/^[a-f0-9]{64}$/)

export const attachmentRefSchema = z.object({ attachmentId: safeId, sha256 }).strict()
export type AttachmentRef = z.infer<typeof attachmentRefSchema>
export interface InputSnapshotRef {
  snapshotId: string
  attachments: AttachmentRef[]
  inputDigest: string
}

export const draftAttachmentCandidateSchema = z.object({
  attachment: attachmentRefSchema,
  mustUse: z.boolean(),
  purposeHint: z.string().max(512).optional(),
}).strict()
export type DraftAttachmentCandidate = z.infer<typeof draftAttachmentCandidateSchema>

export const nodeInputRefSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('attachment'), attachment: attachmentRefSchema, required: z.boolean(), purpose: z.enum(['reference', 'analysis', 'vision', 'media-source']) }).strict(),
  z.object({ kind: z.literal('deliverable'), nodeId: safeId, deliverableId: safeId, required: z.boolean() }).strict(),
])
export type NodeInputRef = z.infer<typeof nodeInputRefSchema>

export const attachmentImportTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('compose'), composerId: safeId, clientNodeId: safeId.optional() }).strict(),
  z.object({ kind: z.literal('draft'), draftId: safeId, expectedRevision: z.number().int().positive() }).strict(),
  z.object({ kind: z.literal('draft-node'), draftId: safeId, nodeId: safeId, expectedRevision: z.number().int().positive() }).strict(),
  z.object({ kind: z.literal('conversation'), taskId: safeId }).strict(),
])
export type AttachmentImportTarget = z.infer<typeof attachmentImportTargetSchema>

export const attachmentViewSchema = z.object({
  attachmentId: safeId,
  displayName: z.string().min(1).max(255),
  mediaType: z.string().min(1).max(128),
  byteLength: z.number().int().nonnegative(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  sha256,
  importSource: z.enum(['picker', 'paste-file', 'paste-image']),
  extractionStatus: z.enum(['pending', 'ready', 'partial', 'not-required', 'unsupported', 'failed']),
  warnings: z.array(z.string().max(512)).max(32),
  extractionSummary: z.string().max(2000).optional(),
}).strict()
export type AttachmentView = z.infer<typeof attachmentViewSchema>

export const attachmentImportSessionSchema = z.object({
  schemaVersion: z.literal(1),
  sessionId: safeId,
  owner: z.object({ memberId: z.string().min(1), enterpriseId: z.string().min(1) }).strict(),
  target: attachmentImportTargetSchema,
  status: z.enum(['open', 'cancelled', 'claimed', 'expired']),
  createdAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().nonnegative(),
  attachments: z.array(attachmentViewSchema).max(10),
  revision: z.number().int().nonnegative().default(0),
}).strict()
export type AttachmentImportSession = z.infer<typeof attachmentImportSessionSchema>

export const attachmentImportLimits = Object.freeze({ maxFiles: 10, maxFileBytes: 20 * 1024 * 1024, maxTotalBytes: 100 * 1024 * 1024 })
