import { z } from 'zod'

export const connectorIdSchema = z.enum(['dingtalk', 'feishu', 'wecom', 'tmeet', 'qqmail'])
export type ConnectorId = z.infer<typeof connectorIdSchema>
export const connectorStateSchema = z.object({
  id: connectorIdSchema,
  status: z.enum(['disconnected', 'authorizing', 'connected', 'error']),
  connectedAt: z.number().optional(),
  phase: z.enum(['setup', 'authorization']).optional(),
  coverage: z.enum(['documents', 'workspace', 'messaging', 'meetings', 'mail']).optional(),
  accountLabel: z.string().max(256).optional(),
  error: z.string().optional(),
  notice: z.string().optional(),
})
export type ConnectorState = z.infer<typeof connectorStateSchema>

export const qqMailCredentialsSchema = z.object({
  email: z.string().trim().toLowerCase().max(254).regex(/^[a-z0-9][a-z0-9._-]*@(qq|foxmail)\.com$/),
  authorizationCode: z.string().trim().regex(/^[a-zA-Z]{16}$/),
}).strict()
export type QQMailCredentials = z.infer<typeof qqMailCredentialsSchema>
