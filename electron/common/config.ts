const SEP_BASE_URL = (process.env['SEP_BASE_URL'] || 'https://sep-dev.longdaoSEP.cn/api').replace(/\/+$/, '')

export const config = {
  SEP_BASE_URL,
  SEP_API_BASE_URL: SEP_BASE_URL,
  SEP_GATEWAY_URL: process.env['SEP_GATEWAY_URL'] || `${SEP_BASE_URL}/gateway/v1`,
  CLIENT_VERSION: process.env['npm_package_version'] || '1.0.0',
  EMPLOYMENT_TOKEN_REFRESH_BEFORE_MS: 5 * 60 * 1000,
  isDevelopment: process.env['NODE_ENV'] === 'development',
} as const
