import { z } from 'zod'

export const connectorIdSchema = z.enum(['dingtalk', 'feishu', 'wecom', 'tmeet', 'qqmail', 'kdocs', 'github'])
export type ConnectorId = z.infer<typeof connectorIdSchema>
export const connectorStateSchema = z.object({
  id: connectorIdSchema,
  status: z.enum(['disconnected', 'preparing', 'authorizing', 'connected', 'error']),
  dependency: z.object({ phase: z.enum(['downloading', 'verifying']), received: z.number().int().nonnegative(), total: z.number().int().positive() }).optional(),
  connectedAt: z.number().optional(),
  phase: z.enum(['setup', 'authorization']).optional(),
  coverage: z.enum(['documents', 'workspace', 'messaging', 'meetings', 'mail', 'development']).optional(),
  readOnly: z.boolean().optional(),
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

export const gitHubCredentialsSchema = z.object({
  token: z.string().trim().min(20).max(512).regex(/^(github_pat_|ghp_)[A-Za-z0-9_]+$/),
  readOnly: z.boolean(),
}).strict()
export type GitHubCredentials = z.infer<typeof gitHubCredentialsSchema>
export type ConnectorCredentials = QQMailCredentials | GitHubCredentials
