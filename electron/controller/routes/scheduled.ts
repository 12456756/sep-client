import { z } from 'zod'
import { scheduleInputSchema, scheduleTimeRequestSchema, createWorkScheduleSchema, editWorkScheduleSchema } from '../../../src/shared/scheduled-tasks'
import { scheduledCreationRequestSchema } from '../../../src/shared/scheduled-creation'
import { INVOKE_CHANNELS } from '../channels'
import { NO_INPUT, route } from '../router'

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)
const mutation = z.object({ id, expectedRevision: z.number().int().positive() }).strict()
export const scheduledRoutes = [
  route(INVOKE_CHANNELS.SCHEDULE_WORK_SOURCE, id, async (ctx, value) => ({ success: true, data: await ctx.scheduledTasks.workSource(value) })),
  route(INVOKE_CHANNELS.SCHEDULE_CREATE_FROM_WORK, createWorkScheduleSchema, async (ctx, value) => ({ success: true, data: await ctx.scheduledTasks.createFromWork(value) })),
  route(INVOKE_CHANNELS.SCHEDULE_EDIT_FROM_WORK, editWorkScheduleSchema, async (ctx, value) => ({ success: true, data: await ctx.scheduledTasks.editFromWork(value) })),
  route(INVOKE_CHANNELS.SCHEDULE_SUBMIT_CREATION, scheduledCreationRequestSchema, async (ctx, value) => ({ success: true, data: await ctx.scheduledCreations.submit(value) })),
  route(INVOKE_CHANNELS.SCHEDULE_CANCEL_CREATION, z.object({ id: z.string().uuid(), expectedRevision: z.number().int().positive() }).strict(), async (ctx, value) => ({ success: true, data: await ctx.scheduledCreations.cancel(value.id, value.expectedRevision) })),
  route(INVOKE_CHANNELS.SCHEDULE_INTERPRET_TIME, scheduleTimeRequestSchema, async (ctx, value) => ({ success: true, data: await ctx.scheduledTasks.interpretTime(value) })),
  route(INVOKE_CHANNELS.SCHEDULE_LIST, NO_INPUT, async ctx => ({ success: true, data: await ctx.scheduledTasks.list() })),
  route(INVOKE_CHANNELS.SCHEDULE_CREATE, z.object({ requestId: id, input: scheduleInputSchema }).strict(), async (ctx, value) => ({ success: true, data: await ctx.scheduledTasks.create(value.requestId, value.input) })),
  route(INVOKE_CHANNELS.SCHEDULE_EDIT, mutation.extend({ input: scheduleInputSchema }), async (ctx, value) => ({ success: true, data: await ctx.scheduledTasks.edit(value.id, value.expectedRevision, value.input) })),
  route(INVOKE_CHANNELS.SCHEDULE_PLAN, mutation, async (ctx, value) => ({ success: true, data: await ctx.scheduledTasks.plan(value.id, value.expectedRevision) })),
  route(INVOKE_CHANNELS.SCHEDULE_CONFIRM, mutation, async (ctx, value) => ({ success: true, data: await ctx.scheduledTasks.confirm(value.id, value.expectedRevision) })),
  route(INVOKE_CHANNELS.SCHEDULE_PAUSE, mutation, async (ctx, value) => { await ctx.scheduledTasks.pause(value.id, value.expectedRevision); return { success: true } }),
  route(INVOKE_CHANNELS.SCHEDULE_DELETE, mutation, async (ctx, value) => { await ctx.scheduledTasks.pause(value.id, value.expectedRevision, true); return { success: true } }),
  route(INVOKE_CHANNELS.SCHEDULE_CHECK, id, async (ctx, value) => { await ctx.scheduledTasks.check(value); return { success: true } }),
  route(INVOKE_CHANNELS.SCHEDULE_ACKNOWLEDGE, z.object({ id, confirmed: z.literal(true) }).strict(), async (ctx, value) => { await ctx.scheduledTasks.check(value.id, true); return { success: true } }),
  route(INVOKE_CHANNELS.SCHEDULE_CANCEL, id, async (ctx, value) => { await ctx.scheduledTasks.cancel(value); return { success: true } }),
  route(INVOKE_CHANNELS.SCHEDULE_RESUME_SCHEDULER, NO_INPUT, async ctx => { await ctx.scheduledTasks.resume(); return { success: true } }),
]
