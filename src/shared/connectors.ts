import { z } from 'zod'

export const connectorIdSchema = z.enum(['dingtalk', 'feishu', 'wecom'])
export type ConnectorId = z.infer<typeof connectorIdSchema>
export const connectorStateSchema = z.object({
  id: connectorIdSchema,
  status: z.enum(['disconnected', 'authorizing', 'connected', 'error']),
  connectedAt: z.number().optional(),
  phase: z.enum(['setup', 'authorization']).optional(),
  coverage: z.enum(['documents', 'workspace', 'messaging']).optional(),
  accountLabel: z.string().max(256).optional(),
  error: z.string().optional(),
  notice: z.string().optional(),
})
export type ConnectorState = z.infer<typeof connectorStateSchema>
