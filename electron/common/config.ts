import { runtimeConfig } from './runtime-config'

const SEP_BASE_URL = (process.env['SEP_BASE_URL'] || runtimeConfig.sepBaseUrl).replace(/\/+$/, '')

export const config = {
  SEP_BASE_URL,
  SEP_API_BASE_URL: SEP_BASE_URL,
  SEP_GATEWAY_URL: process.env['SEP_GATEWAY_URL'] || runtimeConfig.gatewayUrl || `${SEP_BASE_URL}/gateway/v1`,
  CLIENT_VERSION: process.env['npm_package_version'] || process.env['SEP_CLIENT_VERSION'] || '0.1.0',
  RELEASE_CHANNEL: runtimeConfig.channel,
  RELEASE_ENVIRONMENT: runtimeConfig.environment,
  BUILD_TIME: runtimeConfig.buildTime,
  EMPLOYMENT_TOKEN_REFRESH_BEFORE_MS: 5 * 60 * 1000,
  isDevelopment: process.env['NODE_ENV'] === 'development',
} as const
