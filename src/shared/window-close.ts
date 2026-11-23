import { z } from 'zod'

const closeAction = z.enum(['minimize', 'quit'])
export const windowCloseBehavior = z.enum(['ask', ...closeAction.options])
export type WindowCloseBehavior = z.infer<typeof windowCloseBehavior>

export const windowCloseRequestId = z.number().int().positive()
export const windowCloseCommand = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('get') }),
  z.strictObject({ type: z.literal('set'), behavior: windowCloseBehavior }),
  z.strictObject({ type: z.literal('resolve'), requestId: windowCloseRequestId, action: closeAction.or(z.literal('cancel')), remember: z.boolean() }),
])
export type WindowCloseCommand = z.infer<typeof windowCloseCommand>
