import { z } from 'zod'

const fileName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/)
const digest = z.string().regex(/^[a-f0-9]{64}$/)
export const connectorDependencySchema = z.object({
  id: z.enum(['dingtalk', 'feishu', 'wecom']),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  platform: z.enum(['win32', 'darwin', 'linux']),
  arch: z.enum(['x64', 'arm64']),
  archive: fileName,
  sha256: digest,
  bytes: z.number().int().positive().max(128 * 1024 * 1024),
  binary: fileName,
  files: z.array(z.object({ name: fileName, sha256: digest, bytes: z.number().int().positive().max(256 * 1024 * 1024) })).min(2).max(12),
}).superRefine((item, ctx) => {
  const names = item.files.map(file => file.name)
  if (new Set(names).size !== names.length || !names.includes(item.binary) || !names.includes('LICENSE') || item.id === 'dingtalk' && !names.includes('dws-skills.zip')) {
    ctx.addIssue({ code: 'custom', message: 'Incomplete connector dependency' })
  }
  if (item.files.reduce((sum, file) => sum + file.bytes, 0) > 512 * 1024 * 1024) ctx.addIssue({ code: 'custom', message: 'Connector dependency too large' })
})
export const connectorDependenciesSchema = z.object({ schemaVersion: z.literal(1), components: z.array(connectorDependencySchema).length(3) }).superRefine((manifest, ctx) => {
  if (new Set(manifest.components.map(item => item.id)).size !== 3 || new Set(manifest.components.map(item => `${item.platform}-${item.arch}`)).size !== 1) {
    ctx.addIssue({ code: 'custom', message: 'Invalid connector component set' })
  }
})
export type ConnectorDependency = z.infer<typeof connectorDependencySchema>
export interface DependencyProgress { phase: 'downloading' | 'verifying'; received: number; total: number }
export interface ConnectorDependencyPort {
  ensure(signal: AbortSignal, progress: (value: DependencyProgress) => void): Promise<void>
}
