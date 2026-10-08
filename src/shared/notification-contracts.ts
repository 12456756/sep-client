import { z } from 'zod'

export const notificationCategorySchema = z.enum(['SYSTEM', 'USAGE_ALERT', 'SECURITY', 'APPROVAL'])
export const notificationSchema = z.object({
  id: z.string().min(1).max(256),
  userId: z.string().min(1).optional(),
  type: z.enum([
    'INFO', 'SUCCESS', 'WARNING', 'ERROR', 'SUBSCRIPTION_REQUEST_CREATED',
    'SUBSCRIPTION_REQUEST_APPROVED', 'SUBSCRIPTION_REQUEST_REJECTED', 'SKILL_VERSION_UPDATED',
    'ALLOWANCE_WARNING', 'ALLOWANCE_EXHAUSTED', 'WALLET_LOW_BALANCE',
    'CONTRIBUTION_ENTERPRISE_APPROVED', 'CONTRIBUTION_ENTERPRISE_REJECTED',
    'CONTRIBUTION_PLATFORM_APPROVED', 'CONTRIBUTION_PLATFORM_REJECTED',
    'CONTRIBUTION_REWARD_CREDITED', 'SUBSCRIPTION_EXPIRING',
  ]),
  title: z.string().max(1000),
  message: z.string().max(20000),
  relatedType: z.string().nullable().optional().default(null),
  relatedId: z.string().nullable().optional().default(null),
  read: z.boolean(),
  category: notificationCategorySchema,
  severity: z.enum(['INFO', 'WARNING', 'ERROR']),
  actionUrl: z.string().nullable().optional().default(null),
  createdAt: z.iso.datetime({ offset: true }),
})
export const notificationQuerySchema = z.object({
  limit: z.number().int().min(1).max(100).optional(),
  offset: z.number().int().min(0).optional(),
  category: notificationCategorySchema.optional(),
  unreadOnly: z.boolean().optional(),
}).strict()
export const notificationCategoryQuerySchema = z.object({ category: notificationCategorySchema.optional() }).strict()
export const notificationIdSchema = z.string().trim().min(1).max(256)
export const notificationPageSchema = z.object({ items: z.array(notificationSchema), total: z.number().int().nonnegative() })
export const unreadNotificationCountSchema = z.object({ count: z.number().int().nonnegative() })
export const notificationSocketMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('connected'), data: z.object({ unreadCount: z.number().int().nonnegative() }) }),
  z.object({ type: z.literal('notification'), data: notificationSchema }),
  z.object({ type: z.literal('unread_count'), data: unreadNotificationCountSchema }),
  z.object({ type: z.literal('pong') }),
])
export type PlatformNotification = z.infer<typeof notificationSchema>
export type NotificationPage = z.infer<typeof notificationPageSchema>
export type NotificationQuery = z.infer<typeof notificationQuerySchema>
export type NotificationCategory = z.infer<typeof notificationCategorySchema>
export type NotificationCategoryQuery = z.infer<typeof notificationCategoryQuerySchema>
export type NotificationSocketMessage = z.infer<typeof notificationSocketMessageSchema>
/** Renderer-safe push: never contains authentication credentials. REST remains authoritative. */
export type NotificationUpdate = Exclude<NotificationSocketMessage, { type: 'pong' }> | { type: 'resync' }
