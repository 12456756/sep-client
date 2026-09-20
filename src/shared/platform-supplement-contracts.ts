import { z } from 'zod'

const resourceId = z.string().min(1).max(128)
const nullableText = z.string().nullable()
const count = z.number().int().nonnegative()

export const enterpriseOverviewSchema = z.object({
  enterprise: z.object({ id: z.string(), name: z.string(), logo: nullableText }).passthrough(),
  permissions: z.object({
    grantVisibility: z.enum(['ENTERPRISE', 'SELF']),
    departmentGrantInheritance: z.literal('DIRECT_DEPARTMENT_ONLY'),
    personalReportingSupported: z.literal(false),
  }).passthrough(),
  statistics: z.object({
    employeeCount: count, subscriptionCount: count,
    activeEmployeeCount: count, currentUserAvailableEmployeeCount: count,
  }).passthrough(),
  employees: z.array(z.object({
    employeeId: z.string(), subscriptionId: z.string(), name: z.string(),
    avatar: nullableText, position: z.string(), description: z.string(),
    status: z.enum(['ACTIVE', 'PAUSED', 'EXPIRED', 'TERMINATED']),
    employeeStatus: z.string(), endDate: nullableText,
    active: z.boolean(), currentUserCanUse: z.boolean(),
  }).passthrough()),
}).passthrough()

export const enterpriseOrganizationSchema = enterpriseOverviewSchema.extend({
  departments: z.array(z.object({
    id: z.string(), name: z.string(), parentId: nullableText,
    leaderId: nullableText, sortOrder: z.number().int(),
  }).passthrough()),
  members: z.array(z.object({
    id: z.string(), userId: z.string(), name: z.string(),
    departmentId: nullableText, position: nullableText, avatar: nullableText,
  }).passthrough()),
  grants: z.array(z.object({
    id: z.string(), subscriptionId: z.string(), memberId: nullableText,
    departmentId: nullableText, expiresAt: nullableText,
  }).passthrough()),
})

// Keep platform metadata and source untouched; never normalize Markdown or review states.
export const skillVersionSchema = z.object({
  id: z.string(), capabilityId: z.string(), scope: z.string(),
  version: z.string(), status: z.string(),
  parentVersionId: nullableText.optional(), enterpriseId: nullableText.optional(),
  ownerId: nullableText.optional(), submittedAt: nullableText.optional(),
  enterpriseReviewedAt: nullableText.optional(), rejectionReason: nullableText.optional(),
  changeSummary: nullableText.optional(), createdAt: z.string().optional(),
  updatedAt: z.string().optional(), content: z.string().optional(),
}).passthrough()

export const personalSkillVersionRequestSchema = z.object({
  capabilityId: resourceId, parentVersionId: resourceId,
  content: z.string().min(1).max(500_000),
  changeSummary: z.string().max(2_000).optional(),
}).strict()
export const idempotencyKeySchema = z.string().regex(/^[A-Za-z0-9_-]{16,128}$/)
export const skillVersionQuerySchema = z.object({
  capabilityId: resourceId, status: z.string().min(1).optional(),
}).strict()
export const skillVersionReviewQuerySchema = z.object({
  status: z.enum(['PENDING_ENTERPRISE_REVIEW', 'ENTERPRISE_APPROVED', 'ENTERPRISE_REJECTED']).optional(),
  capabilityId: resourceId.optional(), page: z.number().int().min(1).optional(),
  limit: z.number().int().min(1).max(100).optional(),
}).strict()
export const skillVersionReviewRequestSchema = z.object({
  decision: z.enum(['APPROVE', 'REJECT']), comment: z.string().max(2_000).optional(),
}).strict().refine(value => value.decision !== 'REJECT' || Boolean(value.comment?.trim()), {
  message: 'REJECT requires a nonempty comment', path: ['comment'],
})
export const skillVersionIdSchema = resourceId
export const skillVersionListSchema = z.array(skillVersionSchema)
export const skillVersionReviewPageSchema = z.object({
  total: count, page: z.number().int().min(1), limit: z.number().int().min(1).max(100),
  items: skillVersionListSchema,
}).passthrough()

export type EnterpriseOverview = z.infer<typeof enterpriseOverviewSchema>
export type EnterpriseOrganization = z.infer<typeof enterpriseOrganizationSchema>
export type SkillVersion = z.infer<typeof skillVersionSchema>
export type PersonalSkillVersionRequest = z.infer<typeof personalSkillVersionRequestSchema>
export type SkillVersionQuery = z.infer<typeof skillVersionQuerySchema>
export type SkillVersionReviewQuery = z.infer<typeof skillVersionReviewQuerySchema>
export type SkillVersionReviewRequest = z.infer<typeof skillVersionReviewRequestSchema>
export type SkillVersionReviewPage = z.infer<typeof skillVersionReviewPageSchema>
