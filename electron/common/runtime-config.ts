import { generatedRuntimeConfig } from './runtime-config.generated'

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
