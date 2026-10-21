import { z } from 'zod'

export const KNOWLEDGE_MAX_FILE_BYTES = 10 * 1024 * 1024
function hasControlCharacters(value: string): boolean {
  return [...value].some(character => {
    const code = character.codePointAt(0)!
    return code <= 0x1f || code === 0x7f
  })
}
export const knowledgeIdSchema = z.string().min(1).max(256).refine(value => !hasControlCharacters(value) && value !== '.' && value !== '..')
export const knowledgeRequestIdSchema = z.string().uuid()
const keySchema = z.string().regex(/^[A-Za-z0-9_-]{8,128}$/)
const etagSchema = z.string().min(1).max(512).refine(value => !/[\r\n]/.test(value))
const pageFields = { page: z.number().int().min(1).default(1), pageSize: z.number().int().min(1).max(100).default(20), keyword: z.string().trim().max(200).optional() }
const kbFields = { kbId: knowledgeIdSchema }
const docFields = { ...kbFields, docId: knowledgeIdSchema }
const mutationFields = { ...docFields, etag: etagSchema, idempotencyKey: keySchema }
export const knowledgeFileSchema = z.object({
  filename: z.string().min(1).max(255).refine(value => !/[\\/:]/.test(value) && !hasControlCharacters(value) && /\.(pdf|docx|txt|md)$/i.test(value), '仅支持 PDF、DOCX、TXT、MD，文件名不能包含路径'),
  bytes: z.instanceof(Uint8Array).refine(value => value.byteLength > 0 && value.byteLength <= KNOWLEDGE_MAX_FILE_BYTES, '文件必须大于 0 且不超过 10 MiB'),
}).strict()
function request<A extends string, T extends z.ZodRawShape>(action: A, fields: T) {
  return z.object({ requestId: knowledgeRequestIdSchema, action: z.literal(action), ...fields }).strict()
}
// Literal discriminants remain explicit so both IPC and consumers can exhaustively narrow.
export const knowledgeRequestSchema = z.discriminatedUnion('action', [
  request('list', pageFields), request('getBase', kbFields),
  request('createBase', { name: z.string().trim().min(1).max(100), description: z.string().max(500).optional() }),
  request('updateBase', { ...kbFields, name: z.string().trim().min(1).max(100), description: z.string().max(500) }),
  request('deleteBase', kbFields), request('documents', kbFields), request('getDocument', docFields),
  request('uploadDocument', { ...kbFields, file: knowledgeFileSchema, idempotencyKey: keySchema }),
  request('replaceDocument', { ...mutationFields, file: knowledgeFileSchema }),
  request('retryDocument', mutationFields), request('deleteDocument', mutationFields), request('versions', docFields),
  request('preview', { ...docFields, ...pageFields, versionId: knowledgeIdSchema.optional() }),
  request('members', pageFields), request('grants', { ...kbFields, ...pageFields }),
  request('grant', { ...kbFields, memberIds: z.array(knowledgeIdSchema).min(1).max(100).refine(ids => new Set(ids).size === ids.length) }),
  request('revoke', { ...kbFields, memberId: knowledgeIdSchema }),
  request('search', { query: z.string().trim().min(1).max(1000), topK: z.number().int().min(1).max(20).default(5),
    knowledgeBaseIds: z.array(knowledgeIdSchema).min(1).max(100).refine(ids => new Set(ids).size === ids.length).optional() }),
])
export type KnowledgeRequest = z.output<typeof knowledgeRequestSchema>
export type KnowledgeRequestInput = z.input<typeof knowledgeRequestSchema>
export type KnowledgeAction = KnowledgeRequest['action']

const flags = z.record(z.string(), z.boolean())
export const knowledgeBaseSchema = z.object({
  id: knowledgeIdSchema, name: z.string(), description: z.string().nullable().optional(),
  revision: z.number().int().optional(), documentCount: z.number().int().nonnegative().optional(), readyDocumentCount: z.number().int().nonnegative().optional(), permissions: flags,
})
const paging = { page: z.number().int().positive(), pageSize: z.number().int().positive(), total: z.number().int().nonnegative() }
export const knowledgeBasePageSchema = z.object({
  ...paging, items: z.array(knowledgeBaseSchema),
  viewer: z.object({ memberId: z.string().optional(), role: z.string().optional(), isAdmin: z.boolean().optional() }),
  capabilities: flags, limits: z.record(z.string(), z.unknown()),
})
export function restoreKnowledgeFilename(value: string): string {
  if (!/[\u0080-\u00ff]/.test(value) || value.includes('\uFFFD')) return value
  try {
    const bytes = Uint8Array.from(value, character => character.codePointAt(0)!)
    const restored = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return restored.includes('\uFFFD') ? value : restored
  } catch { return value }
}
const filenameSchema = z.string().transform(restoreKnowledgeFilename)
export const knowledgeVersionSchema = z.object({
  id: knowledgeIdSchema, name: filenameSchema.optional(), originalName: filenameSchema.optional(), filename: filenameSchema.optional(),
  version: z.union([z.string(), z.number()]).optional(), versionNumber: z.number().optional(),
  status: z.enum(['PENDING', 'PROCESSING', 'READY', 'FAILED']), stage: z.string().nullable().optional(),
  retryable: z.boolean().optional(), errorCode: z.string().nullable().optional(), errorMessage: z.string().nullable().optional(),
  createdAt: z.string().optional(),
})
export const knowledgeDocumentSchema = z.object({
  id: knowledgeIdSchema, name: filenameSchema.optional(), originalName: filenameSchema.optional(), filename: filenameSchema.optional(),
  status: z.enum(['PENDING', 'PROCESSING', 'READY', 'FAILED']), stage: z.string().nullable().optional(), searchable: z.boolean(),
  activeVersion: knowledgeVersionSchema.nullable().optional(), latestVersion: knowledgeVersionSchema.nullable().optional(),
  retryable: z.boolean().optional(), errorMessage: z.string().nullable().optional(), etag: etagSchema.optional(), unchanged: z.boolean().optional(),
})
const location = z.object({ pageStart: z.number().nullable().optional(), pageEnd: z.number().nullable().optional(), sectionPath: z.array(z.string()).optional(), blockStart: z.number().nullable().optional(), blockEnd: z.number().nullable().optional() })
const previewItem = z.object({
  chunkId: z.string().optional(), id: z.string().optional(),
  content: z.string().optional(), text: z.string().optional(), location: location.optional(),
}).transform(item => ({ ...item, content: item.content ?? item.text })).refine(item => typeof item.content === 'string', 'preview item must contain text or content')
export const knowledgePreviewSchema = z.object({
  ...paging, versionId: knowledgeIdSchema,
  documentName: filenameSchema.optional(), items: z.array(previewItem),
})
export const knowledgeMemberSchema = z.object({
  memberId: knowledgeIdSchema, name: z.string().optional(), displayName: z.string().optional(), email: z.string().nullable().optional(),
  user: z.object({ name: z.string().optional(), email: z.string().nullable().optional() }).optional(),
})
export const knowledgeMemberPageSchema = z.object({ ...paging, items: z.array(knowledgeMemberSchema) })
export const knowledgeGrantSchema = z.object({
  id: knowledgeIdSchema.optional(), memberId: knowledgeIdSchema.optional(), name: z.string().optional(), displayName: z.string().optional(), email: z.string().nullable().optional(),
  member: knowledgeMemberSchema.optional(), createdAt: z.string().optional(), grantedAt: z.string().optional(),
  grantedBy: z.object({ name: z.string().optional(), memberId: knowledgeIdSchema.optional() }).optional(),
}).transform(grant => ({ ...grant, memberId: grant.memberId ?? grant.member?.memberId }))
  .refine(grant => typeof grant.memberId === 'string', 'grant must identify a member')
export const knowledgeGrantPageSchema = z.object({ ...paging, items: z.array(knowledgeGrantSchema) })
export const knowledgeSearchResponseSchema = z.object({
  searchId: z.string().optional(), status: z.enum(['MATCHED', 'NO_MATCH', 'NO_ACCESS', 'NOT_READY']),
  actualStrategy: z.string(), degraded: z.boolean(), partial: z.boolean(), durationMs: z.number().nonnegative(),
  results: z.array(z.object({
    sourceId: knowledgeIdSchema, knowledgeBaseId: knowledgeIdSchema, knowledgeBaseName: z.string(),
    documentId: knowledgeIdSchema, documentName: z.string(), versionId: knowledgeIdSchema, content: z.string(), location,
    tokenCount: z.number().nonnegative().optional(), truncated: z.boolean().optional(),
  })),
})
export const knowledgeResponseSchemas = {
  list: knowledgeBasePageSchema, getBase: knowledgeBaseSchema, createBase: knowledgeBaseSchema, updateBase: knowledgeBaseSchema,
  deleteBase: z.undefined(), documents: z.array(knowledgeDocumentSchema), getDocument: knowledgeDocumentSchema,
  uploadDocument: knowledgeDocumentSchema, replaceDocument: knowledgeDocumentSchema, retryDocument: knowledgeDocumentSchema,
  deleteDocument: z.undefined(), versions: z.array(knowledgeVersionSchema), preview: knowledgePreviewSchema,
  members: knowledgeMemberPageSchema, grants: knowledgeGrantPageSchema,
  grant: z.union([
    z.object({ addedMemberIds: z.array(knowledgeIdSchema), existingMemberIds: z.array(knowledgeIdSchema) }),
    z.undefined(),
  ]), revoke: z.undefined(), search: knowledgeSearchResponseSchema,
} satisfies Record<KnowledgeAction, z.ZodType>
export type KnowledgeData<A extends KnowledgeAction> = z.output<(typeof knowledgeResponseSchemas)[A]>
export type KnowledgeBase = z.output<typeof knowledgeBaseSchema>
export type KnowledgeDocument = z.output<typeof knowledgeDocumentSchema>
export type KnowledgeVersion = z.output<typeof knowledgeVersionSchema>
export type KnowledgeMember = z.output<typeof knowledgeMemberSchema>
export type KnowledgeGrant = z.output<typeof knowledgeGrantSchema>
export interface KnowledgeError {
  code?: string
  message: string
  statusCode?: number
  platformCode?: string
  requestId?: string
  retryAfterMs?: number
}
export type KnowledgeResult<A extends KnowledgeAction> = { success: true; data: KnowledgeData<A> } | { success: false; error: KnowledgeError }
