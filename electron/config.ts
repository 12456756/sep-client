/**
 * SEP Client Configuration
 *
 * Environment variables:
 * - SEP_BASE_URL: SEP backend base URL (default: http://localhost:3001)
 */

export const config = {
  /**
   * SEP backend base URL
   * Development: http://localhost:3001
   * Production: https://sep.example.com
   */
  SEP_BASE_URL: process.env['SEP_BASE_URL'] || 'http://localhost:3001',

  /**
   * Client version (from package.json)
   */
  CLIENT_VERSION: process.env['npm_package_version'] || '1.0.0',

  /**
   * Token refresh timing
   */
  GENERAL_TOKEN_REFRESH_BEFORE_MS: 5 * 60 * 1000, // 5 minutes before expiry
  INSTANCE_TOKEN_REFRESH_BEFORE_MS: 5 * 60 * 1000, // 5 minutes before expiry

  /**
   * Development mode flags
   */
  isDevelopment: process.env['NODE_ENV'] === 'development',
} as const;
