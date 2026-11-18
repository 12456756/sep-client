import { z } from 'zod'
import { INVOKE_CHANNELS } from '../channels'
import { route } from '../router'

export const multimediaRoutes = [
  route(INVOKE_CHANNELS.MULTIMEDIA_GET_SETTINGS, z.object({ subscriptionId: z.string().min(1).max(128) }).strict(), async (ctx, input) => ({
    success: true, data: await ctx.employees.describeMultimedia(input.subscriptionId),
  })),
]
