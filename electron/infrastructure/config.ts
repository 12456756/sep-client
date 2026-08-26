/**
 * SEP Client Configuration
 *
 * Environment variables:
 * - SEP_BASE_URL: SEP backend origin and REST API base (default: http://localhost:3001)
 */

const SEP_BASE_URL = (process.env['SEP_BASE_URL'] || 'http://localhost:3001').replace(/\/+$/, '')

export const config = {
  /**
   * SEP backend base URL
   * Development: http://localhost:3001
   * Production: https://sep.example.com
   */
  SEP_BASE_URL,

  /**
   * OpenAI-compatible SEP model gateway URL.
   */
  SEP_GATEWAY_URL: process.env['SEP_GATEWAY_URL'] || `${SEP_BASE_URL}/gateway/v1`,

  /**
   * Client version (from package.json)
   */
  CLIENT_VERSION: process.env['npm_package_version'] || '1.0.0',

  /**
   * Instance token refresh timing
   */
  INSTANCE_TOKEN_REFRESH_BEFORE_MS: 5 * 60 * 1000, // 5 minutes before expiry

  /**
   * Development mode flags
   */
  isDevelopment: process.env['NODE_ENV'] === 'development',
} as const;
