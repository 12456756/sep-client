/**
 * SEP 客户端配置。
 *
 * 环境变量：
 * - SEP_BASE_URL：SEP 后端地址和 REST API 基础地址（默认：http://localhost:3001）。
 */

const SEP_BASE_URL = (process.env['SEP_BASE_URL'] || 'http://localhost:3001').replace(/\/+$/, '')
const SEP_API_BASE_URL = `${SEP_BASE_URL}/api`

export const config = {
  /**
 * SEP 后端基础地址。
 * 开发环境：http://localhost:3001。
 * 生产环境：https://sep.example.com。
   */
  SEP_BASE_URL,

  /**
 * SEP REST API 基础地址。后端在全局 /api 前缀下提供客户端接口。
   */
  SEP_API_BASE_URL,

  /**
 * 兼容 OpenAI 协议的 SEP 模型网关地址。
   */
  // SEP 后端在全局 /api 前缀下提供兼容 OpenAI 协议的网关。
  // 对于单独部署网关的环境，仍保留覆盖配置的能力。
  SEP_GATEWAY_URL: process.env['SEP_GATEWAY_URL'] || `${SEP_API_BASE_URL}/gateway/v1`,

  /**
 * 仅用于兼容不返回 allowedModels 字段的旧版 /client/instances 接口。
 * 每次请求仍由网关执行最终的模型授权校验。
   */
  SEP_DEFAULT_MODEL: process.env['SEP_DEFAULT_MODEL'] || 'gpt-5.2',

  /**
 * 客户端版本（来自 package.json）。
   */
  CLIENT_VERSION: process.env['npm_package_version'] || '1.0.0',

  /**
 * 实例令牌刷新时机。
   */
  INSTANCE_TOKEN_REFRESH_BEFORE_MS: 5 * 60 * 1000, // 在过期前 5 分钟刷新。

  /**
 * 开发模式标志。
   */
  isDevelopment: process.env['NODE_ENV'] === 'development',
} as const;
