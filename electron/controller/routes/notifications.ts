import { shell } from 'electron'
import { z } from 'zod'
import { config } from '../../common/config'
import { resolveNotificationAction } from '../../common/platform/notification-action'
import { notificationQuerySchema, notificationCategoryQuerySchema, notificationIdSchema } from '../../../src/shared/notification-contracts'
import { requireScope } from '../../service/scope-guard'
import { INVOKE_CHANNELS } from '../channels'
import { route } from '../router'

export const notificationRoutes = [
  route(INVOKE_CHANNELS.NOTIFICATION_LIST, notificationQuerySchema, async (ctx, query) => ({ success: true, data: await ctx.notifications.list(query) })),
  route(INVOKE_CHANNELS.NOTIFICATION_UNREAD_COUNT, notificationCategoryQuerySchema, async (ctx, query) => ({ success: true, data: await ctx.notifications.unreadCount(query) })),
  route(INVOKE_CHANNELS.NOTIFICATION_MARK_READ, notificationIdSchema, async (ctx, id) => { await ctx.notifications.markRead(id); return { success: true } }),
  route(INVOKE_CHANNELS.NOTIFICATION_MARK_ALL_READ, notificationCategoryQuerySchema, async (ctx, query) => { await ctx.notifications.markAllRead(query); return { success: true } }),
  route(INVOKE_CHANNELS.NOTIFICATION_DELETE, notificationIdSchema, async (ctx, id) => { await ctx.notifications.delete(id); return { success: true } }),
  route(INVOKE_CHANNELS.NOTIFICATION_CLEAR_READ, notificationCategoryQuerySchema, async (ctx, query) => { await ctx.notifications.clearRead(query); return { success: true } }),
  route(INVOKE_CHANNELS.NOTIFICATION_OPEN_ACTION, z.string().min(1).max(4096), async (ctx, raw) => {
    requireScope(ctx.backend)
    const url = resolveNotificationAction(raw, config.SEP_WEB_BASE_URL)
    await shell.openExternal(url)
    return { success: true }
  }),
]
