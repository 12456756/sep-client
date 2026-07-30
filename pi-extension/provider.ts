/**
 * pi-extension/provider.ts — SEP Gateway Provider 扩展
 *
 * 动态注入 access token 到每次 LLM 请求的 Authorization header。
 * 通过 before_provider_headers 事件在每次 HTTP 请求前调用 getAccessToken()。
 */

import type {
  ExtensionFactory,
  BeforeProviderHeadersEvent,
} from '@earendil-works/pi-coding-agent';

interface ProviderConfig {
  /** 获取当前 access token (支持 async) */
  getAccessToken: () => Promise<string> | string;
}

/**
 * 构建 SEP Gateway Provider 扩展
 *
 * @param config - 包含 token 获取函数的配置
 * @returns ExtensionFactory 传给 DefaultResourceLoader
 */
export function buildSepGatewayProvider(config: ProviderConfig): ExtensionFactory {
  return (pi) => {
    pi.on('before_provider_headers', async (event: BeforeProviderHeadersEvent): Promise<void> => {
      // 每次 LLM 请求前获取最新 access token
      const token = await config.getAccessToken();

      // 注入到 Authorization header (覆盖 registerProvider 时的 placeholder)
      event.headers['authorization'] = token;
    });
  };
}
