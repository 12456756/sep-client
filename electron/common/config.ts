import { runtimeConfig } from './runtime-config'

const SEP_BASE_URL = (process.env['SEP_BASE_URL'] || runtimeConfig.sepBaseUrl).replace(/\/+$/, '')

/**
 * Built-in employee portraits are served by the web origin, while uploaded
 * company/user images are served by the API origin. Local SEP development uses
 * port 3000 for the web app and 3001 for the API; production uses one origin.
 */
function deriveAssetBaseUrl(baseUrl: string): string {
  try {
    const url = new URL(baseUrl)
    if ((url.hostname === 'localhost' || url.hostname === '127.0.0.1') && url.port === '3001') {
      return `${url.protocol}//${url.hostname}:3000`
    }
    return url.origin
  } catch {
    return baseUrl
  }
}

const SEP_ASSET_BASE_URL = (
  process.env['SEP_ASSET_BASE_URL'] || deriveAssetBaseUrl(SEP_BASE_URL)
).replace(/\/+$/, '')

export const config = {
  SEP_BASE_URL,
  SEP_API_BASE_URL: SEP_BASE_URL,
  SEP_ASSET_BASE_URL,
  // Notification action links target the Web application, never a configured asset CDN.
  SEP_WEB_BASE_URL: (process.env['SEP_WEB_BASE_URL'] || deriveAssetBaseUrl(SEP_BASE_URL)).replace(/\/+$/, ''),
  SEP_GATEWAY_URL: process.env['SEP_GATEWAY_URL'] || runtimeConfig.gatewayUrl || `${SEP_BASE_URL}/gateway/v1`,
  CLIENT_VERSION: process.env['npm_package_version'] || process.env['SEP_CLIENT_VERSION'] || '1.0.0',
  RELEASE_CHANNEL: runtimeConfig.channel,
  RELEASE_ENVIRONMENT: runtimeConfig.environment,
  BUILD_TIME: runtimeConfig.buildTime,
  EMPLOYMENT_TOKEN_REFRESH_BEFORE_MS: 5 * 60 * 1000,
  isDevelopment: process.env['NODE_ENV'] === 'development',
} as const
