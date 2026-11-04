import { generatedRuntimeConfig } from './runtime-config.generated'
import { z } from 'zod'

export interface RuntimeConfig {
  channel: 'beta' | 'stable'
  environment: string
  sepBaseUrl: string
  gatewayUrl: string
  buildTime: string
}

export const runtimeConfig: RuntimeConfig = {
  channel: generatedRuntimeConfig.channel,
  environment: generatedRuntimeConfig.environment,
  sepBaseUrl: process.env['SEP_BASE_URL'] || generatedRuntimeConfig.sepBaseUrl,
  gatewayUrl: process.env['SEP_GATEWAY_URL'] || generatedRuntimeConfig.gatewayUrl,
  buildTime: generatedRuntimeConfig.buildTime,
}

const importInstanceSchema = z.object({
  instanceId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  label: z.string().min(1).max(160),
  apiBaseUrl: z.string().url().refine(value => {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash
  }),
}).strict()

/** Private deployments configure this locally; activation URLs cannot supply endpoints. */
export function resolveSkillImportInstances(configured?: string): Array<z.infer<typeof importInstanceSchema>> {
  const value: unknown = configured ? JSON.parse(configured) : [
    { instanceId: 'sep-default', label: 'SEP', apiBaseUrl: generatedRuntimeConfig.sepBaseUrl },
  ]
  const entries = z.array(importInstanceSchema).max(16).parse(value)
  if (new Set(entries.map(item => item.instanceId)).size !== entries.length) throw new Error('Duplicate import instance')
  return entries
}
